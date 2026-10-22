#!/usr/bin/env node
/**
 * Single build entry for the Chrome MV3 extension.
 *
 * Outputs into apps/extension/dist:
 *   manifest.json     generated from manifest.base.json with the configured backend Origin
 *   background.js     ESM service worker (esbuild)
 *   page/entry.js     dependency-free IIFE injected with chrome.scripting (esbuild)
 *   sidepanel.html    Vue 3 page (Vite)
 *   options.html      Vue 3 page (Vite)
 *
 * Usage:
 *   node scripts/build-extension.mjs
 *   node scripts/build-extension.mjs --origin https://study.example.com --mode production
 *   EXTENSION_BACKEND_ORIGIN=http://127.0.0.1:8080 node scripts/build-extension.mjs
 *
 * The placeholder Origin https://study.example.invalid from manifest.base.json must always be
 * replaced. Local builds default to http://127.0.0.1:8080; non-loopback origins require HTTPS.
 */
import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const EXTENSION_DIR = path.join(ROOT, "apps", "extension");
const DIST_DIR = path.join(EXTENSION_DIR, "dist");
const CONTRACTS_ENTRY = path.join(ROOT, "packages", "contracts", "src", "index.ts");

const ALLOWED_PERMISSIONS = ["activeTab", "scripting", "storage", "sidePanel"];
const FORBIDDEN_PERMISSIONS = [
  "cookies",
  "webRequest",
  "debugger",
  "unlimitedStorage",
  "tabs",
  "history",
  "downloads",
  "clipboardRead",
  "clipboardWrite",
  "management",
  "nativeMessaging",
  "proxy",
  "offscreen",
  "identity"
];
const PLACEHOLDER_ORIGIN = "https://study.example.invalid";
const EXPECTED_OUTPUTS = ["background.js", "page/entry.js", "page/automation-entry.js", "sidepanel.html", "options.html", "runner.html"];

function parseArgs(argv) {
  const options = { origin: process.env.EXTENSION_BACKEND_ORIGIN ?? "", mode: "local" };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--origin" || arg === "-o") {
      options.origin = argv[index + 1] ?? "";
      index += 1;
    } else if (arg.startsWith("--origin=")) {
      options.origin = arg.slice("--origin=".length);
    } else if (arg === "--mode" || arg === "-m") {
      options.mode = argv[index + 1] ?? "local";
      index += 1;
    } else if (arg.startsWith("--mode=")) {
      options.mode = arg.slice("--mode=".length);
    } else if (arg === "--help" || arg === "-h") {
      options.help = true;
    }
  }
  return options;
}

