import type {
  AnswerRequest,
  AnswerResponse,
  ApiProblem,
  LoginRequest,
  LoginResponse,
  MeResponse,
  ProviderProfile
} from "@study/contracts";

export interface ApiFailure {
  ok: false;
  status: number;
  code: string;
  detail: string;
  retryable: boolean;
  requestId: string | null;
}

export type ApiResult<T> = { ok: true; status: number; data: T } | ApiFailure;

export interface ApiRequestOptions {
  method?: "GET" | "POST" | "PUT" | "DELETE";
  body?: unknown;
  token?: string | null;
  idempotencyKey?: string;
  timeoutMs?: number;
}

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

export function assertBackendOrigin(origin: string): string {
  const url = new URL(origin);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("backend Origin must be http or https");
  }
  if (url.username || url.password || url.search || url.hash || (url.pathname !== "/" && url.pathname !== "")) {
    throw new Error("backend Origin must be a bare origin");
  }
  if (url.protocol === "http:" && !LOOPBACK_HOSTS.has(url.hostname.toLowerCase())) {
    throw new Error("non-loopback backend Origins must use HTTPS");
  }
  return url.origin;
}

function parseProblem(status: number, text: string, requestIdHeader: string | null): ApiFailure {
  let code = status === 401 ? "AUTH_REQUIRED" : "HTTP_ERROR";
  let detail = "请求失败";
  let retryable = false;
  let requestId = requestIdHeader;
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed === "object" && parsed !== null) {
      const record = parsed as Record<string, unknown>;
      if (typeof record.code === "string") {
        code = record.code;
      }
      if (typeof record.detail === "string" && record.detail.length > 0) {
        detail = record.detail;
      }
      retryable = record.retryable === true;
      if (typeof record.requestId === "string") {
        requestId = record.requestId;
      }
    }
  } catch {
    if (status === 413) {
      code = "PAYLOAD_TOO_LARGE";
    }
  }
  return { ok: false, status, code, detail, retryable, requestId };
}

/**
 * Requests go directly from the trusted side panel to the configured backend Origin.
 * credentials: "omit" — the extension never relies on cookies, and the backend never sets them.
 */
export async function apiRequest<T>(
  origin: string,
  path: string,
  options: ApiRequestOptions = {}
): Promise<ApiResult<T>> {
  const base = assertBackendOrigin(origin);
  const headers: Record<string, string> = { Accept: "application/json" };
  if (options.body !== undefined) {
    headers["Content-Type"] = "application/json";
  }
  if (options.token) {
    headers.Authorization = `Bearer ${options.token}`;
  }
  if (options.idempotencyKey) {
    headers["Idempotency-Key"] = options.idempotencyKey;
  }

  const controller = new AbortController();
  const timeoutMs = options.timeoutMs ?? 60_000;
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${base}${path}`, {
      method: options.method ?? "GET",
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      credentials: "omit",
      cache: "no-store",
      redirect: "error",
      referrerPolicy: "no-referrer",
      signal: controller.signal
    });
    const text = await response.text();
    if (!response.ok) {
      return parseProblem(response.status, text, response.headers.get("x-request-id"));
    }
    if (!text) {
      return { ok: true, status: response.status, data: undefined as T };
    }
    try {
      return { ok: true, status: response.status, data: JSON.parse(text) as T };
    } catch {
      return {
        ok: false,
        status: response.status,
        code: "INVALID_JSON",
        detail: "后端返回了无法解析的响应",
        retryable: false,
        requestId: response.headers.get("x-request-id")
      };
    }
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      return {
        ok: false,
        status: 0,
        code: "CLIENT_TIMEOUT",
        detail: "请求超时，结果可能未知；不会自动重试",
        retryable: false,
        requestId: null
      };
    }
    return {
      ok: false,
      status: 0,
      code: "NETWORK_ERROR",
      detail: "无法连接后端，请检查设置中的后端地址与网络",
      retryable: true,
      requestId: null
    };
  } finally {
    clearTimeout(timer);
  }
}

export function login(origin: string, username: string, password: string): Promise<ApiResult<LoginResponse>> {
  const body: LoginRequest = { username, password };
  return apiRequest<LoginResponse>(origin, "/api/v1/auth/login", { method: "POST", body });
}

export function logout(origin: string, token: string): Promise<ApiResult<void>> {
  return apiRequest<void>(origin, "/api/v1/auth/sessions/current", { method: "DELETE", token });
}

export function fetchMe(origin: string, token: string): Promise<ApiResult<MeResponse>> {
  return apiRequest<MeResponse>(origin, "/api/v1/me", { token });
}

export function fetchProviderProfiles(origin: string, token: string): Promise<ApiResult<ProviderProfile[]>> {
  return apiRequest<ProviderProfile[]>(origin, "/api/v1/provider-profiles", { token });
}

export interface AutomationLimits {
  perUserConcurrency: number;
  requestsPerMinute: number;
  requestsPerDay: number;
}

export async function fetchAutomationLimits(origin: string): Promise<ApiResult<AutomationLimits>> {
  const result = await apiRequest<{ limits?: Partial<AutomationLimits> }>(origin, "/api/v1/meta");
  if (!result.ok) return result;
  const limits = result.data?.limits;
  if (!limits || ![limits.perUserConcurrency, limits.requestsPerMinute, limits.requestsPerDay]
    .every(value => typeof value === "number" && Number.isSafeInteger(value) && value >= 0)) {
    return { ok: false, status: 200, code: "INVALID_LIMITS", detail: "后端没有返回有效调度限额。", retryable: false, requestId: null };
  }
  return { ok: true, status: 200, data: limits as AutomationLimits };
}

export function setDefaultProvider(
  origin: string,
  token: string,
  profileId: string | null
): Promise<ApiResult<MeResponse>> {
  return apiRequest<MeResponse>(origin, "/api/v1/me/default-provider", {
    method: "PUT",
    token,
    body: { profileId }
  });
}

export function generateAnswer(
  origin: string,
  token: string,
  request: AnswerRequest,
  idempotencyKey: string
): Promise<ApiResult<AnswerResponse>> {
  return apiRequest<AnswerResponse>(origin, "/api/v1/study/answers", {
    method: "POST",
    token,
    body: request,
    idempotencyKey,
    timeoutMs: 65_000
  });
}

/** Only the intentionally public problem shape is surfaced; upstream bodies are never logged or displayed. */
export function describeProblem(failure: ApiFailure): string {
  if (failure.requestId) {
    return `${failure.detail}（${failure.code}，requestId=${failure.requestId}）`;
  }
  return `${failure.detail}（${failure.code}）`;
}

export type { ApiProblem };