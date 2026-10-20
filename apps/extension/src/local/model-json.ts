/**
 * Recover the JSON answer written by a local model.
 *
 * Local providers talk to the user's own OpenAI-compatible endpoint, so the extension
 * receives exactly what the model wrote. Even with response_format=json_object a model
 * can wrap the object in prose or a code fence, use Chinese full-width punctuation
 * (`，` `：` `“”`), forget a closing quote, or stop mid-object when the output token
 * budget runs out.
 *
 * The repair below is purely syntactic: it never invents option ids, blank ids, answers
 * or explanations. It also reports how trustworthy the result is:
 *  - `truncated` — braces/quotes had to be closed or a broken tail dropped;
 *  - `uncertain` — a heuristic quote repair changed string boundaries;
 *  - `affectedKeys` — the object keys whose values the repair had to finish, drop or
 *    rewrite (e.g. `["textAnswer"]` for `...,"textAnswer":，` cut off at the tail).
 * The caller compares `affectedKeys` against the answer-bearing fields of the question:
 * a cut-off `explanation` is harmless once every blank/option/text answer terminated in
 * the raw text, while a cut-off `answer`/`selectedOptionIds` must never be auto-filled.
 */

export interface RecoveredJson {
  value: unknown;
  /** The raw text was not valid JSON; the returned value came from a syntactic repair. */
  repaired: boolean;
  /** The object was cut off or a broken tail was dropped; some content may be missing. */
  truncated: boolean;
  /** A heuristic repaired string boundaries; some string content may be altered. */
  uncertain: boolean;
  /** Keys whose values were finished/dropped/rewritten by the repair ("" = unknown). */
  affectedKeys: string[];
}

const ZERO_WIDTH = /[\uFEFF\u200B-\u200D\u2060]/g;
const FULL_WIDTH_QUOTES = new Set(["\u201C", "\u201D", "\uFF02"]);
const STRUCTURAL: Record<string, string> = {
  "\uFF0C": ",", // ，
  "\uFF1A": ":", // ：
  "\uFF1B": ";", // ；
  "\uFF5B": "{", // ｛
  "\uFF5D": "}", // ｝
  "\uFF3B": "[", // ［
  "\uFF3D": "]", // ］
  "\u00A0": " ", // no-break space
  "\u3000": " " // ideographic space
};
const WHITESPACE = new Set([" ", "\t", "\n", "\r", "\u00A0", "\u3000"]);
const ASCII_STRING_END = new Set([",", ":", "}", "]"]);
const TOKEN_START = /["{[\-0-9tfn\u201C\u201D\uFF02]/;
const IDENTIFIER = /[A-Za-z_$]/;
const IDENTIFIER_PART = /[A-Za-z0-9_$]/;
const LITERAL_VALUES = new Set(["true", "false", "null"]);
const NULL_LITERALS = new Set(["None", "nil", "undefined"]);
/** `"key":` (ASCII or full-width colon) directly before a position, ignoring spaces. */
const KEY_BEFORE = /"([^"]+)"\s*[:\uFF1A]\s*$/;

type ParseResult = { ok: true; value: unknown } | { ok: false };

function tryParse(text: string): ParseResult {
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch {
    return { ok: false };
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function trimEnd(text: string): string {
  let end = text.length;
  while (end > 0 && WHITESPACE.has(text[end - 1]!)) end -= 1;
  return text.slice(0, end);
}

function nextSignificantIndex(text: string, from: number): number {
  for (let index = from; index < text.length; index += 1) {
    if (!WHITESPACE.has(text[index]!)) return index;
  }
  return -1;
}

function nextSignificant(text: string, from: number): string {
  const index = nextSignificantIndex(text, from);
  return index < 0 ? "" : text[index]!;
}

function previousSignificant(text: string, from: number): string {
  for (let index = from; index >= 0; index -= 1) {
    const char = text[index]!;
    if (!WHITESPACE.has(char)) return char;
  }
  return "";
}

/** The object key a value starting at `index` belongs to ("" when it cannot be told). */
function keyBefore(text: string, index: number): string {
  const prefix = text.slice(0, index);
  const match = KEY_BEFORE.exec(prefix);
  return match ? match[1]! : "";
}

/** Object keys named inside a dropped chunk such as `,"textAnswer":，`. */
function keysInChunk(chunk: string): string[] {
  const keys: string[] = [];
  const pattern = /"([^"]+)"\s*[:\uFF1A]/g;
  let match = pattern.exec(chunk);
  while (match !== null) {
    keys.push(match[1]!);
    match = pattern.exec(chunk);
  }
  return keys;
}

