# 0.2.8 整改方案（完整版 · 2026-10-21 需求确认后修订）

- 基线：0.2.7（已发布 GitHub Release）。本文件是**整改方案**，尚未改代码、未升版本。
- 证据：
  - [navigation-findings.md](analysis/navigation-findings.md)（导航/视频/PPT 根因，行号级）
  - [auto-submit-findings.md](analysis/auto-submit-findings.md)（跨机不自动提交根因）
  - [audio-findings.md](analysis/audio-findings.md)（声音现状与目录方案）
  - 用户 2026-10-21 19:21 需求确认（见 §0，取代上一版方案中的待确认项）

---

## 0. 已确认需求与落地规则

| # | 用户原话 | 落地规则 |
|---|---|---|
| 1 | 查看视频是否可以拖动，可以拖动就进行拖动；PPT 划到底部；**一切的目标是任务绿色**；没有任务点就横向跳过，横向为最后就纵向跳过 | ①视频：站点允许拖动时用拖动完成，禁止拖动时回退完整播放；②PPT/PDF：滚动到底部；③**完成判定唯一标准 = 站点任务点变绿（站点自己的完成标记）**；④无任务点的内容直接越过（不计数）；横向没有可处理项时转纵向（下一卡片/章节） |
| 3 | PPT、PDF 划到底部 | 资料任务在观察窗口内未变绿时，执行结构性滚动到底部，再等待变绿 |
| 4 | 我要自定义声音，播放声音稍后提供 | 声音改造按「可自定义音频」设计；用户提供 wav/mp3 后放入固定目录即可生效；同时提供设置页上传入口 |

**由此产生的授权变化（必须写入 AGENTS.md 与验收，见 §12）**：

- 新增「站点允许时可定位视频到末尾」授权：允许把 `video.currentTime` 定位到末尾**以触发站点自己的完成判定**；站点不允许/进度回退时**回退完整播放**；仍以站点完成标记为唯一证据；不伪造 `ended`、不派发伪造事件、不重复拖动。
- 新增「无任务点内容自动越过」授权：已加载、无任务标记、无交互控件的卡片/资料直接越过，**不计数为完成**；有未完成任务标记的内容绝不越过。
- 不改变：不自动提交正式考试、不重复提交、不伪造学习时长/签到、不收集题文/答案/凭据。

---

## 0.5 推荐解决方案（结论先行）

推荐总路线：**先诊断 → 再整改 → 最后做依赖证据的部分**；所有新行为都挂在设置开关后（可一键回退到 0.2.7 行为），完成判定始终是「站点任务点变绿」。

| 领域 | 推荐做法 | 不建议 | 理由 |
|---|---|---|---|
| 视频 | 开头一次「可拖性试探」→ 课程级缓存（可拖：直接定位末尾；禁拖：回 0 完整播放），只改 `video.currentTime`，不模拟鼠标 | 每次视频都盲拖；模拟拖拽进度条；伪造 `ended` | 试探在最安全的开头 10s 内，损失最小；禁拖课程不会反复触发进度回退 |
| PPT/PDF | 打开先观察 3–5s（有的不滚就绿）→ 没绿再结构性滚动到底（3–5 段，不猜类名）→ 再等变绿 | 一打开就无脑滚到底；点翻页按钮；伪造阅读时长 | 覆盖「有的需要滚、有的不需要」两种资料 |
| 导航 | 模块稳定 key（不用数组下标）→ 横向顺序推进 → 横向没有转纵向（站点 Next）→ 无任务点内容直接越过（不计数、四重安全门） | 按位置猜模块；跳过有任务标记的内容；静默跳章 | 解决横向卡住/重排错位/无任务点卡住，同时不丢任务 |
| 提交 | 活跃时间时钟（后台节流不再打穿 60s 窗口）＋「已提交未确认」只复核不重提＋提交控件「模块优先、整页同源兜底」＋提交前滚动可见＋完成双信号 | 重试时重复点提交；把"点过按钮"当完成；无证据时整页乱搜 | 直击"换电脑不自动提交"最大嫌疑，且不破坏单次提交 |
| 声音 | 内置 `sounds/*.wav` ＋ 设置页上传自定义音，三级回退（自定义→内置→现有合成音→仅文字）＋音量/停止/循环可配 | 只做代码合成音；联网加载音频 | 满足「自定义声音」，音频只存本机 |

**推荐默认值（实施时按此，用户可改）**：

| 设置项 | 默认 | 说明 |
|---|---|---|
| 允许拖动完成视频（站点支持时） | 开 | 关闭后=0.2.7 行为：只正常播放 |
| 资料自动滚动到底 | 开 | 找不到滚动容器时不动作、只诊断 |
| 无任务点内容自动越过（不计数） | 开 | 有任务标记的内容绝不越过 |
| 提交后等待 | 活跃 180s / 墙钟 15min | 到点只复核不重复点击 |
| 声音提醒 | 开 | 默认 WAV 内置音；可上传替换 |
| 响铃循环 | 每 30s，最多 20 次 | 可改「无限直到我确认」 |

**推荐实施顺序（风险最低）**：

