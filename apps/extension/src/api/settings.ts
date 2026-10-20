import { BUILD_BACKEND_ORIGIN } from "../shared/buildConfig";
import { ensureTrustedStorageAccess } from "./session";

const SETTINGS_KEY = "studyAssistantSettings";
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

export interface LocalSettings {
  backendOrigin: string;
  defaultProviderProfileId: string | null;
}

export function normalizeBackendOriginInput(raw: string): { ok: true; origin: string } | { ok: false; detail: string } {
  const trimmed = raw.trim();
  if (!trimmed) {
    return { ok: false, detail: "请输入后端 Origin，例如 http://127.0.0.1:8080" };
  }
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return { ok: false, detail: "后端 Origin 不是合法 URL" };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { ok: false, detail: "后端 Origin 只允许 http 或 https" };
  }
  if (url.username || url.password || url.search || url.hash || (url.pathname !== "/" && url.pathname !== "")) {
    return { ok: false, detail: "后端 Origin 不能包含路径、查询或凭据" };
  }
  if (url.hostname.toLowerCase().endsWith(".invalid")) {
    return { ok: false, detail: "study.example.invalid 是占位域，必须替换为真实后端地址" };
  }
  if (url.protocol === "http:" && !LOOPBACK_HOSTS.has(url.hostname.toLowerCase())) {
    return { ok: false, detail: "非本机后端必须使用 HTTPS" };
  }
  return { ok: true, origin: url.origin };
}

export async function loadSettings(): Promise<LocalSettings> {
  await ensureTrustedStorageAccess();
  const stored = await chrome.storage.local.get(SETTINGS_KEY);
  const value = stored[SETTINGS_KEY] as Partial<LocalSettings> | undefined;
  const originCheck = normalizeBackendOriginInput(value?.backendOrigin ?? BUILD_BACKEND_ORIGIN);
  return {
    backendOrigin: originCheck.ok ? originCheck.origin : BUILD_BACKEND_ORIGIN,
    defaultProviderProfileId:
      typeof value?.defaultProviderProfileId === "string" ? value.defaultProviderProfileId : null
  };
}

export async function saveSettings(settings: LocalSettings): Promise<void> {
  await ensureTrustedStorageAccess();
  await chrome.storage.local.set({ [SETTINGS_KEY]: settings });
}
