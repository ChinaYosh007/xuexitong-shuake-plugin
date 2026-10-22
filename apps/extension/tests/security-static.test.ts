import { describe, expect, it } from "vitest";

const sources = import.meta.glob("../src/**/*.{ts,vue}", {
  query: "?raw",
  import: "default",
  eager: true
}) as Record<string, string>;

function relativeKey(path: string): string {
  return path.replace(/^.*?src\//, "");
}

function filesMatching(pattern: RegExp): string[] {
  return Object.entries(sources)
    .filter(([, text]) => pattern.test(text))
    .map(([path]) => relativeKey(path));
}

function sourceOf(relative: string): string {
  const entry = Object.entries(sources).find(([path]) => relativeKey(path) === relative);
  return entry?.[1] ?? "";
}

describe("source coverage", () => {
  it("scans the real extension source tree", () => {
    expect(Object.keys(sources).length).toBeGreaterThan(25);
    expect(sourceOf("background.ts")).not.toBe("");
    expect(sourceOf("shared/messages.ts")).not.toBe("");
    expect(sourceOf("page/entry.ts")).not.toBe("");
  });
});

describe("forbidden browser automation and submission APIs", () => {
  const forbidden = [
    { name: "form.submit", pattern: /form\s*\.\s*submit/i },
    { name: "requestSubmit", pattern: /requestSubmit/i },
    { name: "submit() call", pattern: /\.submit\s*\(/ },
    { name: "innerHTML", pattern: /innerHTML/ },
    { name: "execCommand", pattern: /execCommand/ },
    { name: "v-html", pattern: /v-html/ },
    { name: "fake isTrusted assignment", pattern: /isTrusted\s*[:=]\s*(true|false)/ },
    { name: "keyboard event synthesis", pattern: /new\s+KeyboardEvent/ },
    { name: "paste event synthesis", pattern: /new\s+(ClipboardEvent|Event)\s*\(\s*["']paste/ },
    { name: "eval", pattern: /\beval\s*\(/ },
    { name: "new Function", pattern: /new\s+Function/ },
    { name: "document.cookie", pattern: /document\.cookie/ },
    { name: "localStorage", pattern: /localStorage/ },
    { name: "sessionStorage", pattern: /sessionStorage/ },
    { name: "chrome.cookies", pattern: /chrome\.cookies/ },
    { name: "webRequest", pattern: /webRequest/ },
    { name: "debugger", pattern: /debugger/ },
    { name: "all_urls", pattern: /<all_urls>/ },
    { name: "unlimitedStorage", pattern: /unlimitedStorage/ },
    { name: "externally_connectable", pattern: /externally_connectable/ },
    { name: "window.postMessage", pattern: /postMessage/ },
    { name: "page-wide innerText", pattern: /innerText/ }
  ];

  for (const item of forbidden) {
    it(`does not contain ${item.name}`, () => {
      expect(filesMatching(item.pattern)).toEqual([]);
    });
  }
});

describe("clipboard boundary", () => {
  it("uses the clipboard only in trusted extension pages (user-triggered copy-out), never in page scripts", () => {
    const hits = filesMatching(/clipboard/i);
    expect(hits.length).toBeGreaterThan(0);
    for (const path of hits) {
      expect(path.startsWith("sidepanel/") || path.startsWith("automation/")).toBe(true);
    }
  });
});

describe("fixed page command surface", () => {
  it("declares exactly the four allowed page commands and no generic bridge", () => {
    const messages = sourceOf("shared/messages.ts");
    expect(messages).toContain("CAPTURE_SELECTION");
    expect(messages).toContain("CAPTURE_QUESTION");
    expect(messages).toContain("REVALIDATE_FILL");
    expect(messages).toContain("APPLY_FILL");
    expect(messages).toContain("PAGE_COMMAND_TYPES");
    expect(messages).not.toContain("FETCH_URL");
    expect(messages).not.toContain("EXECUTE_SCRIPT");
    expect(messages).not.toContain("CALL_API");
  });

  it("injects only the fixed page entry file", () => {
    const background = sourceOf("background.ts");
    expect(background).toContain('files: ["page/entry.js"]');
    expect(background).not.toContain("func:");
  });
});

describe("token and storage boundaries", () => {
  it("keeps all storage access in the trusted-context modules only", () => {
    const storageFiles = filesMatching(/chrome\.storage\.(local|session)\.(set|get|remove)\(/);
    expect(storageFiles.sort()).toEqual(["api/session.ts", "api/settings.ts", "local/provider.ts", "updates/updates.ts"]);
    const background = sourceOf("background.ts");
    expect(background).toContain("chrome.storage.local.setAccessLevel");
    expect(background).toContain("chrome.storage.session.setAccessLevel");
    expect(background).toContain("TRUSTED_CONTEXTS");
  });

  it("stores the session token in storage.session and marks access as TRUSTED_CONTEXTS", () => {
    const session = sourceOf("api/session.ts");
    expect(session).toContain("chrome.storage.session.set");
    expect(session).toContain("TRUSTED_CONTEXTS");
    expect(session).not.toContain("chrome.storage.local.set(");
    const tokenStorageFiles = Object.entries(sources)
      .filter(
        ([, text]) =>
          text.includes("accessToken") && /chrome\.storage\.(local|session)\.set\(/.test(text)
      )
      .map(([path]) => relativeKey(path));
    expect(tokenStorageFiles).toEqual(["api/session.ts"]);
  });

  it("keeps the isolated page entry free of storage, token and network access", () => {
    const entry = sourceOf("page/entry.ts");
    expect(entry).not.toContain("chrome.storage");
    expect(entry).not.toContain("accessToken");
    expect(entry).not.toContain("fetch(");
  });

  it("stores only provider configuration, never captured questions or answers", () => {
    const providerModule = sourceOf("local/provider.ts");
    expect(providerModule).toContain("PROVIDERS_KEY");
    expect(providerModule).toContain("ACTIVE_KEY");
    const storageCalls = providerModule.match(/chrome\.storage\.local\.set\(/g) ?? [];
    expect(storageCalls.length).toBeGreaterThan(0);
    // The only persisted payloads are provider configuration and the active id.
    expect(providerModule).not.toMatch(/QUESTION_KEY|ANSWER_KEY|QUESTION_STORAGE/);
  });
});

describe("rendering and network boundaries", () => {
  it("renders model text through template interpolation only", () => {
    for (const [path, text] of Object.entries(sources)) {
      if (!path.endsWith(".vue")) {
        continue;
      }
      expect(text).not.toContain("v-html");
    }
  });

  it("names remote origins only in provider presets, the verified discussion route and public update feed", () => {
    const remote = Object.entries(sources).filter(([, text]) =>
      /https?:\/\/(?!127\.0\.0\.1|localhost)[a-z0-9.-]+/i.test(text)
    );
    expect(remote.map(([path]) => relativeKey(path))).toEqual(["local/provider.ts", "shared/pages.ts", "updates/updates.ts"]);
    expect(sourceOf("shared/pages.ts").match(/https?:\/\/[^"\s]+/g)).toEqual(["https://groupweb.chaoxing.com"]);
    const updateUrls = sourceOf("updates/updates.ts").match(/https?:\/\/[^"\s]+/g);
    expect(updateUrls).toEqual(["https://raw.githubusercontent.com/ChinaYosh007/xuexitong-shuake-plugin/main/updates/update.json"]);
  });

  it("only injects the fixed page entry through chrome.scripting", () => {
    const injection = Object.entries(sources)
      .filter(([, text]) => text.includes("chrome.scripting.executeScript({"))
      .map(([path]) => relativeKey(path));
    expect(injection).toEqual(["background.ts"]);
  });
});