1. **M0 先做**：诊断探针＋报告按钮、提交自愈（活跃时间/只复核不重提/INSPECT 容忍/命令超时）、加载与导航等待容错。不改安全边界，先拿到你失败机器上的错误原文与诊断行。
2. **M1 主整改**：导航（稳定 key、横向→纵向、无任务点越过）、PPT 滚动、视频拖动（你已授权）、提交控件整页兜底（M0 证据允许时）、声音框架。
3. **M2 证据依赖**：点击站点任务点激活模块、其它 PPT 皮肤、只刷课资料越过范围扩展。

**为什么这样推荐**：不需要新证据的（诊断、提交自愈、导航容错、PPT 滚动、视频拖动）先落地，能立刻改善；需要真站结构证据的（提交按钮归属、任务点激活）等 M0 拿到证据再开，避免"猜选择器"违反硬约束。每一项都有开关，出问题可单项关闭回退，不影响其他整改。

> 需要你提供两样东西：① 声音文件（放 `apps/extension/sounds/`，或直接发我文件名/格式）；② 失败电脑复现一次后运行页的红色错误原文或诊断行（不含题文，可安全复制）。

## 1. 目标定义：什么叫「任务绿色」

站点完成判定的**唯一证据**是站点自己的任务点状态（`docs/compatibility.md` §6.9 已记录：完成模块带 `ans-job-finished`，`.ans-job-icon` 的 `aria-label` 为「任务点已完成」）。整改后：

```
任务完成 = 站点任务点变绿（满足任一，且连续 2 次采样稳定）
          ├─ .ans-job-icon[aria-label] 命中 /任务点已完成|Task\s*completed/i
          ├─ 任务点 wrapper 带 ans-job-finished
          └─ 诊断探针确认的其它站点完成信号（需先取证，不猜类名）
```

- **不允许**用「我们拖到了末尾」「我们滚到了底部」「我们点了提交」推断完成。
- 拖动/滚动/提交都只是**促使站点自己变绿**的手段；没变绿就如实报告失败或回退。
- 站点变绿后由站点自己推进；若站点不自动推进，按 §5 横向→纵向规则继续。

---

## 2. 总体架构

```
┌─ runner.html 运行页（CourseRunner 状态机）
│    · 本轮策略（拖动/滚动/提交/越过授权）
│    · 活跃时间时钟 + 可见性补偿 + 诊断展示
│    · 声音（自定义音频 → 内置文件 → 合成音 → 仅文字）
│
└─ 站点课程标签（内容脚本 CoursePage，DOM 读写与点击）
     · 任务点发现（模块列表 + 稳定 key + 异常诊断）
     · 视频策略（探测可拖性 → 拖动/完整播放 → 等绿）
     · 资料策略（观察 → 滚动到底 → 等绿）
     · 提交链（回填核验 → 唯一提交按钮 → 确认 → 等绿）
     · 横向推进（同卡片下一个任务点 / 激活模块）
     · 纵向推进（站点 Next → 下一卡片，遇无任务点继续纵向）
```

统一状态机（`runLoop` 重写为显式阶段）：

```
for each 位置:
  1. INSPECT（绑定 courseKey/taskKey；含脱敏诊断）
  2. 仍未就绪? → 有界等待（加载宽限）→ 超时诊断
  3. 分类：
       已完成 → 计数已完成，转 5
       VIDEO  → 视频策略 → 等绿 → 转 4
       QUIZ   → 既有点击回填+提交流程 → 等绿 → 转 4
       RESOURCE → 资料策略（滚动）→ 等绿 → 转 4
       MATERIAL / 无任务标记卡片 → 直接越过（不计数）→ 转 5
       未知/异常 → 停止 + 诊断（不越过）
  4. 绿了但站点未自动推进? → 记录并检查任务键变化
  5. 横向推进：同卡片有下一个任务点 → 切到它（必要时激活）
     横向没有 → 纵向推进：点站点 Next → 等新卡片
     无任务点卡片：越过不计数，继续走 5（横向→纵向）
     循环/无变化 → 停止并诊断
```

关键约束的落点：

| 约束 | 落点 |
|---|---|
| 不伪造进度 | 拖动只在用户授权 + 站点允许时；完成仍等绿；不伪造 ended |
| 单次提交 | `sendAttempted` 每任务一次；未确认只复核不重提 |
| 未知停止 | 只有「已加载 + 无任务标记 + 无交互控件」可越过；其余 UNKNOWN 停止 |
| 不猜选择器 | 模块/任务点/滚动容器只用已记录结构或结构性探测（tag/scrollHeight/aria-label），新类名必须取证 |

---

## 3. 视频整改（V1–V8）

### 3.1 目标行为

