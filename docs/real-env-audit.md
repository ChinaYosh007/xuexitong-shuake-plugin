# 真实环境测试前审计报告

> 最新模式说明（2026-10-19）：下文为原手动模式及前阶段审计。用户现已明确授权独立课程自动运行模式；新增图像输入、章节任务回填/提交及视频调度的边界和脱敏证据见 `docs/course-automation.md`，验收见 `docs/acceptance.md` 最新追加。原手动模式保持计分页拒绝，不能据此推断新模式只读。

- 日期：2026-10-19
- 审计对象：`apps/extension/dist`（构建产物）、扩展源码、后端接口面、仓库依赖
- 结论：**可以进入「真实浏览器 + 真实学习通页面」的只读验证阶段；但真实页面回填必须先补齐适配器证据，
  且只能在你明确指定为非计分练习的页面上进行。**

## 1 审计范围与方法

| 维度 | 方法 | 结果 |
|---|---|---|
| Manifest 权限 | 读取构建产物 `dist/manifest.json` | 必选仅 `activeTab/scripting/storage/sidePanel`；`host_permissions` 仅本地后端；经所有者批准，新增 `https://*.chaoxing.com/*` 可选声明，默认未授予，用户点击仅申请具体 HTTPS 站点 Origin |
| 危险权限 | 源码与产物双扫描 | 无 `cookies`/`webRequest`/`debugger`/`history`/截图 API/`<all_urls>`/`unlimitedStorage` |
| 页面数据面 | 扫描 `src/page/**` | 无 `storage`/`fetch`/`document.cookie`/`localStorage`/`innerText` 整页采集 |
| 账号凭据 | 全仓扫描 | 不读取 Cookie/密码；扩展登录时密码仅经侧边栏内存提交到本产品后端，不落盘 |
| Token 存放 | `api/session.ts` | 仅 `chrome.storage.session`，且 local/session 均设 `TRUSTED_CONTEXTS`；页面脚本无法访问 |
| 远程代码 | 源码与 CSP | 无远程脚本/远程模块；CSP `script-src 'self'; object-src 'none'`，无 `unsafe-*` |
| 网络出口 | `api/client.ts` + CSP | 只允许「用户配置的后端 Origin」；`assertBackendOrigin` 拒绝非裸 Origin，非回环强制 HTTPS |
| 提交能力 | 全仓扫描 + 静态测试 | 无 `form.submit`/`requestSubmit`/点击提交按钮/`Enter` 提交；扩展测试断言 submit 计数恒为 0 |
| 剪贴板 | 全仓扫描 | 不调用剪贴板 API，不派发合成 `paste`/`keydown` |
| 消息面 | `shared/messages.ts` | 固定四条命令；校验 `sender.id`、可信页面路径、tab/frame、字节上限、`planId` 与一次性 nonce；无通用 `FETCH_URL`/`EXECUTE_SCRIPT`/`CALL_API` |
| 后端接口面 | `docs/openapi.yaml`（20 端点）+ 源码 | 无 fill/submit/grade/progress 类端点；题目与答案无落库字段（`V1__initial.sql` 无 stem/option/answer 列） |
| 依赖供应链 | `package.json` / `package-lock.json` | 扩展运行时依赖仅 `vue` + 本地契约包；无统计、崩溃上报、广告 SDK |
| 错误映射 | 端到端实测（47/47） | 供应商 401 → 502 `UPSTREAM_AUTH_FAILED`，不会误导用户退出本产品 |
| 日志隐私 | 真实运行日志抽查 | 不含题文与 API Key |

## 2 真实环境测试的前置门槛（未满足则不进入）

1. **明确目标页面**：由你提供 URL，并确认该页**不是考试、不是作业提交、不是计分测验**。
2. **只读优先**：第一轮只验证「加载扩展 → 打开侧边栏 → 读取当前题目」；由于尚无真实适配器，
   预期结果是安全拒绝 `ADAPTER_NOT_MATCHED`，且**零网络请求、零写入、零提交**。
3. **要实现真实回填必须先有脱敏 DOM 证据**（AGENTS.md 第 11 条）：仅采集该页题目容器的结构
   （标签、属性名、层级），不采集姓名/学号/班级/课程信息/整页 HTML/Cookie。
4. **不扩大权限**：不为跨域 iframe 增加 `host_permissions`；拿不到就降级为手工输入。
5. **不自动提交**：任何测试都不得点击提交/保存按钮；发现页面在 input/change 时自动保存或计分，
   立即中止并记录为不支持。

## 3 本轮计划的真实环境测试

### 阶段 A：只读安全验证（不修改账号任何内容）

- 在真实 Chrome 中加载未打包扩展（`apps/extension/dist`）。
- 打开你指定的学习通题目页，点「读取当前题目」。
- 断言：安全拒绝或明确不支持；页面计数器中 input/change/submit 均为 0；除本机后端外无出站请求；
  侧边栏关闭后题文不恢复。

### 阶段 B：真实适配器（仅在你同意采集脱敏 DOM 后进行）

- 只采集题目容器的脱敏结构证据，写入 `docs/compatibility.md`。
- 实现该页专用 `PageAdapter`（不写猜测选择器），再用本地后端 + 本地伪上游完成
  采集 → 预览 → 发送 → 审核 → 回填 → 回读，验证零提交。
- 仅在该页被确认非计分时执行；一旦发现计分/自动保存特征，立即停止并关闭回填。

### 明确不做

