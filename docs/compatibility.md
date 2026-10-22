# 学习通插件兼容性与验证记录

**0.2.4 签到表和双栏预览**：彩色题号＋按需Markdown/图片弹窗，不新增站点映射；删除本地图像400KB拒绝及原图编码总预算，保留CORS/真实任务/回读限制。旧后端OpenAPI中的历史body大小不用于独立版直连请求，实际供应商限制仍由上游返回。见[本次说明](question-board-0.2.4.md)。

**0.2.3 调度与界面**：READ_ONE复用已验证describe读取路径，保持课程/任务/题号绑定；边扫描边发，最终按序核验回填。图像后台重试后仍无答案才汇总；预览与复制独立于运行锁。无新增真实DOM映射、权限、依赖；真实供应商空响应原因和真站完整端到端结果本轮未验证。见 [说明](async-scan-ui-0.2.3.md)。

**0.2.2 图片与录入流程**：完整题图覆盖已支持的主题选项列表，边栏附 opt_N 标记；缺少上下文的第二阶段与每题图片按钮直接采用该次图片回答，不与旧样本投票。逐题录入和草稿保留有独立回归。复用已有选择器，无新增真实站点控件映射、权限或截图能力；新增图像选项场景用合成 Fixture 验证，未据此声称真站端到端成功。详见 [本次流程](image-retry-entry-flow.md)、验收§9.33。

**v0.2.0（2026-10-20）最新本地验证**：27 文件 / 403 单测、11 契约单测、22 Fixture 浏览器用例、28 MV3 集成用例通过，类型/构建成功。填空按明确编号写入、已命名控件换序拒绝、混合答案字段拒绝并格式重试、无多数结果不自动回填；未增加站点选择器或 manifest 权限。编号文本框列表使用合成回归，真实站点的新行为未重新实测。更新菜单仅处理公开版本清单；详见 [本轮检查](project-audit-2026-10-20.md)。下方旧数字是历史记录。

2026-10-19 新增课程自动运行分支，独立于原 `PageAdapter` 手动模式。实际观察的章节测验 DOM、控件、提交窗口与限制见 [course-automation.md](course-automation.md)。用户已明确授权该模式自动处理章节任务；正式考试与未知页面不支持。真实账号端到端结果以验收最新记录为准；不能沿用下方手动模式的“全部计分页拒绝”作为新模式的完整描述。

该分支现优先读取源数据、还原已匹配字体，0.2.3按题扫描即并发发送，汇总排序回填；仅不确定时追加两次，图片不清最后汇总补答，可从指定题开始。模式为「刷题（仅题目任务）」「刷课（视频＋题目）」「只刷课（仅视频，题目任务显式跳过）」三种。真实 37 题源数据及正常视频播放已有证据，完整提交、视频完成回执仍未验证；视频弹题自 2026-10-19 22:4x 起按用户授权做**结构性枚举作答**（§6.3，真实弹题 DOM 仍无证据），详见验收 §9.12/§9.23。

版本：1.1　日期：2026-10-19　适配器：`fixture.practice` v1.0.0（合成 Fixture）、`xuexitong.graded` v1.0.0（真实学习通计分页识别，仅拒绝）

## 0 结论摘要

- **可回填页面只验证了合成 Fixture。** 真实学习通页面目前只有一个「计分页识别适配器」`xuexitong.graded`：它只识别并拒绝，不采集题文、不建回填计划、不写入；本文件不宣称任何真实页面可回填，也不包含真实站点选择器。
- 扩展已实现：单题 DOM 采集（用户确认容器）、预览、显式发送、审核、非剪贴板控件写入、立即回读 + ≤1 秒有界渲染复查、14 个本地故障码、消息校验与最小权限构建。
- 真实学习通适配器必须获得脱敏 DOM 样例、人工验证记录后才能加入本文件；在此之前，真实页面只会得到 `ADAPTER_NOT_MATCHED`，回填默认关闭。
- 无法确认页面性质时记录 `Unknown`，不依据页面文字猜测为练习。

## 1 证据分级

| 级别 | 含义 | 本文件中的例子 |
|---|---|---|
| Verified | 实际执行的命令或人工操作 | 扩展 vitest（2026-10-20 修复轮：26 文件 / 383 项）、vue-tsc typecheck、build 产物与 manifest 检查、MV3 e2e 26/26 |
| Static analysis | 只读代码/产物检查，未运行页面 | 源码禁忌调用扫描、构建产物扫描、manifest 权限断言 |
| Unverified | 受页面资料、浏览器或环境限制 | 真实学习通 DOM、真实站点输入事件副作用、浏览器级扩展集成最终结果（由 `tests/extension` 负责人记录于 `docs/acceptance.md`） |

## 2 适配器清单

| 适配器 ID | 版本 | 匹配条件 | 页面类型 | 采集 | 回填 | 证据 | 限制 |
|---|---|---|---|---|---|---|---|
| `fixture.practice` | 1.0.0 | `<html data-fixture="…" data-page-kind="…">` 的合成 Fixture 页面 | PRACTICE / GRADED / UNKNOWN | 只读用户确认的一个 `[data-question-container]` | 仅 `matched && PRACTICE && 已验证事件策略` | `apps/extension/tests/fixture-adapter.test.ts`、`tests/fixtures-integration.test.ts` | 只识别 `data-*` 契约属性，不识别任何真实站点选择器 |
| `xuexitong.graded` | 1.0.0 | 仅 `*.chaoxing.com` 主机；顶层与同源子框架中同时出现「测验/考试/作业」类词与「总分/题目数」类词 | GRADED（其他情况一律 UNKNOWN） | **不采集** | **不回填**（采集与建计划均返回 `PAGE_KIND_UNSUPPORTED`） | `apps/extension/tests/xuexitong-graded.test.ts`；真实页面观察见 §6.1 | 关键词启发式；不保存、不发送任何页面文本；跨域框架不读取 |

适配器源码：`apps/extension/src/page/practice-fixture.ts` 与 `xuexitong-graded.ts`；注册表：`apps/extension/src/page/registry.ts`（注册上述两个手动适配器；课程自动运行使用独立的 `CoursePage` 页面适配器）。

## 3 合成 Fixture 验证矩阵

