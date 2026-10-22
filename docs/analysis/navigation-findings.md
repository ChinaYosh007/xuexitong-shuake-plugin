# 刷课/刷题任务点导航与视频/PPT 完成判定缺陷分析

> 只读分析报告（不修改源码、不提交、不动 dist）。
> 分析对象：0.2.7（`apps/extension/src/automation/course-page.ts` 1302 行、`runner.ts` 1217 行）。
> 用户反馈：0.2.7 真实学习通课程页，出现在「刷课：视频＋题目」「只刷课」模式下：
> 1) 横向任务点很多时无法有效跳转/卡住；2) 「同一横向层级会有点卡住」；3) 很多地方没有任务点也会卡住；
> 4) 视频有的「进度放到最后位置」站点即判定完成，有的不能跳转（跳转导致不完成/进度回退），必须正常播放；
> 5) PPT/资料有的需要滚到最底部才算完成，有的不需要。
>
> 分析依据（均已实际阅读）：
> - 源码：`course-page.ts`、`runner.ts`、`protocol.ts`、`page-entry.ts`、`background.ts`、`App.vue`、`shared/pages.ts`、`manifest.base.json`
> - 文档：`docs/compatibility.md` §6.5/§6.7/§6.9、`docs/course-automation.md`、`docs/course-playback-0.2.6.md`、`docs/course-playback-0.2.7.md`、`docs/acceptance.md` §9.38、`AGENTS.md`
> - 测试：`apps/extension/tests/automation-course-page.test.ts`、`automation-runner.test.ts`、`tests/extension/extension.spec.ts`、`tests/fixtures/automation-{mixed-course,video-chain,video-chain-card}.html`
>
> 证据分级（全文统一）：
> - **[代码可证]**：由当前代码分支/常量直接推出，不需要新页面证据即可断言机制存在。
> - **[已记录证据]**：`compatibility.md` / `course-automation.md` 中已有脱敏 DOM 只读记录支持的结构。
> - **[待真站证据]**：假说；必须取得用户课程页新的脱敏 DOM/运行证据才能确认或落地。
>
> 注意：0.2.7 尚未在用户真实课程重载后取得官方执行记录（`acceptance.md` §9.38 标记 Unverified），
> 因此本报告不把任何「真站已通过/已失败」当既成事实；「代码可证」只表示代码路径必然如此，不表示真站一定触发。

---

## 0. 结论速览

| # | 根因（一句话） | 证据强度 | 直接对应症状 | 修复分级 |
|---|---|---|---|---|
| R1 | `courseModules()` 是「全有或全无」：任一 `.ans-job-icon` 不满足「恰好 1 个 icon + 恰好 1 个 iframe 的 `.ans-attach-ct`」就整体返回 `[]`，整个卡片的模块队列消失，退化回旧「整卡完成」语义 | 代码可证 | 横向任务点多时无法跳转、同一横向层级卡住、无任务点卡片卡住 | P0（纯代码） |
| R2 | 模块身份是数组下标（`activeModule: number`）＋每次 `INSPECT` 重建数组；站点延迟/重排 `.ans-attach-ct` 时下标漂移，会选错模块、`skippedModules` 错位、`taskKey` 抖动 | 代码可证（机制）＋待真站证据（是否重排） | 同一横向层级卡住、跳回已处理任务、`循环` 报错 | P0（纯代码） |
| R3 | 切换同卡片模块只改指针（`activeModule`），**从不点击站点的横向任务点/标签**；若站点只为「当前激活模块」加载播放器/回传完成标记，隐藏模块即使有 iframe 也可能没有 video/题目、标记永不更新 | 代码可证（无点击动作）＋待真站证据（模块是否懒加载/激活后才上报） | 横向任务点跳转后「视频已播但任务点不完成」、卡住 | P0/P1（需证据决定是否加点击） |
| R4 | 视频完成判定只有两条：`markerCompleted()` 只认 `.ans-job-icon[aria-label]` 的「任务点已完成」；且本轮启动过的视频还要求原生 `video.ended`。已记录证据中的完成类名 `ans-job-finished` 完全未被使用；`ended` 被站点播放器吞掉/提前停播/元素被替换时永不满足 | 代码可证（判定口径）＋待真站证据（实际完成信号） | 视频「只放到末尾站点就完成」但扩展仍等/报错；视频不能跳转必须正常播放 | P0（口径收敛）/P1（补类名） |
| R5 | `VIDEO` 与 `RESOURCE` 没有「加载中」宽限：`loading()` 只等 `UNKNOWN` 与 `QUIZ 且题数 0`；`RESOURCE` 还要求 PDF 文档 `readyState==="complete"`，否则 kind 直接落到 `UNKNOWN` → 25 秒后硬停止。刚切到新模块的空白/慢加载 iframe 会立刻 `PLAY → 页面上没有可操作的播放器` | 代码可证 | 横向任务点多时切换即卡住、PPT 卡住 | P0（纯代码） |
| R6 | 扩展没有任何滚动/翻页代码（全仓 `scrollTo/scrollTop/scrollIntoView` 命中 0 处）：需要「滚到最底部」才完成的 PPT/PDF 在刷课模式下只能空等 60 秒后报错；只刷课模式仅在 kind 恰为 `RESOURCE` 时才允许跳过 | 代码可证（无实现）＋待真站证据（滚动是否为完成条件） | PPT 有的卡住、有的正常 | P2（需证据＋用户授权） |
| R7 | 无任务点卡片（MATERIAL）识别过严：静态标签白名单不含 `A` 等常见排版标签；要求卡片文档 `readyState==="complete"`、`无任何 iframe`；且 `markers` 是在**所有同源文档**上统计的「全页无任务标记」才成立。任一不满足 → `UNKNOWN` → 「当前任务类型尚未适配」硬停止 | 代码可证 | 很多地方没有任务点也卡住 | P0/P1（白名单需证据） |
| R8 | 卡片身份 `cardKey = hash(courseKey + chapterId + cards.num)`，`chapterId` 只从顶层 URL 取；若站点点 Next 后顶层 URL 未更新（或存在多个 `/mooc-ans/knowledge/cards` 帧、导航瞬间无 `num` 回落 "0"），新卡片与旧卡片 `taskKey` 可能相同 → 25 秒后「页面没有切换到下一任务」 | 代码可证（哈希输入）＋待真站证据（URL/帧行为） | 无任务点卡片连续越过时卡住、跨章卡住 | P0（诊断）/P1（身份增强） |
| R9 | 导航等待对瞬时失败零容忍：NEXT 后 25 秒等待循环、切任务后的 25 秒稳定循环都直接 `await this.inspect()`，一次页面命令失败（顶层整页导航导致注入/消息失败、帧重载）就整轮 ERROR；其余路径同类 | 代码可证 | 点 Next 时偶发卡住 | P0（纯代码） |

排序判断：R1–R5 与 R7 是最可能直接造成用户 5 条反馈的机制；R6 是 PPT 症状的必要条件（代码里根本没有滚动能力）；
R8/R9 是「卡住/循环」的放大器。R2/R3 决定 0.2.8 是否需要「点击横向任务点」这一步，必须用脱敏 DOM 证据定案。

---

## 1. 现有导航状态机 / 启发式清单

### 1.1 页面与文档作用域

| 项 | 位置 | 判定条件 / 行为 |
|---|---|---|
| 注入位置 | `background.ts:104-117,132`、`page-entry.ts:3-8` | 只向 `frameId: 0`（顶层文档）注入 `page/automation-entry.js`；`new CoursePage(document)` 的 `root` = 顶层 `studentstudy` 文档。所有后续 DOM 搜索都从顶层文档出发。 |
| 同源文档递归 | `course-page.ts:15-22 accessibleDocuments()` | 深度 ≤5、文档数 ≤40；先父文档后子 iframe；跨域 `contentDocument` 捕获异常跳过。 |
| 模块作用域 | `course-page.ts:879-881 taskDocuments()` / `882-884 taskVideo()` | 有 active 模块时只看 `accessibleDocuments(moduleRoot)`；`moduleRoot` 为 `undefined`（未识别到模块）或 `null`（模块 iframe 跨域/未取到文档）时分别退化为「整页文档」「空数组」。 |
| 页面合法性 | `course-page.ts:894-904` | host 必须是 `chaoxing.com` 或子域；非作业页要求 `isCourseTaskPath()` 即路径以 `/mycourse/studentstudy` 结尾；任一可访问文档命中 `isExamPath()` 直接拒绝。 |

### 1.2 任务点识别与卡片身份

