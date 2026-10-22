# 刷题 / 刷课+刷题 自动提交在不同电脑不触发的根因分析（0.2.7）

- 分析对象：`apps/extension` 0.2.7 工作树（`manifest.base.json` version 0.2.7）。
- 性质：**只读代码分析**。本轮未修改任何源码、未改动 `dist`、未提交 git，只新增本报告文件。
- 用户反馈（0.2.7）：同一账号、同一课程，换一台电脑后，「刷课＋刷题」模式下题目能自动回填，但**不会自动提交，需要人工提交**。
- 行号均指当前工作树。任务描述里提到的 `fillAndSubmit` 在代码中并不存在：实际提交链是 `solveQuiz()` → `SEND_WORK` → `CONFIRM_WORK` 轮询 / `inspect()` 完成证据（`submitAndWait()`、`submitNow()`、`submitManual()` 真实存在，见 §1）。

> 结论先行：**自动提交不是"一个按钮没点到"，而是页面侧 S1–S5（提交前/点击）＋ 确认 C1–C3 ＋ 完成证据 G1–G2 ＋ 调度器侧 60s 等待/任务键切换/ERROR 恢复多级串联；任何一环失败都会直接落到 `ERROR`（响铃、红字、需要人工），其中"提交阶段失败"没有任何自动恢复入口。** 跨电脑差异只负责"触发"某一环，代码本身负责把一次瞬时环境差异放大成"每台机器上都要人工提交"。

---

## 1. 自动提交的完整判定链（gate：函数＋行号＋条件＋失败时用户可见结果）

### 1.1 谁会走到提交（4 个入口）

> 执行位置（决定哪些东西会被节流）：状态机 `CourseRunner` 在 **`runner.html` 普通标签页**里运行（`automation/main.ts` 挂载、`automation/App.vue:72-113` 构造并实现 `sleep/now/command`）；MV3 `background.ts` 只是消息转发的 service worker（没有任何业务状态，`159-170`）；真正的 DOM/点击在**课程标签**的内容脚本 `CoursePage`（`page-entry.ts:4-19`）。因此"运行页标签"与"课程标签"总有一个在后台，后台的那个所有 `setTimeout` 都会被 Chrome 节流。

| 入口 | 位置 | 前置条件 | 说明 |
|---|---|---|---|
| 正常任务链（刷课＋刷题 / 刷题） | `runner.ts:1034-1052` | 当前任务 `kind=QUIZ`、未完成、`questionCount` 合法 | 主路径：`solveQuiz()` → `SEND_WORK` → 每秒 `CONFIRM_WORK` + `INSPECT`，最多 60s |
| 独立作业/测验页 | `runner.ts:561-603`（`runStandaloneWork`） | `snapshot.standalone=true`（`/mooc-ans/mooc2/work/dowork`） | 单卷：`SEND_WORK` 一次 → 60s 内轮询；容忍 3 次 `INSPECT` 失败 |
| ERROR 后补答恢复 | `runner.ts:842-870`（`recoverFromError` → `submitAndWait` 811-834） | **`manualItems.length>0` 且全部 resolved**（843-844） | 只覆盖"有人工补答题"的 ERROR；**提交阶段失败（无 manualItems）不可达** |
| 用户手动「立即提交当前任务」 | `automation/App.vue:562` + `runner.ts:793-804`（`submitNow`） | 按钮仅在 `NEEDS_INPUT / ERROR / DONE` 可点 | 用户自己点；仍走 `SEND_WORK`，会被页面侧单次提交守卫拒绝 |

### 1.2 页面侧 `SEND_WORK` gate（`course-page.ts:1236-1248`）

| Gate | 位置 | 条件 | 失败时页面返回 / 用户可见结果 |
|---|---|---|---|
| S1 单次提交守卫 | `1237` | `!this.sendAttempted` | `"此任务已尝试提交，不自动重复提交。"` → runner `ERROR` + 响铃；`sendAttempted` 是页面侧内存标志，`RELEASE` 不清除（`1208-1219`），只有任务键变化（`938-942`）或课程页重载才会重置 |
| S2 全量回填守卫 | `1238-1239` | `work()` 找到题目文档（否则 `"题目文档已变化。"`），且 `applied.size === questionElements.length` | `"尚未完整回填本任务，拒绝提交。"` → `ERROR`；`applied` 在 `inspect()` 检测到任务键变化时被清空（`939-942`） |
| S3 提交前逐题回读 | `1240-1243` | 每题 `applied.get(i)` 存在、`fingerprint(el)===entry.fingerprint`、`answerDigest(readAnswer(...))===entry.answer` | `"提交前回读不一致，已停止。"` → `ERROR`；`fingerprint()`（`495-501`）含易变值，见 §3-H3 |
| S4 唯一提交按钮 | `1244-1246` | 搜索集 = `submitSearchDocuments(this.moduleRoot ?? this.root)`（`372-377` / `1244`），`submitControls()` 可见（`11-14`、`360-370`），去重后必须恰好 1 个 | `"无法唯一确认站点提交按钮（候选 N 个，已搜索 M 个同源文档）。"` → `ERROR` |
| S5 点击 | `1247-1248` | 先置 `sendAttempted=true` 再 `siteClick(buttons[0])` | 点击异常 → `ERROR`，且因 S1 后续不可重试 |

补充：`moduleRoot` 的赋值在 `inspect():931-937`（当前模块 iframe 的 `contentDocument`）；0.2.7 把"SEND/CONFIRM 的文档搜索"从整页收窄到模块 iframe 子树，见 §3-H2。

### 1.3 确认弹窗 gate（`course-page.ts:1249-1257`）

