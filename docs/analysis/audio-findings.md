# 声音告警现状分析与自定义音频/声音优化落地方案

- 分析对象：Chrome MV3 扩展「学习通刷课/刷题助手」当前版本 **0.2.7**（`apps/extension`）。
- 分析方式：**只读静态代码分析**。未修改任何源码，未执行构建、测试或打包，未动 `dist/` 与 git。
- 报告目的：回答「声音放在哪个文件夹」，并给出可执行的声音优化（自定义音频、音量、循环直到确认、多场景区分）落地方案。
- 结论先行：**当前 0.2.7 根本没有声音文件夹，也没有任何读取音频文件的代码**——声音是 Web Audio 振荡器即时合成的（`apps/extension/src/shared/alarm.ts`），所以现在把 `.wav/.mp3` 放到任何目录都不会生效。要支持自定义提示音，必须新增一个源码目录 + 构建拷贝步骤 + 播放逻辑；推荐目录见 §2。

---

## 0. 结论速览

| 问题 | 结论 |
|---|---|
| 现在声音文件放哪？ | **没有这个文件夹**。0.2.7 全仓库无任何 `.wav/.mp3/.ogg` 音频文件（已用 glob 全仓检索确认），`alarm.ts` 用 `OscillatorNode` 合成 880/660 Hz 双音。 |
| 建议源码放哪？ | 新增 `apps/extension/sounds/`（与 `runner.html` 同级），构建脚本显式拷贝。 |
| 构建后在哪？ | `apps/extension/dist/sounds/`。 |
| 解压安装后在哪？ | 用户加载的 `extension/` 文件夹内：`<解压目录>\extension\sounds\`（ZIP 内已是 `extension/sounds/...`，见 `scripts/package-extension.py:19`）。 |
| 用户能直接丢文件进去吗？ | **改完这版后可以**：把同名文件覆盖到 `...\extension\sounds\`，在 `chrome://extensions` 点「重新加载」即可；但更新覆盖安装会替换同名文件，且**换安装目录会改变解压扩展 ID、丢失 `chrome.storage.local` 配置**。更稳的是设置页上传（存 `chrome.storage.local`）。 |
| 要改构建脚本吗？ | **要**。`scripts/build-extension.mjs:253` 是 `publicDir: false`，Vite 不会拷贝 `public/`；必须显式拷贝 `sounds/` 到 `dist/sounds/`，并在 `assertOutputs()` 校验。 |
| 要改 manifest 吗？ | **不必新增权限**。`permissions` 白名单锁死为 4 项（`build-extension.mjs:30`、`manifest.base.json:7-12`）。**不需要 `web_accessible_resources`**（播放发生在扩展页面内）。建议可选地给 `extension_pages` CSP 补 `media-src 'self' data: blob:`（见 §5.1）。 |
| 播放上下文在哪？ | `runner.html` 是 `chrome-extension://<id>/runner.html?...` 扩展页面（`sidepanel/App.vue:683` 用 `chrome.runtime.getURL` 打开，`background.ts:121` 校验 sender URL），所以可以创建 `AudioContext`、可用 `chrome.runtime.getURL` 定位包内音频；Service Worker 不能播。 |
| 当前重复策略？ | ERROR：立即 3 组、每 30 s 重复最多 20 次；NEEDS_INPUT：1 组；用户 pointerdown/keydown、关开关、离开 ERROR 即停。 |
| 最大硬限制？ | 清单禁止 `offscreen`/`unlimitedStorage`（`build-extension.mjs:31-46`），所以**不能**用 offscreen 后台播音频；运行页必须保持打开。`chrome.storage.local` 默认 10 MB 配额。 |

---

## 1. 当前声音实现现状

### 1.1 唯一实现文件与调用点

| 位置 | 内容 |
|---|---|
| `apps/extension/src/shared/alarm.ts`（61 行） | 全部声音逻辑：懒创建单例 `AudioContext`、`unlockAlarm()`、`playAlarm(rounds)` |
| `apps/extension/src/automation/App.vue:25` | `import { playAlarm, unlockAlarm } from "../shared/alarm"` |
| `apps/extension/src/automation/App.vue:163-194` | `start()`：第 167 行 `unlockAlarm()`，注释「用户点击即解锁音频」 |
| `apps/extension/src/automation/App.vue:196-222` | 告警状态机：`soundEnabled`、30 s 定时器、phase watcher |
| `apps/extension/src/automation/App.vue:457-462` | 挂载时挂 `pointerdown`/`keydown` → `onUserAttention()` 停止重复 |
| `apps/extension/src/automation/App.vue:492-498` | 卸载时移除监听并 `stopAlarmRepeat()` |
| `apps/extension/src/automation/App.vue:545-549` | 运行页「声音提醒」复选框（`data-testid="runner-sound"`，默认 `true`，**不持久化**） |
| `apps/extension/src/automation/App.vue:562` | 「立即提交当前任务」等按钮会获得点击手势（也会触发 `onUserAttention` 停止响铃） |

`alarm.ts` 关键实现事实：

- `alarm.ts:7` 模块级 `let context: AudioContext | null = null;`
- `alarm.ts:9-12` 取 `globalThis.AudioContext ?? globalThis.webkitAudioContext`；**没有任何 `Audio`/`<audio>` 元素**。
- `alarm.ts:14-23` 懒创建单例；构造抛错返回 `null`。
- `alarm.ts:26-29` `unlockAlarm()`：仅 `resume()` 挂起的 context，失败静默。
- `alarm.ts:36-60` `playAlarm(rounds = 2)`：
  - `alarm.ts:41` 起点 `ctx.currentTime + 0.05`；
  - `alarm.ts:47` 频率固定 `tone === 0 ? 880 : 660`（**写死，无配置**）；
  - `alarm.ts:48` 每轮间隔 1.1 s、双音间隔 0.28 s；
  - `alarm.ts:50` 峰值增益 `0.22`（**写死，无音量设置**）；
  - 用音频时钟预排程振荡器（后台标签限流时也能放出整段，这是现有实现的优点）；
  - 返回值：排程成功 `true`，无上下文/抛错 `false`。
- **没有 `stopAlarm()`**：已排程的振荡器无法取消（`stopAlarmRepeat` 只清 `setInterval`）。

### 1.2 事件语义、参数与重复策略（现状）

| 进入状态 | 代码 | 行为 |
|---|---|---|
| `ERROR` | `App.vue:211-215` | `playAlarm(3)` 立即响 3 组（约 3.2 s），再 `startAlarmRepeat()` |
| `ERROR` 持续 | `App.vue:202-210` | 每 **30 000 ms** 一次 `playAlarm(2)`；`repeats` 上限 **20**（≈10 分钟）；`soundEnabled=false`、phase 离开 ERROR 时停 |
| `NEEDS_INPUT` | `App.vue:216-217` | `playAlarm(1)` 只响 1 组，**不重复** |
| 用户回页 | `App.vue:222`、`461-462` | 运行页上任意 `pointerdown`/`keydown` → `stopAlarmRepeat()`（只停未来重复，**已在音频时钟排程的 1-3 组仍会响完**） |
| 关闭开关 | `App.vue:221`、`548-549` | 停未来重复 |
| 离开 ERROR | `App.vue:219` | 停未来重复 |
| 卸载页面 | `App.vue:497` | 停未来重复 |

