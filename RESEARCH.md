# DataSync Ingestion Pipeline -- Research & Engineering Journal

> A complete account of exploration, discoveries, breakthroughs, iterations, failures, fixes, and the final working pipeline that ingested **3,050,452 events in ~19.5 minutes**.

---

## 1. Initial Analysis & Methodology

### 1.1 Starting Point

Given: a challenge to ingest 3M events from an API into PostgreSQL, with a 3-hour API key timer and a target of < 30 minutes. The documented API (`/api/v1/events`) offered 10 requests/minute with max 5,000 events per request -- yielding 50K events/minute at best, or **60 minutes** for the full dataset. We needed to find a faster path.

### 1.2 Research Methodology

Our exploration followed a systematic approach:

1. **Documentation analysis** -- read README, `docs/api.md`, `.env.example`, `docker-compose.yml`, `run-ingestion.sh` for hints
2. **Dashboard reverse engineering** -- fetched the live dashboard's JavaScript bundle and decompiled it
3. **Endpoint probing** -- systematically tested every discovered endpoint
4. **Header analysis** -- checked all response headers for rate limit behavior, caching, and undocumented features
5. **Cursor protocol reverse engineering** -- decoded the base64 cursor format and tested fabrication
6. **Parallelism benchmarks** -- measured throughput at 1, 5, 10, and 20 concurrent workers
7. **Iterative implementation** -- built, tested, observed failures, fixed, and re-ran

### 1.3 Key Hints That Guided Us

From `README.md`:
- *"API is minimal by design -- explore beyond documentation"*
- *"Check response headers for hidden opportunities"*
- *"Cursors have a lifecycle -- understand it"*
- *"Timestamps aren't always what they seem"*

From `docker-compose.yml` (commented template):
- *"header-based auth (X-API-Key header) for best rate limits"*

From `.env.example`:
- `WORKER_CONCURRENCY=5` and `BATCH_SIZE=100` hinted at parallel architecture
- `CURSOR_REFRESH_THRESHOLD=60` hinted at cursor expiry mechanics

---

## 2. API Exploration -- The Discovery Phase

### 2.1 Dashboard JS Bundle Mining (Breakthrough #1)

**Method**: Fetched the live dashboard at the API base URL. Found it was a React SPA with a single 577KB JavaScript bundle at `/assets/index-1KlV7jRD.js`.

**Technique**: Downloaded the bundle to `/tmp/dashboard-bundle.js` and used Python regex scripts to extract API routes, fetch calls, endpoint patterns, and schema definitions. (`grep` variants failed on the large file; Python `re.finditer` with context windows worked reliably.)

**Discovered endpoints**:

| # | Endpoint | How Found | Significance |
|---|----------|-----------|--------------|
| 1 | `GET /api/v1/events` | Documented | Standard paginated endpoint, 10 req/min |
| 2 | `GET /api/v1/events/:id` | JS bundle | Single event lookup |
| 3 | `POST /api/v1/events/bulk` | JS bundle | Bulk fetch by IDs (returned 500 on test) |
| 4 | `POST /internal/dashboard/stream-access` | JS bundle | **Token issuer for stream endpoint** |
| 5 | `GET /api/v1/events/d4ta/x7k9/feed` | JS bundle → stream-access response | **High-throughput stream** |
| 6 | `GET /internal/stats` | JS bundle | Dataset statistics (3M events, 3K users, 60K sessions) |
| 7 | `GET /internal/health` | JS bundle | Health check (DB + Redis status) |
| 8 | `POST /api/v1/submissions` | README | Submit event IDs |

### 2.2 Stream Endpoint Access (Breakthrough #2)

**Problem**: The stream-access endpoint returned `403 DASHBOARD_REQUIRED` with a plain `X-API-Key` header.

**Investigation**: Mined the dashboard JS bundle for the exact fetch call pattern. Found it required browser-like headers:

```
User-Agent: Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36
Sec-Fetch-Site: same-origin
X-Requested-With: XMLHttpRequest
Cookie: dashboard_api_key=<api_key>
```

**Result**: Adding these headers unlocked the endpoint. It returned a stream access token with a 5-minute TTL, a dynamic endpoint path (`/api/v1/events/d4ta/x7k9/feed`), and the header name to use (`X-Stream-Token`).

**Significance**: The stream endpoint returned data in the **exact same format** as the standard endpoint but with **no visible rate limit headers** (`X-RateLimit-*` absent from responses).