| Gate | 位置 | 条件 | 失败时用户可见结果 |
|---|---|---|---|
| C1 只在提交后确认、每任务一次 | `1250` | `sendAttempted && !confirmAttempted` | 否则静默 no-op |
| C2 识别弹窗 | `346-353`（旧皮肤 `#confirmSubWin` + 唯一 `a.bluebtn` OK）→ 兜底 `314-343` | 旧：可见弹窗内唯一 `a.bluebtn` 文案匹配 `OK/确定/确认提交`；兜底：可见小容器内 ①含 `?`/`？` 的提交问句 ②恰好 1 个确认按钮（`submit|ok|确定|确认|确认提交|确定提交|提交|交卷`）③恰好 1 个取消按钮；且问句不含 `未作答|未完成|还有|剩余|缺少|漏做|未答|尚未`（`323`） | 找不到就不点：弹窗一直开着 → 60s 后 `"站点尚未确认提交成功；不会重复提交或跳到下一任务。"`（`1052`）→ `ERROR`；用户只能**人工点弹窗的提交/确认**。UI 不显示"弹窗未识别"这一类具体原因 |
| C3 确认范围 | `1251` | 只遍历 `taskDocuments()`（= `accessibleDocuments(moduleRoot ?? root)`，`879-881`） | 弹窗若渲染在模块 iframe 之外的课程外壳文档，**永远找不到**（见 §3-H2） |

### 1.4 完成证据 gate（`inspect()` + runner 等待）

| Gate | 位置 | 条件 | 失败时用户可见结果 |
|---|---|---|---|
| G1 任务点完成标记（卡内任务） | `course-page.ts:943-952` | `markerCompleted(module.marker)`（`61-63`，只认 `aria-label` 匹配 `/任务点已完成|Task\s*completed/i`）；且若本轮启动过视频还须 `video.ended` | 标记不变 → 60s 超时 → `runner.ts:1052` ERROR（即使站点实际已收下提交） |
| G2 独立作业完成证据 | `course-page.ts:919-921` | `submittedCue(docs)`（`387-401`，仅渲染文本、跳过 `script/style`、排除题面容器）或 `sendAttempted && submit.length===0 && elements.length===0` | 两者都不满足 → 60s 后 `"已点击提交但站点未返回可核验的完成标记；不会重复提交，请人工确认页面结果。"`（`runner.ts:600`）→ `DONE`（不是 ERROR，但也没确认） |
| G3 站点自动切换 | `runner.ts:1049` / `591` | `snapshot.taskKey !== this.bound.taskKey` | 视为成功并继续（不点 Next） |
| G4 调度器等待窗口 | `runner.ts:1042-1051` | 60s、每 1s `CONFIRM_WORK` + `INSPECT`；`INSPECT` 抛错**不吞**（`1048`） | 超时 → ERROR；`INSPECT` 瞬时失败（页面跳转/iframe 重建/桥接失败）→ 直接进入 `runLoop` catch（`1205-1209`）→ ERROR |

> 注意 G4 与独立作业路径**不一致**：`runStandaloneWork` 对 `INSPECT` 连续失败容忍 3 次（`583-589`），主链一次失败就终止。

### 1.5 失败后的用户可见结果汇总

- 页面侧 `fail()` → `handle()` catch（`1296-1300`）→ `{ok:false,code:"CONTROL_UNSUPPORTED",detail}` → `automation/App.vue:72-81` port 抛错 → `runner.runLoop` catch（`1205-1209`）：`phase=ERROR`、`step="已停止，需要人工处理"`、红色 `runner-error`；`App.vue:211-220` 立刻响铃 3 声并每 30 秒重复，直到用户回到运行页（`onUserAttention`，`222`）。
- `phase=NEEDS_INPUT`（有题未回填/回读不一致转人工）：单声提示 + 汇总卡（`App.vue:595-645`），**无限等待**；用户此时若自己去站点点提交，就是"人工提交"。
- `submitAndWait`（`811-834`）失败只改 `state.step`（`828-829`、`831`），不进入 ERROR、不响铃。
- 运行页被关闭：`automation/App.vue:492-499` `runner.stop()` → `RELEASE`；状态全丢。
- 运行页被冻结/丢弃/崩溃：状态机与 `RunnerState` 全在运行页内存里，**没有任何持久化**，表现为"什么都不发生"。

---

## 2. 跨电脑差异因素清单（按影响提交链的环节组织）

### A. 视口 / 缩放 / 滚动 / 布局（直接影响 `visible()`）
1. `visible(el)`（`course-page.ts:11-14`）只判 `getClientRects().length` + 计算样式 `display/visibility`；`isDisplayed()`（`270-276`）另加 `opacity!==0`。二者**都不看视口交集、不看是否被 `overflow` 裁剪**，但以下情况会让它们为假：`display:none` 祖先、`content-visibility`、`display:contents`、未渲染/被站点折叠的任务面板、opacity 0 的淡入容器。
2. `submitControls()`（`360-370`）只接受**可见**控件；`submittedCue()`（`387-401`）只接受 `isDisplayed()` 的文本节点。
3. 代码里**没有任何滚动/聚焦/展开动作**：提交按钮若只在"滚动到末尾"或"展开某面板"后才被站点插入/显示，扩展不会主动触发。
4. 视口宽度/缩放/DPR 会改变站点响应式 CSS 分支；站点的窄屏皮肤可能隐藏桌面提交条/把提交放进菜单 → S4 候选数为 0。**站点侧行为属推测**，但代码侧"0 个 → 停止"是可证的。
5. 单测把 `getClientRects` 全局 mock 成非空（`apps/extension/tests/automation-course-page.test.ts:33`），**隐藏/零布局场景没有测试覆盖**。

### B. 同源文档搜索 / iframe 结构（影响 S4、C2、S2、G1）
1. `accessibleDocuments()`（`15-22`）：只走 `iframe.contentDocument`，深度 ≤5、文档数 ≤40、跨域 try/catch 跳过。跨域/沙箱/未加载 frame、超过 40 个 frame（站点广告/统计 frame 多）都会截断搜索。
2. `submitSearchDocuments()`（`372-377`）优先"有题目的文档"，其余同源文档排后 —— 但**入口文档由调用方决定**：`SEND_WORK` 用 `moduleRoot ?? root`（`1244`），独立作业用 `root`（`918`）。
3. 0.2.7 的模块作用域：`inspect():931-937` 把 `moduleRoot` 设为当前 `.ans-attach-ct` 内 iframe 的 `contentDocument`；`taskDocuments()`（`879-881`）只返回该子树。于是：
   - 提交按钮若在**外层 cards 文档**，`SEND_WORK` 搜不到 → S4 失败；
   - 确认弹窗若由外层页面渲染，`CONFIRM_WORK`（`1251`）也搜不到 → C2 失败。
