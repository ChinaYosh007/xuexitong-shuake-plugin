import { describe, expect, it } from "vitest";
import baseManifest from "../manifest.base.json";

interface BuildModule {
  normalizeBackendOrigin(raw: string | undefined, mode?: string): string;
  createManifest(base: unknown, origin: string, version?: string): Record<string, unknown>;
  assertManifest(manifest: Record<string, unknown>, origin: string): void;
}

async function loadBuildModule(): Promise<BuildModule> {
  // @ts-expect-error the build script is plain ESM without type declarations
  return (await import("../../../scripts/build-extension.mjs")) as BuildModule;
}

describe("extension manifest generation", () => {
  it("injects the configured backend origin and only the four allowed permissions", async () => {
    const module = await loadBuildModule();
    const origin = module.normalizeBackendOrigin(undefined, "local");
    expect(origin).toBe("http://127.0.0.1:8080");
    const manifest = module.createManifest(baseManifest, origin, "0.1.0");
    expect(manifest.permissions).toEqual(["activeTab", "scripting", "storage", "sidePanel"]);
    expect(manifest.host_permissions).toEqual([`${origin}/*`]);
    expect(manifest.optional_host_permissions).toEqual(["https://*/*", "http://127.0.0.1/*", "http://localhost/*"]);
    expect(manifest.optional_permissions).toBeUndefined();
    expect(JSON.stringify(manifest)).not.toContain("study.example.invalid");
    expect(manifest.externally_connectable).toBeUndefined();
    const csp = (manifest.content_security_policy as { extension_pages: string }).extension_pages;
    expect(csp).toContain("script-src 'self'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("connect-src https:");
    expect(csp).toContain("http://127.0.0.1:*");
    expect(csp).toContain("http://localhost:*");
    expect(csp).not.toContain("unsafe-eval");
    expect(csp).not.toContain("unsafe-inline");
  });

  it("rejects placeholder, plain-http remote and path-bearing origins", async () => {
    const module = await loadBuildModule();
    expect(() => module.normalizeBackendOrigin("https://study.example.invalid", "local")).toThrow(/placeholder/i);
    expect(() => module.normalizeBackendOrigin("http://example.com:8080", "local")).toThrow(/HTTPS/i);
    expect(() => module.normalizeBackendOrigin("https://study.example.com/api", "local")).toThrow(/path/i);
    expect(() => module.normalizeBackendOrigin("http://127.0.0.1:8080", "production")).toThrow(/loopback/i);
    expect(module.normalizeBackendOrigin("https://study.example.com", "production")).toBe(
      "https://study.example.com"
    );
  });

  it("rejects a tampered manifest", async () => {
    const module = await loadBuildModule();
    const origin = "http://127.0.0.1:8080";
    const manifest = module.createManifest(baseManifest, origin, "0.1.0");
    expect(() =>
      module.assertManifest({ ...manifest, permissions: [...(manifest.permissions as string[]), "cookies"] }, origin)
    ).toThrow(/permissions/i);
    expect(() =>
      module.assertManifest({ ...manifest, host_permissions: ["<all_urls>"] }, origin)
    ).toThrow(/host_permissions/i);
    expect(() =>
      module.assertManifest({ ...manifest, externally_connectable: { matches: ["*"] } }, origin)
    ).toThrow(/externally_connectable/i);
    for (const origins of [undefined, ["<all_urls>"], ["https://*/*"], ["https://*.chaoxing.com/*", "https://example.com/*"]]) {
      expect(() => module.assertManifest({ ...manifest, optional_host_permissions: origins }, origin)).toThrow(/optional_host_permissions/i);
    }
    expect(() => module.assertManifest({ ...manifest, optional_permissions: ["tabs"] }, origin)).toThrow(/optional_permissions/i);
  });
});