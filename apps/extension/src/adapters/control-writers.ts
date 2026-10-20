import type { ControlKind, FieldEvent } from "../shared/types";
import type { LocalErrorCode } from "../shared/codes";

export type ReviewedFieldValue =
  | { kind: "TEXT"; text: string }
  | { kind: "RADIO"; optionId: string }
  | { kind: "CHECKBOX"; optionId: string; checked: boolean }
  | { kind: "SELECT"; optionId: string };

export interface FieldCheck {
  ok: boolean;
  code: LocalErrorCode | null;
  detail: string;
}

export type WriteOutcome =
  | { ok: true }
  | { ok: false; code: LocalErrorCode; detail: string };

export interface ControlWriter {
  id: string;
  supports(target: Element): boolean;
  validate(target: Element, value: ReviewedFieldValue): FieldCheck;
  write(target: Element, value: ReviewedFieldValue, options?: WriteOptions): WriteOutcome;
  readBack(target: Element): ReviewedFieldValue | null;
}

export interface WriteOptions {
  /** Only events the page adapter has verified as necessary and free of submission side effects. */
  events: readonly FieldEvent[];
}

const TEXT_INPUT_TYPES = new Set([
  "text",
  "search",
  "email",
  "tel",
  "url",
  "password",
  "number"
]);

interface RealmConstructors {
  HTMLInputElement?: { prototype: object };
  HTMLTextAreaElement?: { prototype: object };
  HTMLSelectElement?: { prototype: object };
  Event?: typeof Event;
}

/** Realm-safe element checks: same-origin iframe documents have different constructors. */
function isTag(target: Element, tagName: string): boolean {
  return target.tagName === tagName;
}

function asInput(target: Element): HTMLInputElement | null {
  return isTag(target, "INPUT") ? (target as HTMLInputElement) : null;
}

function asTextarea(target: Element): HTMLTextAreaElement | null {
  return isTag(target, "TEXTAREA") ? (target as HTMLTextAreaElement) : null;
}

function asSelect(target: Element): HTMLSelectElement | null {
  return isTag(target, "SELECT") ? (target as HTMLSelectElement) : null;
}

function realmOf(target: Element): RealmConstructors | null {
  return target.ownerDocument.defaultView as unknown as RealmConstructors | null;
}

function isElementVisible(element: Element): boolean {
  let current: Element | null = element;
  while (current) {
    if (current.hasAttribute("hidden")) {
      return false;
    }
    const style = (current as HTMLElement).style;
    if (style && (style.display === "none" || style.visibility === "hidden")) {
      return false;
    }
    if (current.getAttribute("aria-hidden") === "true") {
      return false;
    }
    current = current.parentElement;
  }
  return element.isConnected;
}

function isDisabledOrInert(element: Element): boolean {
  if ((element as unknown as { disabled?: unknown }).disabled === true) {
    return true;
  }
  if (element.getAttribute("aria-disabled") === "true") {
    return true;
  }
  if (element.closest("[inert]")) {
    return true;
  }
  return element.closest("fieldset[disabled]") !== null;
}

function isReadOnly(element: Element): boolean {
  if ((element as unknown as { readOnly?: unknown }).readOnly === true) {
    return true;
  }
  if (element.hasAttribute("readonly")) {
    return true;
  }
  return element.getAttribute("aria-readonly") === "true";
}

function basicEditableCheck(target: Element): FieldCheck {
  if (!isElementVisible(target)) {
    return { ok: false, code: "FIELD_READ_ONLY", detail: "target is not visible" };
  }
  if (isDisabledOrInert(target)) {
    return { ok: false, code: "FIELD_READ_ONLY", detail: "target is disabled or inert" };
  }
  if (isReadOnly(target)) {
    return { ok: false, code: "FIELD_READ_ONLY", detail: "target is read-only" };
  }
  return { ok: true, code: null, detail: "" };
}