语义来源（用户授权与文档）：

- 需求原文：“题目出问题了，你可以发出声音……因为他们可能在刷抖音”（`docs/acceptance.md:865`、`AGENTS.md` 2026-10-19 22:4x 段）。
- 文档实现描述：`docs/course-automation.md:313-316`（「进入 ERROR 立即响三组固定双音蜂鸣，其后每 30 秒重复一次（最多 20 次）……NEEDS_INPUT 响一组」）。
- 验收记录：`docs/acceptance.md:874`（声音告警实现）、`:885`（构建检查要求 runner 块含 `AudioContext`）、`:894`（**真实 Chrome 未人工听测**，只验证了代码路径）。
- 触发错误的主要队列：`runner.ts:290-295`（监听发现任务变化）、`runner.ts:319-325`（`failPipeline` 通用错误）、`runner.ts:538`（进入 NEEDS_INPUT）、`runner.ts:1062`/`:1097`（视频弹题枚举失败）、`runner.ts:1090`（弹题连续 >10 次）。
- 视频弹题失败的错误文案固定含「视频弹题自动作答未通过」（`runner.ts:1062`、`:1097`）——**这是当前唯一可用于区分「弹题失败」与普通错误的线索，但属于字符串匹配，脆弱**（见 §3.8/§4.2 建议加显式字段）。

### 1.3 运行上下文（扩展页面 vs 内容脚本 vs Service Worker）

- 运行页是**扩展页面**：`apps/extension/runner.html:1-5`（只挂 `src/automation/main.ts`）；构建时作为 Vite 输入（`scripts/build-extension.mjs:262-268`）；由侧边栏 `sidepanel/App.vue:680-689` 用 `chrome.runtime.getURL("runner.html?tabId=...")` 打开；`background.ts:120-122` 只接受 `sender.url` 以 `chrome.runtime.getURL("runner.html")` 开头的消息。
- 结论：`runner.html` 的 origin 是 `chrome-extension://<extension-id>`，**不是**被注入到学习通站点页面。因此：
  - 可以正常创建 `AudioContext`、使用 `<audio>`/`Audio`、`FileReader`、`Blob`；
  - 用 `chrome.runtime.getURL("sounds/error.wav")` 即可定位包内音频，**不需要 `web_accessible_resources`**（WAR 只用于让网页/内容脚本引用扩展资源）；
  - 音频告警**不依赖也不改**课程页（内容脚本 `page/entry.js`、`page/automation-entry.js` 里没有声音代码，`security-static.test.ts:120-125` 还要求 page entry 无网络/存储）。
- Service Worker（`background.js`）只做注入/转发/上下文校验（`background.ts:6-10`、`:159-170`），**没有 DOM，也不能创建 `AudioContext`**，不能承担播放职责。
- 内容脚本若想放音，需要 WAR + 站点页面允许自动播放 + 在页面文档手势解锁，明显更差，不建议。

### 1.4 哪些情况下「不响」或静默降级（完整清单）

| 条件 | 代码证据 | 结果 |
|---|---|---|
| 环境无 `AudioContext`/`webkitAudioContext` | `alarm.ts:9-12` | `playAlarm` 返回 `false`，只有文字 |
| `new AudioContext()` 抛错（策略/资源） | `alarm.ts:17-22` | 返回 `false`，静默 |
| 用户从未点击「开始运行」（未解锁） | `App.vue:167`；`alarm.ts:39` | context 可能 `suspended`；代码仍排程并返回 `true`，**可能实际无声且不报错**（现有实现的一个盲区） |
| 系统/浏览器标签静音、音量 0 | — | 无声，扩展无感知 |
| 运行页被关闭/崩溃 | — | 无 watcher，不响（`App.vue:492-498` 只清理本地定时器） |
| `soundEnabled=false` | `App.vue:206`、`:215-217` | 不响 |
| 重复次数到达 20 | `App.vue:206` | 停 |
| 用户在本页点击/按键 | `App.vue:461-462`、`:222` | 停未来重复 |
| 离开 ERROR/NEEDS_INPUT | `App.vue:219` | 停 |
| 页面卸载 | `App.vue:497` | 停 |

补充：`soundEnabled` 只是 `ref(true)`（`App.vue:197`），**不落存储**；每次重开运行页都回到默认开启。

### 1.5 现状与硬性约束的关系

- 无音频文件、无网络、无新权限，因此当前实现不违反 `AGENTS.md` 的「不收集数据 / 不联网 / API Key 加密 / 最小权限」约束。
- 声音仅在扩展页面合成，`security-static.test.ts:34-57` 的禁用 API 扫描（innerHTML、eval、localStorage 等）与 `:96-104` 的存储白名单（`chrome.storage.local/session` 只能出现在 `api/session.ts`、`api/settings.ts`、`local/provider.ts`、`updates/updates.ts`）**目前都没有涉及音频**——新方案若新增存储模块必须遵守这条（详见 §4）。
- `build-extension.mjs:182-196` 的 `FORBIDDEN_OUTPUT_TOKENS` 只扫描 JS 文本，不会扫描二进制音频；但不允许出现 `chrome.cookies`、`webRequest`、`localStorage` 等 token。

---

## 2.「声音文件放哪个文件夹」——确定答案

### 2.1 现状答案：没有任何声音文件夹

- 全仓库检索 `*.wav/*.mp3/*.ogg/m4a/flac/aac/webm`：**0 个文件**。
- `apps/extension` 下没有 `public/`，`src/` 下没有 `assets/` 音频；代码中也没有 `new Audio`、`<audio>`、`media-src`、`web_accessible_resources`。
- 所以对用户当前能做的准确回答是：**0.2.7 没有可放声音的文件夹；只把文件放进去不会生效，只能改代码/重新构建。**

### 2.2 改完后推荐的三层路径（准确、可执行）

推荐：源码目录名与产物目录名保持一致，都叫 `sounds/`。

| 层级 | 路径（Windows 示例） | 说明 |
|---|---|---|
| 源码（仓库，提交进 git） | `apps/extension/sounds/`（与 `runner.html` 同级）<br>`D:\project\xue-xi-tong\apps\extension\sounds\` | 新增；放内置默认音；用户/开发者在这里替换源文件后重新构建 |
| 构建产物（不提交，`dist/` 被 `.gitignore:2` 忽略） | `apps/extension/dist/sounds/`<br>`D:\project\xue-xi-tong\apps\extension\dist\sounds\` | 由 `scripts/build-extension.mjs` 显式拷贝（见 §2.4） |
| 解压安装后（用户实际加载目录） | `<你解压的位置>\extension\sounds\`<br>例如 `C:\Users\<你>\Downloads\study-assistant-extension\extension\sounds\` | ZIP 内路径是 `extension/sounds/...`（打包脚本 `scripts/package-extension.py:19` 加 `extension/` 前缀）。**在 `chrome://extensions` → Study Assistant → 详情页可看到实际「已加载自」路径**，以那里为准 |

