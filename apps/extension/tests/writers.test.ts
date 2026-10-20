import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  checkboxWriter,
  contenteditableWriter,
  detectControlKind,
  radioWriter,
  selectWriter,
  textInputWriter,
  textareaWriter,
  valuesEqual,
  valueToText
} from "../src/adapters/control-writers";

beforeEach(() => {
  document.body.innerHTML = "";
});

function pick<T extends Element>(selector: string): T {
  const element = document.querySelector(selector);
  if (!element) {
    throw new Error(`missing element ${selector}`);
  }
  return element as T;
}

describe("text writers", () => {
  it("uses the native value setter instead of an instance override", () => {
    document.body.innerHTML = '<input id="t" value="" />';
    const input = pick<HTMLInputElement>("#t");
    const instanceSetter = vi.fn();
    Object.defineProperty(input, "value", {
      configurable: true,
      get: () => "instance-value",
      set: instanceSetter
    });
    const outcome = textInputWriter.write(input, { kind: "TEXT", text: "42" }, { events: [] });
    expect(outcome.ok).toBe(true);
    expect(instanceSetter).not.toHaveBeenCalled();
    const nativeGetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.get;
    expect(nativeGetter?.call(input)).toBe("42");
    expect(textInputWriter.readBack(input)).toEqual({ kind: "TEXT", text: "instance-value" });
  });

  it("writes textarea values and reads them back", () => {
    document.body.innerHTML = '<textarea id="ta"></textarea>';
    const textarea = pick<HTMLTextAreaElement>("#ta");
    expect(textareaWriter.validate(textarea, { kind: "TEXT", text: "line" }).ok).toBe(true);
    expect(textareaWriter.write(textarea, { kind: "TEXT", text: "第一行\n第二行" }, { events: [] }).ok).toBe(true);
    expect(textareaWriter.readBack(textarea)).toEqual({ kind: "TEXT", text: "第一行\n第二行" });
  });

  it("rejects readonly, disabled and hidden controls without changing them", () => {
    document.body.innerHTML =
      '<input id="ro" readonly value="locked" /><input id="dis" disabled value="off" /><input id="hid" hidden />';
    const readonly = pick<HTMLInputElement>("#ro");
    const disabled = pick<HTMLInputElement>("#dis");
    const hidden = pick<HTMLInputElement>("#hid");

    expect(textInputWriter.validate(readonly, { kind: "TEXT", text: "x" }).code).toBe("FIELD_READ_ONLY");
    expect(textInputWriter.write(readonly, { kind: "TEXT", text: "x" }, { events: [] }).ok).toBe(false);
    expect(readonly.value).toBe("locked");
    expect(readonly.hasAttribute("readonly")).toBe(true);

    expect(textInputWriter.validate(disabled, { kind: "TEXT", text: "x" }).code).toBe("FIELD_READ_ONLY");
    expect(textInputWriter.validate(hidden, { kind: "TEXT", text: "x" }).code).toBe("FIELD_READ_ONLY");
    expect(disabled.value).toBe("off");
    expect(disabled.hasAttribute("disabled")).toBe(true);
  });

  it("dispatches only the explicitly verified input/change events", () => {
    document.body.innerHTML = '<form id="f"><input id="t" /></form>';
    const input = pick<HTMLInputElement>("#t");
    const counts = { input: 0, change: 0, keydown: 0, keypress: 0, paste: 0, submit: 0 };
    for (const name of Object.keys(counts) as Array<keyof typeof counts>) {
      document.addEventListener(name, () => {
        counts[name] += 1;
      });
    }
    const outcome = textInputWriter.write(input, { kind: "TEXT", text: "ok" }, { events: ["input", "change"] });
    expect(outcome.ok).toBe(true);
    expect(counts.input).toBe(1);
    expect(counts.change).toBe(1);
    expect(counts.keydown).toBe(0);
    expect(counts.keypress).toBe(0);
    expect(counts.paste).toBe(0);
    expect(counts.submit).toBe(0);
  });
});

describe("choice writers", () => {
  beforeEach(() => {
    document.body.innerHTML = `
      <input type="radio" id="r1" name="g" value="opt_1" />
      <input type="radio" id="r2" name="g" value="opt_2" />
      <input type="checkbox" id="c1" value="opt_1" />
      <input type="checkbox" id="c2" value="opt_2" />
      <select id="s">
        <option data-option-id="opt_1" value="opt_1">A</option>
        <option data-option-id="opt_2" value="opt_2">B</option>
      </select>
    `;
  });

  it("sets radio checked state and ignores the rest of the group", () => {
    const radio = pick<HTMLInputElement>("#r1");
    expect(radioWriter.write(radio, { kind: "RADIO", optionId: "opt_1" }, { events: ["input", "change"] }).ok).toBe(true);
    expect(radio.checked).toBe(true);
    expect(pick<HTMLInputElement>("#r2").checked).toBe(false);
    expect(radioWriter.readBack(radio)).toEqual({ kind: "RADIO", optionId: "opt_1" });
  });

  it("sets checkbox true and false", () => {
    const checkbox = pick<HTMLInputElement>("#c1");
    expect(checkboxWriter.write(checkbox, { kind: "CHECKBOX", optionId: "opt_1", checked: true }, { events: [] }).ok).toBe(true);
    expect(checkbox.checked).toBe(true);
    expect(checkboxWriter.write(checkbox, { kind: "CHECKBOX", optionId: "opt_1", checked: false }, { events: [] }).ok).toBe(true);
    expect(checkbox.checked).toBe(false);
  });

  it("selects a select option by local option id", () => {
    const select = pick<HTMLSelectElement>("#s");
    expect(selectWriter.write(select, { kind: "SELECT", optionId: "opt_2" }, { events: ["change"] }).ok).toBe(true);
    expect(select.value).toBe("opt_2");
    expect(selectWriter.readBack(select)).toEqual({ kind: "SELECT", optionId: "opt_2" });
  });

  it("rejects mismatched option ids", () => {
    const radio = pick<HTMLInputElement>("#r1");
    expect(radioWriter.validate(radio, { kind: "RADIO", optionId: "opt_2" }).code).toBe("QUESTION_CHANGED");
    const checkbox = pick<HTMLInputElement>("#c1");
    expect(checkboxWriter.validate(checkbox, { kind: "CHECKBOX", optionId: "opt_2", checked: true }).code).toBe(
      "QUESTION_CHANGED"
    );
  });
});

describe("contenteditable and helpers", () => {
  it("keeps contenteditable as an explicit unsupported branch", () => {
    document.body.innerHTML = '<div id="ce" contenteditable="true">原文本</div>';
    const editable = pick<HTMLElement>("#ce");
    expect(detectControlKind(editable)).toBe("CONTENTEDITABLE");
    expect(contenteditableWriter.validate(editable, { kind: "TEXT", text: "x" }).code).toBe("CONTROL_UNSUPPORTED");
    expect(contenteditableWriter.write(editable, { kind: "TEXT", text: "x" }, { events: [] }).ok).toBe(false);
    expect(editable.textContent).toBe("原文本");
  });

  it("formats and compares reviewed values", () => {
    expect(valueToText({ kind: "CHECKBOX", optionId: "opt_1", checked: true })).toContain("勾选");
    expect(valuesEqual({ kind: "TEXT", text: "a" }, { kind: "TEXT", text: "a" })).toBe(true);
    expect(valuesEqual({ kind: "TEXT", text: "a" }, { kind: "TEXT", text: "b" })).toBe(false);
    expect(valuesEqual({ kind: "TEXT", text: "a" }, null)).toBe(false);
  });
});