| 启发式 | 位置 | 判定条件 |
|---|---|---|
| 卡片序号 | `course-page.ts:36-59 cardIndexOf()` | 遍历所有可访问文档的所有 `iframe`，只接受 `pathname === "/mooc-ans/knowledge/cards"` 的 `num`（数字）；**后遍历到的覆盖先遍历到的**；取不到时回落字符串 `"0"`。不校验该帧是否可见/是否为当前卡片。 |
| 卡片键 | `course-page.ts:925-930` | `cardIndex = cardIndexOf(root)`；`courseKey = hash(courseId|clazzid)`；`cardKey = hash(courseKey|chapterId|cardIndex)`；`cardKey` 变化时重置 `activeModule=null`、清空 `skippedModules`。 |
| 任务标记完成 | `course-page.ts:61-63 markerCompleted()` | 只读取 `.ans-job-icon` 的 `aria-label`，正则 `/任务点已完成|Task\s*completed/i`。**不读取** `docs/course-playback-0.2.7.md`/`compatibility.md §6.9` 已记录的完成模块类名 `ans-job-finished`，也不读可见文本、不读其它属性。 |
| 模块队列 | `course-page.ts:67-87 courseModules()` | 取所有文档的 `.ans-job-icon`；每个 marker 必须 `closest(".ans-attach-ct")` 成功，且该 wrapper 内 `.ans-job-icon` 恰好 1 个、`iframe` 恰好 1 个；**任一 marker 不满足 → 整个函数 `return []`**。kind 由 iframe 路径精确匹配：`/ananas/modules/video/index.html`→VIDEO、`/ananas/modules/work/index.html`→QUIZ、`/ananas/modules/pdf/index.html`→RESOURCE，否则 UNKNOWN；`root` 取 `frame.contentDocument`（可能为 null）。 |
| 作用域内标记统计 | `course-page.ts:943-944` | `markers` = **所有可访问文档**里的 `.ans-job-icon`（与 `courseModules` 独立统计）；有 active 模块时 `markedCompleted = markerCompleted(当前模块 marker)`，否则 `markedCompleted = markers.length>0 && 所有 marker 均完成`（旧整卡语义）。 |
| 无任务点静态卡片 | `course-page.ts:95-106 staticContentCard()` | 必须同时满足：文档路径恰为 `/mooc-ans/knowledge/cards`；`readyState==="complete"`；**文档内无任何 iframe**；`#pageDiv.ans-cc` 可见；`#pageDiv.ans-cc` 及其所有后代 tagName ∈ `DIV/P/SPAN/H1-6/BR/IMG/STRONG/B/EM/I/U/S/UL/OL/LI/BLOCKQUOTE/TABLE/THEAD/TBODY/TR/TH/TD`（**不含 A**）；无 `contenteditable`、无 `role`；所有 `<img>` 均 `complete && naturalWidth>0`；有文本或图片。 |
| MATERIAL 判定 | `course-page.ts:947-948` | `material = markers.length === 0 && docs.some(pdf 路径 || staticContentCard)`。`markers` 是**全页所有文档**统计，因此顶层/其它帧里任意一个 `.ans-job-icon` 都会否决 MATERIAL。 |
| RESOURCE 判定 | `course-page.ts:953-954` | `module?.kind==="RESOURCE" && taskDocs.some(文档路径===pdf && readyState==="complete")`。模块 iframe 未加载完/跨域取不到文档时恒为 false。 |
| 快照 kind 优先级 | `course-page.ts:957-961` | `completed ? COMPLETED : (work || 模块 kind===QUIZ) ? QUIZ : video ? VIDEO : resource ? RESOURCE : material ? MATERIAL : UNKNOWN`。注意 `VIDEO` 只要求「作用域里存在 `<video>`」，不要求可见、不要求是当前激活模块；`RESOURCE` 则强依赖 PDF 文档已加载。 |
| 完成总判据 | `course-page.ts:950-952` | `completed = markedCompleted && (!video || !startedVideos.has(video) || video.ended)`。即：站点标记必须完成；若本进程启动过该 `<video>`，还要求它原生 `ended`。**没有任何基于 `currentTime/duration`、进度百分比、站点进度条的判定。** |
| 是否有下一任务 | `course-page.ts:955-956` | `hasNext = nextModule() >= 0 || (顶层 #prevNextFocusNext 可见 && 无 .disable && aria-disabled!=="true")`。`#prevNextFocusNext` 只在**顶层文档** `root` 里找，不在 iframe 里找。 |

### 1.3 同卡片模块推进（横向任务点）

| 启发式 | 位置 | 判定条件 |
|---|---|---|
| 下一个未完成模块 | `course-page.ts:885-888 nextModule()` | 在 `this.modules` 中 `findIndex`：下标 ≠ `activeModule`、不在 `skippedModules`、且 `markerCompleted(marker)` 为 false。**按下标顺序，可以向小于 activeModule 的方向回退**。 |
| 授权跳过汇总 | `course-page.ts:889-892 authorizedModuleSkips()` | `skippedModules.size>0 && nextModule()<0 && 所有模块(已完成 或 在 skipped 中)`。只用于章节未完成提示的跳过判定。 |
| 初始激活模块 | `course-page.ts:931-937` | 每次 `inspect()` 重建 `modules`；仅当 `modules.length>0 && activeModule===null` 时取「第一个未完成模块」；若全完成取 0。**模块身份完全由下标表示。** |
| NEXT 的同卡片分支 | `course-page.ts:1274-1281` | 若 `activeModule!==null` 且该模块存在：可跳过时把下标加入 `skippedModules`；`nextModule()` 找到下一个未完成 → 暂停当前 video、`popupGeneration++`、`activeModule = upcoming`、返回 ok。**不点击站点横向任务点/标签、不滚动、不等待该模块加载。** |
| 任务键 | `course-page.ts:938` | `taskKey = module ? hash(cardKey\|"module:"+activeModule) : cardKey`；`taskKey` 变化时清空 `applied/sendAttempted/confirmAttempted`（939-942 行）。 |
| 释放 | `course-page.ts:1208-1220` | RELEASE 时清 `owner`、`confirmedNextControl`、`activeModule`、`skippedModules`、`startedVideos`；同一任务下暂停所有视频。 |

### 1.4 章节/卡片级推进

| 启发式 | 位置 | 判定条件 |
|---|---|---|
| NEXT 守卫 | `course-page.ts:1267-1273` | `skipUnfinished = allowSkipUnfinished && kind ∈ {VIDEO,QUIZ,RESOURCE}`；不满足 `completed || kind==="MATERIAL" || skipUnfinished` 即 fail「站点尚未确认本任务完成，拒绝跳转。」 |
| 章节 Next | `course-page.ts:1283-1286` | 同卡片没有下一个未完成模块（或 `activeModule===null`、或 `modules[activeModule]` 已不存在）时，点击顶层 `#prevNextFocusNext`；若 `!hasNext || !next` 则 fail「没有可用的下一个任务。」并清空 `confirmedNextControl`。 |
| 未完成章节提示 | `course-page.ts:251-263 nextNoticeControl()` + `1258-1266 CONFIRM_NEXT` | 只匹配 `.jobFinishTip,#jobFinishTip` 内可见、文案含「当前章节…未完成」的框；`skip` 时点 `.nextChapter`，否则点 `.popMoveDele,.nextbutton`（「to learn/返回学习」）；按钮不唯一即停止；同一按钮不重复点击。 |
| runner 主循环 | `runner.ts:981-1216` | 每轮：先 `CONFIRM_NEXT` 关闭遗留提示（998）→ 读快照 → `loading()` 有界等待（1006-1014）→ 按 kind 处理 → 计数 → `hasNext` 检查（1151）→ `NEXT`（1157）→ 25 秒等待任务键变化（1158-1203）→ 未变化则报错。 |
| 循环检测 | `runner.ts:1018` | `visited` 集合里出现相同 `taskKey` → 抛「任务跳转形成循环，已停止，避免重复答题和计费。」 |
| NEXT 后等待 | `runner.ts:1158-1203` | 每秒 `INSPECT`，直到 `taskKey !== previous` 且 `kind !== UNKNOWN`，上限 25 秒；期间如果出现未完成提示，按 `confirmSkip` 决定跳过还是返回学习；返回学习时最多补一次重读，重复提示即报错。 |
| 结尾释放 | `runner.ts:1210-1215` | 无论 DONE/ERROR 都向页面发 `RELEASE`（因此下次启动时 `activeModule/skippedModules/startedVideos` 已被清空）。 |

### 1.5 视频完成判定