| Fixture | 页面类型 | 采集 | 回填 | 回读/失败结果 | 事件与网络 |
|---|---|---|---|---|---|
| practice.html（5 容器） | PRACTICE | 5 个候选容器，用户选择 | radio / checkbox / select / 两个 input / textarea 全部写入 | 全部 `FILLED`，回读值一致 | submit=0、fetch=0、xhr=0、paste=0、keydown=0 |
| no-paste.html | PRACTICE | 读取单题，不依赖 Selection | 两个 input 控件写入 | `FILLED`，回读一致 | paste=0、submit=0 |
| selection-disabled.html | PRACTICE | Selection 为空仍可读取 | radio 写入 | `FILLED`，回读一致 | copy=0、submit=0 |
| controlled-input.html | PRACTICE | 读取单题 | 先写 blank_1，blank_2 在 change 后恢复原值 | `PARTIAL_FILL` + `VALUE_REVERTED`，已写字段数 1、持久 1 | input/change 计数增加，submit=0 |
| readonly-field.html | PRACTICE | 读取单题（可预览） | 拒绝写入 | `FIELD_READ_ONLY`，readonly/disabled 属性未变 | input/change/submit=0 |
| autosubmit-field.html | PRACTICE | 读取单题（可预览） | 写入前拒绝 | `EVENT_SIDE_EFFECT_UNVERIFIED` | input/change/submit=0，页面自动保存标记未触发 |
| changed-question.html | PRACTICE | 读取单题 | 变化后重新校验拒绝 | `QUESTION_CHANGED`，零写入 | input/change/submit=0 |
| graded.html | GRADED | 采集阶段即拒绝 | 不回填 | `PAGE_KIND_UNSUPPORTED` | submit=0 |
| prompt-injection.html | PRACTICE | 注入文本按题目数据采集；未知编辑器容器拒绝 | 第一个练习容器可回填；contenteditable 容器 `CONTROL_UNSUPPORTED` | `FILLED` / `CONTROL_UNSUPPORTED` | 注入脚本未执行，submit=0 |
| iframe-question.html | PRACTICE | 同源 `#question-frame` 内单题 | 写入同源 iframe 文档 | `FILLED`，回读一致 | iframe 内 input>0、submit=0；跨域 sandbox 框架未访问 |

自动化证据（2026-10-20 修复轮实际执行）：

```text
npm run test -w @study/extension
Test Files  26 passed (26)
     Tests  383 passed (383)
```

其中 `tests/fixtures-integration.test.ts` 直接读取 `tests/fixtures/*.html`，在 JSDOM 中执行页面脚本后调用真实适配器完成上述矩阵。

## 4 控件写入与回读机制

| 控件 | 写入 | 回读 | 拒绝条件 | 预览/计划字段 |
|---|---|---|---|---|
| TEXT_INPUT | 控件原型上的原生 `value` setter | `value` | readonly、disabled、inert、aria-readonly、不可见、多行文本 | `option/blank` 字段 |
| TEXTAREA | 原生 `value` setter | `value` | 同上 | 简答/多行空格 |
| RADIO | 原生 `checked` setter（同组自动互斥） | checked 状态与 optionId | 同组不唯一、只读/禁用 | 单选、判断 |
| CHECKBOX | 原生 `checked` setter，勾选与取消勾选都显式执行 | checked 状态与 optionId | 选项缺失/重复、只读/禁用 | 多选（每个选项一个字段） |
| SELECT | 原生 `value` setter + 选项映射校验 | 选中项的 `data-option-id`/value | 选项缺失、控件不唯一 | 下拉单选 |
| CONTENTEDITABLE | 不写入（返回 `CONTROL_UNSUPPORTED`） | 不读取 | 全部 | 无 |

- 仅派发适配器确认无副作用且必要的 `input`/`change` 事件；事件由 `new Event(...)` 创建，天然不可信，**不伪造 `isTrusted`**。
- 不使用剪贴板 API、不模拟粘贴、不派发键盘事件、不点击按钮、不移除 readonly/disabled、不删除站点处理器。
- 写入后立即回读；随后在 ≤1 秒的有界渲染窗口内再次回读。被页面恢复 → `VALUE_REVERTED`；值不一致 → `VALUE_NOT_ACCEPTED`；中途失败 → `PARTIAL_FILL` 并报告已写/持久字段数；不自动重试、不提交。
- 该检查只证明检查窗口内的状态，不能保证未来页面逻辑不会改变值。

## 5 本地故障码覆盖

| 错误码 | 扩展内触发位置 |
|---|---|
| ADAPTER_NOT_MATCHED | 页面没有 `data-fixture` 或不在已支持 Fixture 列表 |
| PAGE_KIND_UNSUPPORTED | `data-page-kind="GRADED"` 或页面类型未知 |
| QUESTION_AMBIGUOUS | 多容器未确认、容器/选项/空格映射不唯一或超出限制 |
| FRAME_ACCESS_DENIED | 同源题目 frame 缺失/不可访问，或注入被拒绝；仅 host 权限不足时 detail 以 `permission: ` 开头，供 UI 提供可选授权，不新增故障码 |
| DOCUMENT_CHANGED | tab/frame/documentId/documentNonce 不一致、容器已脱离 |
| QUESTION_CHANGED | 重新采集的题目指纹或审核答案 digest 不一致 |
| FIELD_READ_ONLY | readonly、disabled、inert、aria-readonly、不可见 |
| CONTROL_UNSUPPORTED | contenteditable/未知编辑器、无写入器、控件类型不符 |
| UNTRUSTED_EVENT_REJECTED | 页面仅接受可信事件（能力保留，当前 Fixture 未触发） |
| VALUE_REVERTED | 有界复查发现值回到写入前状态 |
| VALUE_NOT_ACCEPTED | 回读值与审核值不一致且不等于原值 |
| EVENT_SIDE_EFFECT_UNVERIFIED | `data-events-side-effect="AUTOSUBMIT"` 等未验证事件页面 |
| CONFIRMATION_EXPIRED | 计划不存在、已消费、超过 5 分钟、nonce 复用或过期 |
| PARTIAL_FILL | 部分字段写入后失败，结果中报告 writtenCount/persistedCount |

## 6 真实学习通页面验证记录（§8 表结构）

**没有可用于回填的真实学习通页面记录。** 未获取题目容器的脱敏 DOM 样例，未做真实站点回填验证，因此真实页面回填兼容性均为 `Unverified`。仅有一条「计分页识别」的真实页面观察记录，见 §6.1。

