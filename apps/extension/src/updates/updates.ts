export interface UpdateSettings { channel: "browser" | "zip"; feedUrl: string }
export interface ReleaseInfo { version: string; zipUrl: string; notes: string; sha256: string }
export const DEFAULT_UPDATE_FEED = "https://raw.githubusercontent.com/ChinaYosh007/xuexitong-shuake-plugin/main/updates/update.json";
const SETTINGS_KEY = "studyAssistantUpdates";
export function updateUrl(value: string, base?: string): URL {
  const url = new URL(value, base);
  const local = ["localhost", "127.0.0.1"].includes(url.hostname);
  if ((url.protocol !== "https:" && !(url.protocol === "http:" && local)) || url.username || url.password) {
    throw new Error("更新地址须为 HTTPS，或本机 HTTP，且不能包含账号密码。");
  }
  return url;
}
function parts(version: string): number[] {
  if (!/^\d+(?:\.\d+){0,3}$/.test(version)) throw new Error("更新版本号格式无效。");
  const result = version.split(".").map(Number);
  if (result.some(part => part > 65535) || result.every(part => part === 0)) throw new Error("更新版本号超出有效范围。");
  return [...result, 0, 0, 0].slice(0, 4);
}
export function isNewerVersion(candidate: string, current: string): boolean {
  const next = parts(candidate), installed = parts(current);
  for (let index = 0; index < 4; index++) {
    if (next[index] !== installed[index]) return next[index]! > installed[index]!;
  }
  return false;
}
export async function loadUpdateSettings(): Promise<UpdateSettings> {
  const stored = (await chrome.storage.local.get(SETTINGS_KEY))[SETTINGS_KEY] as Partial<UpdateSettings> | undefined;
  const customFeed = typeof stored?.feedUrl === "string" ? stored.feedUrl.trim() : "";
  const feedUrl = customFeed || DEFAULT_UPDATE_FEED;
  // Older unpacked builds defaulted to the store despite having no store listing.
  const legacyDefault = !customFeed && !chrome.runtime.getManifest().update_url;
  return { channel: stored?.channel === "browser" && !legacyDefault ? "browser" : "zip", feedUrl };
}
export async function saveUpdateSettings(settings: UpdateSettings): Promise<void> {
  const feedUrl = settings.feedUrl.trim();
  if (settings.channel === "zip") updateUrl(feedUrl);
  await chrome.storage.local.set({ [SETTINGS_KEY]: { channel: settings.channel, feedUrl } });
}
export function parseRelease(value: unknown, feedUrl: string): ReleaseInfo {
  if (!value || typeof value !== "object") throw new Error("更新清单不是有效对象。");
  const item = value as Record<string, unknown>;
  if (typeof item.version !== "string" || typeof item.zipUrl !== "string") throw new Error("更新清单缺少 version 或 zipUrl。");
  parts(item.version);
  const zipUrl = updateUrl(item.zipUrl, feedUrl).href;
  if (!new URL(zipUrl).pathname.toLowerCase().endsWith(".zip")) throw new Error("更新包必须是 ZIP 文件。");
  if (typeof item.sha256 !== "string" || !/^[a-f0-9]{64}$/i.test(item.sha256)) throw new Error("更新清单缺少有效的 SHA-256。");
  return { version: item.version, zipUrl, sha256: item.sha256.toLowerCase(), notes: typeof item.notes === "string" ? item.notes.slice(0, 2000) : "" };
}
/** User click only: request access to this public update origin; no provider key or course data. */
export async function checkZipRelease(feedUrl: string): Promise<ReleaseInfo> {
  const url = updateUrl(feedUrl);
  if (!await chrome.permissions.request({ origins: [url.origin + "/*"] })) throw new Error("未授权读取更新清单。");
  const controller = new AbortController(), timeout = setTimeout(() => controller.abort(), 10000);
  try {
    const response = await fetch(url.href, { signal: controller.signal, credentials: "omit", cache: "no-store", redirect: "error", referrerPolicy: "no-referrer" });
    if (!response.ok) throw new Error("读取更新失败：HTTP " + response.status);
    if (!response.body) throw new Error("更新清单为空。");
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = []; let length = 0;
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      length += result.value.byteLength;
      if (length > 16384) { await reader.cancel(); throw new Error("更新清单超过 16 KB。"); }
      chunks.push(result.value);
    }
    const bytes = new Uint8Array(length); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    return parseRelease(JSON.parse(new TextDecoder().decode(bytes)) as unknown, url.href);
  } catch (error) {
    if (controller.signal.aborted) throw new Error("检查更新超时，请稍后重试。");
    throw error;
  } finally { clearTimeout(timeout); }
}
