import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { StudyQuestion } from "@study/contracts";
import { PRESETS, askLocalProvider, fetchLocalModels, loadLocalProviders, normalizeProvider } from "../src/local/provider";
import type { LocalProvider } from "../src/local/provider";

const IMAGE = "data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQ==";
const ANSWER = JSON.stringify({
  status: "ANSWERED", selectedOptionIds: ["opt_2"], blankAnswers: [], textAnswer: null,
  explanation: "解析", caveats: []
});

function question(image: string | null = IMAGE): StudyQuestion {
  return {
    id: "q_1", type: "SINGLE_CHOICE", stem: "题干与图示",
    options: [{ id: "opt_1", text: "A" }, { id: "opt_2", text: "B" }], blanks: [],
    ...(image === null ? {} : { imageDataUrl: image })
  };
}

function provider(overrides: Partial<LocalProvider> = {}): LocalProvider {
  return {
    id: "lp_1", name: "test", baseUrl: "https://api.example.com/v1", protocol: "CHAT_COMPLETIONS",
    model: "gpt-4.1", apiKey: "sk-test", instructionRole: "system", outputMode: "JSON_OBJECT",
    tokenLimitField: "max_tokens", supportsTemperature: false, supportsStoreFalse: false,
    maxOutputTokens: 2048, temperature: null, supportsImages: true, ...overrides
  };
}

const chatResponse = () => ({
  ok: true, status: 200,
  text: async () => JSON.stringify({ choices: [{ message: { content: ANSWER } }] })
});
const chatAnswer = (content: string, finishReason = "stop") => ({
  ok: true, status: 200,
  text: async () => JSON.stringify({ choices: [{ message: { content }, finish_reason: finishReason }] })
});
const responsesResponse = () => ({
  ok: true, status: 200,
  text: async () => JSON.stringify({ output: [{ content: [{ type: "output_text", text: ANSWER }] }] })
});

function fillQuestion(): StudyQuestion {
  return {
    id: "q_2", type: "FILL_BLANK", stem: "Java虚拟机的英文缩写是（ ）",
    options: [], blanks: [{ id: "blank_1", label: "第 1 空" }]
  };
}

function multiQuestion(): StudyQuestion {
  return {
    id: "q_3", type: "MULTIPLE_CHOICE", stem: "多选",
    options: [{ id: "opt_1", text: "A" }, { id: "opt_2", text: "B" }, { id: "opt_3", text: "C" }], blanks: []
  };
}

const FILL_ANSWER = JSON.stringify({
  status: "ANSWERED", selectedOptionIds: [], blankAnswers: [{ blankId: "blank_1", answer: "JVM" }],
  textAnswer: null, explanation: "JVM 是 Java 虚拟机", caveats: []
});

let request: ReturnType<typeof vi.fn>;
let storage: Record<string, unknown>;

function bodyOf(call: number): Record<string, unknown> {
  return JSON.parse(String((request.mock.calls[call]![1] as RequestInit).body)) as Record<string, unknown>;
}

beforeEach(() => {
  storage = {};
  request = vi.fn(async () => chatResponse());
  vi.stubGlobal("chrome", {
    permissions: { contains: vi.fn(async () => true) },
    storage: { local: { get: vi.fn(async (key: string) => ({ [key]: storage[key] })) } }
  });
  vi.stubGlobal("fetch", request);
});

