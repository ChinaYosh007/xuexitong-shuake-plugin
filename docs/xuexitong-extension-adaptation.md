# Xuexitong Extension Adaptation Specification
# 学习通插件页面适配与非剪贴板回填规格

版本：1.0  日期：2026 年 10 月 18 日

本文件补充 [主架构与实现规格](architecture.md) 第 7、8、21 节。Chrome 插件是核心客户端，受支持练习的主流程不能依赖网站允许复制、选中文字或粘贴。本文是实施契约；当前未获得真实学习通 DOM，因此没有真实页面兼容性已通过的结论。

## 1 主交互

2026-10-19 用户授权新增的独立课程任务调度模式见 [course-automation.md](course-automation.md)，其中含本次实际观察的脱敏 DOM 结构、图片/字体处理、回填与提交验证要求。以下逐题交互及计分页拒绝继续适用于手动模式，不代表自动模式具有所有真实站点兼容性。

1. 用户在当前练习页点击插件。
2. 点击“读取当前题目”。匹配的本地适配器限定单题范围，多题时让用户确认高亮的题目容器。
3. 插件展示本次采集的题干、选项和空格；用户可纠正。
4. 用户确认后，题目经自有后端发给所选 AI 供应商。
5. 用户审核或修改答案。
6. 插件展示逐字段回填计划，用户确认本题。
7. 重新检查文档、题目指纹、控件和练习类型。
8. 写入控件、回读验证并停留，不触发提交。

手工输入、扩展内粘贴与划词是辅助路径。无权限、未知编辑器或图片题时，允许扩展内人工输入，不要求用户必须先从网站复制。

## 2 技术事实与设计边界