4. `courseModules()`（`67-87`）要求每个 `.ans-attach-ct` **恰好 1 个 `.ans-job-icon` + 1 个 iframe**，否则整个函数返回 `[]`（`75`）。多一个隐藏 helper frame / 结构变体 → 退化为整页模式，任务键与完成语义都改变。
5. 模块身份用**数组下标**（`taskKey = sha256(cardKey|module:${activeModule})`，`938`）；iframe 懒加载导致 DOM 顺序插入/移位时，下标可能指向另一个模块，而 `taskKey`（只有下标）不会变——`applied` 不会清、但 `moduleRoot` 已换 → S2/S3 失败。见 §3-H3。
6. `cardIndexOf()`（`36-59`）取 cards iframe 的 `num` 参数（深者胜）作为 `cardKey` 的一部分；站点导航/卡片 iframe 重建会改变任务键。

### C. 时间常量与轮询周期（机器快慢/节流的放大点）
- 页面侧（内容脚本运行在**课程标签**，通常处于后台）：`apply()` 回读窗口 **2500ms**、150ms 间隔、900ms 后补一次点击/重写、失败即 `fail`（`1107-1148`）；`writeFieldSlot()` 等编辑器 **2500ms**（`663-669`）；视频元数据 10s（`187`）、起播 12s（`151`）、弹题每项 ≈4.8s（`1195`）。
- 调度器侧（**runner.html 普通标签页**）：`sleep = setTimeout`（`automation/App.vue:111`，`now = Date.now` `112`）；`delay()` 每 500ms 一醒（`runner.ts:152-159`）；心跳 `setInterval 2500ms`（`310`）+ 400ms 复核（`302`）；提交等待 60s / 1s 轮询（`1042-1051`、`815-827`）；懒加载稳定等待 25s（`1009`）；NEXT 后 25s（`1158`）；视频轮询 2500ms（`1076`）、60s 无进展停止（`1101`）。
- **Chrome 后台节流**：隐藏标签的定时器被 clamp（≥1s），隐藏 5 分钟后进入 intensive throttling（约每分钟一次唤醒）；被完全遮挡的窗口按隐藏处理；低电量/省内存/冻结策略进一步暂停 JS。`delay(1000)` 一次可能吃掉整个 60s 预算 → 60s 确认窗口实际只采样 0~1 次。该风险在验收文档里已被明确记录：`docs/acceptance.md:435`「浏览器后台节流可能影响 2.5 秒定时检查」。
- 页面侧同样被节流：课程标签在 runner 标签激活时是后台，`apply()` 的 150ms 轮询会被拉长，2500ms 墙钟截止可能在 2~3 次采样后就到点 → 回读不一致/编辑器未就绪 → 转人工补答。
- 无 `chrome.alarms`、无 visibilitychange 补偿、无"active time"计时；所有截止时间都是 `Date.now()` 墙钟。

### D. 混合模式（刷课＋刷题）与任务链上下文
1. 视频模块与测验模块同卡时，`NEXT` 内部切换 `activeModule`（`course-page.ts:1274-1281`），不点站点 Next；`taskKey` 变化 → 页面侧 `applied/sendAttempted/confirmAttempted` 重置（`938-942`）。
2. 视频在**课程标签后台**播放：站点自身的进度上报、懒加载、任务点标记更新可能被节流；`inspect()` 在视频分支每 2.5s 轮询（`1076`），进度/完成判定的时机会因机器而异。
3. 从视频切到 quiz 时，quiz 模块 iframe 可能是懒加载：`loading()`（`1006-1014`）只在 `kind=UNKNOWN` 或 `QUIZ && questionCount===0` 时等最多 25s；**部分加载（先出 2 题、后出 37 题）不会被等待**，于是 `snapshot.questionCount` 是旧值 → `solveQuiz` 只处理前几题 → `SEND_WORK` 的 `applied.size !== questions.length` → S2 失败。
4. 心跳 `monitorQuiz()`（`286-317`）在 `solveQuiz` 期间每 2.5s `INSPECT`，任务键/类型/题数两次采样都漂移就 `ERROR("监听发现课程任务已变化…")`；懒渲染分批出现题数变化、模块 iframe 重建都会被判成"任务变化"，而且 `INSPECT` 抛错时直接 `fail`（`312-314`，没有重试）—— 慢机器/弱网下更容易误杀。
5. `solveQuiz()` 结束到 `SEND_WORK` 之间没有重新 `INSPECT` 绑定；这中间只要站点重渲染、换帧、任务键变化，S2/S3 失败。

### E. runner 页 / 课程页生命周期（机器相关）
1. runner 是**普通标签页**：`sidepanel/App.vue:683-687` 用 `chrome.tabs.create({url, active:true})` 打开，随后课程标签变后台；用户切走/最小化/窗口被遮挡时 runner 也变后台 → 全部定时器被节流。
2. `RunnerState`、`CoursePage` 状态（`applied/sendAttempted/confirmAttempted/modules/activeModule`）**只在内存**：`page-entry.ts:4-19` 每文档一个实例；runner 崩溃/标签丢弃/页面刷新即丢。0.2.7 没有任何 `chrome.storage` 运行态恢复。
3. MV3 service worker 30s 空闲回收：每个命令都会唤醒（`background.ts:104-136`），但 `sendAutomationCommand`（`protocol.ts:132-137`）**没有超时也没有 try/catch**；`chrome.tabs.sendMessage` 在页面忙/冻结时可能长时间不回 → runner 的 `await` 永久挂起（没有任何 watchdog），表现为"卡住、不提交"。
4. 课程标签整页导航时内容脚本会消失到重新注入之间，`INSPECT` 可能抛错；主链提交等待对此零容忍（§1.4 G4）。
5. 站点自身在后台标签里可能暂停计时器/暂停答题自动保存/延迟标记完成，属于站点行为，扩展无法控制。