如果用户是「加载已解压的扩展程序」直接选仓库 `apps/extension/dist`，则目录就是 `apps/extension/dist/sounds/`。

### 2.3 为什么必须是这个目录，而不是别的

| 候选 | 是否可行 | 原因 |
|---|---|---|
| `apps/extension/public/sounds/` | **不可行（误导）** | Vite 配置 `publicDir: false`（`build-extension.mjs:253`），`public/` 既不拷贝也不在 dev server 提供；放这里构建后什么都不出现。 |
| `apps/extension/src/assets/sounds/` + `import url from "...wav?url"` | 可行但**不推荐** | Vite 资产管线会生成 `dist/assets/<name>-<hash>.wav`（哈希文件名不稳定，无法让用户按固定名替换）；是否内联受 `build.assetsInlineLimit`（默认 4 KB）影响，小 MP3 可能被内联成 `data:` URL，行为随构建配置变化；vitest/jsdom 还要额外处理资产导入。 |
| 直接放 `apps/extension/dist/sounds/` | **不可行** | 每次构建 `rm(DIST_DIR)`（`build-extension.mjs:244`）会删掉；且 `dist/` 被 git 忽略、不进 Release 源码。 |
| 放在 `extension/` 根目录或任意新目录 | 不可行 | 没有代码读取；扩展页面只能按 `chrome.runtime.getURL` 的固定相对路径取包内资源。 |
| 改 `web_accessible_resources` 指向某目录 | **不需要** | 播放发生在扩展页面自身，同源包内资源无需 WAR；WAR 只会把资源暴露给网页，增加面。 |

### 2.4 `publicDir: false` 下如何让构建把 `sounds/` 拷进 `dist`

必须在 `scripts/build-extension.mjs` 里加显式拷贝（Vite 不会做）：

1. 在 `main()` 中、Vite/esbuild 构建之后、`assertOutputs()` 之前（`build-extension.mjs:244-308` 之间）新增 `copySoundAssets()`：
   - 源：`path.join(EXTENSION_DIR, "sounds")`；目标：`path.join(DIST_DIR, "sounds")`。
   - 只拷贝音频扩展名（`.wav/.mp3/.ogg`），忽略 `README.md` 等说明文件；`mkdir` 目标目录；逐文件 `copyFile`。
   - **目录不存在时不报错**（保留「无音频文件回退合成音」能力），但记录 `sounds: []`；存在文件时记录文件名与字节数到最终 JSON 日志（现有日志结构 `build-extension.mjs:315-331`）。
   - 单个文件大小上限校验（建议 ≤ 2 MB）、总量上限校验（建议 ≤ 5 MB），防止误把大文件打进包。
2. `assertOutputs()`（`build-extension.mjs:198-231`）增加：若 `dist/sounds` 存在，则每个文件必须是**非空普通文件**；不存在则跳过（合法回退场景）。
3. `EXPECTED_OUTPUTS`（`build-extension.mjs:48`）**不要**把音频列入「必须存在」，否则「无音频回退」场景构建失败；但可在构建日志的文件清单里追加 `sounds/*`（`build-extension.mjs:310-314` 的 `files` 数组）。
4. 打包脚本 `scripts/package-extension.py:14` 已经用 `dist.rglob("*")` 收集**所有** dist 文件，音频会自动进 ZIP（`:19` 加 `extension/` 前缀）；`:24-25` 的逐字节回读校验对二进制同样有效。**无需改打包脚本也能带上音频**；建议补一条「sounds 总大小 / 是否为空」的打印或断言，便于发布核对。

命名约定（固定事件名，便于用户按名替换，不需要改代码）：

```text
apps/extension/sounds/
├─ error.wav          # 运行出错（ERROR 通用）
├─ needs-input.wav    # 待人工补答（NEEDS_INPUT）
├─ popup-failed.wav   # 视频弹题枚举失败（ERROR 子类，可选，缺省回退 error.wav）
└─ README.md          # 说明：可替换、更新会被覆盖（构建时不拷贝）
```

播放端按 `.wav → .mp3 → .ogg` 顺序尝试（见 §3.6），因此用户即使只放 `error.mp3` 也能用；替换时**文件名必须保持上述固定名**。

### 2.5 用户自放文件、更新覆盖与丢失规则（重要）

1. **可直接替换**（改完后）：把 `error.wav` 覆盖到 `...\extension\sounds\`，然后 `chrome://extensions` → 该扩展 → **「重新加载」**（运行页会被关闭，需重新打开调度页）。Chrome 对「加载已解压的扩展程序」不做文件完整性校验，允许用户改包内文件。
2. **覆盖式更新会替换同名文件**：`使用说明.md:117-118` 的更新流程是「将新版 `extension` 内容覆盖到原先加载的 extension 目录，保留相同目录路径」。复制覆盖不会删除目录里多出来的文件，**但 `sounds/error.wav` 这类同路径同名文件会被新版默认音覆盖回去**；用户放的不同名文件（如 `my-error.wav`）会保留但代码不引用（除非通过设置页选择/自定义映射）。
3. **换目录 = 丢配置**：解压扩展的扩展 ID 与加载路径绑定；把扩展换到新文件夹会让 Chrome 视为另一个扩展，`chrome.storage.local`（供应商配置、以及**通过设置页上传的自定义音频**）随之失效/丢失。这正是 `docs/extension-updates.md:9`「保持原路径，不删除扩展，本机配置通常保留」的原因。
4. **因此产品应把「设置页上传自定义音频」作为主路径**：存 `chrome.storage.local`，覆盖更新后只要路径不变就保留，且不依赖包内文件；「替换 `extension/sounds/` 文件」作为开发者/高级用户路径保留。

### 2.6 是否需要改 manifest / 构建 / 打包 / 版本

| 项 | 是否必须 | 说明 |
|---|---|---|
| `manifest.base.json` permissions | **否** | 不新增权限；`ALLOWED_PERMISSIONS` 严格 4 项（`build-extension.mjs:30`、`assertManifest` `:128-142`）。**不要**加 `offscreen`（`FORBIDDEN_PERMISSIONS` `:31-46`）或 `unlimitedStorage`（同样禁止，`:34`）。 |
| `web_accessible_resources` | **否** | 扩展页面内的同源资源不需要 WAR。 |
| `content_security_policy.extension_pages` | 建议**可选**加 `media-src 'self' data: blob:` | 当前 CSP（`manifest.base.json:32-34`）只有 `script-src/object-src/connect-src`，没有 `default-src`/`media-src`。包内同源音频通常可放，但显式声明更确定，并为 `blob:`（自定义音频）与 `data:` 留出明确许可。加它不会破坏 `assertManifest`（`build-extension.mjs:157-161` 只检查必须包含的片段）与 `build-manifest.test.ts:27-34`（只断言包含/不包含特定片段）。 |
| `scripts/build-extension.mjs` | **是** | 新增拷贝 + `assertOutputs` 校验 + 日志。 |
| `scripts/package-extension.py` | 否（自动带上），建议加校验 | `rglob` 已覆盖；可加 sounds 存在/大小断言。 |
| `scripts/version-extension.py` | 否 | 与音频无关；但发版必须 `npm run version:extension -- 0.2.8`（同一版本不能覆盖已发布产物，`docs/extension-updates.md:30`）。 |
| `.github/workflows/release-extension.yml` | 否 | 触发路径含 `apps/**`（`:6-13`），会自动构建/打包/发布；但需要先提升版本，否则 Release 步骤拒绝覆盖。 |