| 启发式 | 位置 | 判定条件 / 行为 |
|---|---|---|
| 播放器定位 | `course-page.ts:478-490 currentVideo()` | 取作用域内所有 `<video>`；优先可见的（`isDisplayed`：display/visibility/opacity + `getClientRects`）；可见集为空时**退回全部**（含隐藏）；优先「正在播放」的，否则可见面积最大的。 |
| 起播 | `course-page.ts:177-219 startVideo()` | 已 `ended` 或非暂停直接返回；懒加载时先点站点播放按钮并等 metadata（10s）；`play()` 有 12s 超时（151/152-167）；失败再点站点控件、再静音起播、恢复原静音状态；全失败 fail「自动播放失败（…）」。**不 seek、不改 rate、不伪造进度**（符合硬约束）。 |
| 播放命令 | `course-page.ts:1289-1293` | `PLAY` 前把 video 加入 `startedVideos`；`PAUSE_VIDEO` 递增 `popupGeneration` 并暂停。 |
| runner 视频循环 | `runner.ts:1055-1116` | `playWithRetry()`（最多 3 次，间隔 2s）→ 每 2.5s `INSPECT` → 暂停时处理弹题 → 重试恢复播放 → 记录 `videoStatus`；`videoDeadline = max(600000, min(14400000, (duration+300)*1000))`（1074）。 |
| 无进展/结束超时 | `runner.ts:1099-1107` | 60 秒无 `currentTime` 增长且未 completed/ended → 抛「视频超过 60 秒没有播放进展…」；`ended` 后 60 秒仍未 completed 或超过 `videoDeadline` → 抛「视频播放后站点仍未确认任务完成，请检查课程页面；不会跳过任务。」 |
| 播放器消失 | `runner.ts:1085` | 轮询中发现快照 `video===null` → 立刻抛「监听发现播放器已移除，已停止。」（只在 `completed` 未成立时到达）。 |
| 完成判据 | `course-page.ts:950-952` | 同 §1.2：站点标记完成 + （若本轮启动过则）原生 `ended`。 |
| 已完成的视频 | `course-page.ts:950-952` | 未在本轮启动过且 marker 已完成的视频不会被重播（0.2.7 设计），直接计入完成。 |

### 1.6 PPT/PDF 资料完成判定

| 启发式 | 位置 | 判定条件 |
|---|---|---|
| RESOURCE 分类 | `course-page.ts:81-83,953-954` | 只有 iframe 路径恰为 `/ananas/modules/pdf/index.html` 且其文档 `readyState==="complete"` 才算 RESOURCE；否则 UNKNOWN。 |
| 刷课模式（course） | `runner.ts:1117-1129` | 空等站点标记完成，最多 60 秒；仍不完成 → 抛「站点尚未确认资料任务完成；可使用只刷课模式继续寻找非题目任务。」 |
| 只刷课模式（videosOnly） | `runner.ts:1117-1119,1145,1157`；`course-page.ts:1271-1272` | 只打印「已打开 PPT/PDF 资料，继续寻找下一个非题目任务点（未确认完成的资料仅计越过）」；`skippedResource=true`；NEXT 仅当 `kind==="RESOURCE"` 时携带跳过授权，页面把该模块下标加入 `skippedModules`。kind 不是 RESOURCE（含 UNKNOWN）时不能跳过 → 硬停止。 |
| MATERIAL（无任务点） | `course-page.ts:947-948,1273`；`runner.ts:1145-1146,1157` | kind=MATERIAL 时无需完成即可 NEXT；计 `skippedResources`，不计完成。course 模式与只刷课模式都不携带页面侧跳过授权（MATERIAL 本身不需要）。 |
| 滚动/翻页 | —— | **全仓不存在任何滚动或翻页代码**（见 §2.5），因此「需要滚到底才完成」的资料在 course 模式必然空等超时。 |

### 1.7 三种模式的差异（`App.vue:163,278,553-555`；`runner.ts`）

| 模式 | 选项 | 视频 | 题目 | PPT/资料 | 无任务点卡片 |
|---|---|---|---|---|---|
| 刷课：视频＋题目（course） | `skipVideos=false, videosOnly=false` | 正常播放并等站点完成 | 读取/模型/回填/提交一次 | 等站点完成，60s 超时即 ERROR | 直接 NEXT 越过（不计完成） |
| 刷题：仅完成题目（questions） | `skipVideos=true` | 不播放，带显式跳过授权越过（计 `skippedVideos`） | 同 course | 同 course（仍等完成，60s 超时 ERROR） | 同 course |
| 只刷课（videos） | `videosOnly=true` | 正常播放并等站点完成 | 不读取、不调模型、不提交；带显式跳过授权越过（计 `skippedQuizzes`） | 只有 kind=RESOURCE 才能带授权越过；否则 ERROR | 同 course |
| 独立作业页（dowork） | `standalone=true` | 不涉及 | 整卷提交一次后结束 | 不涉及 | 不涉及 |

所有模式共用同一 `runLoop`、同一 `inspect()`/`NEXT` 守卫；差异只在「谁可以带 `allowSkipUnfinished` 越过未完成任务」。
因此横向任务点/PPT/无任务点的卡住不是某一模式独有，而是「模式允许跳过与否」决定它表现为「越过」还是「ERROR 卡住」。

### 1.8 关键超时与错误文案（用于对照用户反馈）

| 触发点 | 文案 | 位置 |
|---|---|---|
| 未完成且无跳过授权 | 站点尚未确认本任务完成，拒绝跳转。 | `course-page.ts:1273` |
| 无下一任务 | 没有可用的下一个任务。 | `course-page.ts:1284` |
| 重复任务键 | 任务跳转形成循环，已停止，避免重复答题和计费。 | `runner.ts:1018` |
| NEXT 后页面未切换 | 页面没有切换到下一任务，已停止。 | `runner.ts:1203` |
| 重复未完成提示 | 同一任务重复出现未完成提示，已停止，避免循环作答。 | `runner.ts:1170` |
| 视频 60s 无进展 | 视频超过 60 秒没有播放进展，请检查前台播放或网络要求。 | `runner.ts:1101-1103` |
| 视频结束但站点未确认 | 视频播放后站点仍未确认任务完成，请检查课程页面；不会跳过任务。 | `runner.ts:1104-1107` |
| 播放器消失 | 监听发现播放器已移除，已停止。 | `runner.ts:1085` |
| 无播放器 | 页面上没有可操作的播放器。 | `course-page.ts:1291` |
| 资料未确认 | 站点尚未确认资料任务完成；可使用只刷课模式继续寻找非题目任务。 | `runner.ts:1128` |
| 未适配任务 | 当前任务类型尚未适配，请人工处理后再启动。 | `runner.ts:1131` |
| 题数不支持 | 任务题目数量不受支持。 | `runner.ts:1035` |
| 已到末尾（非错误） | 已到最后一个任务 | `runner.ts:1151` |
| 起播失败 | 自动播放失败（…），请在课程页手动点击一次播放。 | `course-page.ts:218` |

---

## 2. 症状 → 根因映射

### 2.1 症状 A：「横向任务点很多时无法有效跳转，会卡住」

**用户可见表现**：卡片顶部/任务点栏有很多任务点（视频/文档/测验混排）时，扩展播放/处理完一个后不前进，
或直接报「任务跳转形成循环」「页面没有切换到下一任务」「当前任务类型尚未适配」「页面上没有可操作的播放器」，
或（无报错）停在 `DONE 已到最后一个任务`。

**代码可证机制**
1. **R1 队列全损**：`courseModules()`（67-87）遇到任一「非标准」`.ans-job-icon` 就整体 `return []`。
   于是 `modules=[]`、`activeModule=null`、`moduleRoot=undefined`；`markedCompleted` 退回「全页所有 marker 都完成」（943-944），
   `completed` 变成旧整卡语义（950-952），`nextModule()=-1`，NEXT 永远走 `#prevNextFocusNext`（1283-1286）。
   横向任务点越多 → 出现「某个 wrapper 的 icon 数/iframe 数不标准」「延迟加载模块缺 icon/iframe」「icon 在 wrapper 外」
   的概率越大 → 越容易整队列消失。**这是 0.2.7 把 0.2.7 之前「整卡」问题修复成模块级之后新引入的脆弱点。**
2. **R2 下标漂移**：`activeModule` 是下标（872），`skippedModules` 是下标集合（874），`taskKey` 由下标构成（938）。
   站点在加载过程中增删/重排 `.ans-attach-ct`（0.2.7 记录过「延迟加载的测验会抢占」）时，同一轮里
   `this.modules` 重建后下标含义改变：可能把已完成模块重新当未完成、`skippedModules` 屏蔽错模块、`taskKey` 抖动导致
   `applied` 被清空（939-942），runner 侧 `bound.taskKey` 不匹配 → 页面命令被拒（1221）→ ERROR。