| 页面来源与脱敏样例标识 | 浏览器 | 适配器版本 | 日期 | 题型 | 编辑器 | iframe 情况 | 禁止粘贴机制 | 练习性质证据 | 事件副作用 | 回读结果 | 限制 | 结论 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 无（未获取） | — | — | — | — | — | — | — | — | — | — | 无脱敏 DOM 证据，未实现可回填真实适配器 | Unverified |

真实适配器加入条件（缺一不可）：

1. 脱敏 DOM 样例标识与人工浏览记录；
2. 页面类型（练习）的明确证据，不能凭页面文字猜测；
3. 目标控件唯一、可见、启用、可编辑；
4. 事件副作用已确认不提交、不保存计分答案；
5. 浏览器版本、日期、成功/失败样例与限制写入本表。

### 6.1 真实学习通计分页识别记录（仅识别，不回填）

| 项 | 值 |
|---|---|
| 页面来源 | 用户在学习通课程中的「本章在线测验」页（`mooc1.chaoxing.com`），URL 参数与课程标识不在仓库保存 |
| 浏览器 | Google Chrome 155.0.8059.80（用户手动加载未打包扩展） |
| 适配器 | `xuexitong.graded` v1.0.0 |
| 日期 | 2026-10-19 |
| 题型 | 单选（页面显示 37 题、总分 100.0；**未读取任何题干或选项文本**） |
| 编辑器 | 未识别（不进入采集流程） |
| iframe 情况 | 未确认；适配器只读取顶层与可访问的同源子框架，跨域框架不访问 |
| 禁止粘贴机制 | 未测试（不属于本适配器目标） |
| 练习性质证据 | 页面可见「本章在线测验 / Total score: 100.0 / Number of questions: 37 / 任务点」→ 判定为**计分评估页** |
| 事件副作用 | 未触发任何事件（适配器不写入） |
| 回读结果 | 不适用（无写入） |
| 限制 | 关键词启发式，可能漏判；漏判时退回 `ADAPTER_NOT_MATCHED`（同样拒绝回填）。不采集题文、不发送、不提交 |
| 结论 | **GRADED：明确拒绝**（`PAGE_KIND_UNSUPPORTED`）。这是"拒绝"能力的验证，不是回填兼容性 |

### 6.2 真实章节测验提交确认弹窗（截图级证据，2026-10-19）

| 项 | 值 |
|---|---|
| 页面来源 | 学习通课程任务页的章节测验（`mooc1.chaoxing.com`），URL 参数与课程标识不在仓库保存 |
| 浏览器 | Google Chrome 155.0.8059.80（用户截图） |
| 观察方式 | 用户截图；**未取得脱敏 DOM**，扩展没有读取该页面结构 |
| 弹窗可见文本 | 标题 `Tip`，正文 `Submit?`，按钮 `Cancel`、`Submit`，右上角关闭图标 |
| 旧适配证据 | `#confirmSubWin` + 唯一 `a.bluebtn` 文案 `OK`；与本新皮肤不一致，所以旧 `CONFIRM_WORK` 不会点击，会在 60 秒后超时卡住 |
| 现实现 | 先按旧 DOM 证据匹配；未命中时使用**可见文本签名兜底**：同一可见小容器内必须同时出现一个含问号的提交确认问句、恰好一个确定按钮（Submit/OK/确定/确认/确认提交/提交/交卷）与恰好一个取消按钮（Cancel/取消/关闭）。按钮同时兼容 `button/a/[role=button]/[onclick]` 与精确文案的叶子 span/div。只在扩展自己点击提交按钮之后、且每任务最多尝试一次 |
| 事件副作用 | 点击的是页面自身弹窗按钮，由站点处理提交；不伪造事件、不改页面状态 |
| 回读结果 | 未验证 |
| 限制 | 该皮肤 DOM 仍为 `Unverified`：文本签名依赖站点可见文案（站点改文案会失配）；若弹窗位于 Shadow DOM 或控件没有任何可点击特征，仍无法识别 |
| 结论 | 文本签名成立时可自动确认；真实提交结果仍以验收最新记录为准 |

### 6.3 视频弹题（无真实 DOM 证据，结构性枚举，2026-10-19 22:4x）

2026-10-21 / 0.2.6：结构性实现补充小弹层内「嵌套选项列表＋外置确认按钮」，答错后重新读取相同选项，暂停/停止取消后续点击；启动时已有弹题先处理再播放。只在已识别 VIDEO 且播放器暂停时执行。证据为新增合成单测和真实 MV3 加载的合成媒体链路，**不构成真实学习通弹题 DOM 证据**。任务编号现限定既有 `/mooc-ans/knowledge/cards` 路径，避免媒体模块的 `num` 覆盖卡片编号；真实页面路径证据仍取自 §6.5。验证与限制见 [0.2.6 记录](course-playback-0.2.6.md)。

| 项 | 值 |
|---|---|
| 页面来源 | 尚未取得任何真实学习通视频弹题的脱敏 DOM（此前仅观察到“可选 AI 题”按钮，非强制弹题）。本条记录的是**用户授权下的结构性实现**及其证据状态 |
| 用户授权 | “刷课的时候中间可能有题目……不需要上报人工，直接撰写即可，因为只有对了才能继续，所以可以采用枚举的方法”（AGENTS.md 2026-10-19 22:4x 段；验收 §9.23） |
| 识别方式 | 不使用任何学习通弹题类名：同源文档中排除章节题目容器（`[id^="question"]`）后，找可见小容器（可见文本 ≤800 字符）＋互斥选项控件——可见原生 radio 组（≥2），或共享小父容器、带字母分隔符（`A.`/`（B）`）或布尔措辞（对/错/True/False）的选项行（≥2）；控件总数 2–12 才判为弹题 |
| 作答方式 | 按 DOM 顺序枚举点击站点自己的选项（复用章节题 `clickOption`）；弹题容器内恰有一个确认按钮（Submit/OK/确定/确认/提交/提交答案/交卷）时点击它；每个选项有界等待 ≈4.8 秒，容器消失或视频恢复即通过。不调用模型、不上报人工、只返回计数（题文/答案不离开页面） |
| 验证证据 | 单元测试（jsdom）：radio 弹题 A 错 B 对 attempts=2、无弹题 found=false、全选项失败、自定义行弹题、章节题选项不被弹题路径触碰；MV3 e2e（`tests/fixtures/automation-video-popup.html`）：运行页→background→内容脚本→夹具 DOM 全链路枚举通过、模型请求 0（验收 §9.23） |
| 限制 | 真实弹题 DOM `Unverified`：弹题在 closed Shadow DOM、选项无字母分隔/布尔措辞、控件 >12 或确认按钮不唯一时判为“未发现”，走原暂停恢复/停止路径（触发声音告警）；误判风险：视频暂停瞬间恰有其他 radio 组可见时最多点错该组选项一次；判错即锁定/计分的弹题皮肤需取得脱敏 DOM 后改为一次性作答策略 |
| 结论 | 结构成立时可自动枚举作答；真实学习通弹题兼容性待脱敏 DOM 证据后升级为精确适配 |