```
视频任务（未完成）
  ├─ 1. 启动播放（现有 startVideo：站点播放按钮 → 有界等待 → 标准 play → 静音兜底）
  ├─ 2. 判定「本站点/本视频是否可拖动」
  │     ├─ 已缓存「可拖」→ 直接定位到末尾
  │     ├─ 已缓存「不可拖」→ 完整播放
  │     └─ 未知 → 一次试探（见 3.2）
  ├─ 3. 拖动路径：currentTime = duration - 2s → 轮询站点变绿（≤20s）
  │     ├─ 变绿 → 完成（站点自己推进或按 §5 推进）
  │     └─ 未变绿/进度回退/出现站点拦截提示 → 回退完整播放（回 0 播放）
  ├─ 4. 完整播放路径：等原生 ended + 站点变绿（现有逻辑 + C1/C2/C4 容错）
  └─ 5. 都失败 → 停止 + 诊断（"站点未变绿"），不跳过、不计完成
```

### 3.2 可拖性探测（唯一可靠的判断方式）

**只读先验（不移动播放位置）**：
- `video.duration > 0`、`video.seekable.length > 0`、`readyState >= 1`；
- 文档里若出现站点自己的「不可拖拽/拖动无效」提示文案（可见文本）→ 直接判「不可拖」；
- 以上任一不满足 → 不具备探测条件，走完整播放。

**行为试探（一次，且只在安全时机）**：
- 仅当 `currentTime <= 10s`（刚开始，损失最小）且用户本轮勾选了「允许拖动完成」时执行；
- 记录 `from = currentTime`；设置 `video.currentTime = Math.max(0, duration - 2)`（**只改标准属性，不派发伪造事件、不模拟鼠标拖动**）；
- 500ms 间隔观察 20s，判定顺序：
  1. 站点变绿 → **可拖**，缓存「允许」；
  2. `currentTime` 被站点回退到 `from` 附近（回退 > 3s）或站点进度条重置 → **不可拖**，缓存「禁止」，回退完整播放；
  3. 出现可见的站点拦截提示（含「拖」或「不能」字样的小弹层）→ **不可拖**，按停止处理（不自动点未知弹窗）；
  4. 视频 ended 但 20s 内仍未变绿 → 视为可疑，回退完整播放并标记「禁止」；
  5. 超时未变绿 → 同上。
- **回退完整播放**：`currentTime = 0` → `play()` → 按 §3.1 第 4 步等 ended + 变绿；同一任务只回退一次，不来回拖。
- **不重复拖动**：单任务最多 1 次试探 + 1 次正式拖动（缓存允许时）。

### 3.3 可拖性缓存（避免在禁拖课程上浪费/损失进度）

- 存储：`api/settings.ts` 管理的 `chrome.storage.local`，键 `videoSeekPolicy`，结构 `{ [courseKeyHash]: { policy: "allowed"|"denied", at: number } }`；只存哈希，不存课程名/URL。
- 失效：30 天后重新探测；缓存「允许」但拖动未变绿 → 立即改为「禁止」。
- 设置页提供开关：「允许拖动完成视频（站点支持时）」默认 **开**（用户已明确要求），并说明风险与回退逻辑。

### 3.4 完成确认与容错

- **V5 完成确认**：拖动后每 500ms `INSPECT`，20s 内变绿才成功；期间站点自动切任务（任务键变化）视为成功推进。
- **V6 播放器移除容错**：视频结束后站点常把 `<video>` 换成完成态 DOM。`snapshot.video === null` 允许连续 3 次（≤10s），期间变绿则正常结束。
- **V7 duration/元素选择**：`duration` 未知为 0 时改用「已播放时间 + 60s 无进展」规则，不套 10 分钟固定上限；同一模块多个 video 时只选「正在播放 → 可见面积最大」，诊断记录数量。
- **V8 90% 标记稳态**：站点先给完成标记、`ended` 未触发时，仍等 `ended`（0.2.7 既有约束）；新增「标记先到 + 播放器被移除 + ended 永不触发」组合用例，验证 V5/V6 不会提前切走。

### 3.5 明确不做

- 不模拟鼠标拖动进度条（不合成 pointer/mouse 事件）——只改 `currentTime`，失败就回退完整播放。
- 不伪造 `ended`、不伪造 `timeupdate`、不改站点 DOM 的完成标记。
- 用户未勾选「允许拖动完成」时不探测、不拖动。

---

## 4. PPT/PDF 资料整改（S1–S6）

### 4.1 目标行为

```
资料任务（未完成）
  ├─ 1. 打开后先观察 3–5s（站点自己变绿 → 直接完成，对应"有的不需要滚"）
  ├─ 2. 未变绿 → 结构性滚动到底部（S2）
  ├─ 3. 滚动后等待变绿（≤15s，站点可能异步上报）
  │     ├─ 变绿 → 完成
  │     └─ 未变绿 → 若该位置"无任务标记/无任务点" → 越过（不计数，按 §5）
  │                  若有任务标记 → 停止 + 诊断（"滚到底后仍未变绿"），不越过
  └─ 4. 找不到可滚动容器 → 诊断 + 按 3 的未变绿规则处理
```

### 4.2 结构性滚动（不猜类名）

- 在资料模块文档（`moduleRoot`，已适配 `/ananas/modules/pdf/index.html`）内找滚动容器：
  - 优先 `doc.scrollingElement`；否则遍历 `scrollHeight - clientHeight > 8` 且 `overflow-y` 可滚动的元素，取 `scrollHeight` 最大者；
  - 分 3–5 次滚到 `scrollHeight`，每次间隔 300–500ms（模拟阅读节奏，不瞬间到底）；
  - 只调用标准 `scrollTop/scrollTo`，不点翻页按钮、不改站点状态。