- 不读取或导出你的 Cookie/密码/整页 HTML/浏览记录。
- 不在考试、作业提交、计分测验页面做任何填写。
- 不为了"跑通"而移除 readonly/disabled、伪造 isTrusted 事件或扩大权限。
- 不把真实页面截图或题文提交进仓库；如需截图仅本地保留并打码。

## 4 账号与浏览器接入方式（待你确认）

现有环境事实：Chrome 已安装（`C:\Program Files\Google\Chrome\Application\chrome.exe`）且当前**正在运行**；
用户数据目录存在多个 Profile；Playwright Chromium 已安装。

三种可选接入方式（隐私侵入从小到大）：

1. **临时配置 + 你手动登录**（推荐）：我用独立临时配置启动 Chrome 并加载扩展，你在弹出的窗口里
   自己登录学习通。我全程接触不到你的主浏览器数据与密码。
2. **沿用现有登录态**：需要你关闭当前 Chrome，我用你的用户数据目录带调试端口启动；
   这会接触该配置目录（不会复制或上传任何数据）。
3. **不碰账号**：只验证扩展在真实 Chrome 中能加载、侧边栏能打开、页面脚本注入失败时安全降级。

## 5 审计结论

- 当前实现不存在「自动提交、整页采集、读取 Cookie、远程代码、隐藏外发」的代码路径；
  真实环境测试不会因为实现缺陷而直接造成账号数据泄露或误提交。
- 最大风险不在扩展，而在**目标页面性质**：学习通多数题目页带计分或自动保存。
  因此阶段 A 可立即执行；阶段 B 必须由你确认页面性质后再进行。

> 本报告只陈述已执行的检查与代码事实；真实页面的兼容性仍为 Unverified，直到阶段 A/B 实际执行。

---

## 6 阶段 A 实测结果（2026-10-19，真实浏览器 + 真实学习通域名）

脚本：`scripts/real-chrome-smoke.mjs`（真实 Chrome/Chromium 进程、未打包 MV3 扩展、独立临时配置，
不使用、不读取你的学习通账号与 Cookie）。

| 断言 | 结果 |
|---|---|
| 扩展在真实浏览器中加载 | ✅ `extensionLoaded=true`，扩展 ID `bdiabohnnmpopkjnmeibpdjpkobmfene` |
| 侧边栏可信页面打开 | ✅ `login-section`/`capture-question`/`capture-selection`/`manual-question` 均正常渲染 |
| 用本产品自有测试账号登录侧边栏 | ✅ 登录成功（账号 `realbrowser_test`，注册于本产品后端，与学习通无关） |
| 打开真实学习通页面 | ✅ `https://i.chaoxing.com` → 登录墙 `passport2.chaoxing.com`，标题「用户登录」 |
| 真实页面点击「读取当前题目」 | ✅ 安全拒绝，错误码 **`FRAME_ACCESS_DENIED`**（无 activeTab 授权时不会绕过权限） |
| 出站请求审计 | ✅ 仅学习通域名 + 本产品后端 `127.0.0.1:8080` + 扩展自身；无第三方 |
| 自动发送/回填 | ✅ `/study/answers` 请求数 **0**，无写入、无提交 |
| 控制台错误 | ✅ 0 条 |

结论：真实域名下，扩展**没有**扩大权限、没有偷偷采集、没有向外部发送题目；在没有得到用户点击授权
（activeTab）时按设计拒绝访问页面。这正是规格要求的行为。

## 7 浏览器安装方式的重要发现

- 本机品牌版 Google Chrome 为 **155.0.8059.80**。Chrome 137+ 已移除
  `--load-extension` 对品牌版的支持，因此自动化无法把未打包扩展塞进品牌版 Chrome。
- 自动化验证使用 Playwright 自带 Chromium（同一引擎、支持未打包 MV3）；品牌版 Chrome 只能由用户
  **手动安装**：`chrome://extensions` → 打开「开发者模式」→「加载已解压的扩展程序」→ 选择
  `apps/extension/dist`。
- 若坚持用品牌版 Chrome 自动化，需改用 Chrome for Testing（`channel: 'chrome'` 指向 CFT 发行版）。

## 8 账号级测试（需要你提供的最小输入）

由于「读取当前题目」依赖用户点击扩展图标的 activeTab 授权，账号级验证**本质上需要人工点击**，
无法在无人值守下安全自动化。要继续，需要你提供：

1. 一个**非计分练习页**的 URL（不要考试/作业提交/计分测验），并确认页面性质；
2. 在你的 Chrome 中按上面步骤「加载已解压的扩展程序」；
3. 是否允许采集该页题目容器的**脱敏 DOM 结构**（标签/属性名/层级，不含个人数据与整页 HTML）。

拿到后按以下顺序执行（每步都可中止）：

```text
1. 打开该练习页 → 点击扩展图标 → 侧边栏「读取当前题目」
   预期：若尚无该页适配器 → ADAPTER_NOT_MATCHED（安全拒绝，不写任何字段）。
2. 若页面结构可支持且你同意，采集题目容器脱敏结构 → 实现该页 PageAdapter → 记录到 docs/compatibility.md。
3. 再次读取 → 预览题干/选项/空格 → 你确认后才允许发送。
4. 本地后端 + 本地伪上游返回答案 → 你审核 → 「审核并回填本题」。
5. 校验逐字段回读结果；确认 submit 计数为 0、无自动保存请求。
6. 任何一步出现计分/自动保存特征 → 立即停止并关闭该页回填。
```

在完成第 1 步之前，真实页面仍一律返回 `ADAPTER_NOT_MATCHED`，不会尝试写入。