### 6.4 独立作业/测验作答页（dowork，2026-10-20，仅路径与题库结构复用，外层 DOM 未取证）

| 项 | 值 |
|---|---|
| 页面来源 | 用户提供的真实地址路径 `/mooc-ans/mooc2/work/dowork`（学习通课程域，带 `courseId`/`classId`/`workId`/`answerId` 参数）；仓库不保存完整 URL、课程标识或题文 |
| 用户授权 | 截图 + 原话「这也算上，可以刷题」；澄清确认：纳入可运行/刷题范围，整卷核验后自动点站点提交。记入 AGENTS.md 2026-10-20 段；验收 §9.27 |
| 识别方式 | 只接受上述已确认路径（忽略末尾斜杠）；`/exam`、`/examination` 等正式考试路径仍拒绝。**不新增页面级选择器**：题目容器/题型标签/选项行/隐藏答案/UEditor/提交按钮/确认弹窗全部复用 §6.1、§6.2 已记录的题库结构 |
| 完成判定 | ①结果视图中明确的「提交成功/已提交/提交完毕/交卷成功/查看答案/重新作答」文本节点（跳过 `script/style` 等非渲染内容），或②本页已点提交且作答视图消失（题面与提交控件都不再出现；仅隐藏提交按钮不算）；站点跳转离开作业页时计为已提交。均不推断成绩 |
| 证据状态 | 外层页面 DOM **Unverified**：未取得脱敏 DOM；内部题库结构证据来自 §6.1（同一题库组件）。运行时结构自检失败（无题目容器 / 提交按钮不唯一 / 提交前回读不一致）即停止，不猜选择器 |
| 验证证据 | 单元测试：独立页快照与路径/考试判定、未填满拒提交、不重复提交、两条完成证据；MV3 e2e（`tests/fixtures/automation-work.html`）：运行页→background→内容脚本→夹具 DOM 全链路整卷回填、回读核验、提交一次、结果视图确认（验收 §9.27） |
| 限制 | 若真实页面把题目放在跨域框架、提交按钮不唯一、或提交后无结果文案且不跳转，会以明确错误停止并提示人工；不重复提交、不伪造完成 |

### 6.5 无任务的静态图文卡片（2026-10-20，真实 DOM 只读取证）

用户截图显示上一测验已确认完成，进入「每节一句」后报「当前任务类型尚未适配」。真实 Chrome 标签只读取证：顶层课程页有 `#iframe`，目标框架路径 `/mooc-ans/knowledge/cards`、`num=4`；框架 `readyState=complete`，`.ans-job-icon` 数量为 0，无子 iframe；`#cardFocus` 是独立的空焦点节点，内容在 `#pageDiv.ans-cc`，后代标签仅 `H2/SPAN/IMG/P/BR`。图片处于 `SPAN.ans-img-wrap` 下，`complete=true`、`naturalWidth=678`。不保存图片内容、完整 URL、课程标识或 HTML。

顶层 `#prevNextFocusNext` 是可见 DIV，class 含 `prev_next next`，无 `disable` 和 `aria-disabled=true`；按正常站点 Next 点击后进入下一章节 `num=0`。下一页是带任务标记的 PDF 模块，尚未完成，不能按本规则跳过。两次截图采集均超时，真实导航结论依据浏览器 DOM/可访问树，不声称取得截图或新版扩展真站运行证据。

新增识别限定上述 cards 路径、加载完成、可见静态内容容器、无任何子 iframe、图片均已加载；只允许常规静态排版标签，交互控件/显式 role/contenteditable 不接受；全页存在任何任务标记即不归类 MATERIAL。NEXT 前重读快照，仍要求满足该分类。连续资料页由已有任务链按站点 Next 逐页寻找后续任务，复用任务键循环检测和 25 秒导航超时；不改权限、不改完成标记、不提交内容。

验证：脱敏结构单测与真实 MV3 合成链路「测验提交→图片格言→普通文字→下一测验」通过；完整验证见验收 §9.28。真实已加载扩展尚未刷新，新版在用户站点连续运行仍为 Unverified。

### 6.6 Resource Analysis 代码图片与多个填空（2026-10-20）

用户截图：题型标签 Resource Analysis，题干代码图片中有两个编号空格，页面显示 No.1/No.2 两个作答区域；模型请求却被归成简答、`blanks=[]`，产生“缺少 blankId/程序代码”的回复；采用单个 textAnswer 后报“答题控件在回填前发生变化”。代码核对发现 UNKNOWN + 文本控件分支无条件给 SHORT_ANSWER，且显式 SHORT_ANSWER 标签在 describe 中可变为多空，但 applyType 又读回原标签，两个入口规则不一致。

修复以已支持控件的实际数量统一映射：多于一个文本控件为 FILL_BLANK、逐个给 blank_1/blank_2 等 ID，单个仍为 SHORT_ANSWER；显式简答标签的多控件布局在读取与回填两侧复用同一规则。没有新增学习通私有选择器；保留未知控件、答案不完整、真实控件数量变化和回读不一致时拒绝提交的守卫。不得按猜测把单段 textAnswer 拆分到多个空。

真实页面只读取证时已处于提交后的结果视图，不重开修订、不改已提交答案。三张题图（含本题代码图）均在 `.Zy_TItle` 内，本题图尺寸 469px 宽且已加载；因此本次没有证据表明取图根选择器遗漏图片，也没有扩大图片采集范围。原始可编辑控件的真实 DOM 未重新取得，控件数量证据来自用户截图；两种布局的写入用现有适配器合成测试验证。

