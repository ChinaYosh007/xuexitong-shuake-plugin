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

const RUNNER_PREFS_KEY = "runnerPreferences";
/** 运行偏好（0.2.8 M1）：视频拖动/资料滚动开关、声音开关与音量、按课程缓存的可拖性。只存本机，不含令牌或题文。 */
export interface RunnerPreferences {
  allowVideoSeek: boolean;
  allowMaterialScroll: boolean;
  soundEnabled: boolean;
  alarmVolume: number;
  videoSeekPolicies: Record<string, "allowed" | "denied" | "unknown">;
}

export async function loadRunnerPreferences(): Promise<RunnerPreferences> {
  await ensureTrustedStorageAccess();
  const stored = await chrome.storage.local.get(RUNNER_PREFS_KEY);
  const value = stored[RUNNER_PREFS_KEY] as Partial<RunnerPreferences> | undefined;
  return {
    allowVideoSeek: typeof value?.allowVideoSeek === "boolean" ? value.allowVideoSeek : true,
    allowMaterialScroll: typeof value?.allowMaterialScroll === "boolean" ? value.allowMaterialScroll : true,
    soundEnabled: typeof value?.soundEnabled === "boolean" ? value.soundEnabled : true,
    alarmVolume: typeof value?.alarmVolume === "number" && Number.isFinite(value.alarmVolume)
      ? Math.min(1, Math.max(0, value.alarmVolume)) : 0.7,
    videoSeekPolicies: value?.videoSeekPolicies && typeof value.videoSeekPolicies === "object" ? value.videoSeekPolicies : {}
  };
}

export async function saveRunnerPreferences(prefs: RunnerPreferences): Promise<void> {
  await ensureTrustedStorageAccess();
  await chrome.storage.local.set({ [RUNNER_PREFS_KEY]: prefs });
}