---

## 3. 声音优化方案设计

### 3.1 内置音频选型：WAV vs MP3/OGG

| 格式 | 推荐度 | 体积（1 秒） | 优点 | 缺点 |
|---|---|---|---|---|
| **WAV PCM 16-bit mono 44.1 kHz** | 首选（默认音） | ≈ 88 KB | 无编码依赖、解码零延迟、高频清晰、可精确裁剪成 0.3-0.8 s 短促告警音 | 体积偏大；3 个 0.5 s 音约 +130 KB（当前 ZIP 0.76 MB，约 +17%） |
| MP3 96-128 kbps mono | 备选（自定义/体积敏感） | ≈ 12-16 KB | 体积小、Chrome 全支持、用户手机录音也能直接用 | 短促高频有轻微编码失真；需要编码工具产生内置资产 |
| OGG/Opus | 可选 | ≈ 4-8 KB | 体积最小 | 桌面 Chrome 支持；素材兼容性/工具链略逊，Windows 用户不一定熟悉 |

建议：内置默认音用 **WAV（短、清晰、可预期）**；用户自定义与替换接受 `wav/mp3/ogg`。单个默认音控制在 ≤ 2 s、≤ 200 KB，三个合计 ≤ 600 KB，ZIP 总体积仍在 1 MB 级别。

**体积与打包影响**：`package-extension.py:31` 打印 ZIP 条目数与 MB 数；当前 0.2.7 为 16 条目（15 个 dist 文件 + `使用说明.md`，见 `docs/course-playback-0.2.7.md:31`）。加 3 个音后约 19 条目；`使用说明.md:103-108` 的压缩包结构说明和验收文档中的条目数需同步更新。

### 3.2 播放引擎设计（推荐架构）

把「声音」拆成三层，便于测试与替换：

```text
事件语义层（runner 状态机）      → AlarmKind: "error" | "needsInput" | "popupFailed"
配置/存储层（api/settings.ts）    → 开关、音量、重复间隔/次数、每个事件的自定义音频(base64)
播放层（shared/alarm.ts）         → 自定义音频 → 内置文件 → 合成双音（逐级回退）
```

- **单一出口** `ring(kind: AlarmKind)`，由 `App.vue` 的 phase/alertKind watcher 调用；播放层不读页面内容。
- **音量**：对 `<audio>` 用 `element.volume = clamp(0..1, cfg.volume)`；对合成音用 `GainNode.gain`（把现在写死的 `0.22`（`alarm.ts:50`）改为 `0.22 * (cfg.volume / 0.7)` 之类的映射，或直接 `Math.min(1, cfg.volume)` 乘到峰值）。
- **不同事件不同音**：`AlarmKind` 决定首选 URL/文件；缺省回退顺序见 §3.6。
- **停止能力**：现在没有 `stopAlarm()`。新增后：
  - 记录所有 `<audio>` 元素与已排程振荡器；
  - `stopAlarm()` 立即 `pause()` 音频、`stop()` 振荡器、清 interval；
  - 用户回页（pointerdown/keydown/focus/visibilitychange→visible）或点「知道了/停止响铃」按钮时调用。
- **重复（保持现有优点）**：合成音继续用**音频时钟预排程**（不受后台定时器节流）；文件音用 `<audio>` + `ended` + 延迟下一轮（简单可靠，缺点是隐藏标签页的 `setTimeout` 可能被拉长到 ~60 s）。

### 3.3 「循环直到用户回到运行页确认」的准确设计

需求原文：「出错每 30 秒重复响铃直到用户回到运行页确认」（`AGENTS.md` / `docs/course-automation.md:315`）。

现状已实现「30 s × 最多 20 次」≈ 10 分钟，但：

1. 硬上限 20 次会在用户离开更久时静默停止。建议把上限做成设置项：默认保留 20（安全/不扰民），提供「无限重复直到我确认」选项（0 = 无限）。
2. 只按 `pointerdown/keydown` 停止不够：用户切回运行页但用鼠标滚轮/触摸板/Alt-Tab 回来时不一定触发。建议增加停止条件：
   - `window.focus`；
   - `document.visibilitychange` 变为 `visible`；
   - 运行页新增「已回到本页 / 停止响铃」按钮（`data-testid="runner-silence"`）；
   - phase 离开 ERROR / 关闭开关 / 组件卸载（已有）。
3. 需要**可区分的事件**：弹题失败是 ERROR 子类。现在只能靠 `state.error` 文本含「视频弹题自动作答未通过」（`runner.ts:1062`/`:1097`）判断，脆弱。建议在 `RunnerState` 增加 `alertKind`（见 §4.2），由 runner 在抛错前显式设置。
4. 循环期间再次收到新的 ERROR/NEEDS_INPUT：先 `stopAlarm()` 再重新开始，避免叠音。
5. 音量可调，但**不要**默认拉满；告警音建议 0.7，并提供试听。

浏览器限制（必须写进文档，避免「设了却没声」）：

| 限制 | 影响 | 对策 |
|---|---|---|
| **自动播放策略**（Chrome autoplay policy） | `AudioContext` 初始 `suspended`；`audio.play()` 可能返回 `NotAllowedError` | 在「开始运行」点击手势内解锁（现状 `App.vue:167`）；在同一次手势里可额外对 `<audio>` 做一次静音 `play()` 再 `pause()` 的 priming；失败时文字提示「声音被浏览器拦截」而不是无声 |
| **后台标签页定时器节流** | 隐藏页 `setInterval/setTimeout` 可能从 30 s 拉到 60 s+；密集节流更慢 | 合成音用音频时钟预排程（现状优点保留）；文件音用 `ended` 链式重复，接受抖动；**不要在后台用 `requestAnimationFrame`** |
| **Service Worker 无 DOM/无 `AudioContext`** | `background.js` 不能播放 | 播放固定在运行页；文档明确「关闭调度页就没有声音」 |
| **`offscreen` 权限被清单禁止** | 不能做「关闭页面仍响」的后台音频 | `build-extension.mjs:44` 的 `FORBIDDEN_PERMISSIONS` 含 `offscreen`；不要尝试加，除非用户明确要求并改安全契约 |
| **运行页 tab 必须存在且扩展被启用** | 用户关掉运行页 → 无声 | 运行页文案已要求保持打开（`App.vue:506`）；可在启动前/错误卡提示 |
| **系统/浏览器静音、音量 0** | 扩展无法感知 | 设置页提供「试听」，让用户自己确认 |

