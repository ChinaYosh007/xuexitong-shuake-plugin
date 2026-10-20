# 合成 Fixture 契约与验收映射

本目录是《学习通 AI 学习助手》的**合成测试页面**，用于在缺少真实学习通 DOM 的情况下验证采集、预览、审核与非剪贴板回填流程。

- 不是真实学习通页面，**不包含真实选择器、真实账号或用户资料**。
- 页面不发起任何真实网络请求：`window.fetch` 与 `XMLHttpRequest.send` 被替换为“只计数、不发送”，表单 submit 一律 `preventDefault`。
- 每个页面在页头 HTML 注释中写明预期行为与验收点。
- 与扩展适配器的 DOM 契约由 [extension-dev](https://example.invalid)（本次协作成员）与 fixture 负责人共同确认；改动属性名必须同步更新本文件与扩展适配器。
- 事件计数与验收见适配规格 §7（`docs/xuexitong-extension-adaptation.md`）。

## 1 通用 DOM 契约

| 标记 | 位置 | 含义 |
|---|---|---|
| `data-fixture` | `<html>` | 取值：`practice`、`graded`、`changed-question`、`prompt-injection`、`no-paste`、`selection-disabled`、`controlled-input`、`readonly-field`、`autosubmit-field`、`iframe-question`（帧内文档为 `iframe-question-frame`）。 |
| `data-page-kind` | `<html>` | `PRACTICE` / `GRADED` / `UNKNOWN`。缺省时扩展可按 fixture 名推断，但不应依赖推断。 |
| `data-question-container` | 任意元素 | 单题容器，可多题。扩展只处理用户确认的一个容器。 |
| `data-question-type` | 容器 | `SINGLE_CHOICE` / `MULTIPLE_CHOICE` / `TRUE_FALSE` / `FILL_BLANK` / `SHORT_ANSWER` / `UNKNOWN`。 |
| `data-question-stem` | 容器内 | 题干元素，取 `textContent`。 |
| `data-option` + `data-option-id` | 选项元素 | 选项 ID 由页面本地生成（`opt_1`…），radio/checkbox 的 `value` 必须等于该 ID；`<option>` 同样带这两个属性且 `value` 相同。 |
| `data-option-text` | 选项内 | 选项文本；缺省时取选项元素文本。 |
| `data-blank` + `data-blank-id` | input/textarea | 填空字段，ID 形如 `blank_1`；控件自身持有该属性。 |
| `data-answer-text` | textarea | SHORT_ANSWER 的文本答案控件（同时带 `data-blank`/`data-blank-id`）。 |
| `data-events-side-effect="AUTOSUBMIT"` | body / 容器 | 该页面/字段的 input 事件会触发站点自动保存或提交副作用；扩展必须在写入前拒绝。 |
| `data-controlled="revert"` | input | 受控字段：change 后页面恢复初始值，用于验证 `VALUE_REVERTED`。 |
| `data-unknown-editor="true"` | contenteditable | 未验证编辑器，扩展必须报告 `CONTROL_UNSUPPORTED`，不得用 innerHTML/execCommand。 |
| `data-graded="true"` | body | 计分/考试页标记（同时 `data-page-kind="GRADED"`）。 |

扩展可用 `window.__fixtureMeta = { fixture, pageKind }`（只读）读取元数据，但不应依赖它。

## 2 事件计数

每个页面（含 iframe 内文档）暴露：

```js
window.__counters   // 只读 getter 视图：input / change / paste / keydown / submit / fetch / xhr / copy
window.__fixtureEvents // 同一份数据的只读别名：input / change / paste / keydown / submit
```

- 属性只有 getter，没有 setter；写入不会被接受。`Object.getOwnPropertyDescriptor(window.__counters, "input").set` 为 `undefined`。
- 页头有 `#reset-counters` 按钮（文案「重置计数」），重置全部计数并刷新页面显示。
- `fetch` / `xhr` 计数表示页面世界中的尝试次数；页面会拦截且不发送。扩展集成测试还应使用 Playwright 的 `request` 事件独立验证“采集不发请求”。
- `submit` 计数由页面模拟（`preventDefault` 后计数），**绝不调用** `form.submit` / `form.requestSubmit` / 点击真实提交按钮。graded 页的「提交试卷（模拟）」按钮也只计数。

## 3 Fixture → 验收点映射

| 文件 | 页面类型 | 核心验收（适配规格 §7） | 关键实现点 |
|---|---|---|---|
| `practice.html` | PRACTICE | 主流程可用：采集→预览→审核→回填→回读；零提交 | 5 个容器：radio 单选、checkbox 多选、select 单选、两个 input 填空、textarea 简答 |
| `no-paste.html` | PRACTICE | paste/beforepaste 被阻止仍可控件写入；paste 计数保持 0 | 页面保留站点 paste 处理器；扩展不得删除或模拟粘贴 |
| `selection-disabled.html` | PRACTICE | Selection 为空仍能读取确认的单题 | `user-select:none` + 阻止 copy/selectstart/contextmenu + 清空选区 |
| `controlled-input.html` | PRACTICE | 渲染后状态被恢复时准确失败，并报告部分填写 | `blank_1` 正常、先写入；`blank_2` 在 change 后恢复初始值 → `VALUE_REVERTED` / `PARTIAL_FILL` |
| `readonly-field.html` | PRACTICE | 不更改 readonly/disabled，不写入 | readonly input、disabled input、disabled radio |
| `autosubmit-field.html` | PRACTICE | 写入前拒绝；无提交副作用 | `data-events-side-effect="AUTOSUBMIT"`；input 只增加 submit 计数 |
| `iframe-question.html` | PRACTICE | 有权限框架文档绑定正确；无权限明确降级 | 同源 `#question-frame` + sandbox 无 `allow-same-origin` 的 `#cross-origin-frame`（不产生网络） |
| `changed-question.html` | PRACTICE | 题目/映射变化后零写入 | 载入 1500ms 后自动改题干/选项；`#simulate-question-change` 立即触发；DOM 修改不派发事件 |
| `graded.html` | GRADED | 不回填、不提交 | 计分横幅 + 禁用回填；提交按钮只 `preventDefault` + 计数 |
| `prompt-injection.html` | PRACTICE | 题干指令不改变工具/页面操作；未知编辑器不支持 | 转义的 `<script>` 文本、`window.__injectionExecuted=false` 金丝雀、contenteditable UNKNOWN 容器 |
| `iframe-question-frame.html` | （帧内文档） | 同上 | 同源 iframe 的题目文档，独立暴露 `window.__counters` |

## 4 运行浏览器行为测试

本目录的 fixture 自身行为由 Playwright 测试验证（不需要扩展构建产物）：

```powershell
npx playwright test -c tests/fixtures/playwright.config.ts
```

扩展集成测试见 `tests/extension/`（需要先构建 `apps/extension/dist`）：

```powershell
npx playwright test -c tests/extension/playwright.config.ts
```

## 5 明确不支持 / 未验证

- 未基于真实学习通页面实现或验证任何选择器；本目录页面均为合成页面。
- `iframe-question.html` 的“跨域”是无权限 sandbox 框架模拟，不是真实第三方站点。
- 真实学习通兼容性必须按适配规格 §8 记录到 `docs/compatibility.md`。