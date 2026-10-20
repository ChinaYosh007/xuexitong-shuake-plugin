/** Error codes from architecture.md §12.3. Contract authority: docs/openapi.yaml. */
export const ERROR_CODES = [
  "VALIDATION_ERROR",
  "AUTH_REQUIRED",
  "SESSION_EXPIRED",
  "CONSENT_REQUIRED",
  "ENDPOINT_NOT_ALLOWED",
  "RESOURCE_NOT_FOUND",
  "PROFILE_NOT_VERIFIED",
  "REQUEST_IN_PROGRESS",
  "DUPLICATE_COMPLETED_NO_REPLAY",
  "REQUEST_OUTCOME_UNKNOWN",
  "IDEMPOTENCY_KEY_REUSED",
  "CONFIG_CHANGED_DURING_PROBE",
  "CONFIG_VERSION_CONFLICT",
  "PAYLOAD_TOO_LARGE",
  "PRECONDITION_REQUIRED",
  "USER_RATE_LIMITED",
  "DAILY_LIMIT_REACHED",
  "UPSTREAM_RATE_LIMITED",
  "UPSTREAM_AUTH_FAILED",
  "UPSTREAM_PROTOCOL_ERROR",
  "UPSTREAM_INVALID_OUTPUT",
  "UPSTREAM_TRUNCATED",
  "SERVICE_BUSY",
  "UPSTREAM_TIMEOUT",
  /** Generic server-side failure (HTTP 500); never exposes upstream detail. */
  "INTERNAL_ERROR"
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

/** RFC 9457 problem shape used by every non-2xx response. */
export interface ApiProblem {
  type: "about:blank";
  title: string;
  status: number;
  code: ErrorCode;
  detail: string;
  requestId: string;
  retryable: boolean;
}