3. **R3 只换指针不激活**：NEXT 的同卡片分支（1274-1281）只是改 `this.activeModule`；下次 `INSPECT` 用
   `module.root = frame.contentDocument`（79-80）直接读那个 iframe。代码里没有任何「点击任务点/标签/滚动到可见」动作。
   若站点只为当前显示的模块初始化播放器（或只在激活时才创建内容文档），被切到的模块可能：
   - VIDEO：模块 kind 仍是 `VIDEO` 但作用域里没有 `<video>` → `PLAY` 立刻 fail「页面上没有可操作的播放器。」（1291）
     → runner 只重试 3×2s（192-203），不会像 UNKNOWN 那样等 25 秒（1006-1014）→ **快速 ERROR**；
   - QUIZ：`questionCount=0`，course 模式 loading() 会等 25 秒（1007）后按「任务题目数量不受支持」停止；videosOnly 模式反而能跳过；
   - RESOURCE：模块文档未 `complete` → kind=UNKNOWN（953-957）→ 25 秒后「当前任务类型尚未适配」。
4. **R5 无加载宽限（VIDEO）**：`loading()`（1006-1007）只覆盖 `UNKNOWN` 和 `QUIZ&&题数0`，**不覆盖 `VIDEO && video===null`**，
   也不覆盖 `moduleRoot` 为 null/空的情况；因此「切过去还没加载」的合法视频模块会被立即播放并失败。
5. **R8 卡片身份碰撞/抖动**：`cardKey` 依赖 `cardIndexOf()`（36-59, 927）。`cardIndexOf` 取「最后一个匹配帧的 num」，
   导航瞬间帧 src 为空时回落 `"0"`；若同时存在两个 cards 帧或顶层 URL 的 `chapterId` 未更新，新旧卡片可能算出相同
   `taskKey` → runner 25 秒后「页面没有切换到下一任务」。
6. **R9 等待零容忍**：NEXT 后等待循环（1158-1203）与切任务稳定循环（1008-1014）都直接 `await this.inspect()`；
   任一次 `INSPECT` 失败（顶层整页导航使注入丢失/`chrome.tabs.sendMessage` 失败、课程标签正导航）
   立刻进 catch → ERROR（1205-1209）。其它地方（1181-1186）反而有 try/catch 容错，说明这是遗漏而不是设计。

**待证据假设**
- H-A1：真实页面里「横向任务点」是 `.ans-attach-ct` 模块的顶栏标签，站点仅在点击标签后才加载对应模块 iframe/播放器；
  未点击时 `contentDocument` 为空或只有占位。→ 需要证据：同一卡片多个模块的 iframe `src`、`contentDocument.body.innerHTML` 是否存在、
  是否 `display:none`、点击标签前后是否变化。
- H-A2：模块 iframe 均已加载，但站点只为「当前激活模块」回传完成标记（隐藏模块播放结束后 `aria-label` 不变）。
  → 需要证据：手动播放一个隐藏模块后该模块 marker 的 aria-label 是否变化、是否必须激活。
- H-A3：真实页面存在不规范 `.ans-job-icon`（例如任务点总览图标、完成度徽标、隐藏模板）使 `courseModules()` 全损。
  → 需要证据：全页 `.ans-job-icon` 数量、各自 `closest(".ans-attach-ct")`、wrapper 内 icon/iframe 计数、可见性。
- H-A4：点站点 Next 会整页导航（顶层文档重建），期间的 `INSPECT` 注入失败造成偶发 ERROR。→ 需要证据：点击前后顶层 `location.href`/`readyState`。

### 2.2 症状 B：「同一横向层级会有点卡住」

**用户可见表现**：同一张卡片内来回跳、重复播放同一视频、报「任务跳转形成循环」；或处理完一个模块后停住不动。

**代码可证机制**
1. R2/R1 的组合：下标漂移 + 队列全损（见 2.1）。
2. **向后回跳**：`nextModule()`（885-888）允许返回小于 `activeModule` 的下标。只要某个更早模块的 marker 短暂/永久判为未完成
   （站点延迟更新、aria-label 文案不同、完成类名未被识别），NEXT 就会跳回去；由于 `visited` 含该 `taskKey`（1018），
   第二次回到同一模块即抛「任务跳转形成循环，已停止」。
3. **完成标记口径窄**：`markerCompleted()` 只认 aria-label（61-63）。若真实完成状态主要落在 `.ans-attach-ct.ans-job-finished`
   类上、aria-label 保持「任务点未完成」或值为其它文案（英文/其它皮肤），则同一卡片内**任何已完成模块都永远不会被判完成**：
   - 有 active 模块时：`completed` 永远 false → 若为 VIDEO 且 `ended`，60 秒后「视频播放后站点仍未确认任务完成」；
   - 若为 QUIZ/RESOURCE：`NEXT` 被拒或 60s 超时 → 同一卡片内反复停在同一模块（如果 `activeModule` 再次被重置为它）。
4. **`inspect()` 的 `applied` 重置**（939-942）与 `skippedModules`（929）绑定 `cardKey`：跨卡返回（未完成提示「to learn」）会重置，
   可能重新处理已完成模块；`recoveredNotices`（runner 1170-1171）只能对同一 `taskKey` 生效，卡片级来回不受它保护。
5. **`startedVideos` 只按元素记**（876, 950-952）：已记录证据显示同卡片可有多个视频模块；若站点复用同一个 `<video>` 元素或
   完成时替换元素，`ended` 条件的归属会错位：替换后 `video` 不在 `startedVideos` → 只靠 marker（可能不更新）→ 卡；
   同一元素复用 → 后一个视频继承 `startedVideos` 状态 → 仍要求 `ended`（通常满足）。
6. **`currentVideo()` 可能选错元素**（478-490）：可见集为空时退回全部并取面积最大；同卡片多个隐藏 video/预览 video 时
   可能选了不是当前模块的播放器；随后 `snapshot.video` 的 `ended/currentTime` 与该模块 marker 不同步 → 永不完成。

**待证据假设**
- H-B1：真实页面里同卡片不同模块的完成标记刷新时机不同（有的需离开卡片/刷新后才更新），导致「回跳/循环」。
- H-B2：视频完成后站点**移除/替换** `<video>` 元素（`runner.ts:1085` 会直接抛「播放器已移除」）或把 `currentTime` 复位。
- H-B3：同卡片多个 `<video>` 共存（隐藏预览/其他模块已加载），`currentVideo` 选错。
→ 以上均需：同一卡片多模块的脱敏快照（模块顺序、iframe src 路径、marker aria-label/类名、video 数量与可见性、
播放完成后 marker/video 的变化序列）。

### 2.3 症状 C：「很多地方没有任务点，也会卡住」

**用户可见表现**：进入「每节一句」/纯图文/补充阅读卡片后报「当前任务类型尚未适配，请人工处理后再启动」；
或莫名停在 `DONE 已到最后一个任务`；或「页面没有切换到下一任务」。

**代码可证机制**
1. **静态标签白名单过严**（95-106）：`A`、`FONT`、`HR`、`SECTION`、`ARTICLE`、`FIGURE`、`PICTURE`、`SOURCE`、`SMALL`、`SUB`、`SUP`、
   `CODE`、`PRE`、`SVG` 等常见排版标签不在白名单 → 只要卡片正文里有一个 `<a>` 链接，`staticContentCard()` 即 false →
   `material=false`（947）→ kind=UNKNOWN → **硬停止「当前任务类型尚未适配」**（runner 1130-1132）。
   同一条也会因 `#pageDiv.ans-cc` 里出现 `<style>/<script>`（被 `querySelectorAll("*")` 计入）而失败。
2. **「无任何 iframe」条件**：卡片文档里只要有隐藏 iframe（音频/统计/嵌入内容/站点工具）→ 静态卡识别失败。
3. **`markers.length===0` 是全页统计**（943-948）：顶层文档或其它帧中存在任意 `.ans-job-icon`（含隐藏模板、上一卡残留、
   侧栏任务总览）→ MATERIAL 永不成立。已记录证据 §6.5 只测过「目标框架 `.ans-job-icon` 数为 0」，不等于「全页为 0」。
4. **`readyState==="complete"`**：卡片帧仍在 `interactive` 时 kind=UNKNOWN，`loading()` 等 25 秒；若站点卡片持续不 complete
   （内嵌资源挂起等）→ 25 秒后硬停止。注意 MATERIAL 本身不会进入 `loading()`（它要求 kind===UNKNOWN 或 QUIZ 题数 0），
   因此「一直没被识别成 MATERIAL」的卡片最终以「当前任务类型尚未适配」停止，而不是继续等待。
5. **`hasNext` 只查顶层**（955-956）：若某皮肤把下一任务按钮放进卡片 iframe（未取得该皮肤证据），
   `#prevNextFocusNext` 找不到 → `hasNext=false` → runner 静默 `DONE 已到最后一个任务`（1151），用户看到「停住」。