原图重试识别新增 NEEDS_CONTEXT 中“缺少/未提供程序代码、空白标记或编号”等描述，复用现有 CORS 原图通道，避免用同一份部分输入再投票。模型真实收到图像、其视觉能力与修复后真站回填仍待重新加载后验证；合成回归结果见验收 §9.29。

新增浏览器回归首跑进一步暴露原图通道的实际加载顺序错误：匿名 Image 的 `src` 在 `await load` 之后赋值，跨域原图因此总是等到超时，返回“没有可读取的原图”。修复为先设置匿名模式和事件处理器、立即赋值 src 再等待；CORS 限制、超时、总大小上限均保留。新增匿名图片加载单测及完整浏览器链路，不只断言请求里存在 data:image 字符串。

### 6.7 章节未完成提示框（2026-10-20）

用户截图：Notice，“There are still some unfinished tasks in the current chapter. Do you want to complete them?”，按钮“to learn”与“Next”。取证时弹窗已由用户关闭、课程已进入后续章节；仅只读核实顶层 DOM 中保留的两个隐藏模板，没有打开旧任务或改动页面：

| 皮肤 | 容器 | 返回学习 | 跳到下一章节 | 其他控件 |
|---|---|---|---|---|
| 新 | `.maskDiv.jobFinishTip`，内层 `.popDiv.wid440.popMove` | `a.popMoveDele`，文本 `to learn` | `a.nextChapter`，文本 `Next` | `a.preChapter`（Previous）、关闭控件 |
| 旧 | `#jobFinishTip.AlertCon02`，内层 `.con03` | `a.nextbutton`，文本 `to learn` | `a.nextChapter`，文本 `Next` | `a.preChapter`（Previous）、标题 Notice |

仅在容器可见、正文匹配未完成章节提示、目标唯一且可交互时处理；不匹配任意 Notice/Submit 弹窗、不点 Previous/关闭、不调用站点私有函数。新固定指令 CONFIRM_NEXT 必须绑定课程/任务；默认选择返回学习，只有模式显式授权跳过当前 VIDEO/QUIZ 时才点 Next。相同可见按钮不会在轮询中重复点击；新 NEXT 尝试/关闭提示/释放运行后清理确认状态。

任务链每次启动先处理遗留弹窗，NEXT 后 25 秒窗口内轮询迟到提示。返回学习且仍在原卡片时，撤回该卡片此前暂计的完成/跳过计数、重读剩余任务并允许原键继续一次；同一卡片反复返回未完成则停止，防止重复答题/提交。若站点仍称有未完成但快照不能定位任务，不会当作完成或强行跳过。

真实模板 DOM 为 Verified（只读），新版本真实点击/连续运行为 Unverified；完整 MV3 合成新旧边界验证与同页补齐/模式跳过流程见验收 §9.30。没有保存完整 URL、题目、课程标识或 HTML。

### 6.8 延迟填空编辑器：稳定槽位与可见编辑器不同（2026-10-20，0.2.1）

Read-only DOM evidence confirms separate placeholder slots and hidden editor wrappers. The new writer activates one slot at a time. Real course writes were not performed in this investigation.

本轮用户提供第6/7/8/11/12/16/17/18题错误文本：回填前指纹失败，且两空只读到一空、五空被归简答。通过用户当前课程页的既有同源嵌套框架只读核实，未点题目、未修改答案、未提交；结构按以下方式脱敏，未保留实际课程/题目标识、题文或答案：

```text
#questionN > .TiMu
  .Zy_TItle                       # 完整题干/程序/附图
  ul.Zy_ulTk
    .blankItemDiv
      .blankItemInp               # 每个逻辑输入位置，关闭时仍显示
        .InpDIV#inpDivN_k          # 已有答案显示/打开输入位置
        .textDIV                  # 当前观察 display:none
          .edui-* > iframe#ueditor_k
          textarea#answerEditorN_k # display:none，唯一且同属于该空
```

第6题有2套、第12题有5套、第16题有2套、第17题有3套；它们不是单个简答输入框。关闭时 iframe 自身 CSS 可仍为 inline，但祖先 `.textDIV` 为 none。旧 describe 点开所有 `.InpDIV` 后立即按可见 iframe 计数，异步初始化/切换导致少读；后续捕获/切换又让指纹字段数或所属编辑器改变，触发“题目内容已变化”。

新增 `LAZY_UEDITOR` 仅匹配每套唯一 `.InpDIV` + `.textDIV textarea[id^=answerEditor]`、最多一个 ueditor iframe 的已观察布局。按稳定占位槽位和对应存储字段 ID 固定数量/顺序，采集不激活编辑器；回填经站点自身点击逐空打开，最多等待2.5秒同源可编辑 body 和可见 iframe，再写纯文本。编辑器工具图片不属于题干变化。异步等待后、每次写入前继续核对题文/槽位；只读、禁用、未知结构、槽位数量或顺序变化仍拒绝，不强制显示隐藏控件，不直接修改隐藏 textarea，不绕过原有守卫。

验证：合成延迟初始化、全页仅一个活动编辑器的 `automation-lazy-blanks.html`；只读读取2/5/2空不点开，逆序模型返回按 blankId 分配，逐空回填核验，提交/确认仅一次。实际站点本轮未重载/执行新版，真实交互仍 Unverified；完整结果见 [修复记录](blank-editor-fix-2026-10-20.md)。

### 6.9 同一卡片视频、测验与资料模块（2026-10-21，0.2.7）

Read-only Java-course evidence: each `.ans-attach-ct` marked module contains one `.ans-job-icon` plus one iframe. Video and work paths are `/ananas/modules/video/index.html` and `/ananas/modules/work/index.html`. A completed video and an unfinished quiz share one card, matching the reported end-of-video stall.

真实 Java 课程只读取证：`.ans-attach-ct` 中各有一个 `.ans-job-icon` 和 iframe，视频额外含 `videoContainer`，完成模块含 `ans-job-finished`；video/work使用上述固定路径。同卡片视频完成而测验未完成，与截图一致。现按模块分别绑定任务键、选择播放/读题作用域及完成标记，站点Next前先处理同卡片后续模块。PPT/PDF只复用既有PDF路径；未取得任意其他PPT皮肤证据。完整行为、用户授权、验证和限制见 [0.2.7记录](course-playback-0.2.7.md)。

