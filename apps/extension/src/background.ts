import { asPageFailure, isTrustedExtensionPageUrl, parseExtensionCommandRequest } from "./shared/messages";
import type { PageResponse } from "./shared/messages";
import { parseAutomationCommand } from "./automation/protocol";
import type { AutomationCommand, AutomationResponse } from "./automation/protocol";
import { openDiscussionTab } from "./automation/discussion-bridge";

/**
 * MV3 service worker: opens the side panel, performs short-lived script injection and relays the
 * fixed page commands. It intentionally keeps no business state and never sends AI requests.
 * AI requests are made by the trusted side panel directly to the configured backend.
 */

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function configureStorageAccess(): Promise<void> {
  try {
    await chrome.storage.local.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" });
    await chrome.storage.session.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" });
  } catch {
    // Older Chrome builds may not expose setAccessLevel; the manifest minimum is 116.
  }
}

async function configurePanelBehavior(): Promise<void> {
  try {
    await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false });
  } catch {
    // A panel configuration failure must not prevent trusted message handling.
  }
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

async function handleBridgeMessage(message: unknown, sender: chrome.runtime.MessageSender): Promise<PageResponse> {
  if (sender.id !== chrome.runtime.id) {
    return asPageFailure("INVALID_COMMAND", "sender is not this extension");
  }
  if (!isTrustedExtensionPageUrl(sender.url, chrome.runtime.id)) {
    return asPageFailure("INVALID_COMMAND", "sender is not a trusted extension page");
  }
  const parsed = parseExtensionCommandRequest(message);
  if (!parsed.ok) {
    return asPageFailure("INVALID_COMMAND", parsed.detail);
  }
  const request = parsed.value;
  const frameId = request.frameId ?? 0;

  try {
    const tab = await chrome.tabs.get(request.tabId);
    if (typeof tab.id !== "number") {
      return asPageFailure("TAB_UNAVAILABLE", "target tab is unavailable");
    }
  } catch {
    return asPageFailure("TAB_UNAVAILABLE", "target tab no longer exists");
  }

  try {
    await chrome.scripting.executeScript({
      target: { tabId: request.tabId, frameIds: [frameId] },
      files: ["page/entry.js"],
      world: "ISOLATED"
    });
  } catch (error) {
    const detail = errorMessage(error);
    const prefix = /Cannot access contents of (?:the page|url)|manifest must request permission/i.test(detail)
      ? "permission: "
      : "";
    return asPageFailure("FRAME_ACCESS_DENIED", `${prefix}page script injection denied: ${detail}`);
  }

  try {
    const response: unknown = await chrome.tabs.sendMessage(
      request.tabId,
      { ...request.command, _meta: { tabId: request.tabId, frameId } },
      { frameId }
    );
    if (!isPageResponse(response)) {
      return asPageFailure("INVALID_COMMAND", "page script returned a malformed response");
    }
    return response;
  } catch (error) {
    return asPageFailure("DOCUMENT_CHANGED", `page script did not answer: ${errorMessage(error)}`);
  }
}

/**
 * The automation page entry is ~1.4 MB (it embeds the verified glyph table). Re-injecting it
 * on every command (INSPECT polls every 2.5s) is pure overhead, so ping the page-side listener
 * first and only inject the file when it is not installed for this document.
 */
async function ensureAutomationEntry(tabId: number): Promise<void> {
  let installed = false;
  try {
    const result: unknown = await chrome.tabs.sendMessage(tabId, { type: "AUTOMATION_PING" }, { frameId: 0 });
    installed = typeof result === "object" && result !== null && (result as Record<string, unknown>).ok === true;
  } catch {
    installed = false;
  }
  if (installed) return;
  await chrome.scripting.executeScript({
    target: { tabId, frameIds: [0] },
    files: ["page/automation-entry.js"],
    world: "ISOLATED"
  });
}

async function relayAutomationCommand(tabId: number, command: AutomationCommand): Promise<AutomationResponse> {
  return await chrome.tabs.sendMessage(tabId, { type: "AUTOMATION_PAGE", command }, { frameId: 0 }) as AutomationResponse;
}

async function handleAutomationBridge(message: Record<string, unknown>, sender: chrome.runtime.MessageSender): Promise<AutomationResponse> {
  if (sender.id !== chrome.runtime.id || sender.url?.split("?")[0] !== chrome.runtime.getURL("runner.html")) {
    return { ok: false, code: "INVALID_COMMAND", detail: "课程调度指令只接受可信运行页。" };
  }
  const command = parseAutomationCommand(message.command);
  const tabId = message.tabId;
  if (!command || typeof tabId !== "number" || !Number.isInteger(tabId) || tabId < 1) {
    return { ok: false, code: "INVALID_COMMAND", detail: "无效课程调度指令。" };
  }
  const execute = async (): Promise<AutomationResponse> => {
    let dispatched = false;
    try {
      await chrome.tabs.get(tabId);
      await ensureAutomationEntry(tabId);
      dispatched = true;
      return await relayAutomationCommand(tabId, command);
    } catch {
      // A lost response does not prove a click/write failed. Never replay a mutating action.
      if (dispatched && !["INSPECT", "READ_ONE", "READ_ALL", "CAPTURE"].includes(command.action)) {
        return { ok: false, code: "TAB_UNAVAILABLE", detail: "页面指令结果未确认；为避免重复点击或写入，未自动重试。请检查课程页面。" };
      }
      // Navigation may briefly remove the listener. Injection is idempotent; only read-only
      // commands, or commands not yet dispatched, may be sent after this single recovery.
      try {
        await chrome.scripting.executeScript({
          target: { tabId, frameIds: [0] },
          files: ["page/automation-entry.js"],
          world: "ISOLATED"
        });
        return await relayAutomationCommand(tabId, command);
      } catch {
        return { ok: false, code: "TAB_UNAVAILABLE", detail: "课程标签已关闭、正在导航或没有站点权限。请先授予课程站点读取权限。" };
      }
    }
  };
  return command.action === "OPEN_DISCUSSION" ? openDiscussionTab(tabId, command, execute) : execute();
}

chrome.runtime.onInstalled.addListener(() => {
  void configureStorageAccess();
  void configurePanelBehavior();
});
chrome.runtime.onStartup.addListener(() => {
  void configureStorageAccess();
  void configurePanelBehavior();
});
void configureStorageAccess();
void configurePanelBehavior();

// Opening the panel exclusively from action.onClicked keeps the documented activeTab
// invocation path. With setPanelBehavior(openPanelOnActionClick) Chrome may consume the
// click itself, and the "reading the page" flow then failed with
// "Cannot access contents of the page. Extension manifest must request permission".
chrome.action.onClicked.addListener((tab) => {
  if (typeof tab.windowId === "number") {
    void chrome.sidePanel.open({ windowId: tab.windowId }).catch(() => undefined);
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (typeof message === "object" && message !== null && (message as Record<string, unknown>).type === "AUTOMATION_COMMAND") {
    void handleAutomationBridge(message as Record<string, unknown>, sender).then(sendResponse, () =>
      sendResponse({ ok: false, code: "TAB_UNAVAILABLE", detail: "课程页面操作失败，请检查运行状态。" }));
    return true;
  }
  void handleBridgeMessage(message, sender).then(
    (response) => sendResponse(response),
    (error: unknown) => sendResponse(asPageFailure("TAB_UNAVAILABLE", `bridge failed: ${errorMessage(error)}`))
  );
  return true;
});