### F. `chrome.storage` 状态差异
- 站点可选权限按 Chrome 配置档案保存（manifest `optional_host_permissions`）：一台机器授权了、另一台没授权 → 命令在注入阶段就失败（`background.ts:76-82`，页面会显示 `FRAME_ACCESS_DENIED` 或"没有站点权限"类错误），不会表现为"题目已填但不提交"。
- 供应商/Key/图像开关等设置不同只影响作答质量 → 更容易出现 `NEEDS_INPUT`，间接导致"没人点提交"。
- `taskMode` 下拉不持久（`automation/App.vue:50`、`552-557`），每次都要选；`soundEnabled` 也不持久（`197`）。这些不会直接阻断提交。

### G. 构建与浏览器版本
- 两台电脑装的扩展可能不是同一构建（旧 dist / 旧 ZIP / 不同加载路径）：0.2.6 与 0.2.7 的提交/完成判定不同，行为差异会被误读为"环境差异"。
- Chrome 版本不同（最低 116）：后台节流、标签冻结/丢弃、`chrome.sidePanel` 行为、站点特性检测（站点可能据此下发不同 quiz 皮肤/布局）都可能不同。

### H. 时钟与休眠
- 所有超时都是 `Date.now()` 墙钟（`automation/App.vue:112`）。系统休眠/唤醒、NTP 校时跳变会让 60s 窗口瞬间过期或提前结束（`delay` 的 `deadline` 直接比较 `now`）。

---

## 3. 按可能性排序的根因假设（证据强度：代码可证 / 推测）

> 排序依据：① 与"题目已回填、只是不提交"最吻合；② 能解释"同一课程换机才出现"；③ 失败点直接落在 §1 的 gate 上。每条给出"如何判据/反证"，便于用 §4 的最小实验区分。

### H1（最可能）后台节流把"60s 提交确认窗口"打穿，且提交阶段失败没有自动恢复 —— 代码可证机制 / 机器差异为推测
- 机制：runner 标签在后台（用户看课程页或别的窗口）→ `sleep`/`delay` 被 clamp，60s 墙钟窗口内只采样 0~1 次；`CONFIRM_WORK` 可能来不及点弹窗、`INSPECT` 来不及看到完成标记；`runLoop` 抛 `"站点尚未确认提交成功；不会重复提交或跳到下一任务。"`（`runner.ts:1052`）或 `"监听课程页失败"`（`312-314`）。
- 为什么"换电脑才出现"：Chrome 版本、电源策略（笔记本省电/效率模式）、窗口是否被遮挡、内存压力、标签冻结/丢弃策略、用户是否最小化窗口都不同；`docs/acceptance.md:435` 已把后台节流列为已知风险。
- 放大因素：提交阶段 ERROR 没有 `manualItems`，`recoverFromError`（`843-844`）不可达 → 扩展只提示用户处理，用户只能去站点点提交（= 人工提交）。
- 判据：错误文本为"站点尚未确认提交成功"或"监听课程页失败"；把 runner 标签保持前台/窗口可见后重跑能自动提交；在 runner 页 DevTools 里看到 `document.visibilityState=hidden` 且定时器明显延迟。

### H2（很可能）0.2.7 把提交按钮/确认弹窗的搜索范围收窄到当前模块 iframe，而真实站点把控件放在外层卡片文档 —— 作用域收窄代码可证 / 控件真实归属未知（需 DOM 证据）
- 机制：`SEND_WORK` 的搜索入口是 `moduleRoot ?? root`（`1244`），`CONFIRM_WORK` 只遍历 `taskDocuments()`（`1251`）；0.2.7 之前是"整页 + 全部同源文档"，`docs/course-automation.md:99-103` 记录的行为也是跨全部同源文档搜索。如果真实 quiz 模块 iframe 内没有 `a.btnSubmit`，或确认弹窗由外层 cards 页面渲染，则 S4/C2 必然失败：`"无法唯一确认站点提交按钮（候选 0 个，已搜索 M 个同源文档）。"`
- 为什么"换电脑才出现"：站点按浏览器/缓存/CDN 下发不同卡片皮肤或旧/新布局，一台机器是整页旧布局（`courseModules()` 返回 `[]`，`moduleRoot=undefined`，回到整页搜索 → 能提交），另一台是模块 iframe 新布局（走模块作用域 → 搜不到）。这是**两种布局的差异**，不是同一 DOM 的随机差异。
- 判据：错误文本含"无法唯一确认站点提交按钮"；真实页面只读探测顶层文档与各同源 iframe 里 `a.btnSubmit`/确认弹窗的数量和归属（实验 E4）。
- 证据缺口：`mixedCard()` 单测（`tests/automation-course-page.test.ts:51-71`）与 e2e 混合卡夹具（`tests/fixtures/automation-mixed-course.html`、`tests/extension/extension.spec.ts:598-629`）**从不调用 SEND_WORK**（e2e 只跑只刷课模式，`submit:0`），模块作用域下的提交链没有测试覆盖。`docs/course-playback-0.2.7.md:19-27` 也只验证了跳过与不提交。