Chrome 内容脚本可以访问共享 DOM，但隔离世界的 JavaScript 环境与页面不同。能够修改 DOM 不代表能直接操作页面框架的私有状态。[Chrome Content Scripts](https://developer.chrome.com/docs/extensions/develop/concepts/content-scripts)

合成 paste 事件本身不会完成浏览器的默认粘贴写入。用脚本修改 value 也不会自动触发 input，因此控件赋值和必要的状态同步必须分别设计并测试。[MDN paste](https://developer.mozilla.org/en-US/docs/Web/API/Element/paste_event)、[MDN input](https://developer.mozilla.org/en-US/docs/Web/API/Element/input_event)

据此，本项目选择按控件适配的非剪贴板写入，不选择模拟粘贴。该选择不能推导出所有学习通页面均兼容。未知站点行为、只读、计分字段、自动提交、复杂编辑器和可信事件要求必须显式报告。

## 3 场景矩阵

| 场景 | 采集 | 回填 |
|---|---|---|
| 可编辑文本框只阻止 paste | 从已确认的单题容器读取 | 控件赋值、已验证事件、回读 |
| CSS 禁止选中或页面阻止复制 | 不依赖 Selection，读取选定单题 DOM | 按控件类型处理 |
| 选择题 | 只采集本题可见选项 | 设置映射选项并回读，不使用提交按钮 |
| 框架受控字段 | 只采集必要文本 | 专属策略同步状态，渲染后复查 |
| contenteditable 或富文本编辑器 | 单独验证内容结构 | 专属适配器；未知则关闭 |
| iframe | 只在已有授权覆盖的框架中读取 | 文档与框架绑定，跨域无权限时关闭 |
| readonly 或 disabled | 可读题文仍可预览 | 不移除属性，不写入 |
| 字段事件会提交或保存计分答案 | 不进入受支持回填流程 | 关闭回填 |
| 站点只接受 isTrusted 事件 | 只按已验证能力采集 | 不伪造事件可信性，不改用 debugger |
| Shadow DOM 或 Canvas | 仅支持实际可访问且经过验证的结构 | 未知结构不声称支持 |

## 4 控件写入端口

```ts
type ControlKind =
  | "TEXT_INPUT"
  | "TEXTAREA"
  | "RADIO"
  | "CHECKBOX"
  | "SELECT"
  | "CONTENTEDITABLE";

interface ControlWriter {
  id: string;
  supports(target: Element): boolean;
  validate(target: Element, value: ReviewedFieldValue): FieldCheck;
  write(target: Element, value: ReviewedFieldValue): FieldWriteResult;
  readBack(target: Element): ReviewedFieldValue;
}

interface FieldWriteResult {
  fieldId: string;
  status: "WRITTEN" | "UNSUPPORTED" | "FAILED";
  errorCode: string | null;
}
```

以上均为项目自定义接口，具体 ReviewedFieldValue 采用按控件类型区分的联合类型，不用 any。

文本控件优先使用该控件原生 value 赋值策略；选择控件使用 checked 或选项状态。只有适配器已经确认必要且不会提交时，才派发最少 input/change 事件。不派发任意键盘事件，不执行剪贴板命令，不点击未知按钮。

受控输入需要单独确认页面框架是否同步状态。只设置 DOM 但下一次渲染被恢复，必须报告失败或不支持，不以画面短暂变化判断成功。

contenteditable 不使用通用 innerHTML，不执行 execCommand，不调用页面不明私有函数。需要专属、可测试策略；缺少证据时不实现该类型写入。

## 5 前置条件与回读

写入前同时满足：

- 页面类型明确为支持的练习。
- 适配器 ID 与版本一致。
- tabId、frameId、documentId、documentNonce 一致。
- 题目指纹一致；用户未修改题目或配置。
- 目标字段唯一、可见、启用、可编辑。
- 审核对象与当前填写值完全一致。
- 单次确认值有效且未消费。

写入后立即回读，并在下一次已完成的有界渲染检查中再次回读，等待上限一秒。该检查只能证明此检查窗口内的状态，不能承诺未来页面逻辑不会改变值。

如值被恢复，报告 VALUE_REVERTED；控件未接受值时报告 VALUE_NOT_ACCEPTED。停止后续写入，不自动重试、不提交、不宣称整题成功。

所有定位器、控件引用、指纹和回填计划只存在扩展本地，不上传后端。模型输出仅含答案数据，不决定选择器、事件或写入代码。

## 6 本地故障码

| 错误码 | 含义 |
|---|---|
| ADAPTER_NOT_MATCHED | 当前页没有经过验证的适配器 |
| PAGE_KIND_UNSUPPORTED | 不是受支持练习或页面类型未知 |
| QUESTION_AMBIGUOUS | 无法唯一确认当前题目 |
| FRAME_ACCESS_DENIED | 没有目标框架权限 |
| DOCUMENT_CHANGED | 文档或框架已经导航 |
| QUESTION_CHANGED | 题干、选项或空格映射变化 |
| FIELD_READ_ONLY | 字段只读、禁用或不可编辑 |
| CONTROL_UNSUPPORTED | 编辑器或控件没有已验证写入器 |
| UNTRUSTED_EVENT_REJECTED | 页面不接受合成事件 |
| VALUE_REVERTED | 页面渲染后恢复原值 |
| VALUE_NOT_ACCEPTED | 回读值与审核值不一致 |
| EVENT_SIDE_EFFECT_UNVERIFIED | 事件副作用未经验证 |
| CONFIRMATION_EXPIRED | 单次审核确认已过期或已消费 |
| PARTIAL_FILL | 部分字段写入后发生失败 |

上述是扩展本地错误，不新增服务器回填 API。不要为了判定错误码而探测提交、网络或站点内部安全机制。

## 7 Fixture 与验收

| 文件 | 核心验收 |
|---|---|
| practice.html | 主流程可用，审核后回填，零提交 |
| no-paste.html | paste 被阻止仍可通过控件写入；剪贴板和 paste 路径没有被使用 |
| selection-disabled.html | Selection 为空仍能读取用户确认的单题 |
| controlled-input.html | 渲染后状态一致；故意恢复原值时准确失败 |
| readonly-field.html | 不更改 readonly/disabled，不写入 |
| autosubmit-field.html | 适配器在写入前拒绝；没有触发提交副作用 |
| iframe-question.html | 有权限框架文档绑定正确；无权限明确降级 |
| changed-question.html | 题目或映射变化后零写入 |
| graded.html | 不回填、不提交 |
| prompt-injection.html | 题目中的指令不改变工具和页面操作 |

实现浏览器测试时，记录 input/change/paste 与 submit 的次数，并监测是否产生意外网络请求。测试页面和事件计数不包含用户真实资料。

浏览器自动化测试中扩展采用实际 MV3 加载；不要用在测试页直接执行等价脚本的方式替代扩展集成验证。

## 8 真实页面验证记录

每个真实适配器在 docs/compatibility.md 记录：页面来源与脱敏样例标识、浏览器、适配器版本、日期、题型、编辑器、iframe 情况、禁止粘贴机制、练习性质证据、事件副作用、回读结果和限制。

页面限制机制无法确认时记录 Unknown，不凭页面文字或猜测将其标为练习。没有样例与真实验证证据时只交付合成 Fixture 和文本学习闭环，不冒充真实学习通回填已经完成。