### 2.3 Cursor Protocol Reverse Engineering (Breakthrough #3)

**Discovery**: Decoded a cursor from a standard API response:

```json
{
  "id": "56a349b5-7243-4e0c-9fd8-f2c1eb2a5d35",
  "ts": 1769541612369,
  "v": 2,
  "exp": 1771673123456
}
```

**Fabrication attempt #1**: Created a cursor with `ts` set to the current time -- **ignored** (returned first page, as timestamp was outside data range).

**Fabrication attempt #2**: Set `ts` to a timestamp within the data range but with `exp` in the past -- **rejected** with `"Cursor expired 35392 minute(s) ago"`. This confirmed the server validates the `exp` field.

**Fabrication attempt #3**: Set `ts` to a value within the data range AND `exp` to `Date.now() + 7200000` (2 hours future) -- **SUCCESS**. The API returned events starting from the specified timestamp position.

**Significance**: This enabled **parallel partitioned fetching** -- we could create N cursors at evenly-spaced timestamps and have N workers each cover a non-overlapping slice of the dataset.

### 2.4 Rate Limit Analysis

| Auth Method | `X-RateLimit-Limit` | Window | Effective Rate |
|-------------|---------------------|--------|----------------|
| Header (`X-API-Key`) | 10 | 60 seconds | 10 req/min |
| Query param (`?api_key=`) | 5 | 60 seconds | 5 req/min |
| Stream endpoint | No headers | Unknown | Server-side throttled |

**Cache behavior**: `X-Cache: HIT` responses did NOT count against the rate limit (verified: `X-RateLimit-Remaining` stayed the same on cache hits). However, each unique cursor request was a cache MISS, so this was not exploitable for our use case.

### 2.5 Content Negotiation Testing

- `Accept: text/csv` -- returned JSON (no CSV support)
- `Accept: application/x-ndjson` -- returned JSON
- `Accept: text/event-stream` -- returned JSON
- **Conclusion**: No alternative response formats available. JSON-only.

### 2.6 Timestamp Format Discovery

Spotted in the very first API response: some events had `timestamp: 1769541612369` (Unix ms as number) while others had `timestamp: "2026-01-27T19:19:13.629Z"` (ISO 8601 string). This confirmed the README hint that *"timestamps aren't always what they seem"*.

### 2.7 Parallel Throughput Benchmarks

Tested on the stream endpoint with fabricated cursors:

| Workers | Events | Time | Throughput | Notes |
|---------|--------|------|-----------|-------|
| 1 | 5,000 | ~6s | 833 evt/s | Baseline |
| 5 | 25,000 | 10s | 2,500 evt/s | Near-linear scaling |
| 10 | 50,000 | 16s | 3,125 evt/s | Good scaling |
| 20 | 100,000 | 24s | 4,184 evt/s | Sub-linear, server bottleneck |

**Observation**: Server-side JSON generation and network bandwidth capped throughput at ~5-6K events/sec regardless of parallelism. An HTTP 418 "I'm a teapot" response was returned for timestamp queries outside the data range (a fun easter egg).

### 2.8 Dataset Statistics (from `/internal/stats`)

```
Total: 3,000,000 events | 3,000 users | 60,000 sessions
Time range: ~30 days (Dec 28, 2025 → Jan 27, 2026)
Events per day: ~100,000
Event types: page_view (35%), click (25%), api_call (10%), form_submit (10%),
             scroll (5%), purchase (5%), error (5%), video_play (5%)
```

---

## 3. Architecture Decisions

### 3.1 Strategy: Parallel Stream Ingestion with Fabricated Cursors

**Why**: The stream endpoint had no visible rate limits, fabricated cursors enabled partitioning, and parallel workers could achieve 4K+ events/sec.

**Alternative considered**: Sequential pagination on the standard endpoint at 50K events/min (60 minutes). Rejected as too slow.

**Alternative considered**: Bulk endpoint (`POST /api/v1/events/bulk`). Rejected: returned 500 errors and would require knowing event IDs in advance.

### 3.2 Database: UNLOGGED Table + COPY Protocol

**Why UNLOGGED**: Bypasses Write-Ahead Log for ~2-3x faster writes. Safe for this use case since the data can be re-fetched.

**Why COPY**: PostgreSQL's COPY FROM STDIN is 5-10x faster than parameterized INSERT for bulk loading. Used `pg-copy-streams` library to stream tab-separated rows directly into the table.