6. **连续静态卡的任务键**：每张静态卡靠 `cardIndex`/`chapterId` 区分（927）；跨章且顶层 URL 未更新 `chapterId`、
   或两卡 `num` 相同（回落 `"0"`）→ `taskKey` 不变 → 25 秒 `页面没有切换到下一任务`（1203）。

**待证据假设**
- H-C1：用户报「没有任务点的页面」中，卡片的实际后代标签清单包含白名单外标签（最可能 `A`）；或卡片帧本身带 iframe。
  → 需要证据：该卡 `#pageDiv.ans-cc` 的后代 **tagName 清单**（不需要文本）、iframe 数量/path、卡片文档 `readyState`。
- H-C2：顶层文档是否存在 `.ans-job-icon`（隐藏模板/任务总览）→ 需要证据：全页 `.ans-job-icon` 计数与可见性。
- H-C3：用户课程页的 `#prevNextFocusNext` 是否确实总在顶层（§6.5 记录是在顶层，但 0.2.7 的 Java 课程皮肤未必相同）
  → 需要证据：顶层与各 iframe 中 `#prevNextFocusNext` 的存在/可见性。
- H-C4：点 Next 后顶层 URL 的 `chapterId` 是否变化、卡片帧 `num` 何时更新 → 需要证据：点击前后两帧 URL 与 `readyState`。

### 2.4 症状 D：视频「有的拖到末尾就完成，有的不能跳转，必须正常播放」

**先明确当前实现的安全面（代码可证）**：
- 扩展**从不 seek、不改倍速、不改时长、不伪造 ended**（`course-automation.md:163,255`；全仓对 `video.currentTime`/`playbackRate` 只有读取
  （`course-page.ts:960`、`runner.ts:1071,1093,1099-1100,224`），没有任何赋值/seek 调用）。
  因此「有的视频不能跳、跳了进度回退」在当前实现下不会由扩展制造；扩展只会正常播放。
- 但扩展**也没有**「拖到末尾」快路径。若用户期望的是「对允许的视频直接把进度放到末尾以节省时间」，
  这是**功能缺口**，且与 `AGENTS.md` 硬约束 2（不伪造视频进度/学习时长）存在冲突：把未观看的进度直接置到末尾，
  在约束口径下等于伪造进度。**本报告不建议在 0.2.8 实现自动 seek**；如确需，必须先由用户显式修改该约束并授权。

**代码可证机制（导致「站点已判定完成但扩展仍卡住」）**
1. **完成口径窄 + ended 双保险**（61-63, 950-952）：站点标记完成时扩展仍可能因为
   - aria-label 不是精确「任务点已完成/任务完成」（其它文案/语言/仅类名 `ans-job-finished`）→ `markedCompleted=false`；
   - 本进程启动过该视频且原生 `ended` 未被触发（站点播放器在结尾自动暂停/拦截 ended/提前停播/替换元素）→ `completed=false`；
   于是 runner 在视频循环里继续等，直到「视频播放后站点仍未确认任务完成」或 60s 无进展 ERROR。
2. **「已完成的视频不重播」与 `startedVideos`**（950-952）：如果扩展在旧一轮/旧进程里启动过该 video（WeakSet 随页面存活，
   但 `RELEASE` 会重置 1218），重启后按站点标记直接判完成；反之若视频被站点标 90% 完成，扩展会继续播到最后（0.2.7 设计），
   这期间若站点把进度重置（用户所说「进度回退」）扩展无法感知，只能等 ended/超时。
3. **播放器消失即 ERROR**（runner 1085）：视频结束后站点把 `<video>` 换成完成态 DOM，若此刻 marker 尚未更新，
   轮询顺序（1079 先查 completed，1085 再查 video）会让一次 null 快照直接终止整轮，而不是继续等标记。
4. **`videoDeadline` 用首帧 duration**（1074）：若起播时 `duration` 未知/为 0，长视频会在 10 分钟后被判超时
   （虽然 60s 进展规则通常先兜住）。
5. **`currentVideo` 选错元素**（478-490）：同模块多个 video/隐藏预览时 `ended/currentTime` 来自错误元素 → 永不完成。

**待证据假设**
- H-D1：用户课程中「放到最后位置即完成」的视频，站点完成信号是什么（`aria-label` 变化？类名变化？进度条文案？服务端刷新？），
  以及完成瞬间的 `currentTime/duration/ended`。→ 需要证据：完成前后 marker 的 `aria-label`/类名、video 的 `currentTime/duration/ended/paused`。
- H-D2：「不能跳转」的视频是否会在 seek 后由站点重置进度（用户描述）；若扩展从不 seek，则该类视频在 0.2.8 唯一要保证的是
  「正常播放 + 正确识别完成」，不需要适配 seek。
- H-D3：是否站点在视频结束后移除/替换 `<video>`（触发 1085）。
- H-D4：是否同模块存在多个 video 元素/隐藏预览。

### 2.5 症状 E：PPT/资料「有的滚到最底部才完成，有的不需要」

**代码可证机制**
1. **没有滚动实现**：`apps/extension/src` 中 `scrollTo/scrollTop/scrollBy/scrollIntoView` 命中 0；
   course 模式对 RESOURCE 只是每秒 `INSPECT` 空等最多 60 秒（runner 1117-1129）。因此「必须滚到底才完成」的资料
   必然 60 秒后 ERROR；「打开即完成」的资料正常。**这正是用户描述的二分现象。**
2. **RESOURCE 分类脆弱**（81-83, 953-954）：kind=RESOURCE 需要 iframe 路径精确匹配且文档 `readyState==="complete"`；
   跨域/未加载/路径皮肤不同 → UNKNOWN → 连只刷课模式的跳过授权都不给 → 「当前任务类型尚未适配」。
   `docs/course-playback-0.2.7.md:35` 也声明「PPT 支持仅指已适配的 PDF 转换查看器」，其它 PPT 皮肤从未取证。
3. **只刷课模式的资料跳过有前置条件**：`kind==="RESOURCE"`（runner 1145、course-page 1271-1272）。若资料是 UNKNOWN，
   即使只刷课也不会越过，与用户「只刷课应该继续找下一个视频」的预期冲突。

**待证据假设**
- H-E1：真实 PPT/PDF 查看器的 iframe 路径是否仍为 `/ananas/modules/pdf/index.html`；`readyState` 是否稳定 complete；
  是否跨子域（导致 `root=null`）。
- H-E2：站点对该资料的完成条件是不是「滚动到最底部/翻到最后一页/停留时长」；若是，滚动容器是哪个（外层文档/内部 div/iframe 内滚动区），
  以及**手动滚到底后 marker 何时变化**（立即/几秒/刷新后）。
- H-E3：是否存在「打开即完成」的资料类型可用来复核 RESOURCE 判定是否需要「已打开」即越过。
- H-E4：只刷课模式下，用户是否希望**所有已打开但未确认的资料**都可越过（当前仅 RESOURCE 可），还是仍保守停止。

---

## 3. 候选修复方向与风险

> 所有修复都必须保留：不伪造视频进度/学习时长/签到；不自动提交考试；不凭记忆编造选择器（新选择器只允许来自
> `compatibility.md` 已记录证据或新的脱敏 DOM 证据）；只刷课跳过题目需显式授权且不计完成；
> 只有已识别的 PDF/PPT 转换查看器才可带跳过授权越过。
> 每条修复标注：**改哪里（函数+行）→ 加什么判定/状态机/超时/日志探针 → 风险 → 是否需要新脱敏 DOM 证据**。

### 3.0 分级与建议落地顺序

| 级别 | 含义 | 建议顺序 |
|---|---|---|
| P0 纯代码 | 不需要新选择器、不改变安全边界，只改状态机/超时/容错/诊断 | 0.2.8 第一批 |
| P1 已有记录证据 | 只使用 `compatibility.md` §6.5/§6.9/`course-automation.md` 已记录的结构；仍需在真站抽样确认（F7、F10、F11、F12） | 0.2.8 第二批（与证据采集并行） |
| P2 需新证据 | 需要用户课程页新的脱敏 DOM/运行证据，可能改变行为或需用户新增授权 | 证据到位后 |

### 3.1 P0 纯代码修复（建议 0.2.8 第一批；其中 F7 需先取证才启用）

**F1. `courseModules()` 局部容错 + 异常标记（course-page.ts:67-87）**
- 改动：把「任一 anomaly → 整体 `return []`」改为「跳过该 marker 并在 `CourseModule` 上记 `anomaly: string`；
  返回 `{modules, anomalies}`。`inspect()` 把 `anomalies` 计入快照诊断字段；当 `anomalies.length>0` 时：
  `MATERIAL` 判定继续禁用、未识别异常模块的「跳过授权」一律不生效（fail-safe 保持保守），但**已完成模块与正常模块仍可推进**。
