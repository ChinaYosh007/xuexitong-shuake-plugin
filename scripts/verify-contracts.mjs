#!/usr/bin/env node
/**
 * scripts/verify-contracts.mjs
 *
 * Verifies that docs/openapi.yaml (contract authority) stays in sync with:
 *   - the endpoint inventory from docs/architecture.md §12.2;
 *   - the error-code list exported by packages/contracts/src/errors.ts;
 *   - the field names declared by the TypeScript contract types.
 *
 * No third-party dependency is used. The YAML is scanned line-by-line for the
 * exact shapes required by this repository (paths / methods / ErrorCode enum /
 * components.schemas.*.properties). This is intentionally a *contract
 * consistency* check, not a full OpenAPI validator: it does not validate schema
 * references or JSON Schema semantics. Those require a YAML parser and a
 * validator, which are not introduced here (see docs/acceptance.md limitations).
 *
 * Exit code: 0 = all checks passed, 1 = missing/mismatched contract items,
 * 2 = usage error (missing files etc).
 */

import { readFileSync, readdirSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = path.resolve(HERE, "..");

/** Endpoint inventory from docs/architecture.md §12.2 (prefix /api/v1). */
export const EXPECTED_ENDPOINTS = [
  "GET /api/v1/meta",
  "POST /api/v1/auth/register",
  "POST /api/v1/auth/login",
  "DELETE /api/v1/auth/sessions/current",
  "GET /api/v1/me",
  "PUT /api/v1/me/password",
  "PUT /api/v1/me/default-provider",
  "POST /api/v1/me/export",
  "DELETE /api/v1/me",
  "GET /api/v1/provider-catalog",
  "GET /api/v1/provider-profiles",
  "POST /api/v1/provider-profiles",
  "GET /api/v1/provider-profiles/{id}",
  "PUT /api/v1/provider-profiles/{id}",
  "DELETE /api/v1/provider-profiles/{id}",
  "PUT /api/v1/provider-profiles/{id}/secret",
  "DELETE /api/v1/provider-profiles/{id}/secret",
  "GET /api/v1/provider-profiles/{id}/models",
  "POST /api/v1/provider-profiles/{id}/probe",
  "POST /api/v1/study/answers",
  "GET /api/v1/me/usage",
];

/** Values that are enums in OpenAPI but are not API error codes. */
const NON_ERROR_ENUM_VALUES = new Set([
  "CHAT_COMPLETIONS",
  "RESPONSES",
  "JSON_SCHEMA",
  "JSON_OBJECT",
  "PROMPT_JSON",
  "SYSTEM",
  "DEVELOPER",
  "MAX_TOKENS",
  "MAX_COMPLETION_TOKENS",
  "MAX_OUTPUT_TOKENS",
  "PRACTICE",
  "GRADED",
  "UNKNOWN",
  "SINGLE_CHOICE",
  "MULTIPLE_CHOICE",
  "TRUE_FALSE",
  "FILL_BLANK",
  "SHORT_ANSWER",
  "ANSWERED",
  "NEEDS_CONTEXT",
  "REFUSED",
  "PASTE",
  "SELECTION",
  "ADAPTER",
  "ACTIVE",
  "DELETING",
  "DISABLED",
  "RUNNING",
  "SUCCEEDED",
  "FAILED",
  "UNVERIFIED",
  "VERIFIED",
  "BEARER",
  "AUTOSUBMIT",
  "GET",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "HEAD",
  "OPTIONS",
  "TRACE",
  "HTTP",
  "HTTPS",
  "UTF",
  "JSON",
  "API",
  "UUID",
  "RFC",
  "ADR",
  "MVP",
  "P0",
  "P1",
  "P2",
  "P3",
  "P4",
  "P5",
  "P6",
]);

function normalizePathTemplate(value) {
  const withoutPrefix = value.startsWith("/api/v1") ? value.slice("/api/v1".length) || "/" : value;
  return withoutPrefix.replace(/\{[^}]+\}/g, "{param}").replace(/\/+$/, "") || "/";
}

function normalizeEndpoint(value) {
  const trimmed = value.trim();
  const space = trimmed.indexOf(" ");
  if (space < 0) {
    return trimmed;
  }
  const method = trimmed.slice(0, space).toUpperCase();
  const rawPath = trimmed.slice(space + 1).trim();
  const prefix = rawPath.startsWith("/api/v1") ? "/api/v1" : "";
  return method + " " + prefix + normalizePathTemplate(rawPath);
}