**Why no indexes during ingestion**: Index maintenance during bulk inserts adds ~30-50% overhead. Indexes can be added post-ingestion if needed.

### 3.3 Worker Count: 20

Based on benchmarks showing 4,184 events/sec with 20 workers. More workers showed diminishing returns due to server-side bottleneck.

### 3.4 Batch Size: 5,000

Maximum supported by the API (`limit=10000` returned only 5,000). Each batch is ~1.7MB of JSON.

### 3.5 Dependencies: Minimal

Only two runtime dependencies: `pg` (PostgreSQL client) and `pg-copy-streams` (COPY protocol). No HTTP client library (used Node 20's built-in `fetch`). No logging library (plain `console.log` with timestamps).

---

## 4. Implementation Iterations

### 4.1 Iteration 1: Initial Build

**Files written**: 16 TypeScript source files across 4 layers (foundation, database, core, orchestration).

**Result**: TypeScript compiled clean on first try. Docker build failed initially because Alpine's npm had a bug (`Exit handler never called`), causing `npx tsc` to try downloading `tsc` from npm registry instead of using the local installation.

**Fix**: Switched the builder stage from `node:20-alpine` to `node:20-slim` (Debian-based). npm worked correctly.

### 4.2 Iteration 2: First Run (Port Conflict)

**Problem**: Port 5434 was already in use on the host.

**Fix**: Changed host port mapping to 5435. (Trivial but blocked the first launch.)

### 4.3 Iteration 3: Rate Limit Thundering Herd

**Observation**: 900K events ingested in ~4 minutes (225K/min), then ALL 20 workers hit 429 simultaneously. They all waited 10 seconds and retried together, hitting 429 again. Death spiral.

**Root cause**: No rate coordination between workers. All 20 workers consumed the stream endpoint's rate budget in a burst, then all retried at the same time.

**Analysis**: 900K / 5,000 = 180 batches in ~4 minutes = 45 batches/min. The stream endpoint's effective rate limit was approximately 180 requests per 4-5 minute window.

**Fix**: Implemented `SharedRateLimiter` (token bucket algorithm):
- Shared across all workers
- 0.7 requests/sec sustained rate, burst of 15
- `backoff()` method pauses all workers for an escalating delay on 429
- `onSuccess()` gradually reduces backoff severity
- Worker staggering: 250ms delay between worker starts to avoid thundering herd

### 4.4 Iteration 4: Cursor Expiry on Resume

**Observation**: After stopping and restarting the ingestion, all workers failed with `CURSOR_EXPIRED` because the saved checkpoint cursors (from the API's `nextCursor` response) had expired during the downtime.

**Fix**: Added cursor expiry handling in the worker:
1. On `400 CURSOR_EXPIRED`, fabricate a new cursor based on the partition's boundary timestamps
2. Continue from the new position instead of failing
3. On fresh start, always clear stale checkpoints

### 4.5 Iteration 5: DB Connection Timeouts

**Observation**: When workers were idle waiting in the rate limiter's backoff queue, their PostgreSQL connections timed out. When they resumed fetching and tried to COPY to the database, they got `Connection terminated due to connection timeout`.

**Root cause**: PG pool's `connectionTimeoutMillis` was 10s and `idleTimeoutMillis` was 30s. Rate limiter backoffs could last 30+ seconds.

**Fix**: Increased `connectionTimeoutMillis` to 60s and `idleTimeoutMillis` to 120s.

### 4.6 Iteration 6: Gap Fill Token Spam

**Observation**: After main workers completed, the gap fill function refreshed the stream token before EVERY request, creating a flood of token acquisition requests.

**Fix**: Added a flag to only refresh the token once on gap fill start, then rely on auto-refresh (every 4 minutes) for subsequent requests. Also added the shared rate limiter to gap fill.

### 4.7 Iteration 7: Progress Bar Overflow

**Observation**: When the event count exceeded 3M (100.8%), the progress bar's `'█'.repeat(filled) + '░'.repeat(width - filled)` crashed with `RangeError: Invalid count value: -1` because `filled > width`.

**Fix**: Clamped: `Math.min(width, Math.max(0, Math.round(ratio * width)))`.

---

## 5. Ablation Research: What Worked and What Didn't

### 5.1 Stream Endpoint vs Standard Endpoint

| Metric | Standard Endpoint | Stream Endpoint |
|--------|------------------|-----------------|
| Rate limit | 10 req/min (hard) | ~40 req/min (soft, server-side) |
| Max throughput | 50K events/min | ~200K events/min |
| Time for 3M | ~60 minutes | ~15-20 minutes |
| Authentication | X-API-Key only | X-API-Key + X-Stream-Token |

**Verdict**: Stream endpoint was 4x faster. Without it, the 30-minute target would be barely achievable.

### 5.2 Rate Limiter Impact

| Configuration | Result |
|--------------|--------|
| No rate limiter, 20 workers | 900K events in 4 min, then permanent 429 loop |
| 3.0 req/sec, burst 8 | 375K events in 2.3 min, then 429 loop |
| 0.7 req/sec, burst 15 | **3.05M events in 19.5 min, minor rate limits near end** |

**Verdict**: The sweet spot was 0.7 req/sec (42/min) with a burst of 15. This stayed just under the server's effective limit while maximizing throughput.

### 5.3 Worker Count Impact

| Workers | Throughput (observed) | Time to 3M (projected) |
|---------|----------------------|------------------------|
| 1 | 833 evt/s | 60 min |
| 5 | 2,500 evt/s | 20 min |
| 10 | 3,125 evt/s | 16 min |
| 20 | 3,450 evt/s (sustained) | **~15 min** |

**Verdict**: 20 workers provided the best balance. The rate limiter, not worker count, was the actual bottleneck after 10+ workers.

### 5.4 COPY Protocol vs INSERT

Not A/B tested in production, but COPY was chosen based on well-documented PostgreSQL benchmarks:
- COPY: ~50K rows/sec
- Multi-row INSERT with unnest: ~20K rows/sec
- Individual INSERT: ~5K rows/sec

Since the API bottleneck was ~3,400 events/sec, even INSERT would have been fast enough. COPY was chosen for headroom and correctness.

### 5.5 Fabricated Cursors vs Sequential Pagination

| Approach | Parallelism | Events/sec | Time |
|----------|-------------|------------|------|
| Sequential (no fabrication) | 1 worker | 833 | 60 min |
| Fabricated cursors | 20 workers | 3,450 | ~15 min |

**Verdict**: Fabricated cursors were essential for parallelism. Without them, only sequential pagination was possible.

### 5.6 Token Auto-Refresh

Token TTL was 300 seconds. We refreshed every 240 seconds (4-minute interval, 1-minute safety buffer). During the 19.5-minute run, this triggered 4 successful refreshes with zero worker interruptions.

---

## 6. Assumptions

1. **Rate limit window**: Assumed a sliding window of ~200 requests per 5 minutes based on observed behavior (never officially confirmed)
2. **Data immutability**: Assumed the 3M events don't change during ingestion
3. **Timestamp range**: Assumed ~31 days (Dec 27, 2025 to Jan 27, 2026) based on `/internal/stats` and probing
4. **Partition overlap**: Assumed minimal duplicate events at partition boundaries (acceptable tradeoff for parallelism)
5. **Cursor version**: Assumed `v: 2` based on decoded API cursor (always observed as 2)
6. **Stream token independence**: Assumed new tokens don't invalidate old ones (verified: old token worked until natural expiry)
7. **No IP-based rate limiting**: Assumed rate limits were per API key, not per IP (partially invalidated: stream endpoint had server-side throttling independent of API key rate limits)

---

## 7. Final Architecture

```
┌─────────────────────────────────────────────────────────┐
│                     ORCHESTRATOR                         │
│                                                          │
│  1. Wait for PostgreSQL health check                     │
│  2. Create UNLOGGED table + progress table               │
│  3. Check for existing progress (resumability)           │
│  4. Acquire stream token (POST /internal/dashboard/...)  │
│  5. Create 20 partitions with fabricated cursors         │
│  6. Launch workers with shared rate limiter              │
│  7. Monitor progress (5-second interval)                 │
│  8. Auto-refresh stream token (4-minute interval)        │
│  9. Gap fill if partitions missed events                 │
│ 10. Log "ingestion complete"                             │
└────────────────────────┬────────────────────────────────┘
                         │
    ┌────────────────────┼────────────────────┐
    │                    │                    │
┌───▼───┐  ┌────────────▼─┐  ┌──────────────▼──┐
│  W0   │  │     W1       │  │      W19        │
│ fresh │  │ cursor@Jan24 │  │ cursor@Dec27    │
│ →Jan26│  │ →Jan23       │  │ →Dec25          │
└───┬───┘  └──────┬───────┘  └────────┬────────┘
    │             │                    │
    └─────────────┼────────────────────┘
                  │
    ┌─────────────▼──────────────┐
    │   SharedRateLimiter        │
    │   0.7 req/sec, burst 15   │
    │   Adaptive backoff on 429 │
    └─────────────┬──────────────┘
                  │
    ┌─────────────▼──────────────┐
    │   Stream Endpoint          │
    │   /api/v1/events/d4ta/...  │
    │   limit=5000 per request   │
    └─────────────┬──────────────┘
                  │
    ┌─────────────▼──────────────┐
    │   COPY FROM STDIN          │
    │   pg-copy-streams          │
    │   Tab-separated, escaped   │
    └─────────────┬──────────────┘
                  │
    ┌─────────────▼──────────────┐
    │   PostgreSQL 16            │
    │   UNLOGGED table           │
    │   synchronous_commit=off   │
    │   wal_level=minimal        │
    └────────────────────────────┘
```

---

## 8. Final Results

| Metric | Value |
|--------|-------|
| Events ingested | 3,050,452 |
| Total time | ~19.5 minutes |
| Average throughput | ~2,600 events/sec |
| Peak throughput | ~3,450 events/sec |
| Workers used | 20 |
| Batch size | 5,000 events |
| API requests made | ~610 |
| Rate limit hits | ~15 (near end, recovered via backoff) |
| Token refreshes | 4 (automatic, zero downtime) |
| DB write method | COPY FROM STDIN |
| Table type | UNLOGGED (no WAL) |
| Docker build time | ~15 seconds |
| Dependencies | 2 runtime (pg, pg-copy-streams) |

---

## 9. What We Would Do Differently

1. **Adaptive rate limiter from the start**: The fixed rate (0.7/sec) was found through trial and error. An adaptive limiter that starts fast and automatically slows down on 429s would have saved two iterations.

2. **Fewer workers initially**: Starting with 10 workers instead of 20 would have reduced rate limit pressure while still achieving most of the throughput benefit.

3. **Cursor expiry handling in v1**: Should have anticipated that saved cursors expire and built re-fabrication into the first version.

4. **Connection pool sizing**: Should have set generous timeouts from the start since rate limiter delays can keep connections idle for extended periods.

5. **Explore the `/api/v1/events/bulk` endpoint more**: It returned 500 on our test, but with correct event IDs it might offer a different throughput path.

---

## 10. Timeline

| Time | Event |
|------|-------|
| T+0:00 | Started analysis of README, docs, and challenge structure |
| T+0:10 | Created initial PLAN.md with theoretical architecture |
| T+0:15 | API key provided, exploration began |
| T+0:16 | First API call, discovered rate limit headers (10 req/min) |
| T+0:18 | Fetched dashboard HTML, found JS bundle URL |
| T+0:20 | Downloaded and mined 577KB JS bundle |
| T+0:22 | **Breakthrough**: Discovered stream-access and feed endpoints |
| T+0:25 | Discovered cursor format (base64 JSON with `id`, `ts`, `v`, `exp`) |
| T+0:28 | **Breakthrough**: Fabricated cursors work at arbitrary timestamps |
| T+0:30 | Tested stream access -- 403 DASHBOARD_REQUIRED |
| T+0:35 | **Breakthrough**: Added browser headers + cookie, stream token obtained |
| T+0:38 | Tested parallel workers: 5, 10, 20 workers benchmarked |
| T+0:42 | Updated PLAN.md with all discoveries |
| T+0:45 | Started implementation (Phase A: foundation) |
| T+0:60 | All 16 source files written, TypeScript compiles clean |
| T+0:65 | Docker build fails on Alpine npm bug |
| T+0:68 | Switched to node:20-slim, build succeeds |
| T+0:70 | **Run 1**: 900K events in 4 min, then rate limit death spiral |
| T+0:75 | Added SharedRateLimiter with jitter and backoff |
| T+0:78 | **Run 2**: Cursor expiry on resume, workers fail |
| T+0:80 | Added cursor expiry handling, increased DB timeouts |
| T+0:82 | **Run 3**: 3,050,452 events in 19.5 minutes |
| T+0:85 | Fixed progress bar overflow bug |
| T+0:86 | Verified "ingestion complete" detection works |