function nativeSetter(target: Element, property: "value" | "checked"): ((value: unknown) => void) | null {
  const realm = realmOf(target);
  let proto: object;
  if (property === "checked") {
    proto = realm?.HTMLInputElement?.prototype ?? HTMLInputElement.prototype;
  } else if (isTag(target, "TEXTAREA")) {
    proto = realm?.HTMLTextAreaElement?.prototype ?? HTMLTextAreaElement.prototype;
  } else if (isTag(target, "SELECT")) {
    proto = realm?.HTMLSelectElement?.prototype ?? HTMLSelectElement.prototype;
  } else {
    proto = realm?.HTMLInputElement?.prototype ?? HTMLInputElement.prototype;
  }
  const descriptor = Object.getOwnPropertyDescriptor(proto, property);
  const setter = descriptor?.set;
  if (!setter) {
    return null;
  }
  return (value: unknown) => {
    setter.call(target, value);
  };
}

function setNativeValue(target: Element, value: string): boolean {
  const setter = nativeSetter(target, "value");
  if (!setter) {
    return false;
  }
  setter(value);
  return true;
}

function setNativeChecked(target: Element, checked: boolean): boolean {
  const setter = nativeSetter(target, "checked");
  if (!setter) {
    return false;
  }
  setter(checked);
  return true;
}

function dispatchVerifiedEvents(target: Element, events: readonly FieldEvent[]): void {
  const realm = realmOf(target);
  const EventCtor = realm?.Event ?? Event;
  for (const eventName of events) {
    target.dispatchEvent(new EventCtor(eventName, { bubbles: true, composed: true }));
  }
}

function textWriter(kind: "TEXT_INPUT" | "TEXTAREA", supports: (target: Element) => boolean): ControlWriter {
  return {
    id: kind,
    supports,
    validate(target, value) {
      if (!supports(target)) {
        return { ok: false, code: "CONTROL_UNSUPPORTED", detail: `target is not ${kind}` };
      }
      if (value.kind !== "TEXT") {
        return { ok: false, code: "CONTROL_UNSUPPORTED", detail: "expected a TEXT value" };
      }
      const editable = basicEditableCheck(target);
      if (!editable.ok) {
        return editable;
      }
      if (kind === "TEXT_INPUT" && /[\r\n]/.test(value.text)) {
        return {
          ok: false,
          code: "CONTROL_UNSUPPORTED",
          detail: "single-line input cannot receive a multi-line answer"
        };
      }
      return { ok: true, code: null, detail: "" };
    },
    write(target, value, options) {
      if (!supports(target) || value.kind !== "TEXT") {
        return { ok: false, code: "CONTROL_UNSUPPORTED", detail: "unsupported control or value" };
      }
      const editable = basicEditableCheck(target);
      if (!editable.ok) {
        return { ok: false, code: editable.code ?? "FIELD_READ_ONLY", detail: editable.detail };
      }
      if (!setNativeValue(target, value.text)) {
        return { ok: false, code: "CONTROL_UNSUPPORTED", detail: "native value setter is unavailable" };
      }
      dispatchVerifiedEvents(target, options?.events ?? []);
      return { ok: true };
    },
    readBack(target) {
      if (!supports(target)) {
        return null;
      }
      const control = asInput(target) ?? asTextarea(target);
      return control ? { kind: "TEXT", text: control.value } : null;
    }
  };
}

export const textInputWriter = textWriter("TEXT_INPUT", (target) => {
  const input = asInput(target);
  return input !== null && TEXT_INPUT_TYPES.has(input.type);
});

export const textareaWriter = textWriter("TEXTAREA", (target) => asTextarea(target) !== null);