function stripQuotes(value) {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

/** Extract "METHOD /path" pairs from a conventional OpenAPI paths block. */
export function extractEndpoints(yamlText) {
  const lines = yamlText.split(/\r?\n/);
  const endpoints = new Set();
  const start = lines.findIndex((line) => /^paths:\s*(#.*)?$/.test(line));
  if (start < 0) {
    return { endpoints, found: false };
  }
  let currentPath = null;
  let pathsIndent = null;
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (/^\S/.test(line) && line.trim() !== "" && !line.trimStart().startsWith("#")) {
      break; // next top-level key
    }
    if (line.trim() === "" || line.trimStart().startsWith("#")) {
      continue;
    }
    const indent = line.length - line.trimStart().length;
    const pathMatch = /^\s{2}(["']?)(\/[^"':]*)(["']?):\s*(#.*)?$/.exec(line);
    if (pathMatch) {
      currentPath = pathMatch[2];
      pathsIndent = indent;
      continue;
    }
    const methodMatch = /^\s{4}(get|post|put|patch|delete|head|options):\s*(#.*)?$/i.exec(line);
    if (methodMatch && currentPath !== null && indent > (pathsIndent ?? 0)) {
      endpoints.add(normalizeEndpoint(methodMatch[1].toUpperCase() + " " + currentPath));
    }
  }
  return { endpoints, found: true };
}

/** Extract error codes from the ErrorCode schema enum (primary) or any enum (fallback). */
export function extractErrorCodes(yamlText) {
  const lines = yamlText.split(/\r?\n/);
  const schemaIndex = lines.findIndex((line) => /^\s*ErrorCode:\s*(#.*)?$/.test(line));
  const codes = new Set();
  let method = "ErrorCode-schema";

  if (schemaIndex >= 0) {
    const schemaIndent = lines[schemaIndex].length - lines[schemaIndex].trimStart().length;
    for (let index = schemaIndex + 1; index < lines.length; index += 1) {
      const line = lines[index];
      if (line.trim() === "" || line.trimStart().startsWith("#")) {
        continue;
      }
      const indent = line.length - line.trimStart().length;
      if (indent <= schemaIndent) {
        break;
      }
      const itemMatch = /^\s*-\s*["']?([A-Z][A-Z0-9_]*)["']?\s*(#.*)?$/.exec(line);
      if (itemMatch) {
        codes.add(itemMatch[1]);
      }
      const inlineEnum = /^\s*enum:\s*\[(.*)\]\s*(#.*)?$/.exec(line);
      if (inlineEnum) {
        for (const raw of inlineEnum[1].split(",")) {
          const value = stripQuotes(raw);
          if (/^[A-Z][A-Z0-9_]*$/.test(value)) {
            codes.add(value);
          }
        }
      }
    }
    if (codes.size > 0) {
      return { codes, method, found: true };
    }
    method = "ErrorCode-schema-empty-fallback";
  } else {
    method = "uppercase-enum-fallback";
  }

  // Fallback: collect uppercase enum items anywhere and remove known non-error enums.
  for (let index = 0; index < lines.length; index += 1) {
    const itemMatch = /^\s*-\s*["']?([A-Z][A-Z0-9_]*)["']?\s*(#.*)?$/.exec(lines[index]);
    if (itemMatch && !NON_ERROR_ENUM_VALUES.has(itemMatch[1])) {
      codes.add(itemMatch[1]);
    }
    const inlineEnum = /^\s*enum:\s*\[(.*)\]\s*(#.*)?$/.exec(lines[index]);
    if (inlineEnum) {
      for (const raw of inlineEnum[1].split(",")) {
        const value = stripQuotes(raw);
        if (/^[A-Z][A-Z0-9_]*$/.test(value) && !NON_ERROR_ENUM_VALUES.has(value)) {
          codes.add(value);
        }
      }
    }
  }
  return { codes, method, found: codes.size > 0 };
}

/** Extract field names that appear under any YAML "properties:" mapping. */
export function extractSchemaProperties(yamlText) {
  const lines = yamlText.split(/\r?\n/);
  const properties = new Set();
  for (let index = 0; index < lines.length; index += 1) {
    const propertiesMatch = /^(\s*)properties:\s*(#.*)?$/.exec(lines[index]);
    if (!propertiesMatch) {
      continue;
    }
    const propertiesIndent = propertiesMatch[1].length;
    const propertyIndent = propertiesIndent + 2;
    for (let inner = index + 1; inner < lines.length; inner += 1) {
      const line = lines[inner];
      if (line.trim() === "" || line.trimStart().startsWith("#")) {
        continue;
      }
      const indent = line.length - line.trimStart().length;
      if (indent <= propertiesIndent) {
        break;
      }
      if (indent !== propertyIndent) {
        continue;
      }
      const propertyMatch = /^\s*([A-Za-z_$][\w$]*)\??:\s*(#.*)?$/.exec(line);
      if (propertyMatch) {
        properties.add(propertyMatch[1]);
      }
    }
  }
  return properties;
}

/** Extract exported interfaces (with inherited fields resolved) from TS contract files. */
export function extractContractInterfaces(contractsDir) {
  const files = readdirSync(contractsDir)
    .filter((name) => name.endsWith(".ts"))
    .sort();
  const raw = new Map();
  for (const file of files) {
    const source = readFileSync(path.join(contractsDir, file), "utf8");
    const interfacePattern = /export interface\s+([A-Za-z_$][\w$]*)(?:\s+extends\s+([^{]+))?\s*\{/g;
    let match;
    while ((match = interfacePattern.exec(source)) !== null) {
      const name = match[1];
      const extendsList = (match[2] ?? "")
        .split(",")
        .map((item) => item.trim())
        .filter((item) => item.length > 0);
      const bodyStart = interfacePattern.lastIndex;
      let depth = 1;
      let index = bodyStart;
      while (index < source.length && depth > 0) {
        const character = source[index];
        if (character === "{") {
          depth += 1;
        } else if (character === "}") {
          depth -= 1;
        }
        index += 1;
      }
      const body = source.slice(bodyStart, index - 1);
      const fields = [];
      for (const line of body.split(/\r?\n/)) {
        if (line.trimStart().startsWith("*") || line.trimStart().startsWith("//")) {
          continue;
        }
        const fieldMatch = /^\s{2}([A-Za-z_$][\w$]*)\??:\s*/.exec(line);
        if (fieldMatch && !fields.includes(fieldMatch[1])) {
          fields.push(fieldMatch[1]);
        }
      }
      raw.set(name, { fields, extends: extendsList, file });
    }
  }
  const resolved = new Map();
  const resolving = new Set();
  function resolve(name) {
    if (resolved.has(name)) {
      return resolved.get(name);
    }
    const entry = raw.get(name);
    if (!entry) {
      return null;
    }
    if (resolving.has(name)) {
      return { fields: entry.fields, file: entry.file };
    }
    resolving.add(name);
    const fields = [...entry.fields];
    for (const parentName of entry.extends) {
      const parent = resolve(parentName);
      if (parent) {
        for (const field of parent.fields) {
          if (!fields.includes(field)) {
            fields.push(field);
          }
        }
      }
    }
    resolving.delete(name);
    const result = { fields, file: entry.file };
    resolved.set(name, result);
    return result;
  }
  const all = new Map();
  for (const name of raw.keys()) {
    const info = resolve(name);
    if (info && info.fields.length > 0) {
      all.set(name, info);
    }
  }
  return all;
}

export function readExpectedErrorCodes(contractsDir) {
  const errorsFile = path.join(contractsDir, "errors.ts");
  const source = readFileSync(errorsFile, "utf8");
  const arrayMatch = /export const ERROR_CODES\s*=\s*\[([\s\S]*?)\];/.exec(source);
  if (!arrayMatch) {
    throw new Error("cannot find ERROR_CODES array in packages/contracts/src/errors.ts");
  }
  const codes = new Set();
  const stringPattern = /"([A-Z][A-Z0-9_]*)"/g;
  let match;
  while ((match = stringPattern.exec(arrayMatch[1])) !== null) {
    codes.add(match[1]);
  }
  return codes;
}

/**
 * Run all contract checks.
 * @param {{rootDir?: string, openapiPath?: string, contractsDir?: string}} [options]
 */
export function runContractCheck(options = {}) {
  const rootDir = options.rootDir ?? DEFAULT_ROOT;
  const openapiPath = options.openapiPath ?? path.join(rootDir, "docs", "openapi.yaml");
  const contractsDir = options.contractsDir ?? path.join(rootDir, "packages", "contracts", "src");
  const errors = [];
  const warnings = [];
  const detail = { endpoints: null, errorCodes: null, properties: null };

  if (!existsSync(openapiPath)) {
    return {
      ok: false,
      errors: [`missing contract file: ${openapiPath}`],
      warnings,
      detail,
    };
  }
  if (!existsSync(contractsDir)) {
    return {
      ok: false,
      errors: [`missing contracts directory: ${contractsDir}`],
      warnings,
      detail,
    };
  }

  const yamlText = readFileSync(openapiPath, "utf8");

  const endpointResult = extractEndpoints(yamlText);
  if (!endpointResult.found) {
    errors.push("docs/openapi.yaml: no top-level 'paths:' block found");
  } else {
    const expected = new Set(EXPECTED_ENDPOINTS.map(normalizeEndpoint));
    const found = endpointResult.endpoints;
    const missing = [...expected].filter((endpoint) => !found.has(endpoint)).sort();
    const extra = [...found].filter((endpoint) => !expected.has(endpoint)).sort();
    detail.endpoints = { expected: expected.size, found: found.size, missing, extra };
    for (const endpoint of missing) {
      errors.push(`missing endpoint in docs/openapi.yaml: ${endpoint}`);
    }
    for (const endpoint of extra) {
      if (/\b(submit|autofill|fill|grade|progress)\b/i.test(endpoint)) {
        errors.push(`forbidden endpoint in docs/openapi.yaml: ${endpoint}`);
      } else {
        warnings.push(`endpoint not listed in architecture.md §12.2: ${endpoint}`);
      }
    }
  }

  const expectedErrorCodes = readExpectedErrorCodes(contractsDir);
  const openapiErrors = extractErrorCodes(yamlText);
  detail.errorCodes = {
    extraction: openapiErrors.method,
    expected: expectedErrorCodes.size,
    found: openapiErrors.codes.size,
    missing: [],
    extra: [],
  };
  if (!openapiErrors.found) {
    errors.push("docs/openapi.yaml: cannot locate an ErrorCode enum/list for API error codes");
  } else {
    const missing = [...expectedErrorCodes].filter((code) => !openapiErrors.codes.has(code)).sort();
    const extra = [...openapiErrors.codes].filter((code) => !expectedErrorCodes.has(code)).sort();
    detail.errorCodes.missing = missing;
    detail.errorCodes.extra = extra;
    for (const code of missing) {
      errors.push(`missing error code in docs/openapi.yaml: ${code}`);
    }
    for (const code of extra) {
      errors.push(`error code in docs/openapi.yaml not exported by packages/contracts: ${code}`);
    }
  }

  const interfaceFields = extractContractInterfaces(contractsDir);
  const openapiProperties = extractSchemaProperties(yamlText);
  detail.properties = { interfaces: interfaceFields.size, openapiProperties: openapiProperties.size, missingByInterface: {} };
  if (interfaceFields.size === 0) {
    errors.push(`no interfaces found in ${contractsDir}`);
  } else if (openapiProperties.size === 0) {
    errors.push("docs/openapi.yaml: cannot locate any 'properties:' mappings in components.schemas");
  } else {
    for (const [name, info] of [...interfaceFields.entries()].sort(([a], [b]) => a.localeCompare(b))) {
      const missing = info.fields.filter((field) => !openapiProperties.has(field));
      if (missing.length > 0) {
        detail.properties.missingByInterface[name] = missing;
        errors.push(`contract type ${name} field(s) not present in docs/openapi.yaml: ${missing.join(", ")}`);
      }
    }
  }

  return { ok: errors.length === 0, errors, warnings, detail };
}

function printReport(result) {
  console.log("contract verification: docs/openapi.yaml <-> packages/contracts");
  console.log(`  endpoints : expected=${result.detail.endpoints?.expected ?? "?"} found=${result.detail.endpoints?.found ?? "?"}`);
  console.log(`  errorCodes: expected=${result.detail.errorCodes?.expected ?? "?"} found=${result.detail.errorCodes?.found ?? "?"} (extraction=${result.detail.errorCodes?.extraction ?? "none"})`);
  console.log(`  properties: interfaces=${result.detail.properties?.interfaces ?? "?"} openapiProperties=${result.detail.properties?.openapiProperties ?? "?"}`);
  if (result.warnings.length > 0) {
    console.log("warnings:");
    for (const warning of result.warnings) {
      console.log("  ! " + warning);
    }
  }
  if (result.errors.length > 0) {
    console.log("failures:");
    for (const error of result.errors) {
      console.log("  x " + error);
    }
  }
  console.log(result.ok ? "RESULT: PASS" : `RESULT: FAIL (${result.errors.length} issue(s))`);
}

function main() {
  const args = process.argv.slice(2);
  const jsonMode = args.includes("--json");
  let result;
  try {
    result = runContractCheck();
  } catch (error) {
    console.error("contract verification crashed: " + (error instanceof Error ? error.message : String(error)));
    process.exit(2);
  }
  if (jsonMode) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    printReport(result);
    if (result.ok) {
      console.log("reminder: this check validates endpoint/error-code/field presence, not full OpenAPI schema validity.");
    }
  }
  process.exit(result.ok ? 0 : 1);
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (invokedDirectly) {
  main();
}