it("sends the whole stem and an exact blank template, then retries an incomplete blank list", async () => {
  const q = { ...fillQuestion(), stem: "完整程序：String info=①; while(index < ②) { index++; }", blanks: [
    { id: "blank_1", label: "第 1 空" }, { id: "blank_2", label: "第 2 空" }
  ] };
  const answer = (complete: boolean) => JSON.stringify({ status: "ANSWERED", selectedOptionIds: [], blankAnswers: [
    { blankId: "blank_1", answer: "scan.nextLine()" }, ...(complete ? [{ blankId: "blank_2", answer: "info.length()" }] : [])
  ], textAnswer: null, explanation: "", caveats: [] });
  request.mockResolvedValueOnce(chatAnswer(answer(false))).mockResolvedValueOnce(chatAnswer(answer(true)));
  const result = await askLocalProvider(provider({ supportsImages: false }), q);
  expect(result.blankAnswers).toHaveLength(2);
  expect(request).toHaveBeenCalledTimes(2);
  const first = JSON.stringify(bodyOf(0));
  expect(first).toContain(q.stem);
  expect(first).toContain("responseTemplate");
  expect(first).toContain("blankCount");
  expect(JSON.stringify(bodyOf(1))).toContain("逐个 requiredIds 返回");
});
it("refuses an image-required retry for a text-only provider before sending any request", async () => {
  await expect(askLocalProvider(provider({ supportsImages: false }), question(), { requireImage: true })).rejects.toThrow("未降级为文字");
  expect(request).not.toHaveBeenCalled();
});
afterEach(() => vi.unstubAllGlobals());