- 风险：局部容错后可能把「不是任务点的杂项 icon」当模块。缓解：只接受「wrapper 内恰 1 iframe 且路径为已记录三种之一或 UNKNOWN」
  才算模块；文字/图标以外的杂项只进 anomalies，不参与推进。
- 新证据：**否**（结构和路径均为已记录证据）。但要真站样本验证 anomalies 的实际形态（诊断探针会给出）。

**F2. 模块稳定身份替代下标（course-page.ts:869-877, 885-892, 931-938, 1274-1281）**
- 改动：`CourseModule` 增加 `key`（wrapper 在卡片内的稳定序号 + `iframe` 的 `pathname` + 已记录类名存在性），
  `activeModule: number|null` → `activeModuleKey: string|null`；`skippedModules: Set<number>` → `Set<string>`；
  `taskKey` 用 `module.key` 而非下标；每次 `inspect()` 校验 `module.marker.isConnected` 与 `module.root` 是否仍对应。
  模块列表重排/增删时：不再错位，而是按 key 查找；key 消失（模块被移除）→ 保留下一个未完成 key 并记诊断。
- 风险：`taskKey` 变化会使旧命令被拒（1221），但这是正确行为；需确保 key 在站点重渲染（同 wrapper 同 iframe src）时稳定。
- 新证据：否（纯结构）；但需要真站验证「重渲染后 same wrapper/icon/iframe 的稳定性」。

**F3. VIDEO/RESOURCE 的加载宽限（runner.ts:1006-1007, 1055-1065；course-page.ts:894-961）**
- 改动：`loading()` 增加 `(current.kind === "VIDEO" && !current.video)` 与
  `(current.kind === "VIDEO" && current.video !== null && current.video.duration === 0)` 等等价「模块/播放器内容尚未就绪」条件，
  统一走 25 秒有界等待（现 1008-1014），超时才按原错误停止；
  同时把 `course-page.inspect()` 中「模块 kind 为 VIDEO 但该模块文档 `root===null`」视为未就绪（让 `loading()` 感知），
  并在 `runLoop` 的 VIDEO 分支 `playWithRetry` 前若 `video===null` 再做一次有界等待，而不是立刻三次重试后 ERROR。
- 风险：把真实「没有播放器」的破坏页面拖长 25 秒，但错误信息更准确（把「页面上没有可操作的播放器」变成
  「等待任务点模块加载 25 秒后仍无播放器（可能需要在课程页点击该任务点激活）」）。无进度伪造。
- 新证据：否（纯时机）；但需要真站观察模块加载耗时以确定 25 秒是否够。

**F4. 导航等待容错（runner.ts:998-1014, 1158-1203）**
- 改动：把「NEXT 后 25 秒等待」「切任务后 25 秒稳定等待」里的 `await this.inspect()` 包成有界重试：
  连续失败 ≤8 次且总时长不超窗口时继续（记录最后一次错误），超过才抛；
  对「顶层整页导航」场景可在重试前用 `chrome.scripting` 重新注入（background 已有 `ensureAutomationEntry`，但 sendMessage 失败路径
  目前直接返回失败，可让 background 在 TAB_UNAVAILABLE 时重试一次注入+发送）。
- 风险：把真实「标签被关闭/权限被收回」拖长几秒；需保留最终明确错误。不得因重试而重复点击 NEXT（NEXT 仍只发一次；等待循环只读）。
- 新证据：否。

**F5. 快照诊断探针（course-page.ts:894-961；protocol.ts:6-20；App.vue 状态卡）**
- 改动：`TaskSnapshot` 增加可选、**脱敏**的 `diagnostics`（只给计数/路径/布尔，不给文本/题文/答案/URL 参数）：
  - `docs`：可访问文档数、iframe 总数；
  - `cards`：`/mooc-ans/knowledge/cards` 帧数量与各自 `num`（仅数字）、`#prevNextFocusNext` 在顶层/帧内各多少、是否可见/禁用；
  - `modules`：`courseModules` 得到的模块数、每个模块的 kind、`rootLoaded`、`anomaly` 计数、`activeModuleKey`、`skipped` 数；
  - `markers`：全页 `.ans-job-icon` 计数、其中 `closest(".ans-attach-ct")` 成功数、aria-label 命中「未完成/已完成/其它/缺失」计数、
    `ans-job-finished` 存在数（这些是已记录结构，不含课程内容）；
  - `material`：识别失败时的前 3 个「违规 tagName」与「iframe 数量」、`#pageDiv.ans-cc` 是否存在/可见、`readyState`；
  - `video`：video 数量/可见数量、当前选中元素是否在 `startedVideos`、`ended/paused/duration/currentTime`；
  - `pdf`：pdf 模块文档 `readyState`、是否可访问（跨域）。
  - runner 把诊断压缩成一行 `state.step`/新增 `state.navDiagnostics` 显示；**不包含题文、答案、课程标识、完整 URL、HTML**。
- 风险：信息量增大但全部为结构计数；需在 `privacy.md`/协议测试中加入「不得出现文本内容」的断言。
- 新证据：**这就是采集证据的手段**（用户下次复现时可直接截图/复制诊断行，作为脱敏 DOM 证据的替代入口）。

**F6. `NEXT` 在「有未完成模块但异常/列表塌缩」时拒绝静默跳章（course-page.ts:1274-1286）**
- 改动：当 `anomalies.length>0` 且即将落到 `#prevNextFocusNext` 时，若快照显示本卡片存在未完成模块（能证明）→
  fail「本卡片仍有未完成模块但结构异常（诊断行），已停止，不跳过」；若不能证明有未完成模块，保持现有逻辑但诊断行必须带 anomalies。
- 风险：可能更多 ERROR；但避免「静默跳过未完成任务」比卡住更安全。
- 新证据：否。

**F7（P1，先取证后启用）. 完成标记口径收敛（course-page.ts:61-63 markerCompleted + 950-952）**
- 改动（**仅吸收已记录证据**）：`markerCompleted(marker)` 增加第二个来源——`marker.closest(".ans-attach-ct")?.classList.contains("ans-job-finished")`
  （`compatibility.md` §6.9 已记录完成模块含该类）。保留 aria-label 优先；两者任一成立即视为「站点标记完成」。
  仍**只用于推进已完成任务**，绝不用于「授权跳过未完成」；`skippedModules` 的产生条件不变。
- 风险：若该类在站点上存在「曾经完成、后又被回退」的残留，可能提前推进 → 因此该修复**必须先取得真站「完成→回退」证据**，
  或增加「类名出现后仍需 5-10 秒二次确认（连续两次 INSPECT 都成立）」的稳态判定。
- 新证据：**是**（需在用户课程页确认完成瞬间`.ans-attach-ct`/`.ans-job-icon` 的 aria-label 与类名变化序列，是否只加类名不改 aria-label）。

**F8. 视频结束后的有界观测（runner.ts:1085-1107；course-page.ts:950-952）**
- 改动：`snapshot.video === null` 时不要立刻抛，改为「允许连续 N 次（如 3 次/≤10 秒）null，期间若 `completed` 成立则正常结束」；
  仍无 video 且未完成 → 原错误。
- 风险：几乎不增加误判（完成仍以站点标记为准），只是容忍站点结束后替换 DOM。
- 新证据：否（纯容错），但若真站确实移除播放器，该修复能直接消除一类卡住。

**F9. 诊断化错误文案（runner/course-page 多处 fail）**
- 改动：把上述每类错误后面附上脱敏诊断摘要（如「卡片 #3；模块 4 个（VIDEO/QUIZ/PDF/VIDEO），当前第 2 个；marker：未完成 2 个/已完成 1 个/无 aria-label 1 个；顶层 Next 可见」），
  让用户下次反馈可直接说明卡在哪；**不含题文/答案/课程标识**。
- 风险：低；须在日志规范/测试中断言脱敏。
- 新证据：否（是取证手段）。

### 3.2 P1：已有记录证据即可做，但需真站抽样确认

**F10. 静态无任务点卡片白名单扩展（course-page.ts:95-106）**
- 改动：白名单加入**展示型**标签：`A`（普通链接，不点击、不激活）、`FONT`、`HR`、`SECTION`、`ARTICLE`、`FIGURE`、`FIGCAPTION`、
  `PICTURE`、`SOURCE`、`SMALL`、`SUB`、`SUP`、`CODE`、`PRE`、`SVG`/`PATH`（只作为图形内容；若存在 `script` 子节点则仍拒绝）；
  仍拒绝交互/嵌入：`IFRAME/FRAME/OBJECT/EMBED/VIDEO/AUDIO/CANVAS/FORM/INPUT/SELECT/TEXTAREA/BUTTON`、
  `[contenteditable]`、`[role]`、`[onclick]`、`<a href^="javascript:">`。