### 6.10 视频定位末尾与资料滚动到底（2026-10-21，0.2.8 M1，仅标准媒体/DOM 原语，不新增选择器）

用户授权「站点允许拖动时定位到末尾触发站点自身完成判定」「PPT/PDF 滚动到底促使站点完成，不伪造阅读时长」。本批**不猜测任何学习通专有选择器**（硬约束 §11），只用标准媒体与 DOM 几何：

| 原语 | 实现 | 边界与证据 |
|---|---|---|
| `SEEK_TAIL` | 只读 `video.duration/readyState/seekable.end()`，写 `video.currentTime = min(duration,seekable末) − 2s`；不派发合成鼠标/指针事件、不伪造 `ended`/`timeupdate`、不改站点完成标记；不可定位/未就绪返回 `applied:false` 交回完整播放 | 合成单测断言 applied→写末尾、length:0 拒绝、短片段拒绝、非视频任务拒绝；**真站是否允许拖动 Unverified**，运行器仅在播放位置≤10s 时试探，进度回退>3s 判 `denied` 并 `PLAY_FROM_START` 完整播放，可拖性按课程缓存 |
| `PLAY_FROM_START` | 写 `video.currentTime = 0` 后走既有 `startVideo` 静音起播链路 | 合成单测断言回卷到 0 并播放；仅作为拖动被拒后的回退 |
| `SCROLL_MATERIAL` | 容器只取 `doc.scrollingElement`（可滚范围>8），否则 `body` 内 `div/section/main/article` 中 `overflow-y:auto/scroll` 且可滚范围最大者；5 步 ~350ms 节奏 `scrollTo(0, max·i/5)` | 只用标准 `scrollTo/scrollTop/scrollHeight/clientHeight`，不点翻页控件、不改站点状态、不伪造阅读时长；合成单测断言无容器不滚、节奏 5 步到 `scrollTop≈800`、视频任务拒绝；跨域/不可滚框架如实上报不猜。**真站滚动是否触发完成 Unverified** |

三种命令完成证据仍是站点 `.ans-job-icon`（`ans-job-finished`）变绿；`allowVideoSeek`/`allowMaterialScroll` 为运行页默认开、可关的授权开关，关闭时行为与 0.2.7 完全一致。验证与限制见验收 §9.40。

### 6.11 章节横向标签栏与讨论入口（2026-10-21，0.2.8 M1，同源结构证据 + 跨源缺口如实记录）

2026-10-21 用户在真实课程页（`mooc1.chaoxing.com/mycourse/studentstudy`）截图指出章节顶部有一排横向标签，希望「这种横向的」「讨论题也走题目那套、能填就填」。本批落地**同源横向标签导航**，并如实标注**跨源讨论回帖**尚未实现。脱敏结构证据：

| 结构 | 真实观察（只读取证，无题文/URL/标识） | 适配处理 |
|---|---|---|
| 标签栏 | `ul.prev_ul` 内 `li#dct1..dct5`，`role=option`；当前项 class 含 `active`，其余为 `c1..c5`；每项 inline `onclick=changeDisplayContent(num,total,chapterId,courseId,clazzid,…)` | `sectionTabItems` 只取 `ul.prev_ul li`；不猜其它皮肤 |
| 分区映射 | 站点自身 `changeDisplayContent` 把内容 `#iframe` 的 src 改写为 `/mooc-ans/knowledge/cards?…&num=(tab−1)`：1 学习内容→num=0、2 讨论→num=1、3 教学课件→num=2、4 教学视频→num=3、5 评估测试→num=4 | `SWITCH_SECTION_TAB` 点击 `li#dct{tab}` 触发站点导航，再轮询（≤30×~200ms）等 `active` 类落到该页且 `#iframe` 卡片 `num==tab−1`；两者都成立才 `confirmed:true` |
| 安全边界 | 标签只是同源分区切换，不涉及提交/跨源 | 缺 `sectionIndex` 或独立作业页直接拒绝；越界(0/6)、非整数、其它动作携带的 `sectionIndex` 由 `parseAutomationCommand` 丢弃；`confirmed:false` 时运行器停止，不假定分区可达；切换后清空在途流水线，真正任务内容以之后 INSPECT 为准 |

**同源部分**：`SWITCH_SECTION_TAB` 已在 protocol + `CoursePage` 实现并有合成单测（讨论页签确认 `activeIndex:1/loadedNum:1/activeLabel:"讨论"`、缺序号失败、站点未移动 `confirmed:false`、工作页拒绝、解析越界丢弃）。**真站标签切换与运行器自动遍历各分区仍 Unverified**——本批未把该动作接入 `runLoop` 的自动推进，只完成可被调用的适配与取证。

**跨源缺口（如实记录，未实现）**：讨论**主题的回帖页**开在 `groupweb.chaoxing.com/…/replysList`，是**独立标签、独立源**（上一会话取证：题干 `.topicDetail_replyTitle`、回帖 `.replyEdit textarea`、发表 `div.replyBtn`、回复列表 `.topicDetail_replyList`）。要实现「按题目管线读题→AI→回填→发表→核验回帖出现」，须先：①在真站重取一份 replysList 脱敏 DOM 证据（本批目标章节无讨论主题、回帖标签已关闭，取证不完整，绝不凭记忆造选择器）；②新增 `https://groupweb.chaoxing.com/*` 可选 host 权限；③给仅绑定单一 tabId 的运行器加上跨标签命令路由。三者齐备前，讨论自动回帖不落地、不发布。验证与限制见验收 §9.41。

### 6.12 横向遍历与独立讨论草稿（2026-10-21，本轮真实只读取证）

2026-10-21 最初实现只填讨论草稿；2026-10-22 用户明确要求所有模式自动提交，并选择包括自动发表讨论，覆盖原草稿限制。现完整回读后单次提交/发表，等待实际结果，再继续原课程；只刷课仅提交已有完整答案或草稿，不生成缺答。