function openerOf(char: string): string | null {
  const mapped = STRUCTURAL[char] ?? char;
  return mapped === "{" || mapped === "[" ? mapped : null;
}

function closerOf(char: string): string | null {
  const mapped = STRUCTURAL[char] ?? char;
  return mapped === "}" || mapped === "]" ? mapped : null;
}

/** Find every position that may start a JSON object, including full-width `｛`. */
function objectStarts(text: string): number[] {
  const starts: number[] = [];
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]!;
    if (char === "{" || char === "\uFF5B") starts.push(index);
  }
  return starts;
}

/**
 * Find the first complete JSON object starting at `start` (string aware, full-width
 * braces/brackets included). When the object never closes the rest of the text is
 * returned and flagged truncated.
 */
function extractObject(text: string, start: number): { candidate: string; truncated: boolean } {
  const stack: string[] = [];
  let inString = false;
  let quote = "\"";
  let escaped = false;
  for (let index = start; index < text.length; index += 1) {
    const char = text[index]!;
    if (inString) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (char === "\\") {
        escaped = true;
        continue;
      }
      if (char === quote || (FULL_WIDTH_QUOTES.has(quote) && (FULL_WIDTH_QUOTES.has(char) || char === "\""))) {
        inString = false;
      }
      continue;
    }
    if (char === "\"" || FULL_WIDTH_QUOTES.has(char)) {
      inString = true;
      quote = char;
      continue;
    }
    const opener = openerOf(char);
    if (opener !== null) {
      stack.push(opener);
      continue;
    }
    const closer = closerOf(char);
    if (closer !== null) {
      if (stack.length > 0) stack.pop();
      if (stack.length === 0) return { candidate: text.slice(start, index + 1), truncated: false };
    }
  }
  return { candidate: text.slice(start), truncated: true };
}

/**
 * Decide whether an ASCII/Chinese quote really ends the current string. A quote inside
 * a long explanation is content unless the next token can only follow a finished string
 * value (`,` `:` `}` `]`, end of text, or a full-width separator followed by a token).
 */
function quoteEndsString(text: string, index: number): boolean {
  const nextIndex = nextSignificantIndex(text, index + 1);
  if (nextIndex < 0) return true;
  const next = text[nextIndex]!;
  if (ASCII_STRING_END.has(next)) return true;
  if (STRUCTURAL[next] === undefined) return false;
  const afterIndex = nextSignificantIndex(text, nextIndex + 1);
  if (afterIndex < 0) return true;
  return TOKEN_START.test(text[afterIndex]!);
}

/**
 * Normalize the syntactic noise models add: full-width structural punctuation, Chinese
 * quote delimiters, unquoted object keys / enum values, Python nulls, raw newlines
 * inside strings and trailing commas. Returns the keys of strings whose boundaries the
 * quote heuristic rewrote (that content may be clipped or extended).
 */
function sanitize(text: string): { text: string; uncertainKeys: string[] } {
  let output = "";
  const uncertainKeys: string[] = [];
  let inString = false;
  let quote = "\"";
  let escaped = false;
  let stringKey = "";
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]!;
    if (inString) {
      if (escaped) {
        output += char;
        escaped = false;
        continue;
      }
      if (char === "\\") {
        output += char;
        escaped = true;
        continue;
      }
      const closes = char === "\""
        ? quote === "\"" || FULL_WIDTH_QUOTES.has(quote)
        : FULL_WIDTH_QUOTES.has(char) && FULL_WIDTH_QUOTES.has(quote);
      if (closes) {
        if (char === "\"" && !quoteEndsString(text, index)) {
          output += "\\\"";
          uncertainKeys.push(stringKey);
          continue;
        }
        output += "\"";
        inString = false;
        continue;
      }
      if (char === "\n") {
        output += "\\n";
        continue;
      }
      if (char === "\r") {
        output += "\\r";
        continue;
      }
      if (char === "\t") {
        output += "\\t";
        continue;
      }
      const codePoint = char.codePointAt(0) ?? 0;
      if (codePoint < 0x20) {
        output += "\\u" + codePoint.toString(16).padStart(4, "0");
        continue;
      }
      output += char;
      continue;
    }
    if (WHITESPACE.has(char)) {
      output += char;
      continue;
    }
    const structural = STRUCTURAL[char];
    if (structural !== undefined) {
      if (structural === ",") {
        const after = nextSignificant(text, index + 1);
        if (after === "}" || after === "]" || after === "\uFF5D" || after === "\uFF3D") continue;
      }
      output += structural;
      continue;
    }
    if (char === "\"") {
      inString = true;
      quote = "\"";
      stringKey = keyBefore(text, index);
      output += char;
      continue;
    }
    if (FULL_WIDTH_QUOTES.has(char)) {
      inString = true;
      quote = char;
      stringKey = keyBefore(text, index);
      output += "\"";
      continue;
    }
    if (char === ",") {
      const after = nextSignificant(text, index + 1);
      if (after === "}" || after === "]" || after === "\uFF5D" || after === "\uFF3D") continue;
      output += char;
      continue;
    }
    if (IDENTIFIER.test(char)) {
      let end = index + 1;
      while (end < text.length && IDENTIFIER_PART.test(text[end]!)) end += 1;
      const token = text.slice(index, end);
      const after = nextSignificant(text, end);
      const before = previousSignificant(text, index - 1);
      const isObjectKey = after === ":" || after === "\uFF1A";
      const isBareValue = (before === ":" || before === "\uFF1A") && !LITERAL_VALUES.has(token);
      if (isObjectKey) output += JSON.stringify(token);
      else if (isBareValue) output += NULL_LITERALS.has(token) ? "null" : JSON.stringify(token);
      else output += token;
      index = end - 1;
      continue;
    }
    output += char;
  }
  return { text: output, uncertainKeys };
}

