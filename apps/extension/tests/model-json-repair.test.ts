import { describe, expect, it } from "vitest";
import { recoverModelJson, recoverModelJsonCandidates } from "../src/local/model-json";

const STRICT = '{"status":"ANSWERED","selectedOptionIds":["opt_2"],"blankAnswers":[],"textAnswer":null,"explanation":"解析","caveats":[]}';

/** The exact malformed output reported from a real course run (truncated, full-width comma). */
const REPORTED = '{"status":"ANSWERED","selectedOptionIds":[],"blankAnswers":[{"blankId":"blank_1","answer":"Java虚拟机（JVM）"}],"textAnswer":，';

describe("model JSON recovery", () => {
  it("returns strict JSON untouched", () => {
    expect(recoverModelJson(STRICT)).toEqual({ value: JSON.parse(STRICT), repaired: false, truncated: false, uncertain: false, affectedKeys: [] });
  });

  it("recovers the reported answer but marks the cut-off object as truncated", () => {
    const recovered = recoverModelJson(REPORTED);
    expect(recovered.repaired).toBe(true);
    expect(recovered.truncated).toBe(true);
    expect(recovered.uncertain).toBe(false);
    // Only the dangling "textAnswer":， was dropped: the blank answers themselves terminated.
    expect(recovered.affectedKeys).toContain("textAnswer");
    expect(recovered.affectedKeys).not.toContain("blankAnswers");
    expect(recovered.value).toMatchObject({
      status: "ANSWERED",
      selectedOptionIds: [],
      blankAnswers: [{ blankId: "blank_1", answer: "Java虚拟机（JVM）" }]
    });
  });

  it("extracts the object from prose and a Markdown code fence", () => {
    const recovered = recoverModelJson("好的，答案如下：\n```json\n" + STRICT + "\n```\n以上。");
    expect(recovered.repaired).toBe(true);
    expect(recovered.truncated).toBe(false);
    expect(recovered.uncertain).toBe(false);
    expect(recovered.value).toMatchObject({ status: "ANSWERED", selectedOptionIds: ["opt_2"] });
  });

  it("rewrites full-width delimiters and drops a trailing comma while keeping string content intact", () => {
    const text = '{“status”：“ANSWERED”，“selectedOptionIds”：[“opt_1”]，“blankAnswers”：[]，“textAnswer”：null，“explanation”：“先看第一，二步：再选择”，“caveats”：[]，}';
    const recovered = recoverModelJson(text);
    expect(recovered.repaired).toBe(true);
    expect(recovered.truncated).toBe(false);
    expect(recovered.value).toMatchObject({
      status: "ANSWERED",
      selectedOptionIds: ["opt_1"],
      explanation: "先看第一，二步：再选择"
    });
  });

  it("quotes unquoted keys and enum values", () => {
    const recovered = recoverModelJson('{status:"ANSWERED",selectedOptionIds:["opt_1"],blankAnswers:[],textAnswer:null,explanation:"",caveats:[]}');
    expect(recovered.value).toMatchObject({ status: "ANSWERED", selectedOptionIds: ["opt_1"], textAnswer: null });
  });

  it("maps Python null spellings to JSON null", () => {
    const recovered = recoverModelJson('{"status":"ANSWERED","selectedOptionIds":[],"blankAnswers":[],"textAnswer":None,"explanation":"","caveats":[]}');
    expect((recovered.value as Record<string, unknown>).textAnswer).toBeNull();
  });

  it("escapes raw newlines inside string values", () => {
    const raw = '{"status":"ANSWERED","selectedOptionIds":["opt_1"],"blankAnswers":[],"textAnswer":null,"explanation":"第一行\n第二行","caveats":[]}';
    const recovered = recoverModelJson(raw);
    expect(recovered.value).toMatchObject({ explanation: "第一行\n第二行" });
  });

  it("keeps full-width quotes inside a normal string as content", () => {
    const recovered = recoverModelJson('{"status":"ANSWERED","selectedOptionIds":["opt_1"],"blankAnswers":[],"textAnswer":null,"explanation":"他说“你好”吗","caveats":[]}');
    expect(recovered.value).toMatchObject({ explanation: "他说“你好”吗" });
    expect(recovered.uncertain).toBe(false);
  });

  it("escapes unescaped inner quotes and flags the heuristic as uncertain", () => {
    const recovered = recoverModelJson('{"status":"ANSWERED","selectedOptionIds":["opt_1"],"blankAnswers":[],"textAnswer":null,"explanation":"他说"你好"吗","caveats":[]}');
    expect(recovered.uncertain).toBe(true);
    expect(recovered.value).toMatchObject({ explanation: '他说"你好"吗' });
  });

  it("preserves content around inner quotes that are followed by a full-width comma", () => {
    const recovered = recoverModelJson('{"status":"ANSWERED","selectedOptionIds":["opt_1"],"blankAnswers":[],"textAnswer":null,"explanation":"他说："你好"，然后继续","caveats":[]}');
    expect(recovered.uncertain).toBe(true);
    expect(recovered.value).toMatchObject({ explanation: '他说："你好"，然后继续' });
  });

  it("closes an unterminated string value and attributes it to its field", () => {
    const recovered = recoverModelJson('{"status":"ANSWERED","selectedOptionIds":["opt_1"],"blankAnswers":[],"textAnswer":null,"explanation":"正在解释');
    expect(recovered.truncated).toBe(true);
    expect(recovered.affectedKeys).toContain("explanation");
    expect(recovered.affectedKeys).not.toContain("selectedOptionIds");
    expect(recovered.value).toMatchObject({ explanation: "正在解释" });
  });

  it("attributes a truncated blank answer to the answer field", () => {
    const recovered = recoverModelJson('{"status":"ANSWERED","selectedOptionIds":[],"blankAnswers":[{"blankId":"blank_1","answer":"Java虚拟机（JV');
    expect(recovered.truncated).toBe(true);
    expect(recovered.affectedKeys).toContain("answer");
    expect(recovered.value).toMatchObject({ blankAnswers: [{ blankId: "blank_1", answer: "Java虚拟机（JV" }] });
  });

  it("attributes an unclosed option array to selectedOptionIds", () => {
    const recovered = recoverModelJson('{"status":"ANSWERED","selectedOptionIds":["opt_1",');
    expect(recovered.truncated).toBe(true);
    expect(recovered.affectedKeys).toContain("selectedOptionIds");
    expect(recovered.value).toMatchObject({ selectedOptionIds: ["opt_1"] });
  });

  it("drops a key that was cut off before its value and marks it truncated", () => {
    const recovered = recoverModelJson('{"status":"ANSWERED","selectedOptionIds":["opt_1"],"blankAnswers":[],"textAnswer":null,"expl');
    expect(recovered.truncated).toBe(true);
    expect(recovered.value).toMatchObject({ status: "ANSWERED", selectedOptionIds: ["opt_1"], textAnswer: null });
    expect((recovered.value as Record<string, unknown>).expl).toBeUndefined();
  });

  it("marks a cut-back repair as truncated so missing options are never silently accepted", () => {
    const text = '{"status":"ANSWERED","selectedOptionIds":["opt_1","opt_2"] "blankAnswers":[],"textAnswer":null,"explanation":"","caveats":[]}';
    const recovered = recoverModelJson(text);
    expect(recovered.truncated).toBe(true);
  });

  it("accepts a one-element array wrapper around the answer object", () => {
    const recovered = recoverModelJson("[" + STRICT + "]");
    expect(recovered.value).toMatchObject({ status: "ANSWERED", selectedOptionIds: ["opt_2"] });
  });

  it("unwraps a double-encoded JSON string", () => {
    const recovered = recoverModelJson(JSON.stringify(STRICT));
    expect(recovered.value).toMatchObject({ status: "ANSWERED", selectedOptionIds: ["opt_2"] });
  });

  it("recovers an object written with full-width braces including ASCII arrays", () => {
    const recovered = recoverModelJson('｛“status”：“ANSWERED”，“selectedOptionIds”：["opt_1"]，“blankAnswers”：[]，“textAnswer”：null，“explanation”：“解释”｝');
    expect(recovered.truncated).toBe(false);
    expect(recovered.value).toMatchObject({ status: "ANSWERED", selectedOptionIds: ["opt_1"], explanation: "解释" });
  });

  it("tries every object start so a leading placeholder object cannot hide the answer", () => {
    const text = '{"note":"thinking"} {"status":"ANSWERED","selectedOptionIds":["opt_2"],"blankAnswers":[],"textAnswer":null,"explanation":"","caveats":[]}';
    const candidates = recoverModelJsonCandidates(text);
    expect(candidates.length).toBeGreaterThanOrEqual(2);
    expect(candidates[1]!.value).toMatchObject({ status: "ANSWERED", selectedOptionIds: ["opt_2"] });
  });

  it("throws when the text contains no recoverable object", () => {
    expect(() => recoverModelJson("抱歉，我无法作答。")).toThrow(/没有可恢复的 JSON 对象/);
    expect(() => recoverModelJson("   ")).toThrow(/没有返回任何内容/);
  });

  it("marks a cut-back chunk that has no recognisable key as an unknown affected key", () => {
    // A stray quoted fragment after the real textAnswer value: the dropped tail cannot be
    // attributed to a known field, so it must be conservative ("" = unknown) instead of
    // looking like a harmless non-answer field.
    const text = '{"status":"ANSWERED","selectedOptionIds":[],"blankAnswers":[],"textAnswer":"他说","然后继续","explanation":"","caveats":[]}';
    const recovered = recoverModelJson(text);
    expect(recovered.truncated).toBe(true);
    expect(recovered.affectedKeys).toContain("");
  });
});
