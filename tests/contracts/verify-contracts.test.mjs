import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  EXPECTED_ENDPOINTS,
  extractContractInterfaces,
  extractEndpoints,
  extractErrorCodes,
  extractSchemaProperties,
  readExpectedErrorCodes,
  runContractCheck,
} from "../../scripts/verify-contracts.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const CONTRACTS_DIR = path.join(REPO_ROOT, "packages", "contracts", "src");
const ACTUAL_OPENAPI = path.join(REPO_ROOT, "docs", "openapi.yaml");

function makeRoot(openapiYaml) {
  const root = mkdtempSync(path.join(tmpdir(), "contracts-"));
  mkdirSync(path.join(root, "docs"), { recursive: true });
  writeFileSync(path.join(root, "docs", "openapi.yaml"), openapiYaml, "utf8");
  return root;
}

function buildYaml(options = {}) {
  const endpoints = options.endpoints ?? EXPECTED_ENDPOINTS;
  const extraEndpoints = options.extraEndpoints ?? [];
  const errorCodes = options.errorCodes ?? [...readExpectedErrorCodes(CONTRACTS_DIR)];
  const contractFields =
    options.propertyFields ??
    [...new Set([...extractContractInterfaces(CONTRACTS_DIR).values()].flatMap((info) => info.fields))];

  const grouped = new Map();
  for (const endpoint of [...endpoints, ...extraEndpoints]) {
    const space = endpoint.indexOf(" ");
    const method = endpoint.slice(0, space).toLowerCase();
    const endpointPath = endpoint.slice(space + 1);
    const methods = grouped.get(endpointPath) ?? [];
    methods.push(method);
    grouped.set(endpointPath, methods);
  }

  let yaml = "openapi: 3.0.3\ninfo:\n  title: synthetic contract\n  version: 1.0.0\npaths:\n";
  for (const [endpointPath, methods] of grouped) {
    yaml += `  ${endpointPath}:\n`;
    for (const method of methods) {
      yaml += `    ${method}:\n      summary: synthetic\n      responses:\n        '200':\n          description: ok\n`;
    }
  }
  yaml += "components:\n  schemas:\n    ErrorCode:\n      type: string\n      enum:\n";
  for (const code of errorCodes) {
    yaml += `        - ${code}\n`;
  }
  yaml += "    ContractFields:\n      type: object\n      properties:\n";
  for (const field of contractFields) {
    yaml += `        ${field}:\n          type: string\n`;
  }
  return yaml;
}