/** Remove a trailing `"..."` token; used when a truncated key has no value. */
function dropLastString(text: string): string {
  const last = text.length - 1;
  if (last < 0 || text[last] !== "\"") return text;
  for (let index = last - 1; index >= 0; index -= 1) {
    if (text[index] !== "\"") continue;
    let backslashes = 0;
    for (let cursor = index - 1; cursor >= 0 && text[cursor] === "\\"; cursor -= 1) backslashes += 1;
    if (backslashes % 2 === 0) return text.slice(0, index);
  }
  return text.slice(0, last);
}

/**
 * Drop a trailing `,`, `:` or `"key":` left behind by a cut-off object, reporting the
 * keys named in everything that was removed.
 */
function dropPartialTail(text: string): { text: string; droppedKeys: string[] } {
  let output = trimEnd(text);
  const droppedKeys: string[] = [];
  for (let attempt = 0; attempt < 4; attempt += 1) {
    if (output.endsWith(",")) {
      output = trimEnd(output.slice(0, -1));
      continue;
    }
    if (output.endsWith(":")) {
      // Only the key directly in front of the dropped colon belongs to this removal;
      // scanning the whole prefix would attribute every earlier key too.
      const key = keyBefore(output, output.length);
      if (key) droppedKeys.push(key);
      const chunk = output.slice(0, -1);
      output = trimEnd(chunk);
      if (output.endsWith("\"")) {
        output = trimEnd(dropLastString(output));
      }
      if (output.endsWith(",")) output = trimEnd(output.slice(0, -1));
      continue;
    }
    break;
  }
  return { text: output, droppedKeys };
}

interface OpenFrame {
  opener: string;
  key: string;
}

/**
 * Close an unterminated string and every open object/array, dropping partial members.
 * Reports which keys the closures/drops belong to: an unterminated string attributes to
 * its owning key, an unclosed array/object to the key that owns it, and the root object
 * itself to nobody.
 */
function closeOnce(text: string): { closed: string; affectedKeys: string[] } {
  let output = "";
  const stack: OpenFrame[] = [];
  const affectedKeys: string[] = [];
  let inString = false;
  let escaped = false;
  let stringKey = "";
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]!;
    if (inString) {
      output += char;
      if (escaped) {
        escaped = false;
        continue;
      }
      if (char === "\\") {
        escaped = true;
        continue;
      }
      if (char === "\"") inString = false;
      continue;
    }
    const opener = openerOf(char);
    if (opener !== null) {
      stack.push({ opener, key: stack.length === 0 ? "" : keyBefore(text, index) });
      output += opener;
      continue;
    }
    if (closerOf(char) !== null) {
      stack.pop();
      output += char;
      continue;
    }
    if (char === "\"") {
      inString = true;
      stringKey = keyBefore(text, index);
      output += char;
      continue;
    }
    output += char;
  }
  if (inString) {
    affectedKeys.push(stringKey);
    if (output.endsWith("\\")) output += "\\";
    output += "\"";
  }
  // Every non-root frame that never closed owns content the model did not finish.
  for (let index = stack.length - 1; index >= 1; index -= 1) {
    affectedKeys.push(stack[index]!.key);
  }
  while (stack.length > 0) {
    const tail = dropPartialTail(output);
    output = tail.text;
    affectedKeys.push(...tail.droppedKeys);
    const frame = stack.pop()!;
    output += frame.opener === "{" ? "}" : "]";
  }
  return { closed: output, affectedKeys };
}