| 结构 | 本轮真实观察（不保存页面 HTML、题文、课程 ID 或完整 URL） | 适配 |
|---|---|---|
| 讨论入口 | cards 内 `/ananas/modules/insertbbs/index.html`，再嵌套 `iframe#frame_content` 指向 `/mooc-ans/bbscircle/chapter`；唯一可见 `#topicMainDiv.PublicCardBox[onclick="openTopicUrl()"]`，其 `data` 属性含完整目标地址（2026-10-21 用户失败页重新取证） | `OPEN_DISCUSSION` 读取并核验此目标；后台通过 `chrome.tabs.create` 直接打开，不依赖网页弹窗 |
| 独立页面 | HTTPS `groupweb.chaoxing.com/course/topic/v3/bbs/{topic}/{thread}/replysList`，带 courseId/classId | 仅匹配此主机和路径；新标签必须属于相同课程/班级；不接管已有标签或任意当前激活标签 |
| 原题 | `#bbsTopicDetail .topicDetail_title > span` 标题；`#bbsTopicDetail .topicDetail_main .replyContent` 正文 | 只读原题，排除教师信息、同学回复和输入框；图片渲染复用该已确认正文根 |
| 回复框 | `.replyEdit .textareawrap textarea`，真实页面唯一、可见、非只读、非禁用 | 原生 value setter + input/change/blur；400ms 后核对题干指纹、控件身份与完整值；不覆盖已有不同草稿 |
| 发表控件与结果 | 回复区唯一可见 `.replyEdit .addReply`；真站浏览器工具单次点击用户已有草稿后，`.topicDetail_replyList` 新增有 id 的直接子项 `.topicDetail_replyItem`，含匹配的可见 `.replyContent`，回复框清空 | 完整回读后单次点击；必须同时见到新匹配项与原输入框清空才确认发表，不点击顶部 `.replyBtn`，不把发表当作站点任务点变绿 |
| 标签绑定 | 旧实现点击后按 `openerTabId` 寻找弹窗，用户真站反馈未找到新标签；不能确认当次是弹窗拦截还是归属丢失 | 改为只跟踪 `tabs.create` 返回的确切 ID；创建前与加载完成后均核实精确主机、路径、课程班级；不查找或接管其他标签 |

生产 manifest 的必选权限与可选权限声明不变；讨论站点在运行页由用户点击单独申请精确 Origin，未授权即停止。浏览器集成测试的两个 HTTPS Origin 仅加在临时复制的测试 manifest 中，所有页面本地合成拦截，绝不修改生产权限。

本轮还将 NEXT 接入「同卡片模块优先→后续可见 dct1..dct5 页签→站点 Next」；有未完成任务则保留原跳转守卫。模块重排按 DOM marker 身份保持当前任务；单个模块结构异常只阻塞该未知模块，不清空正常兄弟模块。卡片身份优先使用主 #iframe 的 num/knowledgeid；切换时等待新文档加载，不能只见 src 改变就处理旧内容。完成类 `ans-job-finished` 支持已有真实证据中的绿色标记。

实际真站仅完成结构取证及浏览器工具填入一份未发表示例；新版扩展重载后的整课自动运行仍 **Unverified**。本轮验证与已知边界见 [检查报告](project-audit-2026-10-21.md)。

2026-10-22 补充：浏览器工具已发表一条用户已有草稿并观察到上述结果，未保存题文、回复、用户标识到仓库。新版扩展完整真实课程仍未执行。提交确认搜索修复为当前任务文档及其同源祖先文档（有界至根文档）；底层提交按钮仍限定任务文档，不扫描兄弟任务的确认框。重启时已有确认框也须先逐题 ADOPT_EXISTING/回读核验，再确认，不再次点击底层提交。

### 6.13 提交确认弹框渲染在父文档（2026-10-21，0.2.8 M1，用户真实截图取证）

用户真实课程页截图显示：章节测验的题目与站点「Submit」按钮位于嵌套任务 iframe（`/ananas/modules/work/index.html`）内，而点击提交后站点弹出的「Tip / Submit? / Cancel / Submit」确认框渲染在**顶层文档**，覆盖整个视口（含右侧 Content/Discussion 侧栏）。旧 `CONFIRM_WORK` 只在 `taskDocuments()`（任务帧子树）内找确认框，父文档的框被漏检，导致提交无法确认、表现为「没有自动点击提交」。

| 结构 | 真实观察（不保存页面 HTML、题文、课程 ID 或完整 URL） | 适配 |
|---|---|---|
| 提交按钮 | 任务帧内唯一站点提交控件（`a.btnSubmit` 或精确文案可见控件） | `SEND_WORK` 的提交按钮唯一性搜索**限定 `taskDocuments()`**，父页其它 Submit 不进入候选 |
| 确认弹框 | 顶层文档内一个小可见容器：含 `Submit?` 问句（`/[?？]/`＋`/submit/i`）＋恰好一个确认＋一个取消 | `submissionDocuments()` 从任务帧经 `frameElement.ownerDocument` **向上遍历至顶层（≤6 层）**，`CONFIRM_WORK` 在任务帧＋各祖先文档一并查找；仍受「唯一确认框」守卫约束 |
| 未作答告警 | 「还有 N 题未作答，确定提交吗？」类文案 | `genericConfirmButton` 明确排除，交回人工，不自动点确认（守「绝不提交缺题」） |

该提交路径为所有解答题目的模式共用（刷题、刷课、自动运行、独立作业/测验页）；**只刷课模式**按既有授权仍跳过题目、不提交，未改语义。单次提交、不重复点、完成只认站点绿标等硬约束不变。新增跨 realm 回归单测复现「题在子帧、框在父文档」并断言各恰好点一次。真站 Chrome 中父文档框被自动点下的实机观察仍 **Unverified**。

## 7 权限、消息与存储边界