export const radioWriter: ControlWriter = {
  id: "RADIO",
  supports(target) {
    const input = asInput(target);
    return input !== null && input.type === "radio";
  },
  validate(target, value) {
    if (!this.supports(target)) {
      return { ok: false, code: "CONTROL_UNSUPPORTED", detail: "target is not a radio input" };
    }
    if (value.kind !== "RADIO") {
      return { ok: false, code: "CONTROL_UNSUPPORTED", detail: "expected a RADIO value" };
    }
    const radio = target as HTMLInputElement;
    if (radio.value !== value.optionId) {
      return { ok: false, code: "QUESTION_CHANGED", detail: "radio value no longer matches the option id" };
    }
    return basicEditableCheck(target);
  },
  write(target, value, options) {
    if (!this.supports(target) || value.kind !== "RADIO") {
      return { ok: false, code: "CONTROL_UNSUPPORTED", detail: "unsupported control or value" };
    }
    const radio = target as HTMLInputElement;
    if (radio.value !== value.optionId) {
      return { ok: false, code: "QUESTION_CHANGED", detail: "radio value no longer matches the option id" };
    }
    const editable = basicEditableCheck(target);
    if (!editable.ok) {
      return { ok: false, code: editable.code ?? "FIELD_READ_ONLY", detail: editable.detail };
    }
    if (!setNativeChecked(radio, true)) {
      return { ok: false, code: "CONTROL_UNSUPPORTED", detail: "native checked setter is unavailable" };
    }
    dispatchVerifiedEvents(target, options?.events ?? []);
    return { ok: true };
  },
  readBack(target) {
    if (!this.supports(target)) {
      return null;
    }
    const radio = target as HTMLInputElement;
    return radio.checked ? { kind: "RADIO", optionId: radio.value } : null;
  }
};

export const checkboxWriter: ControlWriter = {
  id: "CHECKBOX",
  supports(target) {
    const input = asInput(target);
    return input !== null && input.type === "checkbox";
  },
  validate(target, value) {
    if (!this.supports(target)) {
      return { ok: false, code: "CONTROL_UNSUPPORTED", detail: "target is not a checkbox input" };
    }
    if (value.kind !== "CHECKBOX") {
      return { ok: false, code: "CONTROL_UNSUPPORTED", detail: "expected a CHECKBOX value" };
    }
    const checkbox = target as HTMLInputElement;
    if (checkbox.value !== value.optionId) {
      return { ok: false, code: "QUESTION_CHANGED", detail: "checkbox value no longer matches the option id" };
    }
    return basicEditableCheck(target);
  },
  write(target, value, options) {
    if (!this.supports(target) || value.kind !== "CHECKBOX") {
      return { ok: false, code: "CONTROL_UNSUPPORTED", detail: "unsupported control or value" };
    }
    const checkbox = target as HTMLInputElement;
    if (checkbox.value !== value.optionId) {
      return { ok: false, code: "QUESTION_CHANGED", detail: "checkbox value no longer matches the option id" };
    }
    const editable = basicEditableCheck(target);
    if (!editable.ok) {
      return { ok: false, code: editable.code ?? "FIELD_READ_ONLY", detail: editable.detail };
    }
    if (!setNativeChecked(checkbox, value.checked)) {
      return { ok: false, code: "CONTROL_UNSUPPORTED", detail: "native checked setter is unavailable" };
    }
    dispatchVerifiedEvents(target, options?.events ?? []);
    return { ok: true };
  },
  readBack(target) {
    if (!this.supports(target)) {
      return null;
    }
    const checkbox = target as HTMLInputElement;
    return { kind: "CHECKBOX", optionId: checkbox.value, checked: checkbox.checked };
  }
};

export const selectWriter: ControlWriter = {
  id: "SELECT",
  supports(target) {
    return asSelect(target) !== null;
  },
  validate(target, value) {
    if (!this.supports(target)) {
      return { ok: false, code: "CONTROL_UNSUPPORTED", detail: "target is not a select element" };
    }
    if (value.kind !== "SELECT") {
      return { ok: false, code: "CONTROL_UNSUPPORTED", detail: "expected a SELECT value" };
    }
    const select = target as HTMLSelectElement;
    if (!findSelectOption(select, value.optionId)) {
      return { ok: false, code: "QUESTION_CHANGED", detail: "select option is missing" };
    }
    return basicEditableCheck(target);
  },
  write(target, value, options) {
    if (!this.supports(target) || value.kind !== "SELECT") {
      return { ok: false, code: "CONTROL_UNSUPPORTED", detail: "unsupported control or value" };
    }
    const select = target as HTMLSelectElement;
    if (!findSelectOption(select, value.optionId)) {
      return { ok: false, code: "QUESTION_CHANGED", detail: "select option is missing" };
    }
    const editable = basicEditableCheck(target);
    if (!editable.ok) {
      return { ok: false, code: editable.code ?? "FIELD_READ_ONLY", detail: editable.detail };
    }
    if (!setNativeValue(select, value.optionId) || select.value !== value.optionId) {
      return { ok: false, code: "VALUE_NOT_ACCEPTED", detail: "select did not accept the option" };
    }
    dispatchVerifiedEvents(target, options?.events ?? []);
    return { ok: true };
  },
  readBack(target) {
    if (!this.supports(target)) {
      return null;
    }
    const select = target as HTMLSelectElement;
    const selected = select.options.item(select.selectedIndex);
    if (!selected) {
      return null;
    }
    return { kind: "SELECT", optionId: optionIdOf(selected) };
  }
};