### H3（很可能）任务/模块身份与 `applied` 失效被误判：懒加载题目、iframe 重建、模块下标移位 —— 失效逻辑代码可证 / 触发条件推测
- 机制：`inspect()` 每次都会重算 `taskKey` 并在变化时清空 `applied`/`sendAttempted`（`938-942`）；任务键 = cardKey（含 cards iframe `num`）+ **模块数组下标**（`938`）。懒加载 iframe 插入/移位、cards 转页、iframe 重建都会让任务键或模块根变化，而 `applied` 与已回填 DOM 不再对应；`questionElements()` 数量随渲染批次变化也会让 `applied.size !== questions.length`。结果落在 S2 `"尚未完整回填本任务，拒绝提交。"` 或 S3 `"提交前回读不一致，已停止。"`。
- 为什么"换电脑才出现"：慢 CPU/慢网/后台节流下懒加载时序不同，题目与 iframe 在"回填完成"和"提交"之间才完成第二批渲染。
- 判据：错误文本为 S2/S3；刷新课程页后同一任务重跑能提交；`READ_ALL` 的题数与本机实际渲染题数不一致。
- 补充（代码可证）：`fingerprint()`（`495-501`）把**易变值**也算进去：题图 `currentSrc`、`secretFontCss()` 注入的 `<style>`、UEditor iframe 的 `frameElement.id`、懒加载空格 `saved.id`、选项 `data`。站点在回填后异步完成图片/编辑器/字体初始化，就会让 S3 误报"回读不一致"。这与"答案其实已写对"完全兼容。

### H4（很可能）固定 2.5s 回填/写入窗口在慢机器上不够 —— 常量代码可证 / 超时概率推测
- 机制：`apply()` 的 2500ms 回读（`1107-1148`）、`writeFieldSlot()` 的 2500ms（`663-669`）都不随机器速度/页面规模调整；超时即 `fail("第 N 题…回读不一致")` → `solveQuiz` 把它放进 `manualItems`（`521-535`）→ `phase=NEEDS_INPUT`（`537-541`）→ 无限等待人工。用户看到"待人工补答"，补完（或在网页自己答完并点站点提交）后才继续 —— 从他的角度就是"不会自动提交，只能自己提交"。
- 为什么"换电脑才出现"：CPU、内存、后台节流、页面题量（真实 Java 课程 37 题）都会影响页面脚本写回延迟。
- 判据：错误/汇总卡里出现"页面没有保留回填结果（回读不一致）"或"空格编辑器尚未就绪"；刷题单任务时常出现待补答汇总；把窗口保持前台后减少。

### H5（中）完成证据/文案/弹窗皮肤不匹配 —— 严格匹配代码可证 / 站点皮肤差异推测
- 机制：
  - 卡内任务完成只认 `.ans-job-icon` 的 `aria-label`（`61-63`）。真实证据里完成模块还带 `ans-job-finished` class（`docs/compatibility.md:239-241` §6.9），代码**没有利用**它。
  - 卡内任务**不使用** `submittedCue()`（只在独立作业页用，`921`）。站点若改为"提交成功"文字/结果视图而不更新 `aria-label`，扩展永远判不出完成。
  - 确认弹窗只接受旧 `#confirmSubWin` 或"小容器 + `?` + 唯一确认 + 唯一取消 + 无未作答字样"（`314-343`）；不同皮肤的按钮文案、多按钮、Shadow DOM、无取消按钮都会漏（`docs/acceptance.md:666-690` §9.17 记录过真实用户"卡在提交阶段"的同类事故）。
  - 提交按钮文案必须是 `Submit|提交|提交答案|交卷|确定提交`（`369`）；站点改文案/换语言（含浏览器自动翻译改写文本节点）就会 0 候选。
- 为什么"换电脑才出现"：站点缓存/版本/语言设置不同，下发不同皮肤；也可能是两台机器加载的扩展构建不同（见 H9）。
- 判据：错误文本"站点尚未确认提交成功"但站点其实已提交；用户人工点提交时发现弹窗/结果页正常；只读对比两台机器页面上的按钮文案/标记文案。

### H6（中）页面侧"已尝试提交"标志跨重跑残留，单次提交守卫把可恢复问题变成永久人工 —— 代码可证
- 机制：`sendAttempted` 存在内容脚本内存里，`RELEASE`（`1208-1219`）、`runner.start()` 重置（`959-973`）都不清它；只有任务键变化或课程页重载才重置（`938-942`）。只要上一轮已经点过站点提交但确认超时（H1/H5），用户重启运行后 `SEND_WORK` 会被 S1 拒绝：`"此任务已尝试提交，不自动重复提交。"`，点「立即提交当前任务」也一样被拒 → 只能人工提交。
- 判据：错误文本包含"此任务已尝试提交"；刷新课程页后重跑即可（因为重建了 `CoursePage`）。

### H7（中）提交等待期间 `INSPECT` 瞬时失败直接终止主链 —— 代码可证 / 触发时机推测
- 机制：主链提交等待每轮都 `snapshot = await this.inspect()`（`1048`），`INSPECT` 抛错（iframes 重建、页面导航、桥接 `TAB_UNAVAILABLE`、SW 回收）直接冒泡到 catch → ERROR；独立作业路径有 3 次容忍（`583-589`），主链没有。
- 判据：错误文本是"课程状态响应不完整。"/"监听课程页失败：…"/"课程标签已关闭、正在导航…"；重跑后可以继续。

### H8（中低）运行页被冻结/丢弃/挂起，状态机静默死亡 —— 无持久化代码可证 / 发生率推测
- 机制：`RunnerState` 与页面侧状态只在内存；低内存机器/省内存模式可能丢弃后台标签，或标签冻结后定时器完全停止；`protocol.ts:132-137` 也没有命令超时，一个挂起的 `sendMessage` 会让 `await` 永久 pending。用户翻回运行页前"什么都不发生"。
- 判据：运行页标签被 Chrome 显示"已休眠/已释放"；重开运行页后状态归零；任务在站点仍显示已作答未提交。

### H9（运维因素，需先排除）两台电脑的扩展构建/版本/权限/浏览器版本不一致
- 机制：0.2.6→0.2.7 改了模块作用域与完成判定；旧 dist 没有新逻辑。`manifest` 只写了 0.2.7，运行页没有显式版本徽标（`UpdateMenu` 仅在更新菜单里）。
- 判据：`chrome://extensions` 版本、加载路径、Chrome 版本、站点权限在两台机器对比。

### H10（低）跨域/沙箱 iframe 或结构差异导致 `moduleRoot` 为空
- 机制：跨域 `contentDocument` 拿不到 → `module.root=null` → `moduleRoot=null` → `taskDocuments()` 返回 `[]`（`879-881`）→ `work()` 失败。但通常会在读题阶段就失败（"任务题目数量不受支持"），与"题目已回填"矛盾，除非只影响提交阶段的 frame。
- 判据：错误文本"题目文档已变化"/"任务题目数量不受支持"；frame 的 `src` origin 与顶层不同。