| 项目 | 实现 |
|---|---|
| permissions | `activeTab`、`scripting`、`storage`、`sidePanel`（构建脚本断言，其他权限直接失败） |
| host_permissions | 仅构建时注入的后端 Origin（本地默认 `http://127.0.0.1:8080/*`；独立模式不使用该后端） |
| optional_host_permissions | `https://*/*`、`http://127.0.0.1/*`、`http://localhost/*`，默认均未授予。供应商请求由用户在设置页「授权此站点」逐个授予；课程读取只请求用户确认的具体 `*.chaoxing.com` HTTPS Origin（代码限制，见 `sidepanel/bridge.ts`） |
| 授权失败与撤销 | 拒绝/异常转手工输入；在 Chrome 扩展详情“网站访问权限”撤销；不增加 `tabs`，URL 不可见时用户输入并核对站点 |
| 授权后行为 | 仅重试读取；期间目标标签或站点变化则停止；仍只识别计分页并拒绝，不自动发送或回填 |
| 点击与标签 | Worker 加载/安装/启动重置 `openPanelOnActionClick=false`；读取时重新解析当前标签，切换标签清除旧流程；同源导航不自动撤销 activeTab |
| CSP extension_pages | `script-src 'self'; object-src 'none'; connect-src https: http://127.0.0.1:* http://localhost:*`（供应商直连需要放行任意 HTTPS Origin；非本机 http 明文仍被拒绝） |
| 禁止 | cookies、webRequest、debugger、`<all_urls>`、unlimitedStorage、externally_connectable、远程代码 |
| 页面消息 | 手动模式仅 `CAPTURE_SELECTION`、`CAPTURE_QUESTION`、`REVALIDATE_FILL`、`APPLY_FILL`；课程调度页另有固定 `INSPECT/READ_ALL/CAPTURE/ADOPT_EXISTING/APPLY/SEND_WORK/CONFIRM_WORK/NEXT/CONFIRM_NEXT/PLAY/PAUSE_VIDEO/ENUM_POPUP/RELEASE`；无通用 FETCH/EXECUTE/CALL |
| 消息校验 | `sender.id`、可信扩展页面路径、tabId/frameId、消息字节上限、planId/一次性 nonce、documentId/documentNonce、题目指纹 |
| Token | 仅 `chrome.storage.session`；local/session 均设置 `TRUSTED_CONTEXTS`；页面隔离世界无 storage 访问 |
| 题文/答案 | 仅侧边栏内存与页面隔离世界内存；不落库、不写 local storage；关闭面板即清除 |

## 8 环境与复现命令

- Windows 11，PowerShell；Node.js 22.22.2，npm 10.9.7。
- 类型检查：`npm run typecheck -w @study/extension`（vue-tsc 2.2.x + TypeScript 5.9.3）。
- 单元/集成测试：`npm run test -w @study/extension`（vitest 2.1.9，jsdom 25.0.1）。
- 构建：`node scripts/build-extension.mjs`（默认 local：`http://127.0.0.1:8080`）；产物 `apps/extension/dist/`。esbuild 已固定 `absWorkingDir`，从仓库根或 workspace 执行得到相同产物。
- 生产构建：`node scripts/build-extension.mjs --mode production --origin https://<真实后端>`，占位域 `.invalid`、非 HTTPS、含路径的 Origin 均会被拒绝。
- 浏览器级 MV3 集成：`npx playwright test -c tests/extension/playwright.config.ts`（需要先构建 dist）；2026-10-20 修复轮复跑 26/26 通过。
  - 本次交付期间的观察：23:26 的运行中 manifest、practice、graded、autosubmit 4 项通过；readonly 项因当时的 `captureFirstQuestion` candidate-list 竞态失败，fixtures-dev 已修复 helper 并重跑。**该失败不是扩展断言放宽或测试删除，最终浏览器结果以 acceptance 为准。**
- 已安装 Chromium（Playwright）版本：156.0.8078.4（`chromium-1248`）。

## 9 已知限制（按优先级）

1. **无真实可回填页面的 DOM 证据**：真实页面目前只会命中计分页识别器（拒绝）或 `ADAPTER_NOT_MATCHED`，回填关闭；需要 P5 阶段样例与人工验证。
2. **跨域 iframe 不支持**：不扩大权限；同源 fixture iframe 可采集/写入，跨域 sandbox 框架不访问。
3. **contenteditable/富文本/Canvas/Shadow DOM**：手动模式（`fixture.practice`）下未知编辑器仍返回 `CONTROL_UNSUPPORTED`，不使用通用 HTML 注入/浏览器编辑命令。课程自动运行分支自 2026-10-19 22:5x 起支持：通用 `[contenteditable=true]` 与纯输入框的纯文本写入（原生 setter + input/change/blur，回读一致才继续）、canvas/内联 SVG 绘制进题图、open shadow root 的文字读取；排序/连线/拖拽/画图/未知控件标记 `answerMode="NONE"` 不写入，转人工汇总（`answerReason` 说明原因）。closed shadow root、CSS background-image 图示、音视频/嵌入框架仍不支持转静态题图。
4. **受控组件**：只保证有界窗口内的回读；页面异步恢复可能晚于检查窗口（本实现最多等待约 1 秒）。
5. **只接受可信事件或写入会触发提交的页面**：不伪造事件、不探测提交；返回 `UNTRUSTED_EVENT_REJECTED`/`EVENT_SIDE_EFFECT_UNVERIFIED`。
6. **多选/下拉的站点私有状态同步**：仅通过原生 setter + 已验证事件同步；不调用站点私有函数。
7. **浏览器级扩展集成最终结论**：等待 `docs/acceptance.md` 汇总，本文件不替代。

## 10 变更记录

| 日期 | 变更 |
|---|---|
| 2026-10-18 | 首版：合成 Fixture 适配器 `fixture.practice` v1.0.0；控件写入器、回读与故障码；明确无真实学习通页面证据 |
| 2026-10-19 | 新增真实学习通计分页识别适配器 `xuexitong.graded` v1.0.0（只识别、只拒绝）；记录真实页面观察证据；测试增至 103 项 |
| 2026-10-19 | 课程调度提交确认：记录真实新皮肤 `Tip / Submit? / Cancel / Submit` 截图证据；`CONFIRM_WORK` 增加可见文本签名兜底（未取得 DOM），并保留旧 `#confirmSubWin` 证据路径；扩展测试增至 227 项 |
| 2026-10-19 | 非粘贴题目支持（课程自动化分支）：题图渲染纳入内联 SVG/canvas/open shadow root，音视频与嵌入框架显式转人工；作答控件新增通用 contenteditable 与纯输入框的纯文本写入（`answerMode`），未知控件 `NONE` 降级转人工汇总；限制清单见 §9.3（上条第 3 条）。同窗口另一会话并行注入视频弹题枚举/`videosOnly`/告警（授权记录待用户确认，见 course-automation 同名节） |
| 2026-10-19 22:4x | 上行所述并行改动正式落档（授权已由用户本轮对话直接给出并记入 AGENTS.md）：新增 §6.3 视频弹题结构性枚举记录（无真实 DOM 证据，明确误判/漏判边界）；`NEXT` 跳过授权扩展到未完成 QUIZ（只刷课模式）；`play()` 永不 settle 的 12 秒竞速上限；运行页声音告警。验证与限制见验收 §9.23 |