### 3.4 自定义用户音频（上传/选择）

**入口**：`apps/extension/src/options/App.vue`（Chrome 扩展设置页，不是 Python；`manifest.base.json:31` `options_page: "options.html"`）。新增「声音提醒」卡片，字段：

| 字段 | 控件 | 存储/默认 |
|---|---|---|
| 启用声音提醒 | checkbox | `sound.enabled = true` |
| 音量 | `range 0-100`（映射 0-1） | `sound.volume = 0.7` |
| 出错提示音 | `<input type="file" accept="audio/wav,audio/mpeg,audio/ogg">` + 试听/清除 | `custom.error = {base64,...} \| null` |
| 待补答提示音 | 同上 | `custom.needsInput = null` |
| 弹题失败提示音 | 同上 | `custom.popupFailed = null` |
| 循环间隔/上限（可选高级） | number 15-300 s / 0-200 次 | `sound.repeatSeconds = 30`、`sound.maxRepeats = 20` |

**存储结构（建议，独立键，避免每次保存偏好都重写大块 base64）**：

```ts
// api/settings.ts（白名单文件；security-static.test.ts:98-99 只允许这 4 个文件访问 storage）
const SETTINGS_KEY = "studyAssistantSettings";        // 已有，扩展 sound 子对象
const CUSTOM_SOUNDS_KEY = "studyAssistantCustomSounds"; // 新增：{ error?: StoredSound; needsInput?: ...; popupFailed?: ... }
interface StoredSound { name: string; mime: string; bytes: number; dataBase64: string; addedAt: number }
```

**大小与配额**：

- `chrome.storage.local` 默认配额 **10 MB**（`QUOTA_BYTES = 10485760`）；**不要**申请 `unlimitedStorage`（被 `FORBIDDEN_PERMISSIONS` 禁止，`build-extension.mjs:34`）。
- 存储只接受 JSON 可序列化值 → `ArrayBuffer` 会被序列化成 `{}`，**必须存 base64 字符串**（或用数字数组，浪费体积，不推荐）。
- 建议限制：单文件原始字节 ≤ **1 MB**（base64 ≈ 1.37 MB），全部自定义合计 ≤ **3 MB** 原始；超出直接给用户文字错误，不静默截断。用 `chrome.storage.local.getBytesInUse()` 在设置页显示占用。
- 备选：IndexedDB 配额更大、可存 Blob，但引入第二套存储/迁移成本；MVP 不建议。
- `chrome.storage.local` 已被 `background.ts:16-23` 设为 `TRUSTED_CONTEXTS`，内容脚本/网页读不到，符合隐私边界；扩展页面（设置/运行页）可读。

**隐私（必须写进 UI 与文档）**：

- 音频字节**只存本机** `chrome.storage.local`，**绝不上传网络**、不发给模型供应商、不写日志、不进入题目/答案请求；
- 不新增任何远程地址；`security-static.test.ts:148-155` 的「远程 Origin 只允许出现在 provider 预设与更新源」测试必须保持通过（音频模块不得出现 `http(s)://`）；
- 读取用 `FileReader.readAsDataURL`（本地），播放用 `Blob`+`URL.createObjectURL`（本地），不用网络请求；**不要用 `fetch()` 读包内文件**（见 §5.1 的 CSP `connect-src` 风险）。

**校验**：`mime` 白名单 `audio/wav`、`audio/mpeg`、`audio/ogg`、`audio/webm`；`bytes` > 0 且 ≤ 上限；`dataBase64` 只能 `[A-Za-z0-9+/=]`；解码失败/无法播放 → 回退下一级并提示。

### 3.5 无音频文件时的回退链（明确优先级）

```text
1. 用户自定义音频（chrome.storage.local 里对应 kind 的 base64，且开关允许）
2. 内置文件：chrome.runtime.getURL("sounds/<kind>.wav") → .mp3 → .ogg
3. 现有合成双音 880/660 Hz（alarm.ts 现逻辑，保留不动）
4. 以上都不可用 → 仅文字（现状行为），可记录 console.warn 但不弹窗
```

判定「不可用」：`audio.play()` 返回的 Promise reject（`NotAllowedError`/`NotSupportedError`/解码失败），或 `error` 事件。监听必须在每次播放时挂，避免一次失败缓存永久失效；内置文件缺失时 `<audio>` 会触发 error → 回退合成音。

### 3.6 设置 UI 位置

| 页面 | 内容 |
|---|---|
| **设置页** `apps/extension/src/options/App.vue`（主入口，扩展页面可播可读文件） | 「声音提醒」卡片：启用、音量、三个事件的自定义音上传/试听/清除、循环间隔与上限（高级）、存储占用、隐私说明、内置文件目录说明（`extension/sounds/`） |
| **运行页** `apps/extension/src/automation/App.vue:545-549` | 保留 `runner-sound` 复选框；建议改为**读取/持久化**设置（现在每次重开都 true）；可加「试听」按钮与音量显示；ERROR 卡加「停止响铃」按钮 |
| 侧边栏 `apps/extension/src/sidepanel/App.vue` | **现状没有任何声音开关**（已检索确认）；不必新增，侧边栏不是播放上下文，加开关易造成「以为开了」的误解 |
| 更新菜单 | 与音频无关；不要因为音频改动而触发自动下载/联网 |

### 3.7 默认值汇总（建议）

| 键 | 默认 | 说明 |
|---|---|---|
| `sound.enabled` | `true` | 与现状行为一致（现状 `soundEnabled` 默认 true） |
| `sound.volume` | `0.7` | 现状合成音峰值 0.22；文件音建议 0.7，可在设置页试听调整 |
| `sound.repeatSeconds` | `30` | 与现状一致 |
| `sound.maxRepeats` | `20` | 与现状一致；0 可表示无限（高级选项） |
| `sound.events.error` | `true` | |
| `sound.events.needsInput` | `true` | |
| `sound.events.popupFailed` | `true` | 缺自定义/内置音时回退 `error` 音，再回退合成音 |
| `custom.*` | `null` | 无自定义即用内置/合成 |

---

## 4. 具体改动清单（文件级 + 函数级）

> 以下为**提案**，本次分析未实施。所有路径均相对仓库根目录。

### 4.1 新增文件

| 文件 | 内容 |
|---|---|
| `apps/extension/sounds/error.wav` / `needs-input.wav` / `popup-failed.wav`（+ 可选 `README.md`） | 内置默认音；`README.md` 说明可替换、更新会被覆盖，构建时只拷贝音频扩展名 |
| `apps/extension/tests/alarm.test.ts` | 播放层单测：mock `AudioContext` 与 `Audio`；回退链、音量、重复、stop、无上下文返回 false |
| `apps/extension/tests/sound-settings.test.ts` | 存储层单测：默认值/迁移/校验/配额/无网络 |
| （可选）`apps/extension/tests/sound-assets.test.ts` | 构建产物检查：`dist/sounds/*` 非空、命名符合约定（需先 build，或改测源码目录） |