- 若 iframe 不可访问（跨域）或没有可滚动容器 → 不滚动，诊断输出 `readyState`、文档可访问性、候选容器数。
- 记录「滚动前后站点状态」到诊断：滚动次数、是否到底、变绿时间。

### 4.3 资料分类增强

- `RESOURCE` 判定从「路径匹配 + `readyState==="complete"`」改为「路径匹配 + 文档可访问 + 有界等待加载完成」；等待期间按「未就绪」而不是 UNKNOWN。
- 其它 PPT 皮肤（非 PDF 转换查看器）：未取得脱敏证据前只做「识别失败 → 诊断 → 停止」，不猜。

---

## 5. 导航整改：横向优先、纵向兜底（N1–N7）

### 5.1 术语（按用户语义）

- **横向**：同一张知识卡片内的任务点序列（`.ans-attach-ct` 模块：视频/测验/资料）。
- **纵向**：站点 Next（下一张卡片/章节）。
- **无任务点位置**：已加载、无 `.ans-job-icon`、无任务 iframe、无交互控件的卡片/资料。

### 5.2 推进算法

```
advance(snapshot):
  if snapshot.completed: 记录已完成; return next()
  if kind == VIDEO:     视频策略(§3); return next()
  if kind == QUIZ:      回填+提交(§6); return next()
  if kind == RESOURCE:  资料策略(§4); return next()
  if kind == MATERIAL 或无任务标记: 越过(不计数); return horizontalThenVertical()
  else: 停止 + 诊断（未知不越过）

horizontalThenVertical():
  1) 同卡片还有未处理任务点（按稳定 key 顺序）→ 切到它：
       a. 若站点需要激活（模块 iframe 未加载）→ 有界等待；仍无 → 尝试激活（N6，需证据）
       b. 切换后等新任务键稳定 → 继续主循环
  2) 横向没有 → 纵向：点站点 Next（`#prevNextFocusNext` 或已记录控件）
       → 等 25s 内任务键变化；无变化 → 诊断重试（N5）→ 仍无 → 停止
  3) 纵向落到的新卡片若是"无任务点" → 不计数，回到 1)（继续横向/纵向找下一个任务）
  4) 全流程用 visited 集合防循环；同一任务键重复出现 → 停止