export function normalizeBackendOrigin(rawOrigin, mode = "local") {
  const candidate = rawOrigin || "http://127.0.0.1:8080";
  let url;
  try {
    url = new URL(candidate);
  } catch {
    throw new Error(`Invalid backend Origin: ${candidate}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Backend Origin must be http or https");
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error("Backend Origin must not contain credentials, query or fragment");
  }
  if (url.pathname !== "/" && url.pathname !== "") {
    throw new Error("Backend Origin must not contain a path");
  }
  const hostname = url.hostname.toLowerCase();
  if (hostname.endsWith(".invalid")) {
    throw new Error("Replace the study.example.invalid placeholder with the real backend Origin");
  }
  const loopback =
    hostname === "127.0.0.1" || hostname === "localhost" || hostname === "::1" || hostname === "[::1]";
  if (url.protocol === "http:" && !loopback) {
    throw new Error("Non-loopback backend Origins must use HTTPS");
  }
  if (mode === "production") {
    if (loopback) {
      throw new Error("Production builds must not use a loopback backend Origin");
    }
    if (url.protocol !== "https:") {
      throw new Error("Production builds require an HTTPS backend Origin");
    }
  } else if (mode !== "local") {
    throw new Error(`Unsupported build mode: ${mode}`);
  }
  return url.origin;
}

export function createManifest(baseManifest, origin, version) {
  const manifest = JSON.parse(JSON.stringify(baseManifest));
  if (version) {
    manifest.version = version;
  }
  if (!Array.isArray(manifest.host_permissions)) {
    throw new Error("manifest.base.json must declare host_permissions");
  }
  manifest.host_permissions = [`${origin}/*`];
  const csp = manifest.content_security_policy?.extension_pages;
  if (typeof csp !== "string") {
    throw new Error("manifest.base.json must declare content_security_policy.extension_pages");
  }
  manifest.content_security_policy.extension_pages = csp.split(PLACEHOLDER_ORIGIN).join(origin);
  assertManifest(manifest, origin);
  return manifest;
}

export function assertManifest(manifest, origin) {
  const permissions = manifest.permissions;
  if (!Array.isArray(permissions)) {
    throw new Error("manifest must declare permissions");
  }
  const sorted = [...permissions].sort();
  const expected = [...ALLOWED_PERMISSIONS].sort();
  if (JSON.stringify(sorted) !== JSON.stringify(expected)) {
    throw new Error(`permissions must be exactly ${ALLOWED_PERMISSIONS.join(", ")}`);
  }
  for (const forbidden of FORBIDDEN_PERMISSIONS) {
    if (permissions.includes(forbidden)) {
      throw new Error(`forbidden permission requested: ${forbidden}`);
    }
  }
  const expectedOptional = ["https://*/*", "http://127.0.0.1/*", "http://localhost/*"];
  if (JSON.stringify(manifest.optional_host_permissions) !== JSON.stringify(expectedOptional)) {
    throw new Error("optional_host_permissions must be the user-granted provider origins: " + expectedOptional.join(", "));
  }
  if (manifest.optional_permissions !== undefined) {
    throw new Error("additional optional_permissions are not allowed");
  }
  if (
    !Array.isArray(manifest.host_permissions) ||
    manifest.host_permissions.length !== 1 ||
    manifest.host_permissions[0] !== `${origin}/*`
  ) {
    throw new Error("host_permissions must contain exactly the configured backend Origin");
  }
  const csp = manifest.content_security_policy?.extension_pages ?? "";
  if (!csp.includes("script-src 'self'") || !csp.includes("connect-src https:")
      || !csp.includes("http://127.0.0.1:*") || !csp.includes("http://localhost:*")) {
    throw new Error("extension_pages CSP must allow self scripts and user-granted provider origins only");
  }
  if (manifest.externally_connectable) {
    throw new Error("externally_connectable is not allowed");
  }
  if (manifest.background?.service_worker !== "background.js" || manifest.background?.type !== "module") {
    throw new Error("background must be the ESM background.js service worker");
  }
  if (manifest.side_panel?.default_path !== "sidepanel.html") {
    throw new Error("side_panel.default_path must be sidepanel.html");
  }
  if (manifest.options_page !== "options.html") {
    throw new Error("options_page must be options.html");
  }
  const serialized = JSON.stringify(manifest);
  for (const token of ["<all_urls>", "connectsig", "unlimitedStorage", "cookies", "webRequest", "debugger", "study.example.invalid"]) {
    if (serialized.includes(token)) {
      throw new Error(`generated manifest must not contain ${token}`);
    }
  }
}

const FORBIDDEN_OUTPUT_TOKENS = [
  "requestSubmit",
  ".submit(",
  "innerHTML",
  "execCommand",
  "chrome.cookies",
  "webRequest",
  "debugger",
  "unlimitedStorage",
  "<all_urls>",
  "localStorage",
  "sessionStorage",
  "document.cookie",
  "externally_connectable"
];

async function assertOutputs() {
  for (const relative of ["manifest.json", ...EXPECTED_OUTPUTS]) {
    const absolute = path.join(DIST_DIR, relative);
    const info = await stat(absolute);
    if (!info.isFile() || info.size === 0) {
      throw new Error(`missing build output: ${relative}`);
    }
  }
  const manifest = JSON.parse(await readFile(path.join(DIST_DIR, "manifest.json"), "utf8"));
  const backgroundSource = await readFile(path.join(DIST_DIR, "background.js"), "utf8");
  const pageEntrySource = await readFile(path.join(DIST_DIR, "page", "entry.js"), "utf8");
  const automationEntrySource = await readFile(path.join(DIST_DIR, "page", "automation-entry.js"), "utf8");
  if (!pageEntrySource.trimStart().startsWith('"use strict";') && !pageEntrySource.trimStart().startsWith("(() =>")) {
    throw new Error("page/entry.js must be a self-contained IIFE");
  }
  if (/^\s*(import|export)\s/m.test(pageEntrySource)) {
    throw new Error("page/entry.js must not contain ESM imports or exports");
  }
  if (pageEntrySource.includes("chrome.storage") || pageEntrySource.includes("accessToken")) {
    throw new Error("the isolated page entry must not access storage or tokens");
  }
  for (const [name, source] of [
    ["background.js", backgroundSource],
    ["page/entry.js", pageEntrySource],
    ["page/automation-entry.js", automationEntrySource]
  ]) {
    for (const token of FORBIDDEN_OUTPUT_TOKENS) {
      if (source.includes(token)) {
        throw new Error(`${name} contains forbidden token ${token}`);
      }
    }
  }
  return manifest;
}

const SOUNDS_SRC_DIR = path.join(EXTENSION_DIR, "sounds");
const SOUND_EXTENSIONS = [".mp3", ".wav", ".ogg"];

/**
 * 0.2.8 §7 E6: copy the user/developer alarm sounds from apps/extension/sounds into dist/sounds so
 * the extension page can play `chrome.runtime.getURL("sounds/error.mp3")`. Missing/empty is fine —
 * the code falls back to the built-in synthetic beep — so this never throws.
 */
async function copySoundAssets() {
  const copied = [];
  let entries;
  try {
    entries = await readdir(SOUNDS_SRC_DIR, { withFileTypes: true });
  } catch {
    return copied;
  }
  const sounds = entries.filter(entry => entry.isFile() && SOUND_EXTENSIONS.includes(path.extname(entry.name).toLowerCase()));
  if (sounds.length === 0) return copied;
  await mkdir(path.join(DIST_DIR, "sounds"), { recursive: true });
  for (const entry of sounds) {
    const data = await readFile(path.join(SOUNDS_SRC_DIR, entry.name));
    if (data.length === 0) continue;
    await writeFile(path.join(DIST_DIR, "sounds", entry.name), data);
    copied.push({ file: `sounds/${entry.name}`, bytes: data.length });
  }
  return copied;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log("Usage: node scripts/build-extension.mjs [--origin <url>] [--mode local|production]");
    return;
  }
  const origin = normalizeBackendOrigin(options.origin, options.mode);
  const packageJson = JSON.parse(await readFile(path.join(EXTENSION_DIR, "package.json"), "utf8"));
  const baseManifest = JSON.parse(await readFile(path.join(EXTENSION_DIR, "manifest.base.json"), "utf8"));
  const manifest = createManifest(baseManifest, origin, packageJson.version);

  await rm(DIST_DIR, { recursive: true, force: true });
  await mkdir(path.join(DIST_DIR, "page"), { recursive: true });

  const { build: viteBuild } = await import("vite");
  const vuePlugin = (await import("@vitejs/plugin-vue")).default;
  await viteBuild({
    configFile: false,
    root: EXTENSION_DIR,
    base: "./",
    publicDir: false,
    logLevel: "warn",
    define: { __BUILD_BACKEND_ORIGIN__: JSON.stringify(origin) },
    plugins: [vuePlugin()],
    build: {
      outDir: DIST_DIR,
      emptyOutDir: false,
      target: "chrome116",
      sourcemap: false,
      rollupOptions: {
        input: {
          sidepanel: path.join(EXTENSION_DIR, "sidepanel.html"),
          options: path.join(EXTENSION_DIR, "options.html"),
          runner: path.join(EXTENSION_DIR, "runner.html")
        }
      }
    }
  });

  const esbuild = await import("esbuild");
  const shared = {
    bundle: true,
    target: ["chrome116"],
    sourcemap: false,
    legalComments: "none",
    logLevel: "warning",
    // Pin the working directory so the esbuild source comments (and therefore the output
    // bytes) do not change depending on where the build command was started from.
    absWorkingDir: EXTENSION_DIR,
    alias: { "@study/contracts": CONTRACTS_ENTRY },
    define: { __BUILD_BACKEND_ORIGIN__: JSON.stringify(origin) }
  };
  await esbuild.build({
    ...shared,
    entryPoints: [path.join(EXTENSION_DIR, "src", "page", "entry.ts")],
    format: "iife",
    outfile: path.join(DIST_DIR, "page", "entry.js")
  });
  await esbuild.build({
    ...shared,
    entryPoints: [path.join(EXTENSION_DIR, "src", "automation", "page-entry.ts")],
    banner: { js: "if (!window.__studyCourseAutomationV1) {" },
    footer: { js: "}" },
    format: "iife",
    outfile: path.join(DIST_DIR, "page", "automation-entry.js")
  });
  await esbuild.build({
    ...shared,
    entryPoints: [path.join(EXTENSION_DIR, "src", "background.ts")],
    format: "esm",
    outfile: path.join(DIST_DIR, "background.js")
  });

  await writeFile(path.join(DIST_DIR, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  await writeFile(path.join(DIST_DIR, "font-reference-LICENSE.txt"), await readFile(path.join(EXTENSION_DIR, "src", "automation", "data", "LICENSE.txt")));
  const copiedSounds = await copySoundAssets();
  const verifiedManifest = await assertOutputs();

  const files = [];
  for (const relative of ["manifest.json", ...EXPECTED_OUTPUTS]) {
    const info = await stat(path.join(DIST_DIR, relative));
    files.push({ file: relative, bytes: info.size });
  }
  files.push(...copiedSounds);
  console.log(
    JSON.stringify(
      {
        status: "built",
        mode: options.mode,
        backendOrigin: origin,
        outDir: path.relative(ROOT, DIST_DIR).split(path.sep).join("/"),
        permissions: verifiedManifest.permissions,
        hostPermissions: verifiedManifest.host_permissions,
        optionalHostPermissions: verifiedManifest.optional_host_permissions,
        extensionPagesCsp: verifiedManifest.content_security_policy.extension_pages,
        files
      },
      null,
      2
    )
  );
}

const invokedDirectly =
  typeof process.argv[1] === "string" &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (invokedDirectly) {
  main().catch((error) => {
    console.error(`extension build failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}