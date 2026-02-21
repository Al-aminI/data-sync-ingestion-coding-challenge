# DataSync Ingestion Pipeline -- Solution

**Result**: 3,050,452 events ingested in ~19.5 minutes (~2,600 events/sec average)

## How to Run

```bash
sh run-ingestion.sh
```

This builds the Docker images, starts PostgreSQL and the ingestion service, and monitors progress. The script waits for `"ingestion complete"` in the container logs.

Alternatively:

```bash
docker compose up -d --build
docker logs -f assignment-ingestion
```

## Architecture

20 parallel workers partition the 3M-event dataset by timestamp using fabricated cursors. Each worker fetches 5,000 events per request from a high-throughput stream endpoint discovered by reverse-engineering the dashboard's JavaScript bundle. Events are bulk-loaded into an UNLOGGED PostgreSQL table via the COPY protocol. A shared token-bucket rate limiter coordinates workers to avoid API throttling.

```
Orchestrator
  ├── StreamTokenManager (auto-refresh every 4 min)
  ├── CursorFactory (20 fabricated cursors across 31 days)
  ├── SharedRateLimiter (0.7 req/sec, burst 15, adaptive backoff)
  └── 20 Workers
       ├── fetch stream endpoint (limit=5000)
       ├── COPY FROM STDIN to PostgreSQL
       └── checkpoint progress for resumability
```

Key files: `packages/ingestion/src/orchestrator.ts` (main), `worker.ts` (fetch loop), `stream-token-manager.ts` (token lifecycle), `cursor-factory.ts` (partitioning), `rate-limiter.ts` (throttling), `db/writer.ts` (COPY protocol).

## API Discoveries

1. **Dashboard JS bundle** (`/assets/index-1KlV7jRD.js`) revealed undocumented endpoints including a stream access token issuer and a high-throughput feed endpoint.
2. **Stream endpoint** (`/api/v1/events/d4ta/x7k9/feed`) -- no visible rate limit headers, ~4x throughput vs standard endpoint. Requires a short-lived token obtained via `POST /internal/dashboard/stream-access` with browser-like headers.
3. **Fabricated cursors** -- cursors are base64 JSON (`{id, ts, v:2, exp}`). Setting `ts` to arbitrary timestamps enables parallel partitioned fetching across the dataset.
4. **Mixed timestamps** -- events use both Unix milliseconds (number) and ISO 8601 (string) formats. Normalized during ingestion.
5. **Rate limits**: header auth = 10 req/min, query param auth = 5 req/min. Cache HITs don't count against limits.

Full exploration details in [RESEARCH.md](RESEARCH.md). Complete technical plan in [PLAN.md](PLAN.md).

## What I Would Improve With More Time

- **Adaptive rate limiter** that learns the optimal rate from 429 responses instead of fixed 0.7 req/sec
- **Unit and integration tests** for cursor fabrication, timestamp normalization, and COPY writer
- **Prometheus metrics** for request latency, throughput, and error rates
- **Deduplication** at partition boundaries (currently ~50K overlapping events)
- **Explore `/api/v1/events/bulk`** endpoint which returned 500 but might work with valid event IDs
- **Dynamic worker scaling** -- reduce workers when rate limited, increase when clear

## AI Tools Used

This solution was built with **Cursor IDE** using **Claude** as the AI assistant. Claude helped with:
- Systematic API exploration strategy and endpoint discovery
- Reverse-engineering the dashboard JavaScript bundle for hidden endpoints
- Designing the parallel partitioning architecture with fabricated cursors
- Iterative debugging of rate limiting, cursor expiry, and connection timeout issues
- Writing all TypeScript source code and Docker configuration

---

# Original Challenge README

## Overview

Build a production-ready data ingestion system that extracts event data from the DataSync Analytics API and stores it in a PostgreSQL database.

## Requirements

Your solution must:

1. Run entirely in Docker using the provided `docker-compose.yml`
2. Work with the command: `sh run-ingestion.sh`
**Tools Policy:**
- **Allowed:** Any AI coding tools or development tools during development
- **Solution constraint:** Your final solution must run entirely in Docker without requiring external API keys or 3rd party services


If you use AI tools, please document which ones and how they helped in your solution's README.

## The Challenge

DataSync Analytics is a live application with:
- **Dashboard:** http://datasync-dev-alb-101078500.us-east-1.elb.amazonaws.com (explore the UI!)
- **API:** http://datasync-dev-alb-101078500.us-east-1.elb.amazonaws.com/api/v1

Your task is to:

1. **Connect** to the DataSync API
2. **Extract** ALL events from the system (3,000,000)
3. **Handle** the API's pagination correctly
4. **Respect** rate limits
5. **Store** data in PostgreSQL
7. **Make it resumable** (save progress, resume after failure)

### Important Notes

- The API documentation is minimal by design
- Part of this challenge is **discovering** how the API works
- Pay attention to response headers and data formats
- The API has behaviors that aren't documented
- Timestamp formats may vary across responses - normalize carefully

## Getting Started

### Prerequisites

- Docker and Docker Compose
- Node.js 20+
- npm or yarn

### Your Workspace

Use this directory as your workspace. A `docker-compose.yml` is provided with PostgreSQL for your solution.