```

### 5.3 修复点

| 编号 | 修复 | 对应根因 |
|---|---|---|
| N1 | `courseModules()` 局部容错：异常 marker 只记 anomaly，不清空整个模块队列；有 anomaly 时禁用"跳过未完成"授权并保留诊断 | B1 |
| N2 | 模块稳定身份：`key = iframe 路径 + wrapper 内相对序号 + 完成类存在性`；`activeModuleKey`/`skippedKeys` 替代数组下标；每次 inspect 校验 `marker.isConnected` | B2 |
| N3 | 横向激活：模块 iframe 未就绪时先有界等待；等待失败再尝试点击该模块**唯一、可见、非禁用**的站点任务点控件（仅当取得任务点栏结构证据后启用；否则只报诊断） | B3 |
| N4 | 加载宽限：`VIDEO && !video`、`VIDEO && duration===0`、`RESOURCE` 未加载 → 统一 25s 有界等待，超时诊断化停止 | B4 |
| N5 | 导航等待容错：NEXT 后 25s 内 `INSPECT` 连续失败 ≤8 次不算错（总窗口有界）；background 对 `TAB_UNAVAILABLE` 重试一次注入 | B5 |
| N6 | 卡片身份：`cardIndexOf` 只统计可见 cards 帧；多帧 `num` 不一致记 anomaly；不可判定时返回 `null` 并重试，不回落 `"0"` | B5/B7 |
| N7 | 无任务点越过：`MATERIAL` 扩展（展示型标签白名单 + 无 iframe + 已加载），并新增"无任务点卡片"越过的显式确认；**有任务标记的内容绝不越过**；越过计数单独统计 | B6/B10 |

### 5.4 无任务点越过的安全门（必须四重满足）

1. 页面路径仍是已知课程任务路径（`/mooc-ans/knowledge/cards` 等已记录）；
2. 卡片内容已加载（`readyState=complete`、图片已加载）；
3. 无 `.ans-job-icon`、无任务 iframe、无交互控件（`input/button/select/textarea/[contenteditable]/[role]/[onclick]`）；
4. 不是正式考试/非未知页面。

越过只记「越过数」，**不计完成**，并在运行页显示。

---

## 6. 提交整改（P1–P8，沿用并收紧上一版 A1–A8）

维持「每任务只点一次站点提交」的硬约束，目标是让任务点变绿。

| 编号 | 修复 | 目的 |
|---|---|---|
| P1 | 统一 `waitForSubmission()`：成功/站点自动推进/未确认三分支；`INSPECT` 连续失败 ≤3 次容忍；截止用活跃时间 + 墙钟硬上限；到点只终检不重点 | 修「换电脑不提交」最大嫌疑（后台节流打穿 60s） |
| P2 | 活跃时间时钟：`delay()` 只累加 `min(实际, 请求×1.5)`；运行页 `visibilitychange/focus` 补偿（`INSPECT`+`CONFIRM_WORK`） | 后台节流感知 |
| P3 | 「已提交未确认」只复核不重提：`recheckSubmission()`；`recoverFromError` 在 `sendAttempted` 时也可进入；UI 按钮改「重新检查提交结果」 | 避免人工提交与重复提交风险 |
| P4 | 提交控件搜索「模块优先、整页同源兜底」：SEND 用 `submitSearchDocuments(root)` 且模块文档排第一；CONFIRM 遍历模块+全部同源文档；仍要求唯一可见 | 修模块作用域收窄导致的"候选 0 个"（先取证再开） |
| P5 | 提交前 `scrollIntoView` 可见性补偿（仅对唯一候选），再判可见 | 站点响应式/滚动导致按钮不可见 |
| P6 | 完成证据多信号：`ans-job-finished` + 提交后 `submittedCue`（连续 2 次稳定） | 站点变绿表现不一致 |
| P7 | 回读窗口 2.5s→6s 自适应；`fingerprint` 拆 `contentFingerprint`/`stateFingerprint`（只有内容真变才停止） | 慢机器误判、图片懒加载误报 |
| P8 | 诊断与防呆：失败文案附候选数/文档数/模块序号/标记计数；命令超时 20–30s；运行页提示「保持窗口可见」 | 可定位、减少无效重跑 |

提交安全边界不变：不 `form.submit`/`requestSubmit`、不重复提交、不把"点过按钮"当完成、结果不可核验时如实报告。

---

## 7. 声音整改（E1–E8，等用户提供音频文件）

### 7.1 用户提供文件后的放置位置（三种场景，任选其一）

| 场景 | 路径 | 生效方式 |
|---|---|---|
| **最推荐：源码内置** | `D:\project\xue-xi-tong\apps\extension\sounds\`（文件名见 7.2） | 重新构建（`npm run package:extension`）或开发时替换后重新打包 |
| **快速试用（不重建）** | 已构建的 `apps\extension\dist\sounds\`，或解压安装目录 `<解压目录>\extension\sounds\` | 扩展页「重新加载」即可 |
| **个性化（不碰文件）** | 设置页「声音提醒」上传（存 `chrome.storage.local`） | 覆盖更新不丢；换安装目录才丢 |

### 7.2 固定文件名（替换时保持同名）

```
apps/extension/sounds/
├─ error.wav          # 运行出错（ERROR）
├─ needs-input.wav    # 待人工补答（NEEDS_INPUT）
├─ popup-failed.wav   # 视频弹题枚举失败（可缺省 → 回退 error）
└─ README.md          # 说明，构建时不拷贝
```

格式接受 `wav / mp3 / ogg`（按 `wav → mp3 → ogg` 尝试）。单文件建议 ≤1MB、总计 ≤3MB。

### 7.3 改动

| 编号 | 改动 |
|---|---|
| E1 | `RunnerState.alertKind`：`error / needsInput / popupFailed`，runner 抛错前显式设置，不再靠错误文本匹配 |
| E2 | `shared/alarm.ts` 重写：`ring(kind)` 回退链（自定义 → 内置文件 → 现有合成音 → 仅文字）；每次播放挂失败监听 |
| E3 | 音量可调（默认 0.7）；新增 `stopAlarm()`；循环间隔/上限可配（默认 30s×20，0=无限直到确认）；`focus/visibilitychange/停止响铃按钮` 停止 |
| E4 | 设置页「声音提醒」卡片：启用、音量、三事件上传/试听/清除、循环设置、占用、隐私说明、目录说明 |
| E5 | `api/settings.ts` 新增 `studyAssistantCustomSounds` 键；单文件 ≤1MB、合计 ≤3MB、mime 白名单；只存本机、绝不上传 |
| E6 | `scripts/build-extension.mjs` 新增 `copySoundAssets()`：`apps/extension/sounds/` → `dist/sounds/`；`assertOutputs()` 校验非空（无文件时不报错，保留合成音回退） |
| E7 | `scripts/package-extension.py` 自动带上（rglob）；补 sounds 大小/条目打印；ZIP 条目 16 → 约 19，同步文档 |
| E8 | 测试：`alarm.test.ts`（回退链/音量/停止/循环）、`sound-settings.test.ts`（存储/大小/mime）；`docs/privacy.md` 增补 |

### 7.4 浏览器限制（写进使用说明）

- 依赖「开始运行」用户手势解锁音频；可在同一手势内对 `<audio>` 做静音 `play()` priming。
- Service Worker 无 `AudioContext`、`offscreen` 权限被禁 → **关闭运行页就没有声音**。
- 运行页被冻结/丢弃 → 静音；后台节流会让文件音抖动（合成音走音频时钟预排程，较稳）。

---

## 8. 诊断与取证（D1–D4，跨问题）

| 编号 | 内容 |
|---|---|
| D1 | `TaskSnapshot.diagnostics`（脱敏）：文档/iframe 计数、cards 帧与 `num`、模块数/kind/rootLoaded/anomaly/activeKey、marker 的 aria-label 三态计数、`ans-job-finished` 计数、静态卡违规 tag 前 3、video 计数与 currentTime/duration/ended、pdf readyState/可访问性、可滚动容器数 |
| D2 | 运行页「复制诊断行」按钮：一行文本，可安全粘贴（**不含题文/答案/课程标识/完整 URL/HTML**） |
| D3 | 错误文案附诊断摘要；测试与 `docs/privacy.md` 断言不得出现文本内容 |
| D4 | 真站取证清单：拖动前后 marker/aria-label/类名变化、PPT 滚到底前后 marker 变化、站点任务点栏结构、失败机错误原文与诊断行、运行页可见性 |

---

## 9. 代码改动清单（按文件）

| 文件 | 改动 |
|---|---|
| `apps/extension/src/automation/course-page.ts` | 模块列表 `{modules, anomalies}` + 稳定 key；任务点激活（证据后）；视频拖动策略（新 action：`SEEK_TAIL`/`PLAY_FROM_START`，带 runId/taskKey 校验）；资料滚动（新 action：`SCROLL_MATERIAL`）；完成标记多信号；无任务点分类；提交搜索范围；回读窗口与指纹拆分；诊断快照 |
| `apps/extension/src/automation/protocol.ts` | 新增 action 与诊断字段、`TaskSnapshot` 扩展、命令校验 |
| `apps/extension/src/automation/runner.ts` | `runLoop` 显式阶段化（横向/纵向推进、跳过计数）；视频策略与缓存；资料策略；`waitForSubmission`/`recheckSubmission`；活跃时间；INSPECT 容忍；`alertKind` |
| `apps/extension/src/automation/App.vue` | 运行页：拖动/滚动策略开关（默认拖动开）、诊断行复制、可见性提示、声音开关持久化、复核按钮文案 |
| `apps/extension/src/shared/alarm.ts` | 播放引擎重写（回退链/音量/停止） |
| `apps/extension/src/api/settings.ts` | 新增声音设置、自定义音频键、`videoSeekPolicy` |
| `apps/extension/src/options/App.vue` | 「声音提醒」与「视频快速完成」设置卡片 + 试听 |
| `scripts/build-extension.mjs` | 拷贝 `sounds/` + 校验 + 日志 |
| `scripts/package-extension.py` | sounds 统计打印（可选断言） |
| `apps/extension/sounds/` | 新增目录（用户音频文件放这里） |
| `tests/` | 见 §10 |
| `docs/` | `compatibility.md`（新证据）、`course-automation.md`、`acceptance.md`（新授权章节）、`privacy.md`、`使用说明.md`、`extension-updates.md`、`updates/update.json` |

---

## 10. 测试与验收

| 层 | 内容 |
|---|---|
| 单元 | 课程页：模块局部容错/稳定 key/懒加载等待/激活门禁/视频拖动探测与回退/滚动容器选择/完成标记双信号/无任务点越过四重门/提交搜索作用域/回读窗口。runner：横向→纵向推进、跳过计数、循环保护、拖动缓存、活跃时间、等待自愈、复核不重提、INSPECT 容忍、alertKind。alarm：回退链/音量/停止/循环。 |
| 合成 MV3 e2e | 新夹具：横向多任务点懒加载卡、无任务点 iframe 卡、PPT 滚动完成（合成 PDF 查看器）、提交控件在父文档、拖动可完成视频、禁拖视频（seek 被回退）、后台节流模拟。 |
| 真站（用户配合） | 失败机错误原文＋诊断行；窗口可见性对照；拖动可完成/禁拖视频各一例的 marker 前后状态；PPT 滚到底前后 marker；任务点栏结构；声音真机听测。 |
| 发布 | `npm run typecheck`、`npm run test`、`npm run build`、`npm run test:release`、`npm run package:extension`、`npm run version:extension -- 0.2.8`、更新清单校验。 |
| 禁止声称 | 未在真站验证的兼容性一律 `Unverified`。 |

---

## 11. 分批实施

### M0（0.2.8-alpha，1–2 天，低风险）
D1–D3 诊断、P1–P3 提交自愈与活跃时间、P8 命令超时、N4/N5 加载与导航容错。**不改安全边界，不加拖动/滚动。**
产出：用户复现一次 → 拿到错误原文＋诊断行＋可见性 → 决定 P4/P5 是否启用。

> 实施状态（2026-10-21）：上述 M0 项已在本地全部落地，`npm run typecheck` 通过、`npm test` 454 项通过、无回归、未改安全边界。缺口：`recheckSubmission`/`onForeground`/诊断行格式化无专门新单测、本轮未重跑 MV3 e2e、真站取证待用户在失败机复现。明细见 docs/acceptance.md §9.39。

### M1（0.2.8 正式）
N1/N2/N6/N7 导航主体、S1–S3 资料滚动、V1–V4 视频拖动（按用户授权）、P4–P7（在 M0 证据允许时）、E1–E8 声音框架。
版本：`npm run version:extension -- 0.2.8` → 打包 → 发布 → 更新 `updates/update.json`。

> 实施状态（2026-10-21）：本批已落地 **V1–V4 视频定位末尾**（`SEEK_TAIL`/`PLAY_FROM_START` + `trySeekVideoCompletion`，`RunOptions.allowVideoSeek` 代码默认 `false`、运行页复选框默认勾选传入 `true`；可拖性按课程缓存）与 **S1–S3 资料滚动到底**（`SCROLL_MATERIAL`，资源等待内 `allowMaterialScroll` 时滚动一次，完成仍靠站点绿标）；**声音框架 E** 完成打包音频（`sounds/error.mp3` 随 `copySoundAssets` 内置）＋运行页「告警音量」滑块＋开关/音量/按课程 `videoSeekPolicies` 经 `api/settings.ts` 可信模块持久化（App.vue 不直接碰 `chrome.storage`）。**未完成 / 仍缺**：导航 N1/N2/N6/N7 与提交 P4–P7 依赖 M0 真站证据，本批未动；自定义音频文件上传的设置页 UI 未做（仅内置 `sounds/<kind>` 机制）；真站可拖性/滚动触发完成均 `Unverified`。`npm run typecheck` 通过、`npm test` 464 项通过、无回归、未改安全边界。明细见 docs/acceptance.md §9.40。

> 实施状态（2026-10-21 增补 · 横向标签导航）：用户追加需求「处理章节顶部横向标签、讨论题也走题目管线」，本批落地一项**超出原计划的新能力**——**同源横向标签导航** `SWITCH_SECTION_TAB`（`protocol.ts` + `CoursePage.switchSectionTab`）：点击站点自身 `li#dct{tab}` 触发其 `changeDisplayContent`，解析器只透传整数 `sectionIndex` 1..5（越界/非整数/其它动作携带一律丢弃），适配器轮询确认「活动页签类落到该页 **且** 内容 cards 帧 `num==tab−1`」才算 `confirmed:true`，未移动即 `confirmed:false` 让运行器停止，独立作业页拒绝。**尚未接入 `runLoop` 自动遍历各分区**（只完成可调用的适配与取证）。**如实的口径切分**：顶部标签栏是同源，本批已在适配层完成；讨论**回帖作答**目标在 `groupweb.chaoxing.com`（独立标签、跨源），**本批未实现**，仍需①真站重取一份完整 replysList 脱敏 DOM 证据、②新增可选 host 权限 `https://groupweb.chaoxing.com/*`、③给单一 tabId 运行器加跨标签命令路由，三者齐备前不落地、绝不凭记忆造选择器。`npm run typecheck` + `npm run build` 通过、`npm test` **469 项通过（+5 新单测）**、无回归、安全静态扫描仍通过、未改安全边界、仍为 0.2.8-alpha 未发布。明细见 docs/compatibility.md §6.11、docs/acceptance.md §9.41。