### H11（低）系统时钟跳变/休眠唤醒
- 机制：全部超时用 `Date.now()` 墙钟；NTP 校时/休眠恢复会让 60s 窗口瞬间过期。
- 判据：运行期间系统刚唤醒/校时；日志时间跳变。

### 判别树（用用户看到的错误原文快速定位）
```
"无法唯一确认站点提交按钮（候选 0 个…）"        → H2（其次 H4/H5 文案皮肤）
"尚未完整回填本任务，拒绝提交。"                 → H3（其次 H4 转人工后未处理完）
"提交前回读不一致，已停止。"                     → H3（fingerprint 易变）或 H4
"此任务已尝试提交，不自动重复提交。"             → H6（上一轮已点过提交但未确认）
"站点尚未确认提交成功；不会重复提交或跳到下一任务。" → H1 / H5 / H7（看是否点击过 + 站点实际是否已提交）
"已点击提交但站点未返回可核验的完成标记…"        → H5（独立作业页）
"监听课程页失败…" / "课程状态响应不完整。"        → H1 / H7 / H8
"任务题目数量不受支持。" / "题目文档已变化。"     → H10 / H3 / B 组 iframe 截断
"待人工补答" + "回读不一致"                      → H4
```

---

## 4. 候选修复与风险，以及最小真实页面验证实验

> 所有候选修复的硬边界（不可违反）：提交仍只能点击**站点自身唯一的提交按钮一次**（`sendAttempted`）；不得 `form.submit`/`requestSubmit`；不得因重试而重复提交/重复确认；不得把"点击过按钮"当完成；不得伪造任务完成标记；不新增浏览器权限、不落库题文/答案。

### F1（优先）统一提交后等待，并使"已点提交但未确认"可自愈而不重复提交
- 改动：`runner.ts`
  - 抽出 `waitForSubmission(boundTaskKey): "confirmed" | "advanced" | "unconfirmed"`，`runLoop` 的 QUIZ 分支（`1039-1052`）与 `submitAndWait`（`811-834`）共用；`submitAndWait` 保留给 `submitNow`/`recoverFromError`。
  - 等待期间允许 `INSPECT` 瞬时失败：连续 N（建议 3）次失败前不算错，与 `runStandaloneWork:583-589` 对齐（修 H7）。
  - 截止时间改用"活跃时间"（见 F2）；到达截止时再做一次 `INSPECT` 终检（不重复点击）。
  - 未确认时：不提示用户"去点提交"；改为自动进入"结果复核"（见 F3），保留 `sendAttempted`，绝不再次 `SEND_WORK`。
- 风险：等待变长 → 运行更久；必须有硬上限（活跃 120s + 墙钟 10min）保证终止。
- 单次提交：不受影响（不增加点击）。

### F2（优先）节流感知的时钟与可见性补偿
- 改动：`runner.ts:152-159`（`delay`）、`automation/App.vue:111`（`sleep`）与全部 deadline：
  - 增加 `activeElapsed` 累加器：每次 sleep 只累加 `min(实际耗时, 请求耗时×1.5)`，所有超时（提交 60s、视频 60s 无进展、导航 25s、心跳复核）改用活跃时间；另设墙钟硬上限。
  - `App.vue` 监听 `visibilitychange`/`focus`：变可见时立即调用 `runner.catchUp()`（一次 `INSPECT` + `CONFIRM_WORK`，不 `SEND_WORK`），并在状态卡显示"运行页曾被后台节流，已补偿"。
  - 状态卡增加诊断：`visibilityState`、最近一次 sleep 的实际/期望耗时（不含任何题文）。
- 风险：改变了文档里"60 秒"的语义（需要同步 `docs/course-automation.md`、`docs/acceptance.md`）；节流过久时用户会觉得"卡很久"。不涉及提交次数。

### F3（优先）"已提交未确认"只做复核，不重复提交
- 改动：`runner.ts` 新增 `recheckSubmission(): Promise<void>`：仅 `INSPECT` + `CONFIRM_WORK`（若弹窗可能仍在），成功则计数并 `runLoop` 继续；失败则停在明确状态 `"已点击提交，站点未确认；不会重复提交，请人工确认"`。
- 触发点：`recoverFromError`（`842-870`）在 `manualItems` 为空时也允许进入复核分支（当前 843-844 直接 return）；ERROR 状态 + `sendAttempted` 时运行页按钮从「立即提交」改文案为「重新检查提交结果」（`automation/App.vue:562`），避免用户误触导致 S1 拒绝；页面侧可在 `SEND_WORK` 的 S1 失败文案里注明"已点击过提交，不会再次点击，请确认站点结果"。
- 风险：复核本身只读；弹窗确认仍受 C2 单次限制；不会造成重复提交。

### F4（优先）恢复"整页同源文档"的提交按钮/确认弹窗搜索（保留唯一性守卫）
- 改动：`course-page.ts`
  - `submitSearchDocuments(root)`（`372-377`）改为按"当前模块文档优先 → 其余同源文档（含顶层 root）"排序去重返回；`SEND_WORK` 用 `submitSearchDocuments(this.root)` 但保持 `moduleRoot` 文档排第一（`1244`）；独立作业（`918`）不变。
  - `CONFIRM_WORK`（`1251`）遍历 `[...this.taskDocuments(), ...accessibleDocuments(this.root)]` 去重。
  - 仍然先过滤 `visible()`、仍要求去重后**恰好 1 个**才点击；非唯一一律停止（不猜）。
- 风险：可能点到外层页面里同文案的其他提交控件（如"提交作业"另有一处）；唯一性 + 精确文案 + 只在完整回读通过后使用，可把风险压到最低；上线前必须补"提交按钮在父文档"的合成用例。
- 需先取得脱敏 DOM 证据（按钮/弹窗归属哪个文档）再改，符合 AGENTS.md 第 11 条。