### 4.2 修改文件

| 文件 | 函数/位置 | 改动 |
|---|---|---|
| `apps/extension/src/shared/alarm.ts` | 全文 | 保留 `unlockAlarm`/`playAlarm` 兼容导出；新增 `AlarmKind`、`AlarmConfig{volume,repeatSeconds,maxRepeats}`、`ring(kind, config)`、`playFile(url,{volume,loop})`、`stopAlarm()`、`playSynthAlarm(rounds)`（把现 `playAlarm` 主体抽出来）；记录振荡器/音频元素以便停止；导出 `resolveBuiltInSound(kind)` 用 `chrome.runtime.getURL("sounds/...")` 依次尝试扩展名 |
| `apps/extension/src/api/settings.ts` | `LocalSettings`/`loadSettings`/`saveSettings` | 扩展 `sound` 子对象与 `loadSoundSettings`/`saveSoundSettings(patch)`（read-modify-write，防止覆盖 `backendOrigin`/`defaultProviderProfileId`）；新增 `CUSTOM_SOUNDS_KEY` 与 `loadCustomSound(kind)`/`saveCustomSound(kind, file)`/`removeCustomSound(kind)`/`soundStorageBytesInUse()`；集中做 mime/大小/配额校验。**必须放在该文件**，因为 `security-static.test.ts:96-104` 的 storage 白名单只允许 4 个文件，否则要同步改测试白名单 |
| `apps/extension/src/automation/runner.ts` | `RunnerState`（`:91-118`）、`createRunnerState`（`:128-132`）、`failPipeline`（`:319-325`）、`monitorQuiz` 的 `fail`（`:290-295`）、NEEDS_INPUT 设置（`:538`）、弹题失败抛出（`:1062`、`:1090`、`:1097`） | 增加 `alertKind: "error" \| "needsInput" \| "popupFailed" \| null`；在具体失败点显式设置（普通错误默认 `"error"`；弹题相关设 `"popupFailed"`；进入 NEEDS_INPUT 设 `"needsInput"`）；RUNNING/IDLE/STOPPED/DONE 时清空。这样 App.vue 不再依赖错误文本匹配 |
| `apps/extension/src/automation/App.vue` | `start()`（`:163-194`）、`soundEnabled`（`:197`）、`startAlarmRepeat`（`:202-210`）、phase watcher（`:211-220`）、`onUserAttention`（`:222`）、`onMounted`（`:457-491`）、`onBeforeUnmount`（`:492-499`）、模板（`:548-549`、错误卡 `:568-587`） | 1) 挂载时 `loadSoundSettings()`，用持久化配置初始化 `soundEnabled`/音量/间隔；2) 用 `state.alertKind` 决定 `ring("error"\|"needsInput"\|"popupFailed")`；3) 重复间隔/上限改读配置，`maxRepeats=0` 表示无限；4) 停止条件加 `window.focus` 与 `visibilitychange→visible`；5) 卸载/离开 ERROR 调 `stopAlarm()`；6) 错误卡加「停止响铃」按钮（`data-testid="runner-silence"`）；7) 打开运行页时预取自定义音频/设置一次，避免每次响铃都读存储 |
| `apps/extension/src/options/App.vue` | 新卡片 + `onPickSound`/`previewSound`/`resetSound`/`saveSoundToggle` 等 | 见 §3.4；导入 `loadSoundSettings`/`saveCustomSound`/`loadCustomSound`；`<input type="file">` 读 `File` → 大小/mime 校验 → `FileReader.readAsDataURL` → base64 存；试听必须由用户点击触发（同为扩展页面手势）；显示 `chrome.storage.local.getBytesInUse` 占用；隐私说明「只存本机、不上传」 |
| `apps/extension/manifest.base.json` | `content_security_policy.extension_pages`（`:32-34`） | 建议追加 `media-src 'self' data: blob:`；**不加权限、不加 WAR** |
| `scripts/build-extension.mjs` | `main()`（`:233-332`）、`assertOutputs()`（`:198-231`） | 新增 `copySoundAssets()`（§2.4）；`assertOutputs` 校验非空；日志 `files` 追加 sounds；保持 `EXPECTED_OUTPUTS` 不含音频（允许回退） |
| `scripts/package-extension.py` | `:14-31` | 可选：断言 `sounds/` 下文件数与总大小（如非空则 ≤ 5 MB），打印；无需改打包收集逻辑 |
| `apps/extension/tests/security-static.test.ts` | storage 白名单（`:96-104`）、远程 Origin（`:148-155`） | 若新增文件访问 storage，更新白名单；新增断言：音频模块不含 `fetch(`、不含 `http(s)://`、不含 `unlimitedStorage`/`offscreen` |
| `apps/extension/tests/build-manifest.test.ts` | `:27-34` | 若加 `media-src`，补一条断言（现有断言不会失败，只是覆盖不到新指令） |
| 版本 | `npm run version:extension -- 0.2.8` | 一次同步 6 处（`version-extension.py:19-37`）；不改版本则 Release 拒绝覆盖（`docs/extension-updates.md:30`） |

### 4.3 存储键、默认值与迁移兼容

- 键：沿用 `studyAssistantSettings`（`api/settings.ts:4`）新增 `sound` 对象；新增 `studyAssistantCustomSounds` 存 base64。
- 迁移：`loadSettings` 对缺失/非法字段给默认值（现有实现已对 `backendOrigin`/`defaultProviderProfileId` 做类型校验，`:42-47`，照此扩展）；**不要**把旧字段丢掉；`saveSettings` 改为 read-modify-write，避免调用方只传旧字段时把 `sound`/自定义音清空。
- 旧 `soundEnabled` 从未持久化（`App.vue:197`），因此无历史数据迁移问题；新键默认 `true` 与现行为一致。
- 兼容旧版运行页/设置页：新增字段全部可选，缺省回退；`chrome.storage` 里有多余未知键时忽略。

### 4.4 测试方案（vitest/jsdom 现状与新增）

现状（`apps/extension/vitest.config.ts:1-12`）：jsdom 环境、`tests/**/*.test.ts`、`define __BUILD_BACKEND_ORIGIN__`；**当前没有任何 `alarm.ts`/`AudioContext` 测试**，jsdom 也不实现 `AudioContext` 与 `HTMLMediaElement.play`。