> 实施状态（2026-10-21 增补 · 提交后停留 2 秒再切换）：用户提出「自动提交好像没了」并要求「提交后不要立刻切下一任务、先停 2 秒以便复核或重做」。核实结论：**自动提交从未被删除**——章节 QUIZ 恒常先 `solveQuiz` 回填全部题、再恰好一次 `SEND_WORK`+`awaitSubmission`；「看着没提交」是 `solveQuiz` 里**故意的 `NEEDS_INPUT` 门**（任一回填/回读不过即 `manualItems` 非空、停在待补答不点提交），以遵守「绝不提交缺题」硬约束，补完后自动恢复并提交，是「等待后提交」而非「放弃提交」。落地：新增静态 `CourseRunner.SUBMIT_ADVANCE_DWELL_MS=2000`，`runLoop` 仅在提交结果为 `"confirmed"`（站点已确认但仍停当前任务）时置 `submitDwell`，点 `NEXT` 前显示「已提交并确认，停留 2 秒后进入下一任务（可复核或重做）」并 `await this.delay(2000)`（可中断）；站点自行跳转 `"advanced"` 不插等待。`npm run typecheck`、`npm test` **470 项通过（+1 运行器停留单测）**、`npm run build` 全绿，无回归、未改安全边界。真站停留时序与用户具体运行态仍 `Unverified`；「即使有未确定题也强制提交」会破坏「绝不提交缺题」硬约束，须用户显式授权后才做，本批未做。明细见 docs/acceptance.md §9.42。