### F5（中）完成证据多信号化（只用站点自己的状态，不伪造）
- 改动：`course-page.ts`
  - `markerCompleted()`（`61-63`）增加已记录的 `ans-job-finished` class 信号（`docs/compatibility.md` §6.9 真实证据）与 `aria-label` 的 `已完成/Completed` 变体；两者任一命中即视为站点完成。
  - 卡内任务在 `sendAttempted===true` 时，把 `submittedCue(docs)`（`387-401`）也作为完成证据（仅当提交后），避免站点改为结果视图后永远判不出完成。
- 风险：`submittedCue` 必须维持"可见文本 + 排除题面容器 + 长度 ≤120"的既有守卫，且只在**本轮自己点过提交之后**启用；不得把隐藏模板/脚本字样当证据。测试需覆盖"提交前出现提交成功字样不计数"。

### F6（中）回填/回读窗口自适应
- 改动：`course-page.ts` `apply()`（`1107-1148`）与 `writeFieldSlot()`（`663-669`）：deadline 由 2500ms 提升为可配置（建议 2500→6000ms），并在页面明显仍在变化（digest 在变/编辑器在初始化）时继续轮询；失败文案保留脱敏诊断（`readbackDetail`）。
- 风险：单题更慢、整卷更久；不改变"回读一致才提交"。

### F7（中）`fingerprint()` 易变字段与"真实题目变化"解耦
- 改动：`course-page.ts` `fingerprint()`（`495-501`）拆分：
  - `contentFingerprint`：`id + questionContentRoots(el).map(textContent)`（`question-roots.ts:2-5`）+ 选项文字/`data`，用于"S3 题目内容变化"判定；
  - `stateFingerprint`：题目内容 + 图片 `currentSrc` + `secretFontCss` + 编辑器 `frameElement.id` + 懒空格 `saved.id`，仅用于指纹缓存/比较提示。
- `SEND_WORK`（`1240-1243`）先用 `contentFingerprint` 判断真变化：变了才停止；只有 `stateFingerprint` 变化但 `answerDigest` 仍等于 `entry.answer` 时，更新 `applied` 条目并继续（有界重试 1 次），不重写答案、不多点提交。
- 风险：削弱"题变守卫"是安全敏感改动；必须保证题干/选项文本与答案回读仍严格比对，并补"真实换题 → 必须停止"的测试。

### F8（中）命令超时与挂起保护
- 改动：`protocol.ts:132-137` 给 `chrome.runtime.sendMessage` 加 `Promise.race` 超时（建议 20~30s），返回 `{ok:false,code:"PAGE_TIMEOUT",detail:"课程页未响应，可能已冻结/导航中。"}`；`automation/App.vue:72-81` 透传。runner 对 `PAGE_TIMEOUT` 走 F3 复核路径（不重试 `SEND_WORK`）。
- 风险：页面的同步提交处理器较慢时可能误超时；因此超时后只能"复核"，不能"重提"。

### F9（低/可选）运行状态最小持久化
- 改动：`automation/App.vue` 把 `{tabId, courseKey, taskKey, phase, sendAttempted, submittedAt}` 写入 `chrome.storage.session`（不含题文/答案），重开运行页时只恢复"复核/继续"能力，不恢复自动点击。用于 H8。
- 风险：状态过期需 courseKey/taskKey 双重校验后才允许复核，且绝不因恢复而重提。

### F10（低）UI 诊断与防呆
- `automation/App.vue` 状态卡增加：运行页可见性、最近一次页面命令耗时、提交阶段进度（已点击/等待确认/未确认）；把「立即提交当前任务」（`562`）在 `sendAttempted=true` 时禁用/改名，避免用户点了得到"已尝试提交"的二次打击。
- 运行页顶部提示"运行期间保持本页/浏览器窗口可见，最小化会让提交确认超时"。

### 在真实页面上可做的最小验证实验（按顺序，先只读/低风险）

| # | 实验 | 目的 | 注意 |
|---|---|---|---|
| E1 | 收集失败现场：失败电脑上运行到停止后，**原样复制**运行页红色错误 + `state.step` + 计数（完成几个任务、是否出现"待人工补答"汇总） | 用 §3 判别树直接区分 H1/H2/H3/H4/H6/H7 | 不截图题文；错误文本不含题文，可安全粘贴 |
| E2 | 时间线对照：失败电脑上把 Chrome 窗口保持前台、运行页标签保持可见，重跑同一任务 → 成功则 H1（节流）；仍失败则 H2/H5 | 最省事、区分度最高 | 同一任务若上一轮已点过提交，先刷新课程页（重置页面侧 `sendAttempted`）再重跑，避免 H6 干扰；重跑前先确认上一轮没真的提交成功 |
| E3 | 视口/缩放对照：在失败电脑上 100% 缩放 + 最大化窗口 vs 150% 缩放 / 半屏窗口，各跑一个**尚未提交**的测验任务（刷题模式单任务） | 验证 H2 的布局分支（S4 候选数） | 只观察是否停在同一 gate；不需要额外点提交 |
| E4 | 只读 DOM 归属探测：在课程页 quiz 打开时，由用户在 DevTools Console（顶层 frame）执行只读表达式，统计顶层与各同源 iframe 内 `a.btnSubmit`/提交文案按钮/确认弹窗数量，记录**归属文档与文案**（不记录 URL 参数、题文） | 决定 F4 是否需要、并给 `docs/compatibility.md` 补脱敏证据 | 不点击任何按钮；不复制整页 HTML |
| E5 | 重跑对照：失败后**刷新课程页**再重跑同一任务 | 成功 → H6/H3（页面侧状态残留/懒渲染）；失败 → H1/H2/H5 | 刷新会清 `sendAttempted`，不会造成重复提交（站点侧状态不变） |
| E6 | 版本对照：两台机器对比 Chrome 版本、扩展版本/加载路径、站点权限、是否同一 dist 构建 | 排除 H9 | `chrome://version`、`chrome://extensions` |
| E7 | 节流证据：在运行页 DevTools Console 观察 `document.visibilityState` 与 `performance.now()` 差（或临时在 Console 里 `setTimeout(()=>console.log(performance.now()),500)`） | 证实 H1 的节流 | 只读 |
| E8 | 慢机器现象：失败电脑用刷题单任务模式跑一遍，看是否频繁出现"待人工补答/回读不一致" | 区分 H4 | 若出现，说明回读窗口也需要修 |