| 测试 | mock 方式 | 断言 |
|---|---|---|
| `alarm.test.ts`：无上下文 | 不 stub，`playAlarm()` | 返回 `false`，不抛错 |
| 合成音排程 | `vi.stubGlobal("AudioContext", FakeAudioContext)`：记录 `createOscillator/createGain/currentTime/resume` | `playAlarm(2)` 排 2 轮 × 2 音 = 4 个振荡器；频率 880/660；音量/轮次正确；`unlockAlarm()` 对 `suspended` 调 `resume()` |
| stop | 记录 `oscillator.stop`/`audio.pause` | 调 `stopAlarm()` 后已排程/播放停止 |
| 文件回退链 | `vi.stubGlobal("Audio", FakeAudio)`；`chrome.runtime.getURL` 返回 `"chrome-extension://test/sounds/error.wav"` | 优先自定义 URL → 内置 URL → `play()` reject 时回退合成音；`element.volume` 等于配置 |
| 自定义音频 | 假 `chrome.storage.local.get/set` + 小 base64（1×1 帧 WAV 或任意字节，只测存储层） | 保存/读取/删除；超 1 MB 拒绝；非法 mime 拒绝；配额错误给出可读错误 |
| 设置迁移 | 假 storage 返回旧对象 | 补默认值且不丢 `backendOrigin`；非法 volume/repeat 被 clamp |
| runner 事件 | 复用 `tests/automation-runner.test.ts` 的 fake port | 弹题失败后 `state.alertKind === "popupFailed"`；NEEDS_INPUT 后为 `"needsInput"`；普通失败为 `"error"` |
| 安全静态 | 现有 `security-static.test.ts` | storage 白名单、远程 Origin 白名单不被破坏；音频模块无 `fetch(`/`http` |

命令：`npm run test -w @study/extension`、`npm run typecheck -w @study/extension`、`npm run test:release`、`npm run verify:contracts`。

### 4.5 验收方法（手工 + 构建 + e2e）

| 层级 | 步骤/断言 |
|---|---|
| 构建 | `node scripts/build-extension.mjs` 成功，日志显示 `sounds: [...]`；`dist/sounds/error.wav` 存在且非空；删掉 `sounds/` 再构建仍成功（回退场景） |
| 打包 | `npm run package:extension` 成功；ZIP 含 `extension/sounds/*`，条目数从 16 变为 N（预期 19），`package-extension.py:24-25` 的逐字节校验通过；`update.json`/`.sha256` 更新 |
| 单测 | `npm run test -w @study/extension` 全绿（含新增 alarm/sound-settings 用例）；`npm run typecheck` 全绿 |
| MV3 e2e | `npx playwright test -c tests/extension/playwright.config.ts` 通过（现有 26 项，见 HANDOFF 0.2.7 记录）；新增用例建议：设置页上传小音频→保存→重载后仍在；运行页开关持久化；触发 ERROR 后断言 `alertKind`/`runner-silence` 按钮出现（**不**验证真实音频输出） |
| 真机听测（必须人工，当前验收未验证） | ①运行页点开始 → 人为制造 ERROR（如关闭课程标签）→ 听到内置 error 音，每 30 s 重复；②点运行页任意位置 → 停止；③切到别的窗口，30 s 后仍响（后台节流下允许轻微延迟）；④设置页音量 0/50/100 对比；⑤上传 MP3 → 重开运行页 → 听到自定义音；⑥恢复默认/删除自定义 → 回退内置 → 再删包内文件重建 → 回退合成音；⑦关闭运行页 → 确认无声音（预期限制）；⑧DevTools Network 无任何音频请求；⑨系统静音时仅文字，不报错 |
| 边界 | 生成 manifest `permissions` 仍为 4 项、无 `web_accessible_resources`、无 `offscreen`/`unlimitedStorage`；`web_accessible_resources` 若出现即失败 |

### 4.6 需要同步更新的文档（本报告不改文档）

- `docs/course-automation.md:313-316`（声音告警节：文件/自定义/循环/限制）；
- `docs/acceptance.md` 新增 §9.39（构建、单测、e2e、真机听测与未验证项）；
- `使用说明.md:103-108`（ZIP 内容加 `extension/sounds/`）、新增「声音设置/自定义提示音」小节、版本号；
- `README.md:51`；
- `docs/architecture.md` §7.3 存储表（新增自定义音频）、§7.1 CSP 示例（若加 `media-src`）；
- `docs/extension-updates.md:9`（更新覆盖会替换同名内置音；保持路径）；
- `docs/course-playback-0.2.7.md`/发布记录中的 ZIP 条目数（16 → N）。

---

## 5. 风险与未知项

### 5.1 技术风险

1. **CSP `media-src` 未显式声明**：当前 CSP（`manifest.base.json:32-34`）没有 `default-src`/`media-src`。按规范，缺少 `media-src` 且无 `default-src` 时媒体加载不受限，包内同源 `<audio>` 通常可放；但**未在真实 Chrome 验证**，且 `blob:`（自定义音频）行为需确认。建议显式加 `media-src 'self' data: blob:` 并在真机验证；加指令不影响现有 `assertManifest`/`build-manifest.test.ts` 断言。
2. **`connect-src` 不含 `'self'`**：若实现选择用 `fetch(chrome.runtime.getURL(...))` 读取音频字节再 `decodeAudioData`，按 CSP 规范可能被 `connect-src` 拦截（当前只列 `https:` 与本机 HTTP）。本方案推荐用 `<audio>`/Blob（不走 fetch）；若确需 fetch，先加 `connect-src 'self'` 并实测，否则会得到「文件在但读不到」的隐蔽失败。
3. **自动播放策略**：`AudioContext` 需用户手势解锁（现状 `App.vue:167`）；`<audio>.play()` 在长延迟后的后台标签仍可能被拒（`NotAllowedError`）。必须实现「播放失败→文字提示/回退」，不能假设一定有声。验收 §9.23 明确标注**真机未听测**（`docs/acceptance.md:894`）。
4. **后台节流**：`setInterval(30 s)` 在隐藏页可能被拉长（尤其 5 分钟后密集节流）；合成音走音频时钟不受影响，但文件音链式重复会抖动。用户要求「每 30 秒重复」，需在文档中说明实际可能 30-60 s；若必须精确，需 `connect-src 'self'` + 预解码 + 音频时钟排程（复杂度/风险更高）。
5. **`AudioContext` 只能扩展页面创建**：Service Worker 无 DOM；`offscreen` 权限被 `FORBIDDEN_PERMISSIONS` 禁止（`build-extension.mjs:44`）→ **不能**做「关闭调度页仍响」；运行页关闭/崩溃即无告警。若将来要后台响，必须重新评估安全契约（不推荐）。
6. **`chrome.storage.local` 配额**：默认 10 MB；`unlimitedStorage` 被禁。base64 存 3 个 ≤1 MB 文件 ≈ 4 MB，加供应商配置仍够，但要防用户反复上传导致叠加；用 `getBytesInUse()` 显示、按 kind 单槽覆盖（不追加）控制总量。`ArrayBuffer` 不能直接存（JSON 序列化变 `{}`），必须 base64。
7. **包体积/发布**：WAV 约 +150-600 KB，ZIP 0.76 MB → 约 1 MB 级；`docs` 中 16 条目需更新；Release 工作流（`.github/workflows/release-extension.yml:49`）无固定条目断言，但 `使用说明.md` 的目录说明会过时。
8. **用户包内替换的可靠性**：Chrome 未签名解压扩展允许改文件，但「重新加载」会关闭运行页；不同 Chrome 版本/企业策略可能限制解压扩展；商店版会对包做完整性校验（当前未上架）。必须引导用户优先用设置页上传。
9. **`data:`/`blob:` 与扩展 CSP**：即使加了 `media-src`，MV3 对扩展页面脚本仍有严格限制（不影响媒体）；但若把音频内联成 `data:`（Vite 小文件内联）也需 `media-src` 允许 `data:`——本方案不走 Vite 资产内联，规避该问题。
10. **测试环境**：jsdom 不实现 `AudioContext`/`HTMLMediaElement.play`，单测必须 stub；Playwright e2e 在 headless 下无法验证「是否真的出声」，只能验证 UI/状态/存储；真实听测必须人工。