> 实施状态（2026-10-21 增补 · 父文档提交确认框，覆盖上一条对「没提交」成因的推断）：用户据真实截图再报「没有自动点击提交，请所有模式都支持自动提交」。**真实成因**：题目在嵌套任务 iframe 内，站点在**顶层文档**弹「Tip / Submit?」确认框，而 `CONFIRM_WORK` 旧实现只在 `taskDocuments()`（任务帧子树）内找确认框 → 父文档框被漏检、`awaitSubmission` 点不到、提交无法确认。修复：`submissionDocuments()` 经 `frameElement.ownerDocument` **向上遍历祖先文档至顶层（≤6 层）**，`CONFIRM_WORK` 在任务帧＋祖先文档一并查找（仍受「唯一确认框」守卫）；`SEND_WORK` 提交按钮唯一性搜索**仍限定 `taskDocuments()`**，只把「已存在确认框」收养检测扩到祖先，避免父页其它 Submit 污染。所有解答题目模式共用该提交路径，修复自动覆盖；**只刷课模式**按既有授权仍跳过题目、不提交，未改语义。并修上一轮遗留 `submissionDocuments()` 的 `current` 可能 `undefined` 类型错误。新增跨 realm 回归单测（题在子帧、框在父文档，各恰好点一次、不重复提交）。`npm run typecheck` 通过、`npm test` **501 项通过（30 文件）**、`npm run build` 通过，未改安全边界。真站 Chrome 中父文档框被自动点下仍 `Unverified`。明细见 docs/acceptance.md §9.45、docs/compatibility.md §6.13。