describe("extension-local provider multimodal input", () => {
  it("maps explicit blank ordinals by ID without guessing or depending on response order", async () => {
    request.mockImplementation(async () => chatAnswer(JSON.stringify({ status: "ANSWERED", selectedOptionIds: [], textAnswer: null,
      blankAnswers: [{ blankId: "2", answer: "second" }, { blankId: "blank1", answer: "first" }], explanation: "", caveats: [] })));
    const result = await askLocalProvider(provider(), { ...fillQuestion(), blanks: [{ id: "blank_1", label: "first" }, { id: "blank_2", label: "second" }] });
    expect(result.blankAnswers).toEqual([{ blankId: "blank_2", answer: "second" }, { blankId: "blank_1", answer: "first" }]);
    expect(String((bodyOf(0).messages as Array<{ content: string }>)[1]!.content)).toContain("answerContract");
  });
  it("does not confuse 正确 with 不正确 or silently choose duplicate option text", async () => {
    request.mockImplementation(async () => chatAnswer(JSON.stringify({ status: "ANSWERED", selectedOptionIds: ["true"], blankAnswers: [], textAnswer: null, explanation: "", caveats: [] })));
    expect((await askLocalProvider(provider(), { ...question(null), type: "TRUE_FALSE", options: [{ id: "opt_1", text: "不正确" }, { id: "opt_2", text: "正确" }] })).selectedOptionIds).toEqual(["opt_2"]);
    request.mockImplementation(async () => chatAnswer(JSON.stringify({ status: "ANSWERED", selectedOptionIds: ["相同"], blankAnswers: [], textAnswer: null, explanation: "", caveats: [] })));
    await expect(askLocalProvider(provider(), { ...question(null), options: [{ id: "opt_1", text: "相同" }, { id: "opt_2", text: "相同" }] })).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
  });
  it("keeps model-list body reads within the timeout instead of clearing it after headers", async () => {
    vi.useFakeTimers();
    request.mockImplementation(async (_url: unknown, init: RequestInit) => ({ ok: true, json: () => new Promise((_resolve, reject) => {
      init.signal?.addEventListener("abort", () => reject(new Error("aborted")));
    }) }));
    const pending = fetchLocalModels(provider()).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(90000);
    expect((await pending as { code: string }).code).toBe("UPSTREAM_TIMEOUT");
    vi.useRealTimers();
  });
  it.each([
    { status: "MAYBE", selectedOptionIds: ["opt_1"], blankAnswers: [], textAnswer: null },
    { status: "ANSWERED", selectedOptionIds: ["opt_1"], blankAnswers: [{ blankId: "blank_1", answer: "other" }], textAnswer: null }
  ])("rejects invalid status or mixed answer channels instead of accepting divergent structure", async fields => {
    request.mockImplementation(async () => chatAnswer(JSON.stringify({ ...fields, explanation: "", caveats: [] })));
    await expect(askLocalProvider(provider(), question(null))).rejects.toMatchObject({ code: "UPSTREAM_INVALID_OUTPUT" });
    expect(request).toHaveBeenCalledTimes(3);
  });
  it("never converts a structured blank value into [object Object] and writes it as text", async () => {
    request.mockImplementation(async () => chatAnswer(JSON.stringify({ status: "ANSWERED", selectedOptionIds: [],
      blankAnswers: [{ blankId: "blank_1", answer: { value: "JVM", reason: "explanation" } }], textAnswer: null, explanation: "", caveats: [] })));
    await expect(askLocalProvider(provider(), fillQuestion())).rejects.toMatchObject({ code: "UPSTREAM_INVALID_OUTPUT" });
  });
  it("attaches the rendered question image to the first Chat Completions request and keeps base64 out of the text part", async () => {
    const answer = await askLocalProvider(provider(), question());
    expect(answer.status).toBe("ANSWERED");
    expect(answer.selectedOptionIds).toEqual(["opt_2"]);
    expect(request).toHaveBeenCalledTimes(1);
    expect(String(request.mock.calls[0]![0])).toBe("https://api.example.com/v1/chat/completions");
    const body = bodyOf(0);
    expect(body.model).toBe("gpt-4.1");
    const messages = body.messages as Array<Record<string, unknown>>;
    const content = messages[1]!.content as Array<Record<string, unknown>>;
    expect(Array.isArray(content)).toBe(true);
    expect(content[0]).toMatchObject({ type: "text" });
    expect(String(content[0]!.text)).toContain("题干与图示");
    expect(String(content[0]!.text)).not.toContain("data:image");
    expect(content[1]).toEqual({ type: "image_url", image_url: { url: IMAGE } });
    expect(JSON.stringify(body)).toContain(IMAGE);
  });

  it("keeps a text-only request when the question has no rendered image", async () => {
    await askLocalProvider(provider(), question(null));
    const messages = bodyOf(0).messages as Array<Record<string, unknown>>;
    expect(typeof messages[1]!.content).toBe("string");
    expect(JSON.stringify(bodyOf(0))).not.toContain("image_url");
  });

  it("attaches original-quality extra images after the composite render and drops duplicates", async () => {
    const original = "data:image/png;base64,iVBORw0KGgoAAA";
    const extra = "data:image/png;base64,iVBORw0KGgoBBB";
    const withOriginals: StudyQuestion = { ...question(), imageDataUrl: original, extraImageDataUrls: [extra, original, "not-a-data-url"] };
    await askLocalProvider(provider(), withOriginals);
    const content = (bodyOf(0).messages as Array<Record<string, unknown>>)[1]!.content as Array<Record<string, unknown>>;
    expect(content.filter(part => part.type === "image_url")).toEqual([
      { type: "image_url", image_url: { url: original } },
      { type: "image_url", image_url: { url: extra } }
    ]);
  });

  it("does not attach images when the provider is marked as text-only", async () => {
    await askLocalProvider(provider({ supportsImages: false }), question());
    const messages = bodyOf(0).messages as Array<Record<string, unknown>>;
    expect(typeof messages[1]!.content).toBe("string");
    expect(JSON.stringify(bodyOf(0))).not.toContain("data:image");
  });

  it("attaches input_image content for the Responses protocol", async () => {
    request.mockImplementation(async () => responsesResponse());
    const answer = await askLocalProvider(provider({ protocol: "RESPONSES", model: "gpt-4.1" }), question());
    expect(answer.status).toBe("ANSWERED");
    expect(String(request.mock.calls[0]![0])).toBe("https://api.example.com/v1/responses");
    const body = bodyOf(0);
    expect(typeof body.instructions).toBe("string");
    const input = body.input as Array<Record<string, unknown>>;
    const content = input[0]!.content as Array<Record<string, unknown>>;
    expect(content[0]).toMatchObject({ type: "input_text" });
    expect(String(content[0]!.text)).not.toContain("data:image");
    expect(content[1]).toEqual({ type: "input_image", image_url: IMAGE });
  });

  it("defaults the capability on for new and legacy providers, and keeps the DeepSeek preset text-only", async () => {
    expect(normalizeProvider({ baseUrl: "https://api.example.com/v1", model: "gpt-4.1" }).supportsImages).toBe(true);
    expect(normalizeProvider({ baseUrl: "https://api.example.com/v1", model: "x", supportsImages: false }).supportsImages).toBe(false);
    expect(PRESETS[0]!.supportsImages).toBe(false);
    expect(PRESETS[1]!.supportsImages).toBe(true);
    storage.studyAssistantLocalProviders = [{
      id: "lp_legacy", name: "legacy", baseUrl: "https://api.example.com/v1", protocol: "CHAT_COMPLETIONS",
      model: "gpt-4.1", apiKey: "sk-test", instructionRole: "system", outputMode: "JSON_OBJECT",
      tokenLimitField: "max_tokens", supportsTemperature: false, supportsStoreFalse: false,
      maxOutputTokens: 2048, temperature: null
    }];
    const loaded = await loadLocalProviders();
    expect(loaded[0]!.supportsImages).toBe(true);
  });

  it("explains a provider that rejects image input instead of silently downgrading the request", async () => {
    request.mockImplementation(async () => ({
      ok: false, status: 400,
      text: async () => JSON.stringify({ error: { message: "Invalid content type image_url: model does not support images" } })
    }));
    await expect(askLocalProvider(provider(), question())).rejects.toThrow(/不支持图像输入/);
  });
});