- 风险：把「看似静态但实际是交互卡片」误判 MATERIAL 并越过 → 不计完成、不提交，但会少处理内容。缓解：保留
  「全页无任务标记 + 无模块 iframe + readyState complete + 图片加载完成」四重门；并让 F5 诊断记录「被跳过卡片」的 tag 清单摘要。
- 新证据：**是**（需要用户报卡住的那类卡片的 tagName 清单，确认新增白名单标签确实是展示型）。

**F11. `markers` 统计口径（course-page.ts:943-948）**
- 改动：把「全页 `.ans-job-icon` 数为 0」拆为两条：`cardMarkers`（当前 cards 文档内、且属于当前卡片的模块 wrapper）
  与 `foreignMarkers`（其余文档/无 wrapper 的 icon）。MATERIAL 只要求 `cardMarkers===0 && 无模块 iframe`；
  `foreignMarkers>0` 时记诊断但不否决（因为已记录证据只证明目标框架内部无 icon）。若真站证据显示顶层 icon 确实代表本卡任务，
  再收紧。
- 风险：若顶层 icon 真属于当前卡任务，可能把带任务卡片误判 MATERIAL 越过（不计完成，但仍会少做任务）。必须用证据定夺；
  默认建议**先只加诊断、不改判定**，等证据。
- 新证据：**是**（顶层/其它帧 `.ans-job-icon` 是否存在、是否属于当前卡片）。

**F12. `cardKey` 身份增强（course-page.ts:36-59, 925-938）**
- 改动：`cardIndexOf` 增加：只统计**可见**的 cards 帧；若多个匹配帧，校验 `num` 一致性（不一致记 anomaly 并按「URL 中的 chapterId +
  当前可见帧 num」取）；`cardIndexOf` 不再回落 `"0"` 作为身份，而是返回 `null` 表示「卡片身份不可判定」，
  `cardKey` 在 `null` 时附加「未知」标记并让 runner 在等待循环里重试而不误判为已切换；
  顶层 URL 若含 `chapterId` 之外的章标识（如 `knowledgeId`）也不臆造，只记诊断。
- 风险：身份变化会改变现有任务键 → 需同步更新测试与 `taskKey` 兼容；不得让「身份不可判定」被当成完成。
- 新证据：部分需要（真实 URL 参数与多帧时序），但可用纯代码先做「不回落 0 + 诊断」。

### 3.3 P2：需要新脱敏 DOM 证据（可能还需用户新增授权）

**F13. 点击横向任务点/标签激活模块（course-page.ts:1274-1281）**
- 前置证据：真实卡片任务点栏的**结构**（已记录的 `.ans-attach-ct`? 是否另有 tab 控件）、点击后 iframe 是否加载/激活、
  点击是否产生副作用（是否会标记为已打开而不计完成、是否触发站点自身进度）。
- 改动（证据到位后）：在 NEXT 的同卡片切换分支中，点击该模块对应的站点自身任务点控件（**只点击由证据确认的那一个控件**），
  然后有界等待其 `contentDocument` 就绪（复用 F3 的等待）；点击前校验「该控件唯一、可见、非禁用」，不唯一即停止。
- 风险：误点其它任务点（需要唯一性守卫）；点击可能被站点记为用户行为（但这本来就是用户授权的自动刷课）。
- 新证据：**是**（必须有）。

**F14. PPT/PDF 资源完成辅助（course-page.ts/新增；runner.ts:1117-1129）**
- 前置证据：查看器 iframe 路径与 DOM、滚动容器、站点完成条件（滚动/翻页/时长）、手动操作后 marker 变化。
- 方案（证据到位后，二选一）：
  a) **站点自身控件翻页**（更安全）：若查看器提供「下一页」控件且已取证，按站点控件逐页/滚到底部；仍只以站点标记作为完成证据；
  b) **滚动查看器滚动容器到最底部**：只在已识别容器上 `scrollTop = scrollHeight`，不伪造时间、不伪造完成；仍等站点标记。
- 风险：自动滚动是否等同于「伪造阅读进度」需要用户明确授权（与「不伪造学习时长」相邻）；必须在授权文案和 UI 中说明
  「仅滚动到资料末尾，完成与否仍由站点判定」。只刷课模式对未确认资料仍只计越过、不计完成。
- 新证据：**是**（DOM + 站点完成条件 + 用户授权）。

**F15. 只刷课模式的资料越过范围（runner.ts:1145,1157；course-page.ts:1271-1272）**
- 前置证据：用户是否希望「已打开但未确认完成的任意资料」都越过、还是仅已识别 PDF/PPT 转换查看器（当前约束是后者）。
- 改动（若用户授权扩大）：在 `videosOnly` 下，对「已打开的 RESOURCE 变体（例如新取证的第二查看器路径）」带授权越过，仍不计完成。
- 风险：越过未知资源可能漏掉真实任务；必须保持「只刷课不加成完成」。
- 新证据：**是**。

**F16. 不做的方向（明确写入方案）：视频 seek/拖到末尾快路径**
- 当前全仓无 seek；用户描述的「拖到末尾站点就判定完成」是站点行为，不是扩展行为。
- 若在 0.2.8 实现「自动 seek 到末尾」，等于把未观看的进度直接置为完成 → **违反 AGENTS 硬约束 2**。
- 结论：0.2.8 不实现；若用户明确要求，需要用户先修改该约束（并在验收/AGENTS 中重新授权），且仍需真站证据证明哪些视频允许跳转。

### 3.4 证据采集方案（不修改源码即可执行的只读步骤）

在用户课程页（已登录、真实课程）**只读**采集，建议一次采集一个卡片，按下列顺序，全部只记录结构与计数，不记录题文/答案/完整 URL/HTML：

1. **基础快照**：顶层 `location.pathname`（只保留路径）+ 顶层 `#prevNextFocusNext` 存在/可见/`class`/`aria-disabled`；
   顶层 iframe 数量；每个 iframe 的 `pathname`（不含 query 值）；卡片帧 `readyState`；卡片帧 `num`（数字）。
2. **模块快照**：`document.querySelectorAll(".ans-job-icon").length`（分别统计顶层与卡片帧）；每个 icon 的
   `closest(".ans-attach-ct")` 是否成立、wrapper 内 `.ans-job-icon` 数、`iframe` 数、iframe `pathname`、
   wrapper `classList` 是否含 `ans-job-finished`；icon 的 `aria-label` 属于「未完成/已完成/其它/缺失」（aria-label 是站点固定结构文案，可只回传匹配类别，不回传页面正文）。
3. **可见/加载态**：哪些 wrapper/iframe 可见（`getClientRects`）；各 iframe 的 `contentDocument` 是否可访问、`body` 是否有内容、
   是否有 `<video>`、video 的 `readyState/paused/ended/currentTime/duration`（数值）。
4. **完成瞬间**：对「拖到末尾即完成」视频，手动操作到站点显示完成，记录此时（及 5 秒后）marker 的 aria-label/类名与 video 数值；
   对「必须正常播放」的视频同样记录，用于区分完成信号。
5. **PPT 完成条件**：打开一个需要滚到底的 PPT/PDF 资料，先记录 marker 状态，手动画到底部后再记录（0s/5s/30s/刷新一次），
   以及滚动容器结构（tagName + class 名 + scrollHeight/clientHeight 是否可滚动；class 名属于结构，需用户同意后可脱敏保留）。
6. **导航时序**：点站点 Next 后立刻（0/1/3/10 秒）记录顶层 `location.href` 的 **pathname 与参数名**（不含参数值）、
   卡片帧数量与 `num`、`readyState`。用于验证「点 Next 是否整页导航」「chapterId 是否变化」。

若代码侧先落 F5 诊断探针，则第 1-4 步的大部分数据可在调度页直接读到，无需用户手工执行 DOM 检查。

### 3.5 测试与文档同步（供 lead 写 0.2.8 方案时引用）

- 单测（`apps/extension/tests/automation-course-page.test.ts`）：
  - `mixedCard()` 增加变体：仅 `ans-job-finished` 类完成、wrapper 内 2 个 icon、模块重排后 NEXT 选对、非标准 marker 只进 anomalies；
  - `staticCard()` 增加 `<a>`/`<iframe>`/`<script>`/白名单外标签用例，断言 MATERIAL 与 UNKNOWN 边界；
  - `cardIndexOf` 增加「两个 cards 帧」「无 num 回落」用例；
  - 视频：`VIDEO` 且无 video 的 snapshot、`ans-job-finished` 完成、ended 后 video 被移除的序列。
- 单测（`automation-runner.test.ts`）：VIDEO 无 video 的 25s 宽限；NEXT 后 inspect 连续失败重试；diagnostics 摘要不含文本。
- e2e（`tests/extension/extension.spec.ts` + `tests/fixtures/automation-mixed-course*.html`）：新增「未激活模块 iframe」与「PPT 需滚动」夹具；
  维持零提交、零模型请求断言。