test("expected endpoint inventory matches architecture.md §12.2", () => {
  const architecture = readFileSync(path.join(REPO_ROOT, "docs", "architecture.md"), "utf8");
  const section = architecture.split("### 12.2 端点清单")[1].split("## 13 ")[0];
  const documented = [...section.matchAll(/\| `(GET|POST|PUT|DELETE|PATCH) (\/[^`]+)`/g)]
    .map(match => `${match[1]} /api/v1${match[2]}`);
  assert.ok(documented.length > 0);
  assert.deepEqual([...EXPECTED_ENDPOINTS].sort(), documented.sort());
  const unique = new Set(EXPECTED_ENDPOINTS);
  assert.equal(unique.size, EXPECTED_ENDPOINTS.length);
  for (const endpoint of EXPECTED_ENDPOINTS) {
    assert.match(endpoint, /^(GET|POST|PUT|DELETE|PATCH) \/api\/v1\//);
  }
});

test("synthetic openapi that covers endpoints, error codes and contract fields passes", () => {
  const root = makeRoot(buildYaml());
  try {
    const result = runContractCheck({ rootDir: root, contractsDir: CONTRACTS_DIR });
    assert.equal(result.ok, true, JSON.stringify(result.errors, null, 2));
    assert.equal(result.detail.endpoints.expected, EXPECTED_ENDPOINTS.length);
    assert.equal(result.detail.endpoints.found, EXPECTED_ENDPOINTS.length);
    assert.equal(result.detail.errorCodes.extraction, "ErrorCode-schema");
    assert.deepEqual(result.detail.endpoints.missing, []);
    assert.deepEqual(result.detail.errorCodes.missing, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("missing endpoint is reported as a failure", () => {
  const removed = "POST /api/v1/study/answers";
  const endpoints = EXPECTED_ENDPOINTS.filter((endpoint) => endpoint !== removed);
  const root = makeRoot(buildYaml({ endpoints }));
  try {
    const result = runContractCheck({ rootDir: root, contractsDir: CONTRACTS_DIR });
    assert.equal(result.ok, false);
    assert.ok(result.errors.some((error) => error.includes(removed)), result.errors.join("\n"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("forbidden fill/submit endpoint is rejected", () => {
  const root = makeRoot(buildYaml({ extraEndpoints: ["POST /api/v1/study/fill"] }));
  try {
    const result = runContractCheck({ rootDir: root, contractsDir: CONTRACTS_DIR });
    assert.equal(result.ok, false);
    assert.ok(result.errors.some((error) => error.includes("forbidden endpoint")), result.errors.join("\n"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("non-forbidden extra endpoint is only a warning", () => {
  const root = makeRoot(buildYaml({ extraEndpoints: ["GET /api/v1/health"] }));
  try {
    const result = runContractCheck({ rootDir: root, contractsDir: CONTRACTS_DIR });
    assert.equal(result.ok, true, result.errors.join("\n"));
    assert.ok(result.warnings.some((warning) => warning.includes("/api/v1/health")));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("missing error code in openapi is reported", () => {
  const codes = [...readExpectedErrorCodes(CONTRACTS_DIR)].filter((code) => code !== "VALIDATION_ERROR");
  const root = makeRoot(buildYaml({ errorCodes: codes }));
  try {
    const result = runContractCheck({ rootDir: root, contractsDir: CONTRACTS_DIR });
    assert.equal(result.ok, false);
    assert.ok(result.errors.some((error) => error.includes("missing error code") && error.includes("VALIDATION_ERROR")));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("error code not exported by packages/contracts is reported", () => {
  const codes = [...readExpectedErrorCodes(CONTRACTS_DIR), "MADE_UP_FAILURE"];
  const root = makeRoot(buildYaml({ errorCodes: codes }));
  try {
    const result = runContractCheck({ rootDir: root, contractsDir: CONTRACTS_DIR });
    assert.equal(result.ok, false);
    assert.ok(result.errors.some((error) => error.includes("MADE_UP_FAILURE")), result.errors.join("\n"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("missing contract property in openapi is reported per interface", () => {
  const root = makeRoot(buildYaml({ propertyFields: ["unrelatedField"] }));
  try {
    const result = runContractCheck({ rootDir: root, contractsDir: CONTRACTS_DIR });
    assert.equal(result.ok, false);
    assert.ok(Object.keys(result.detail.properties.missingByInterface).length > 0);
    assert.ok(result.errors.some((error) => error.includes("contract type")));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("missing docs/openapi.yaml is a clear failure, not a crash", () => {
  const root = mkdtempSync(path.join(tmpdir(), "contracts-missing-"));
  try {
    const result = runContractCheck({ rootDir: root, contractsDir: CONTRACTS_DIR });
    assert.equal(result.ok, false);
    assert.ok(result.errors.some((error) => error.includes("missing contract file")));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("paths/error-code/property extraction handles quoted keys and selects", () => {
  const yaml = [
    "openapi: 3.0.3",
    "paths:",
    '  "/api/v1/meta":',
    "    get:",
    "      responses: {}",
    "  /api/v1/auth/login:",
    "    post:",
    "      responses: {}",
    "components:",
    "  schemas:",
    "    ErrorCode:",
    "      enum:",
    "        - VALIDATION_ERROR",
    "        - AUTH_REQUIRED",
  ].join("\n");
  const endpoints = extractEndpoints(yaml);
  assert.equal(endpoints.found, true);
  assert.ok(endpoints.endpoints.has("GET /api/v1/meta"));
  assert.ok(endpoints.endpoints.has("POST /api/v1/auth/login"));
  const codes = extractErrorCodes(yaml);
  assert.equal(codes.found, true);
  assert.equal(codes.method, "ErrorCode-schema");
  assert.deepEqual([...codes.codes].sort(), ["AUTH_REQUIRED", "VALIDATION_ERROR"]);
  const properties = extractSchemaProperties(yaml);
  assert.equal(properties.size, 0);
});

test("actual repository contract (docs/openapi.yaml) is consistent when present", async (t) => {
  if (!existsSync(ACTUAL_OPENAPI)) {
    t.skip("docs/openapi.yaml does not exist yet (owned by backend-dev); verify-contracts.mjs exits non-zero until it lands");
    return;
  }
  const yaml = readFileSync(ACTUAL_OPENAPI, "utf8");
  assert.ok(yaml.length > 0);
  const result = runContractCheck({ rootDir: REPO_ROOT });
  assert.equal(result.ok, true, "\n" + result.errors.join("\n"));
  assert.deepEqual(result.detail.endpoints.missing, []);
  assert.deepEqual(result.detail.errorCodes.missing, []);
});