describe("local provider JSON recovery and per-question errors", () => {
  const REPORTED = '{"status":"ANSWERED","selectedOptionIds":[],"blankAnswers":[{"blankId":"blank_1","answer":"Java虚拟机（JVM）"}],"textAnswer":，';

  it("adopts the reported truncated answer because only non-answer fields were cut off", async () => {
    request.mockImplementation(async () => chatAnswer(REPORTED));
    const answer = await askLocalProvider(provider({ supportsImages: false }), fillQuestion());
    expect(answer.blankAnswers).toEqual([{ blankId: "blank_1", answer: "Java虚拟机（JVM）" }]);
    expect(answer.caveats[0]).toContain("不完整");
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("retries when a cut-off explanation is the only damaged field of a choice answer", async () => {
    request.mockImplementation(async () => chatAnswer(ANSWER));
    const answer = await askLocalProvider(provider(), question(null));
    expect(answer.selectedOptionIds).toEqual(["opt_2"]);
    expect(answer.caveats).toHaveLength(0);
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("retries a short answer whose text was cut off", async () => {
    const short: StudyQuestion = { id: "q_4", type: "SHORT_ANSWER", stem: "简答", options: [], blanks: [] };
    const cut = '{"status":"ANSWERED","selectedOptionIds":[],"blankAnswers":[],"textAnswer":"Java虚拟机（JV';
    const valid = JSON.stringify({ status: "ANSWERED", selectedOptionIds: [], blankAnswers: [], textAnswer: "JVM 是 Java 虚拟机", explanation: "", caveats: [] });
    let calls = 0;
    request.mockImplementation(async () => (++calls === 1 ? chatAnswer(cut) : chatAnswer(valid)));
    const answer = await askLocalProvider(provider({ supportsImages: false }), short);
    expect(calls).toBe(2);
    expect(answer.textAnswer).toBe("JVM 是 Java 虚拟机");
  });

  it("adopts a choice answer whose explanation string was left unterminated", async () => {
    const cut = '{"status":"ANSWERED","selectedOptionIds":["opt_2"],"blankAnswers":[],"textAnswer":null,"explanation":"JVM 是 Java 虚拟机';
    request.mockImplementation(async () => chatAnswer(cut));
    const answer = await askLocalProvider(provider(), question(null));
    expect(answer.selectedOptionIds).toEqual(["opt_2"]);
    expect(answer.caveats[0]).toContain("不完整");
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("retries an answer whose blank text was cut off even though it would pass validation", async () => {
    const cut = '{"status":"ANSWERED","selectedOptionIds":[],"blankAnswers":[{"blankId":"blank_1","answer":"Java虚拟机（JV';
    let calls = 0;
    request.mockImplementation(async () => (++calls === 1 ? chatAnswer(cut) : chatAnswer(FILL_ANSWER)));
    const answer = await askLocalProvider(provider({ supportsImages: false }), fillQuestion());
    expect(calls).toBe(2);
    expect(answer.blankAnswers[0]!.answer).toBe("JVM");
  });

  it("never accepts a missing-comma recovery that silently drops multiple-choice options", async () => {
    const cut = '{"status":"ANSWERED","selectedOptionIds":["opt_1","opt_3"] "blankAnswers":[],"textAnswer":null,"explanation":"","caveats":[]}';
    const valid = JSON.stringify({ status: "ANSWERED", selectedOptionIds: ["opt_1", "opt_3"], blankAnswers: [], textAnswer: null, explanation: "", caveats: [] });
    let calls = 0;
    request.mockImplementation(async () => (++calls === 1 ? chatAnswer(cut) : chatAnswer(valid)));
    const answer = await askLocalProvider(provider({ supportsImages: false }), multiQuestion());
    expect(calls).toBe(2);
    expect(answer.selectedOptionIds).toEqual(["opt_1", "opt_3"]);
  });

  it("reports UPSTREAM_TRUNCATED when every attempt cuts off an answer field", async () => {
    request.mockImplementation(async () => chatAnswer('{"status":"ANSWERED","selectedOptionIds":[],"blankAnswers":[{"blankId":"blank_1","answer":"Java虚拟机（JV'));
    const failure = await askLocalProvider(provider({ supportsImages: false }), fillQuestion()).catch((error: unknown) => error);
    expect((failure as { code?: string }).code).toBe("UPSTREAM_TRUNCATED");
    expect(request).toHaveBeenCalledTimes(3);
  });

  it("accepts a fenced answer with prose around it", async () => {
    request.mockImplementation(async () => chatAnswer("好的，答案如下：\n```json\n" + ANSWER + "\n```\n以上。"));
    const answer = await askLocalProvider(provider(), question());
    expect(answer.selectedOptionIds).toEqual(["opt_2"]);
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("retries once with a corrective prompt when the first output cannot be parsed at all", async () => {
    let calls = 0;
    request.mockImplementation(async () => (++calls === 1 ? chatAnswer("抱歉，我无法回答") : chatAnswer(ANSWER)));
    const answer = await askLocalProvider(provider(), question(null));
    expect(calls).toBe(2);
    expect(answer.selectedOptionIds).toEqual(["opt_2"]);
    const messages = bodyOf(1).messages as Array<Record<string, unknown>>;
    expect(String(messages[1]!.content)).toContain("重试要求");
  });

  it("raises the output token limit when the provider reports a truncated response", async () => {
    let calls = 0;
    request.mockImplementation(async () => (++calls === 1
      ? chatAnswer('{"status":"ANSWERED","selectedOptionIds":["opt_', "length")
      : chatAnswer(ANSWER)));
    const answer = await askLocalProvider(provider(), question(null));
    expect(calls).toBe(2);
    expect(answer.selectedOptionIds).toEqual(["opt_2"]);
    expect(bodyOf(1).max_tokens).toBe(4096);
  });

  it("reports UPSTREAM_INVALID_OUTPUT after bounded retries instead of a bare error", async () => {
    request.mockImplementation(async () => chatAnswer("我不知道"));
    const failure = await askLocalProvider(provider(), question(null)).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(Error);
    expect((failure as { code?: string }).code).toBe("UPSTREAM_INVALID_OUTPUT");
    expect((failure as Error).message).toContain("不是有效 JSON");
    expect((failure as Error).message).toContain("共尝试 3 次");
    expect(request).toHaveBeenCalledTimes(3);
  });

  it("keeps semantically invalid answers single-shot with VALIDATION_ERROR", async () => {
    const invalid = JSON.stringify({
      status: "ANSWERED", selectedOptionIds: ["opt_1", "opt_2"], blankAnswers: [], textAnswer: null,
      explanation: "", caveats: []
    });
    request.mockImplementation(async () => chatAnswer(invalid));
    const failure = await askLocalProvider(provider(), question(null)).catch((error: unknown) => error);
    expect((failure as { code?: string }).code).toBe("VALIDATION_ERROR");
    expect((failure as Error).message).toContain("不合法");
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("retries empty content and reports UPSTREAM_TRUNCATED when it stays empty", async () => {
    request.mockImplementation(async () => chatAnswer("", "length"));
    const failure = await askLocalProvider(provider(), question(null)).catch((error: unknown) => error);
    expect((failure as { code?: string }).code).toBe("UPSTREAM_TRUNCATED");
    expect((failure as Error).message).toContain("空内容");
    expect(request).toHaveBeenCalledTimes(3);
    expect(bodyOf(2).max_tokens).toBe(4096);
  });

  it("retries a short answer when an unattributable cut-back chunk follows the answer field", async () => {
    const short: StudyQuestion = { id: "q_4", type: "SHORT_ANSWER", stem: "简答", options: [], blanks: [] };
    const cut = '{"status":"ANSWERED","selectedOptionIds":[],"blankAnswers":[],"textAnswer":"他说","然后继续","explanation":"","caveats":[]}';
    const valid = JSON.stringify({ status: "ANSWERED", selectedOptionIds: [], blankAnswers: [], textAnswer: "完整答案", explanation: "", caveats: [] });
    let calls = 0;
    request.mockImplementation(async () => (++calls === 1 ? chatAnswer(cut) : chatAnswer(valid)));
    const answer = await askLocalProvider(provider({ supportsImages: false }), short);
    expect(calls).toBe(2);
    expect(answer.textAnswer).toBe("完整答案");
  });

  it("classifies an upstream timeout with the contract code instead of hanging forever", async () => {
    vi.useFakeTimers();
    request.mockImplementation((_url: unknown, init: unknown) => new Promise((_resolve, reject) => {
      (init as RequestInit).signal?.addEventListener("abort", () => {
        reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
      });
    }));
    const pending = askLocalProvider(provider({ supportsImages: false }), question(null)).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(90_000);
    const failure = await pending;
    expect((failure as { code?: string }).code).toBe("UPSTREAM_TIMEOUT");
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("marks an HTTP 4xx caused by image input as question-scoped and auth/limit failures as run-level", async () => {
    request.mockImplementation(async () => ({
      ok: false, status: 400,
      text: async () => JSON.stringify({ error: { message: "model does not support image_url" } })
    }));
    const imageFailure = await askLocalProvider(provider(), question()).catch((error: unknown) => error);
    expect((imageFailure as { code?: string }).code).toBe("UPSTREAM_PROTOCOL_ERROR");
    expect((imageFailure as { questionScoped?: boolean }).questionScoped).toBe(true);

    request.mockImplementation(async () => ({ ok: false, status: 401, text: async () => "unauthorized" }));
    const authFailure = await askLocalProvider(provider({ supportsImages: false }), question(null)).catch((error: unknown) => error);
    expect((authFailure as { code?: string }).code).toBe("UPSTREAM_AUTH_FAILED");
    expect((authFailure as { questionScoped?: boolean }).questionScoped).toBeUndefined();

    request.mockImplementation(async () => ({ ok: false, status: 429, text: async () => "rate limited" }));
    const rateFailure = await askLocalProvider(provider({ supportsImages: false }), question(null)).catch((error: unknown) => error);
    expect((rateFailure as { code?: string }).code).toBe("UPSTREAM_RATE_LIMITED");
  });
});


describe("compatible response content and empty-output diagnostics", () => {
  function respond(data: unknown) {
    return { ok: true, status: 200, text: async () => JSON.stringify(data) };
  }
  it("reads Chat Completions text parts without stringifying the array", async () => {
    request.mockResolvedValue(respond({ choices: [{ message: { content: [null, { type: "text", text: ANSWER }] }, finish_reason: "stop" }] }));
    expect((await askLocalProvider(provider(), question())).selectedOptionIds).toEqual(["opt_2"]);
    expect(request).toHaveBeenCalledTimes(1);
  });
  it("reads flat Responses output_text and safely ignores null output items", async () => {
    request.mockResolvedValue(respond({ status: "completed", output: [null], output_text: ANSWER }));
    expect((await askLocalProvider(provider({ protocol: "RESPONSES" }), question())).selectedOptionIds).toEqual(["opt_2"]);
    expect(request).toHaveBeenCalledTimes(1);
  });
  it("increases a reasoning-only truncated request up to 8192, never parsing reasoning as an answer", async () => {
    request.mockResolvedValue(respond({ choices: [{ message: { content: null, reasoning_content: ANSWER }, finish_reason: "length" }] }));
    const failure = await askLocalProvider(provider(), question()).catch(error => error);
    expect(failure.message).toContain("只返回推理内容");
    expect(failure.message).toContain("输出额度已耗尽");
    expect([0, 1, 2].map(i => bodyOf(i).max_tokens)).toEqual([2048, 4096, 8192]);
    expect(failure.message).not.toContain("opt_2");
  });
  it("distinguishes missing response fields from an empty final answer", async () => {
    request.mockResolvedValue(respond({ message: "unsupported envelope" }));
    const failure = await askLocalProvider(provider(), question()).catch(error => error);
    expect(failure.code).toBe("UPSTREAM_INVALID_OUTPUT"); expect(failure.message).toContain("响应结构不兼容");
    expect(request).toHaveBeenCalledTimes(3);
  });
  it("never treats object content or reasoning-only stopped output as an answer", async () => {
    request.mockResolvedValue(respond({ choices: [{ message: { content: {}, reasoning_content: ANSWER }, finish_reason: "stop" }] }));
    const failure = await askLocalProvider(provider(), question()).catch(error => error);
    expect(failure.message).toContain("未返回最终答案");
    expect([0, 1, 2].map(i => bodyOf(i).max_tokens)).toEqual([2048, 2048, 2048]);
  });
});


it("keeps the increased reasoning budget when a later response has a truncated answer", async () => {
  request.mockResolvedValueOnce({ ok: true, status: 200, text: async () => JSON.stringify({ choices: [{ message: { content: null, reasoning_content: "reasoning" }, finish_reason: "length" }] }) })
    .mockResolvedValueOnce(chatAnswer('{"status":"ANSWERED","selectedOptionIds":["opt_', "length"))
    .mockResolvedValueOnce(chatAnswer(ANSWER));
  expect((await askLocalProvider(provider({ maxOutputTokens: 4096 }), question())).selectedOptionIds).toEqual(["opt_2"]);
  expect([0, 1, 2].map(i => bodyOf(i).max_tokens)).toEqual([4096, 8192, 8192]);
});


it("sends large image bytes intact through both local provider protocols", async () => {
  const large = "data:image/png;base64," + "A".repeat(900000);
  request.mockResolvedValueOnce(chatResponse()).mockResolvedValueOnce(responsesResponse());
  await askLocalProvider(provider(), question(large), { requireImage: true });
  await askLocalProvider(provider({ protocol: "RESPONSES" }), question(large), { requireImage: true });
  const chat = (bodyOf(0).messages as Array<{ content: Array<{ type: string; image_url?: { url: string } }> }>)[1]!.content;
  expect(chat.find(part => part.type === "image_url")!.image_url!.url).toBe(large);
  const responses = (bodyOf(1).input as Array<{ content: Array<{ type: string; image_url?: string }> }>)[0]!.content;
  expect(responses.find(part => part.type === "input_image")!.image_url).toBe(large);
});