### M2（0.2.9，证据/授权依赖）
N3 任务点激活（需任务点栏结构证据）、无任务点卡片越过开关（授权后）、其它 PPT 皮肤、只刷课资料越过范围扩展。

---

## 12. 授权与文档更新（必须与代码同批提交）

`AGENTS.md` 新增段落（草案）：

> 2026-10-21 用户补充授权：①视频任务在站点允许拖动时，允许把播放位置定位到末尾以触发站点自己的完成判定；站点不允许或进度回退时回退完整播放；仍以站点任务点变绿为唯一完成证据，不伪造 `ended`/进度、不重复拖动、不模拟鼠标拖动。②已加载、无任务标记、无交互控件的卡片/资料允许自动越过（横向优先、横向最后纵向），越过不计数；有未完成任务标记的内容不得越过。③PPT/PDF 资料允许滚动到底部促使站点完成，滚动不伪造阅读时长。④声音允许使用内置/用户自定义本地音频文件，音频只存本机、绝不上传。其余隐私、凭据、DOM 证据、纯文本、进度真实性约束继续适用。

`docs/acceptance.md` 新增验收小节（§9.4x）：逐条记录实现、单元/合成 e2e 结果、真站 `Unverified` 项与限制。
`docs/compatibility.md`：补充拖动探测、滚动容器、任务点栏结构、完成信号序列的脱敏证据（§6.10 起）。
`docs/privacy.md`：声音只本地、诊断不含内容。

---

## 13. 风险与回滚

| 风险 | 缓解 |
|---|---|
| 拖动导致禁拖视频进度回退 | 只在开头 10s 内试探；失败立即回 0 完整播放；per-course 禁拖缓存；用户可关闭开关 |
| 拖动被站点判定异常 | 只改 `currentTime`，不模拟鼠标/不伪造事件；站点提示即停 |
| 滚动到底后仍未变绿 | 不推断完成；有任务标记则停止并诊断，无标记则按授权越过（不计数） |
| 无任务点越过错杀 | 四重安全门 + 只越过不计数 + 诊断记录；异常卡片停止 |
| 横向激活点到错误控件 | 需结构证据才启用；唯一/可见/非禁用；不唯一即停 |
| 提交仍可能失败 | P1–P3 让其可自愈且不重复提交；诊断让用户可定位 |
| 声音文件覆盖/丢失 | 设置页上传为主路径；内置文件为默认；文档说明覆盖规则 |
| 后台节流无法根除 | 活跃时间 + 可见性补偿 + 明确提示 + 复核路径 |

回滚：所有新行为挂在设置开关后（拖动、滚动、越过），默认值按用户授权（拖动默认开、越过默认开、滚动默认开），单开关可关闭；关闭后回到 0.2.7 行为。

---

## 14. 待办（仅剩一项外部输入）

1. **等用户提供声音文件**：放到 `apps/extension/sounds/`（或直接给我文件名/格式，我来接入命名映射）；文件到位后 E1–E8 即可实现并试听。
2. 真站取证（M0 跑一次）后再启用 P4/P5 与 N3。
3. 其余无阻塞：本方案中 M1 的拖动/滚动/横向纵向跳过已具备用户授权，可直接实现。

---

## 附录 A：视频策略伪代码

```ts
// course-page.ts 新增（示意）
async seekTail(): Promise<{ ok: boolean; reason?: string }> {
  const video = this.taskVideo();
  if (!video || !(video.duration > 0) || video.readyState < 1) return { ok: false, reason: "未就绪" };
  const from = video.currentTime;
  if (from > 10) return { ok: false, reason: "非开头，拒绝试探" };
  video.currentTime = Math.max(0, video.duration - 2);   // 只改标准属性
  // runner 侧观察 20s：变绿 → ok；currentTime 回退 → denied；站点提示 → stop
}
```

## 附录 B：术语

- **绿色**：站点任务点完成态（aria-label / ans-job-finished 等站点自己的信号），是本方案唯一完成证据。
- **横向**：同一知识卡片内的任务点序列。
- **纵向**：站点 Next（下一卡片/章节）。
- **无任务点位置**：已加载、无任务标记、无交互控件的内容。
