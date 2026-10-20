/**
 * Extension-local fault codes (docs/xuexitong-extension-adaptation.md §6).
 * These codes never leave the extension; there is no server-side fill API.
 */
export const LOCAL_ERROR_CODES = [
  "ADAPTER_NOT_MATCHED",
  "PAGE_KIND_UNSUPPORTED",
  "QUESTION_AMBIGUOUS",
  "FRAME_ACCESS_DENIED",
  "DOCUMENT_CHANGED",
  "QUESTION_CHANGED",
  "FIELD_READ_ONLY",
  "CONTROL_UNSUPPORTED",
  "UNTRUSTED_EVENT_REJECTED",
  "VALUE_REVERTED",
  "VALUE_NOT_ACCEPTED",
  "EVENT_SIDE_EFFECT_UNVERIFIED",
  "CONFIRMATION_EXPIRED",
  "PARTIAL_FILL"
] as const;

export type LocalErrorCode = (typeof LOCAL_ERROR_CODES)[number];

export interface ErrorGuidance {
  title: string;
  hint: string;
}

/** Human-readable guidance for every local code: what happened and what the user can do next. */
export const ERROR_GUIDANCE: Record<LocalErrorCode, ErrorGuidance> = {
  ADAPTER_NOT_MATCHED: {
    title: "当前页面没有已验证的适配器",
    hint: "手动读取没有匹配当前页面。课程任务请点击“打开课程任务调度”，在调度页预览后运行；该入口使用独立课程适配器。未知页面请先核对页面类型。"
  },
  PAGE_KIND_UNSUPPORTED: {
    title: "页面不是受支持的练习",
    hint: "手动模式不支持计分测验或未知页面回填。已适配的章节测验请使用“打开课程任务调度”；正式考试及未知页面仍不支持。"
  },
  QUESTION_AMBIGUOUS: {
    title: "无法唯一确认当前题目",
    hint: "请在题目列表中选择一个题目容器，或手工整理本题后再试。"
  },
  FRAME_ACCESS_DENIED: {
    title: "没有目标框架的访问权限",
    hint: "先在目标标签页点击扩展图标再读取；站点权限不足时可自愿授予该学习通站点读取权限，拒绝后可重新授权并打开课程任务调度。跨域 iframe 不通过追加权限解决。"
  },
  DOCUMENT_CHANGED: {
    title: "页面已导航或文档已变化",
    hint: "请重新读取当前题目，再预览、发送和审核。旧的回填计划已失效。"
  },
  QUESTION_CHANGED: {
    title: "题目或选项已变化",
    hint: "题目指纹不一致，本次不写入。请重新读取本题并重新审核。"
  },
  FIELD_READ_ONLY: {
    title: "字段只读或不可编辑",
    hint: "扩展不会移除 readonly/disabled，也不会写入被锁定的字段。请检查站点是否已开放答题。"
  },
  CONTROL_UNSUPPORTED: {
    title: "控件类型没有已验证的写入器",
    hint: "未知编辑器、富文本或 contenteditable 不执行通用写入。请手工输入或使用站点允许的输入方式。"
  },
  UNTRUSTED_EVENT_REJECTED: {
    title: "页面不接受合成事件",
    hint: "扩展不会伪造事件可信性，也不会使用调试器绕过限制。此处不支持回填。"
  },
  VALUE_REVERTED: {
    title: "页面渲染后恢复了原值",
    hint: "受控组件可能覆盖了直接赋值。扩展不会自动重试或提交，请检查页面是否允许编辑。"
  },
  VALUE_NOT_ACCEPTED: {
    title: "控件没有接受审核值",
    hint: "回读值与审核值不一致，已停止后续写入。请人工确认页面是否接受该输入。"
  },
  EVENT_SIDE_EFFECT_UNVERIFIED: {
    title: "事件副作用未经验证",
    hint: "该页面可能在 input/change 时自动保存或提交，事件副作用未经验证。未确认前禁止回填，扩展不会尝试探测提交行为。"
  },
  CONFIRMATION_EXPIRED: {
    title: "单次确认已过期或已使用",
    hint: "回填确认只能使用一次。请重新审核本题并再次点击确认。"
  },
  PARTIAL_FILL: {
    title: "部分字段写入后失败",
    hint: "扩展已停止写入，不会自动重试，也不会提交。请检查失败字段并人工修正。"
  }
};

export function isLocalErrorCode(value: unknown): value is LocalErrorCode {
  return typeof value === "string" && (LOCAL_ERROR_CODES as readonly string[]).includes(value);
}