export const contenteditableWriter: ControlWriter = {
  id: "CONTENTEDITABLE",
  supports(target) {
    if ((target as HTMLElement).isContentEditable === true) {
      return true;
    }
    return target.hasAttribute("contenteditable");
  },
  validate() {
    return {
      ok: false,
      code: "CONTROL_UNSUPPORTED",
      detail: "contenteditable/rich text has no verified writer; no generic rich-text rewrite is performed"
    };
  },
  write() {
    return {
      ok: false,
      code: "CONTROL_UNSUPPORTED",
      detail: "contenteditable/rich text has no verified writer"
    };
  },
  readBack() {
    return null;
  }
};

function optionIdOf(option: HTMLOptionElement): string {
  return option.getAttribute("data-option-id") ?? option.value;
}

function findSelectOption(select: HTMLSelectElement, optionId: string): HTMLOptionElement | null {
  for (const option of Array.from(select.options)) {
    if (optionIdOf(option) === optionId) {
      return option;
    }
  }
  return null;
}

export function detectControlKind(target: Element): ControlKind | null {
  if (textInputWriter.supports(target)) {
    return "TEXT_INPUT";
  }
  if (textareaWriter.supports(target)) {
    return "TEXTAREA";
  }
  if (radioWriter.supports(target)) {
    return "RADIO";
  }
  if (checkboxWriter.supports(target)) {
    return "CHECKBOX";
  }
  if (selectWriter.supports(target)) {
    return "SELECT";
  }
  if (contenteditableWriter.supports(target)) {
    return "CONTENTEDITABLE";
  }
  return null;
}

export function writerForKind(kind: ControlKind): ControlWriter | null {
  switch (kind) {
    case "TEXT_INPUT":
      return textInputWriter;
    case "TEXTAREA":
      return textareaWriter;
    case "RADIO":
      return radioWriter;
    case "CHECKBOX":
      return checkboxWriter;
    case "SELECT":
      return selectWriter;
    case "CONTENTEDITABLE":
      return contenteditableWriter;
    default:
      return null;
  }
}

export function valueToText(value: ReviewedFieldValue | null): string {
  if (!value) {
    return "(空)";
  }
  switch (value.kind) {
    case "TEXT":
      return value.text;
    case "RADIO":
      return value.optionId;
    case "CHECKBOX":
      return `${value.checked ? "勾选" : "取消勾选"} ${value.optionId}`;
    case "SELECT":
      return value.optionId;
    default:
      return "(未知)";
  }
}

export function valuesEqual(expected: ReviewedFieldValue, actual: ReviewedFieldValue | null): boolean {
  if (!actual) {
    return false;
  }
  if (expected.kind !== actual.kind) {
    return false;
  }
  switch (expected.kind) {
    case "TEXT":
      return actual.kind === "TEXT" && expected.text === actual.text;
    case "RADIO":
      return actual.kind === "RADIO" && expected.optionId === actual.optionId;
    case "CHECKBOX":
      return actual.kind === "CHECKBOX" && expected.checked === actual.checked && expected.optionId === actual.optionId;
    case "SELECT":
      return actual.kind === "SELECT" && expected.optionId === actual.optionId;
    default:
      return false;
  }
}