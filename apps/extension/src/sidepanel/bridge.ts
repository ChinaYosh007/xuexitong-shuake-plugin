import { randomId } from "../shared/ids";
import { isCourseTaskPath, isWorkPagePath } from "../shared/pages";
import type { PageCommand, PageResponse } from "../shared/messages";

/** Only exact HTTPS Chaoxing origins can be requested, never the declared wildcard. */
export function sitePermissionOrigin(input: string): string | null {
  try {
    const url = new URL(input);
    if (
      url.protocol !== "https:" || url.username || url.password || url.port ||
      !/^[a-z0-9.-]+$/.test(url.hostname) ||
      (url.hostname !== "chaoxing.com" && !url.hostname.endsWith(".chaoxing.com"))
    ) {
      return null;
    }
    return `${url.origin}/*`;
  } catch {
    return null;
  }
}

export async function readPermissionSite(tabId: number): Promise<string> {
  try {
    const tab = await chrome.tabs.get(tabId);
    const origin = sitePermissionOrigin(tab.url ?? "");
    return origin ? origin.slice(0, -2) : "";
  } catch {
    return "";
  }
}

export function isCourseTaskUrl(input: string): boolean {
  try {
    const url = new URL(input);
    // 2026-10-20 用户授权（验收 §9.27）：独立作业/测验作答页也走课程调度器（刷题），
    // 不再落到“计分页面不支持”的手动提示；正式考试页仍不匹配。
    return Boolean(sitePermissionOrigin(input)) && (isCourseTaskPath(url.pathname) || isWorkPagePath(url.pathname));
  } catch { return false; }
}

/** Call directly from the click handler, before awaiting any other API. */
export function requestSitePermission(site: string): Promise<boolean> {
  const origin = sitePermissionOrigin(site);
  return origin ? chrome.permissions.request({ origins: [origin] }) : Promise.resolve(false);
}

/** True when Chrome already granted the exact course-site origin, so no request UI is needed. */
export async function isSitePermissionGranted(site: string): Promise<boolean> {
  const origin = sitePermissionOrigin(site);
  if (!origin) {
    return false;
  }
  try {
    return await chrome.permissions.contains({ origins: [origin] });
  } catch {
    return false;
  }
}

export function newRequestId(): string {
  return randomId();
}

function isPageResponse(value: unknown): value is PageResponse {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const record = value as Record<string, unknown>;
  if (record.ok === true) {
    return typeof record.kind === "string";
  }
  if (record.ok === false) {
    return typeof record.code === "string";
  }
  return false;
}

/** Side panel never injects scripts itself; the service worker performs the short-lived injection. */
export async function sendPageCommand(tabId: number, command: PageCommand): Promise<PageResponse> {
  try {
    const response: unknown = await chrome.runtime.sendMessage({
      type: "PAGE_COMMAND",
      tabId,
      frameId: 0,
      command
    });
    if (!isPageResponse(response)) {
      return { ok: false, code: "INVALID_COMMAND", detail: "扩展后台返回了非预期响应" };
    }
    return response;
  } catch {
    return { ok: false, code: "TAB_UNAVAILABLE", detail: "无法连接扩展后台或目标标签页" };
  }
}

export function readTabIdFromSearch(search: string): number | null {
  const params = new URLSearchParams(search);
  const raw = params.get("tabId");
  if (!raw) {
    return null;
  }
  const value = Number(raw);
  return Number.isInteger(value) && value > 0 ? value : null;
}

export async function resolveTargetTabId(explicitTabId: number | null): Promise<number | null> {
  if (explicitTabId !== null) {
    try {
      await chrome.tabs.get(explicitTabId);
      return explicitTabId;
    } catch {
      return null;
    }
  }
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  const active = tabs[0];
  return typeof active?.id === "number" ? active.id : null;
}