/** Index of the last comma outside a string; -1 when there is none left to cut at. */
function lastComma(text: string): number {
  let found = -1;
  let inString = false;
  let escaped = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === "\"") inString = false;
      continue;
    }
    if (char === "\"") inString = true;
    else if (char === ",") found = index;
  }
  return found;
}

interface CloseResult {
  ok: boolean;
  value?: unknown;
  /** The tail had to be cut back, so some written members were dropped. */
  cutBack: boolean;
  affectedKeys: string[];
}

/**
 * Parse a repaired candidate. When the tail is still unusable (junk tokens, a missing
 * comma, a half-written literal) cut back to the last comma and close again, bounded so
 * a hostile or heavily broken response cannot loop. Every dropped chunk reports its keys.
 */
function closeAndParse(text: string): CloseResult {
  let work = text;
  const affectedKeys: string[] = [];
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const closed = closeOnce(work);
    affectedKeys.push(...closed.affectedKeys);
    const parsed = tryParse(closed.closed);
    if (parsed.ok) return { ok: true, value: parsed.value, cutBack: attempt > 0, affectedKeys };
    const cut = lastComma(work);
    if (cut < 0) return { ok: false, cutBack: true, affectedKeys };
    // A dropped chunk with no recognisable `"key":` cannot be attributed. Treat it as an
    // unknown key ("" in the provider's conservative rule) instead of silently assuming it
    // only touched a non-answer field: the chunk after a cut-back can be a truncated answer
    // value such as `,"textAnswer":"他说","然后继续"`.
    const droppedKeys = keysInChunk(work.slice(cut));
    affectedKeys.push(...(droppedKeys.length ? droppedKeys : [""]));
    work = work.slice(0, cut);
  }
  return { ok: false, cutBack: true, affectedKeys };
}

/** A model occasionally wraps the answer object in a one-element array. */
function unwrap(value: unknown): unknown {
  return Array.isArray(value) && value.length === 1 && isRecord(value[0]) ? value[0] : value;
}

/** A model occasionally double-encodes the whole JSON object as a JSON string. */
function unwrapNestedString(value: unknown): unknown {
  if (typeof value !== "string") return value;
  const inner = value.trim();
  if (!inner.startsWith("{")) return value;
  try {
    return unwrap(JSON.parse(inner) as unknown);
  } catch {
    return value;
  }
}

function unique(keys: string[]): string[] {
  return [...new Set(keys)];
}

/** All plausible recoveries in preference order: strict JSON, then each object start. */
export function recoverModelJsonCandidates(text: string): RecoveredJson[] {
  const raw = String(text ?? "").replace(ZERO_WIDTH, "").trim();
  if (!raw) throw new Error("模型没有返回任何内容");
  const candidates: RecoveredJson[] = [];
  const seen = new Set<string>();
  const push = (candidate: RecoveredJson): void => {
    const key = JSON.stringify(candidate.value) ?? "";
    if (seen.has(key)) return;
    seen.add(key);
    candidates.push(candidate);
  };
  const strict = tryParse(raw);
  if (strict.ok) {
    push({ value: unwrapNestedString(unwrap(strict.value)), repaired: false, truncated: false, uncertain: false, affectedKeys: [] });
  }
  for (const start of objectStarts(raw).slice(0, 8)) {
    const extracted = extractObject(raw, start);
    const sanitized = sanitize(extracted.candidate);
    if (!extracted.truncated) {
      const direct = tryParse(sanitized.text);
      if (direct.ok) {
        push({
          value: unwrapNestedString(unwrap(direct.value)),
          repaired: true,
          truncated: false,
          uncertain: sanitized.uncertainKeys.length > 0,
          affectedKeys: unique(sanitized.uncertainKeys)
        });
        continue;
      }
    }
    const repaired = closeAndParse(sanitized.text);
    if (repaired.ok) {
      push({
        value: unwrapNestedString(unwrap(repaired.value)),
        repaired: true,
        truncated: extracted.truncated || repaired.cutBack,
        uncertain: sanitized.uncertainKeys.length > 0,
        affectedKeys: unique([...sanitized.uncertainKeys, ...repaired.affectedKeys])
      });
    }
  }
  if (!candidates.length) throw new Error("模型返回的内容中没有可恢复的 JSON 对象");
  return candidates;
}

/**
 * Recover the answer object from the raw model text (first/best candidate).
 * @throws Error when the text contains no recoverable JSON object.
 */
export function recoverModelJson(text: string): RecoveredJson {
  return recoverModelJsonCandidates(text)[0]!;
}