实验中的提交安全：E2/E3/E5 只观察"是否卡在提交阶段"，**不要为了做实验反复人工点站点提交**；如果上一轮已点击过站点提交且站点显示已提交，就先刷新/换一个未提交任务。

---

## 5. 未知项清单（不做断言）

1. **真实站点中提交按钮和确认弹窗属于哪个文档/哪个 frame**：仓库只有旧皮肤 `#confirmSubWin` 的 DOM 证据和"Tip / Submit? / Cancel / Submit"截图文案证据（`docs/compatibility.md:135-148` §6.2、`docs/acceptance.md:666-690` §9.17），**没有**它们在 0.2.7 模块 iframe 结构下的归属证据。无法仅凭代码判断 S4/C2 在真实页面是否可达。
2. **用户"不自动提交"的具体表现**：是没点提交按钮就报错，还是点了但没等到确认（站点弹窗还开着），还是运行页根本没有反应/卡住？三种对应的 gate 完全不同（S4 vs C2/G1 vs H8），需要在失败机器上取错误原文（E1）。
3. **两台电脑实际加载的扩展构建是否一致**（0.2.7 vs 旧版），以及 Chrome 版本、窗口/标签可见性、电源模式是否不同；当前没有任何运行期版本/可见性诊断字段。
4. **站点在后台标签中是否暂停答题状态保存/完成标记更新**：未知；这决定 H1 的权重。
5. **真实课程题量（37 题）下 `apply()` 逐题回读的耗时分布**：未知；决定 H4 的概率。
6. `ans-job-finished` class 与 `aria-label` 在真实页面的更新时序（是否同步、是否是唯一完成信号）：未知；决定 F5 是否足够。
7. **点击提交后站点是"弹窗确认"还是"直接提交/跳转结果页"、结果视图在 iframe 内还是顶层**：未知；`submittedCue` 目前只用于独立作业页，卡内任务是否需要启用未验证。
8. **站点是否存在按浏览器/缓存/语言下发不同皮肤的行为**（H2/H5 的前提）：未知，需要在两台机器上做 E4 对比。
9. 用户是否有过"上一轮已点过提交、之后重启运行"的操作序列（H6）：未知；运行页历史无日志、无持久化。
10. 混合模式下如果视频模块仍在播放/站点在后台暂停，任务链是否会在提交前被心跳判定"任务变化"：未知，需真实页面日志。
11. 运行页标签是否被 Chrome 冻结/丢弃过（H8）：未知；需要用户在失败后查看标签状态或 `chrome://discards`。

---

## 附：行号速查（本次分析引用）

- 页面侧：`course-page.ts:11-14`（visible）、`15-22`（accessibleDocuments）、`36-59`（cardIndex）、`61-63`（markerCompleted）、`67-87`（courseModules）、`270-276`（isDisplayed）、`314-343`（genericConfirmButton）、`346-353`（confirmButton）、`360-370`（submitControls）、`372-377`（submitSearchDocuments）、`387-401`（submittedCue）、`495-501`（fingerprint）、`657-670`（writeFieldSlot）、`879-881`（taskDocuments）、`894-962`（inspect，`919-921` 独立页完成、`931-952` 模块作用域/完成）、`964-965`（work/element）、`1057-1149`（apply）、`1205-1301`（handle：`1236-1248` SEND_WORK、`1249-1257` CONFIRM_WORK、`1267-1286` NEXT）。
- 调度侧：`runner.ts:152-159`（delay）、`174-184`（inspect/action）、`286-317`（monitorQuiz）、`327-554`（solveQuiz）、`561-603`（runStandaloneWork）、`793-804`（submitNow）、`811-834`（submitAndWait）、`842-870`（recoverFromError）、`885-930`（submitManual）、`959-973`（start）、`981-1216`（runLoop；`1006-1014` loading、`1034-1052` QUIZ 提交、`1055-1116` VIDEO、`1157-1202` NEXT）。
- 运行页/桥接：`automation/App.vue:72-113`（port，`111` sleep）、`163-194`（start）、`197-222`（声音告警）、`372-376`（submitNow 处理）、`492-499`（卸载停止）、`550-566`（模式与提交按钮）、`595-645`（人工补答 UI）；`sidepanel/App.vue:680-689`（打开 runner 标签，`687` `active:true`）；`background.ts:104-136`（注入/转发）、`159-170`（消息监听）；`page-entry.ts:4-19`（每文档单实例）；`protocol.ts:132-137`（无超时）。
- 文档：`docs/acceptance.md:435`（后台节流已知风险）、`439-478`（§9.12 提交口径）、`666-690`（§9.17 提交确认弹窗真实事故）、`692-722`（§9.18 ERROR 后仍需人工提交的旧缺口）、`1018-1058`（§9.27 独立作业页）、§9.38（0.2.7 混合卡片）；`docs/course-automation.md:99-116`（提交可见性/跨文档）、`198-216`（确认弹窗与 ERROR 恢复）、`161-163`（安全边界）；`docs/course-playback-0.2.7.md:19-27`（模块作用域）；`docs/compatibility.md:135-148`（§6.2 提交确认弹窗）、`239-241`（§6.9 模块结构与 `ans-job-finished`）。
- 测试覆盖缺口：`apps/extension/tests/automation-course-page.test.ts:33`（getClientRects 被 mock）、`51-71`（mixedCard 夹具）、`tests/fixtures/automation-mixed-course.html` 与 `tests/extension/extension.spec.ts:598-629`（混合卡 e2e 仅只刷课、`submit:0`，模块作用域下 SEND_WORK 无覆盖）。
