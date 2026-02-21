export interface ApiEvent {
  id: string;
  sessionId: string;
  userId: string;
  type: string;
  name: string;
  properties: Record<string, unknown>;
  timestamp: number | string;
  session: {
    id: string;
    deviceType: string;
    browser: string;
  };
}

export interface ApiResponse {
  data: ApiEvent[];
  pagination: {
    limit: number;
    hasMore: boolean;
    nextCursor: string | null;
    cursorExpiresIn: number | null;
  };
  meta: {
    total: number;
    returned: number;
    requestId: string;
  };
}

export interface Partition {
  workerId: number;
  startCursor: string | null;
  boundaryTs: number;
  completed?: boolean;
  resumeCursor?: string | null;
  resumeCount?: number;
}