```bash
docker compose up -d
```

This gives you:
- PostgreSQL at `localhost:5434`

### Exploring the Application

**Dashboard:** http://datasync-dev-alb-101078500.us-east-1.elb.amazonaws.com
- Browse the dashboard to understand the data model
- Curious developers explore everything...

**API Base URL:** `http://datasync-dev-alb-101078500.us-east-1.elb.amazonaws.com/api/v1`

**API Key:** You should have received a unique API key from your interviewer.

> **Important:** Your API key is valid for **3 hours from first use**. The timer starts when you make your first API call. Plan your work accordingly.

**API Documentation:** http://datasync-dev-alb-101078500.us-east-1.elb.amazonaws.com/docs/api.md

## Requirements

### Must Have

1. **TypeScript** codebase
2. **PostgreSQL** for data storage
3. **Docker Compose** for running your solution
4. **Proper error handling** and logging
5. **Rate limit handling** - respect the API limits
6. **Resumable ingestion** - if the process crashes, it should resume from where it left off

### Should Have

1. **Throughput optimization** - maximize events per second
2. **Progress tracking** - show ingestion progress
3. **Health checks** - monitor worker health

### Nice to Have

1. **Unit tests**
2. **Integration tests**
3. **Metrics/monitoring**
4. **Architecture documentation**

## Submitting Your Results

Once you've ingested all events, submit your results to verify completion.

### Step 1: Push Your Solution to GitHub

Before submitting, push your solution to a GitHub repository. This allows us to review your code and see your commit history/progress.

### Step 2: Submit via API

**POST** `http://datasync-dev-alb-101078500.us-east-1.elb.amazonaws.com/api/v1/submissions`

Submit a file containing all event IDs (one per line) along with your GitHub repo URL.

**Headers:**
- `X-API-Key`: Your API key
- `Content-Type`: `text/plain` or `application/json`

**Option 1: Plain text with query param (recommended)**
```bash
curl -X POST \
  -H "X-API-Key: YOUR_API_KEY" \
  -H "Content-Type: text/plain" \
  --data-binary @event_ids.txt \
  "http://datasync-dev-alb-101078500.us-east-1.elb.amazonaws.com/api/v1/submissions?github_repo=https://github.com/yourusername/your-repo"
```

**Option 2: JSON**
```bash
curl -X POST \
  -H "X-API-Key: YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "ids": "id1\nid2\nid3",
    "githubRepoUrl": "https://github.com/yourusername/your-repo"
  }' \
  http://datasync-dev-alb-101078500.us-east-1.elb.amazonaws.com/api/v1/submissions
```

**Response:**
```json
{
  "success": true,
  "data": {
    "submissionId": "uuid",
    "eventCount": 3000000,
    "githubRepoUrl": "https://github.com/yourusername/your-repo",
    "submittedAt": "2024-01-15T10:30:00.000Z",
    "timeToSubmit": {
      "ms": 1234567,
      "seconds": 1235,
      "minutes": 20.6,
      "formatted": "20m 35s"
    },
    "submissionNumber": 1,
    "remainingSubmissions": 4
  },
  "message": "Submission #1 received with 3,000,000 event IDs. 4 submissions remaining."
}
```

**Limits:**
- Maximum **5 submissions** per API key
- The response includes your completion time (from first API call to submission)

**Check your submissions:**
```bash
curl -H "X-API-Key: YOUR_API_KEY" \
  http://datasync-dev-alb-101078500.us-east-1.elb.amazonaws.com/api/v1/submissions
```

## Important: Verification Testing

**Your solution will be tested after submission to verify it works correctly.**

- The full ingestion must work when running `sh run-ingestion.sh` from scratch on a clean Linux machine using Docker
- We will run your solution on a fresh environment with only Docker installed
- The following do NOT count as valid solutions:
  - WIP/incomplete code that requires manual intervention
  - Solutions that require manual pauses or human interaction during execution
  - Code that needs to be modified after starting the ingestion
  - Solutions that only work after multiple manual restarts

Your solution must be fully automated and complete the entire ingestion without any manual steps.

## What to Submit

Your solution should include:

1. All source code in the `packages/` directory
2. Updated `docker-compose.yml` if needed
3. `README.md` with:
   - How to run your solution
   - Architecture overview
   - Any discoveries about the API
   - What you would improve with more time

## Evaluation Criteria

| Category | Weight |
|----------|--------|
| API Discovery & Throughput | 60% |
| Job Processing Architecture | 40% |

**Your score is primarily based on throughput** - how many events per minute can your solution ingest?

> **Challenge yourself:** Top candidates have solved this entire challenge - including ingesting all 3M events - in under 30 minutes. If you feel limited by the API, keep pushing. There's always a faster way.

## Tips

- Start by exploring the API thoroughly - this is critical
- Make requests, look at responses, **check headers carefully**
- The documented API may not be the fastest way...
- Think about failure scenarios - what happens if the process crashes mid-ingestion?
- Consider how to **maximize throughput** while respecting rate limits
- Good engineers explore every corner of an application
- Cursors have a lifecycle - don't let them get stale

## Questions?

If something is unclear about the requirements (not the API!), please reach out to your contact.

Good luck!