- 文档：`compatibility.md` 新增证据记录；`course-playback-0.2.8.md`；`acceptance.md` 新增一节；AGENTS/约束如需扩大授权必须显式写明。

### 3.6 风险清单（修复时逐条对照）

1. **重复答题/重复提交**：任何让 `taskKey` 更不稳定的改动都会使 `applied` 被清空→拒绝提交或重复处理；F2 必须同时保证
   `SEND_WORK` 的 `applied` 校验与 `sendAttempted`（1236-1248）不被重置绕过。
2. **误判完成**：F7 类名补信号若站点有「暂标记完成后又回退」的行为，会提前推进 → 必须稳态确认或先取证。
3. **误越过未完成任务**：F1/F6 的 fail-safe 必须保证 anomalies 存在时**不增加**任何跳过授权；MATERIAL 误判会越过内容（不计完成但仍可能漏任务）。
4. **滚动=读进度**：F14 可能被认定为「伪造阅读进度」，必须用户显式授权并在 UI 说明；只刷课仍不计完成。
5. **浏览器后台标签页节流**：视频轮询依赖标签页存活；站点「观看时不可离开」限制不得绕过（错误停止即可）。
6. **选择器纪律**：0.2.8 不得新增任何凭记忆猜测的类名；F13/F14 的控件必须来自新证据。
7. **协议/契约**：`TaskSnapshot.diagnostics` 为可选字段，需同步 TS 类型、协议测试与 `docs/openapi.yaml`（若涉及后端契约）与静态安全检查测试。
8. **日志脱敏**：诊断字段禁止包含题文、答案、aria-label 之外的可见文本、课程标识、完整 URL、HTML。

---

## 4. 未知项清单（不下断言）

| # | 未知项 | 影响 | 最小取证方式 |
|---|---|---|---|
| U1 | 真实「横向任务点」的 DOM 形态：是否为 `.ans-attach-ct` 顶栏标签/另设 tab 控件；点击与不点击的差异 | 决定是否需要 F13、R3 是否成立 | §3.4 第 1、2、3 步；点击一个任务点前后快照对比 |
| U2 | 未激活模块的 iframe 是否已加载内容、是否有 video/题目、完成标记是否只在激活时更新 | 决定 R1/R3/F3 修复形态 | 同 U1；对隐藏模块手动播放后观察 marker |
| U3 | 真实完成信号：`.ans-job-icon[aria-label]` 是否随完成即时变化；`ans-job-finished` 是否可靠；是否会回退 | 决定 F7 是否可落地 | §3.4 第 4 步（完成瞬间与 5s 后） |
| U4 | 视频完成后 `<video>` 是否被移除/替换；`ended` 是否稳定触发；`currentTime/duration` 与完成的关系 | 决定 F8 与 ended 双保险是否要调整 | §3.4 第 3、4 步 |
| U5 | 同模块是否存在多个 `<video>`（隐藏预览/其它模块共存） | 决定 `currentVideo` 选择是否需要收紧 | §3.4 第 3 步：video 数量/可见性/位置 |
| U6 | PPT/PDF 查看器真实路径、`readyState` 时序、是否跨域；完成是否由滚动/翻页/时长决定；滚动容器 | 决定 F14 是否可行、RESOURCE 判定是否要放宽 | §3.4 第 5 步 |
| U7 | 无任务点校园页卡片的真实后代标签清单与 iframe 数量 | 决定 F10 白名单与 F11 口径 | §3.4 第 2 步（只回传 tagName/计数） |
| U8 | 顶层是否也存在 `.ans-job-icon`（隐藏模板/总览），是否属于当前卡片 | 决定 F11 | §3.4 第 2 步（顶层计数） |
| U9 | 点站点 Next 后顶层是否整页导航、`chapterId` 是否更新、是否存在多个 cards 帧/导航瞬间无 `num` | 决定 F12 与 R9 修复 | §3.4 第 6 步 |
| U10 | 顶层 `#prevNextFocusNext` 是否在所有皮肤都在顶层；是否有 `disable`/`aria-disabled` 之外的禁用形态 | 决定 hasNext/「已到最后一个任务」的误判 | §3.4 第 1 步（各帧存在性） |
| U11 | 用户对「自动滚动 PPT」「把视频进度放到末尾」是否愿意/允许（与约束 2 冲突） | 决定 F14/F16 是否做、授权文案 | 需要用户明确答复，不由代码推断 |
| U12 | `accessibleDocuments` 深度 5/文档 40 上限在用户课程多横向任务点时是否被触顶 | 可能漏模块/漏播放器 | 诊断探针的 docs 计数（F5） |
| U13 | 0.2.7 真实运行日志/错误截图：用户看到的具体错误文案与所处卡片 | 决定优先级（本报告只能按代码路径排优先级） | 用户提供错误截图/诊断行；不含题文/答案 |

---

## 附录 A：关键文件与行号索引（本次实际阅读）

- `apps/extension/src/automation/course-page.ts`
  - 文档递归 15-22；卡片序号 36-59；marker 完成 61-63；模块队列 67-87；静态卡 95-106；播放按钮 109-121；
    metadata 123-137；`PLAY_START_TIMEOUT_MS` 151；`tryPlay` 152-167；`startVideo` 177-219；`siteClick` 228-246；
    未完成提示 251-263；video 候选 266-268；`isDisplayed` 270-276；弹题 410-476；`currentVideo` 478-490；
    `questionElements` 492-494；`CoursePage` 字段 862-877；作用域 879-884；`nextModule` 885-888；`authorizedModuleSkips` 889-892；
    `inspect` 894-962（卡片键 925-930、模块 931-938、标记/完成 943-961）；`describe` 967-1023；`capture` 1025-1046；
    `adoptExisting` 1048-1055；`apply` 1057-1149；`enumVideoPopup` 1158-1203；`handle` 1205-1301（RELEASE 1208-1220、
    SEND_WORK 1236-1248、CONFIRM_WORK 1249-1257、CONFIRM_NEXT 1258-1266、NEXT 1267-1286、PLAY/PAUSE 1289-1293）。
- `apps/extension/src/automation/runner.ts`
  - RunOptions 7-22；`playWithRetry` 192-203；`inspect/action` 174-184；`runLoop` 981-1216（遗留提示 998-1001、
    loading 1006-1014、循环检测 1018、QUIZ 1030-1052、视频 1055-1116、RESOURCE 1117-1129、未适配 1130-1132、
    计数 1143-1149、hasNext 1151、NEXT 1157、NEXT 等待 1158-1203、错误/释放 1205-1215）。
- `apps/extension/src/automation/protocol.ts`：TaskSnapshot 6-20；Action 52；`allowSkipUnfinished` 84-91；解析 100-130。
- `apps/extension/src/automation/App.vue`：`start` 163；模式映射 278；模式选项 553-555。
- `apps/extension/src/background.ts`：注入 104-118；发送 120-136。
- `apps/extension/src/automation/page-entry.ts`：单实例 + `CoursePage(document)` 3-8。
- `apps/extension/src/shared/pages.ts`：路径判定 7-15。
- 已记录证据：`docs/compatibility.md` §6.5（176-184）、§6.7（198-211）、§6.9（237-241）；
  `docs/course-automation.md` 169-185（页面结构表）、163（视频只正常播放）；`docs/course-playback-0.2.7.md` 13-22、35；
  `docs/acceptance.md` §9.38（1237-1245，标注 Unverified）。

## 附录 B：与硬约束的对照（修复方案必须遵守）

1. 不伪造视频进度/学习时长/签到 → 不实现 seek 快路径（F16）、不伪造 ended、不伪造滚动为完成。
2. 不自动提交考试 → 本报告所有改动不触碰 `submitControls`/`CONFIRM_WORK`/考试路径。
3. 不凭记忆编造选择器 → 本报告所有「新增」选择器/类名都注明来源：已记录证据（`.ans-attach-ct`、`.ans-job-icon`、`ans-job-finished`、
   `#prevNextFocusNext`、`#pageDiv.ans-cc`、`#iframe`、模块路径）或「需新证据」（F13/F14）。
4. 只刷课模式题目跳过需显式授权且不计完成 → F1/F6 的 fail-safe 不得扩大跳过授权；`skippedQuizzes/skippedResources` 语义不变。
5. 仅已识别的 PDF/PPT 转换查看器可带跳过授权越过 → F15 需用户授权 + 新证据；UNKNOWN 资料仍停止。
6. 未知/未加载模块、正式考试、需前台播放等仍停止并如实报告 → F3 只把「立即停止」改为「有界等待后停止」，错误更准确。