### 5.2 隐私/合规风险

- 自定义音频只应本地存储与本地播放：**不得** `fetch`/`XHR` 上传，不发供应商、不写日志、不进 `chrome.storage.sync`（`docs/architecture.md:607-617` 规定 sync 不用）；音频文件名可能含个人信息，UI 只显示文件名/大小即可，日志不记录内容。
- 不新增权限、不新增远程 Origin：必须保持 `security-static.test.ts:148-155`（远程 Origin 只允许 `local/provider.ts`、`updates/updates.ts`）与 `:96-104`（storage 白名单）通过。
- 不使用 `unlimitedStorage`/`offscreen`；不绕过自动播放策略；不把声音做成「偷偷后台播放」。
- 声音仍然只是「文字告警的叠加」，不得用声音替代错误文字/人工确认流程（现状如此，`docs/course-automation.md:315`）。

### 5.3 更新安装与用户文件丢失风险

- ZIP 覆盖更新会**替换同名内置音**（`使用说明.md:117-118` 的覆盖流程），用户手改的 `extension/sounds/error.wav` 会被新默认音覆盖；不同名文件保留但可能不被引用。
- 换安装目录 → 扩展 ID 变化 → `chrome.storage.local`（供应商配置、自定义音频）丢失（`docs/extension-updates.md:9` 要求保持原路径）。
- 同版本不能覆盖已发布 Release（`docs/extension-updates.md:30`）→ 音频改动必须提升版本号并走发布流程；未上架商店，用户仍需手动覆盖+重载。

### 5.4 明确的未知/未验证项（不要当成已证明）

1. 真实 Chrome 下「后台标签 30 s 后 `<audio>.play()` 是否被拒」「`blob:`/`data:` 在 `media-src` 下是否放行」——**未实测**。
2. `web_accessible_resources` 不用是否会带来边界问题——按扩展页面同源规则推断不需要，但未在真机逐项验证。
3. 用户替换包内文件后不同 Chrome 版本/策略的加载行为——未实测。
4. 各供应商/模型不受音频影响（音频不发送），但「运行页保持打开」前提下的告警可靠性（长时间后台、系统睡眠、扩展被更新重载）——未实测。
5. 音频解码（异常 MP3/损坏文件）在 Chrome 116+ 的行为与错误码——未实测，需按「失败回退」实现。
6. 验收 §9.23 已声明「声音告警在真实浏览器的实际出声……本轮未在真实 Chrome 人工听测」（`docs/acceptance.md:894`），本方案落地后必须补真机听测记录，**不得**把合成音 e2e 当成真实出声已通过。

### 5.5 不建议的做法

- ❌ 把音频放 `apps/extension/public/`（`publicDir:false`，不会进 dist）。
- ❌ 直接在 `dist/` 放文件（每次构建清空、被 gitignore）。
- ❌ 给音频目录加 `web_accessible_resources`（无必要，扩大网页可读面）。
- ❌ 新增 `offscreen`/`unlimitedStorage` 权限（违反清单/安全契约，`build-extension.mjs:31-46`）。
- ❌ 用 `fetch`/远程 URL 加载提示音（违反「不联网」与 CSP `connect-src` 限制；用户自定义音也更适合二进制本机存储）。
- ❌ 用错误文本 `includes("弹题")` 作为唯一事件区分（脆弱；应加显式 `alertKind`）。

---

## 附录 A：关键证据行号索引

| 主题 | 位置 |
|---|---|
| 声音唯一实现 | `apps/extension/src/shared/alarm.ts:7-60` |
| 启动手势解锁 | `apps/extension/src/automation/App.vue:163-167` |
| 声音开关（不持久化） | `apps/extension/src/automation/App.vue:197`、`:548-549` |
| 30 s × 20 次重复 | `apps/extension/src/automation/App.vue:198-210` |
| ERROR/NEEDS_INPUT 语义 | `apps/extension/src/automation/App.vue:211-220` |
| 用户回页停止 | `apps/extension/src/automation/App.vue:222`、`:457-462` |
| 运行页是扩展页面 | `apps/extension/src/sidepanel/App.vue:680-689`、`apps/extension/runner.html:1-5`、`apps/extension/src/background.ts:120-122` |
| 运行页状态机 | `apps/extension/src/automation/runner.ts:91-132`、`:290-325`、`:538`、`:1062`、`:1090`、`:1097` |
| `publicDir:false` / 构建输出 | `scripts/build-extension.mjs:48`、`:182-231`、`:244-308` |
| 权限/禁用权限 | `scripts/build-extension.mjs:30-46`、`apps/extension/manifest.base.json:7-12` |
| CSP | `apps/extension/manifest.base.json:32-34`、`scripts/build-extension.mjs:157-161` |
| 打包 | `scripts/package-extension.py:14-31` |
| 版本同步 | `scripts/version-extension.py:19-37` |
| 存储边界测试 | `apps/extension/tests/security-static.test.ts:96-104`、`:148-155` |
| 清单 CSP 测试 | `apps/extension/tests/build-manifest.test.ts:27-34` |
| jsdom 测试环境 | `apps/extension/vitest.config.ts:1-12` |
| 安装/更新说明 | `使用说明.md:28-34`、`:103-108`、`:114-119`；`docs/extension-updates.md:9`、`:30` |
| 声音文档/验收 | `docs/course-automation.md:313-316`；`docs/acceptance.md:863-894` |

## 附录 B：一句话回答用户

> 当前版本（0.2.7）**没有**放声音的文件夹，也没有任何音频文件——双音是代码即时合成的。实现「自定义提示音」后，源码放在 `apps/extension/sounds/`，构建输出到 `apps/extension/dist/sounds/`，解压安装后在**你加载的那个 `extension` 文件夹下的 `sounds\` 子目录**（例如 `C:\Users\<你>\Downloads\study-assistant-extension\extension\sounds\`）；把同名 `error.wav` / `needs-input.wav` / `popup-failed.wav` 覆盖进去后，在 `chrome://extensions` 点「重新加载」即可。更稳妥的是在扩展设置页上传自己的音频（只存本机 `chrome.storage.local`，不上传网络，更新覆盖包也不丢）。
