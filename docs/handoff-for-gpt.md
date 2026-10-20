# 交接文档（给外部模型 / GPT）

> 2026-10-19 最新范围变更：用户随后明确授权并要求执行独立课程自动运行模式（回填、核验、提交章节任务、视频正常播放、下一任务、鼠标自由）。本文件原始“计分页只识别”等约束描述属于原手动模式及此前阶段；新增模式以 `docs/course-automation.md` 与验收最新记录为准，正式考试和未适配结构仍不支持。不能将本文件历史限制误当作用户尚未授权。

> 用途：把本仓库当前真实状态、约束、已验证证据与**唯一阻塞问题**完整交接给另一个模型，
> 使其无需访问本机即可给出判断或补丁。仓库根目录为当前检出的项目目录。
> 本文件与 `HANDOFF.md`（仓库内部交接）互补；本文件更偏"问题分析与决策"。

---

## 1 项目一句话

《学习通 AI 学习助手》：Chrome MV3 扩展是核心客户端（读取当前单题 → 用户预览 → 显式发送 →
后端经用户自备供应商生成解析 → 用户审核 → 扩展非剪贴板回填 → 回读验证 → 不提交）；
后端为 Spring Boot 4.1.1 模块化单体 + PostgreSQL 17 + Flyway；Web 控制台用于账号与供应商配置。
隐私优先、BYOK、默认不落库题文与答案、不做统计/广告。

## 2 硬性约束（任何改动不得违反，来自 AGENTS.md 与两份规格）

1. 不收集学习通密码、Cookie、浏览记录、完整页面 HTML。
2. 不伪造视频进度、学习时长、签到。
3. 不自动提交考试、作业或计分测验；不得出现 `form.submit`/`requestSubmit`/点击提交按钮/提交 API。
4. 采集后必须预览，用户主动发送才调用供应商。
5. 只有"已验证适配器 + 用户单次审核"才允许回填。
6. 不执行模型返回的脚本/HTML/选择器/动作；模型文本按纯文本渲染。
7. 题文与答案默认不落库；日志不得含题文、答案、密钥。
8. API Key 用 AES-256-GCM，主密钥从 Secret 文件注入；Base URL 变更同事务清密钥与验证状态。
9. 不引入微服务、Redis、MQ、AI 框架、ORM、Lombok、MapStruct、前端组件库/Pinia/vue-router。
10. 不凭记忆编造学习通 DOM 选择器；真实适配器必须有脱敏 DOM 证据。
11. 权限最小化：不得请求 `cookies`/`webRequest`/`debugger`/`<all_urls>`/`unlimitedStorage`。
    2026-10-19 所有者明确批准方案 C：仅在读取因 host 权限失败后由用户点击申请具体 HTTPS 学习通站点可选权限，拒绝则手工输入；不为跨域框架追加授权。

## 3 当前实现状态（2026-10-19）

### 3.1 交付物

| 路径 | 内容 |
|---|---|
| `apps/extension` | MV3 扩展：单题采集、预览、发送、审核、控件写入器、回读、14 个本地故障码、计分页识别器 |
| `apps/console` | Vue 3 + Vite 控制台：账号、供应商配置、密钥、probe、默认配置、用量、导出、删号 |
| `packages/contracts` | OpenAPI 对应 TS 契约类型（错误码 25 个） |
| `packages/ui` | 共享表单/隐私/错误组件（无第三方运行时依赖） |
| `backend` | Spring Boot 4.1.1 + Spring JDBC + Flyway + PostgreSQL 17；JWT 无关，用不透明 Bearer |
| `tests/fixtures` | 10 个合成练习页（禁粘贴、只读、受控回弹、自动提交、计分、iframe、提示注入等） |
| `tests/extension` | 真实加载 MV3 扩展的 Playwright 集成测试（12 项） |
| `scripts` | 构建、契约校验、打包、本地伪上游、本地端到端、真实浏览器冒烟 |
| `infra` | Dockerfile（可选 `MAVEN_MIRROR_URL`）、compose.local/prod、Caddyfile、secrets 说明 |

### 3.2 已验证证据（本机实际执行）

| 检查 | 命令 | 结果 |
|---|---|---|
| 全仓 typecheck | `npm run typecheck` | 4 workspace exit 0 |
| 全仓单测 | `npm run test` | 175 passed（ui 23 / console 55 / extension 97；后扩展增至 103） |
| 扩展单测（最新） | `npm run test -w @study/extension` | **103 passed / 11 files** |
| 全仓构建 | `npm run build` | console dist + extension dist |
| 后端 | `mvn -f backend/pom.xml -B verify` | **66 tests, 0 fail, 0 skip**（含真实 PostgreSQL + Flyway） |
| Fixture 浏览器 | `npm run test:fixtures` | 22 passed |
| 扩展真实 MV3 | `npm run test:e2e` | 12 passed（真实加载 dist，同源伪后端） |
| 契约 | `node scripts/verify-contracts.mjs` | PASS（端点 20/20、错误码 25/25） |
| 后端端到端 | `node scripts/local-e2e.mjs` | **47/47 断言通过**（真实 jar + 真实 PG + 伪上游：注册/登录/ETag/密钥/双协议 probe 与答题/401→502/非法输出/租户隔离/用量导出/改密/限流） |
| 真实浏览器冒烟 | `node scripts/real-chrome-smoke.mjs --headful --login ... --backend http://127.0.0.1:8080` | 扩展加载成功；真实学习通域名下「读取当前题目」**安全拒绝**，`/study/answers` 0 次 |

### 3.3 文档

- 验收与证据：`docs/acceptance.md`（§9 为 Lead 复核，§9.6 真实环境阶段 A，§9.7 计分页识别器）
- 审计：`docs/real-env-audit.md`（权限/数据面/网络出口/提交能力 + 真实域名实测 + 账号级测试步骤）
- 兼容记录：`docs/compatibility.md`（适配器清单、§6.1 真实计分页观察、权限边界）
- 架构规格：`docs/architecture.md`（2505 行，权威，尤其 §7 权限、§8 回填、§21 验收）
- 适配规格：`docs/xuexitong-extension-adaptation.md`
- 仓库内部交接：`HANDOFF.md`

## 4 环境事实（换机器必须知道）

| 项 | 现状 |
|---|---|
| 系统 | Windows 11，PowerShell；Node 22.22.2 / npm 10.9.7；Java 21.0.10；Maven 3.9.12；Docker 29.5.3 |
| npm | `registry.npmjs.org` 不可达；仓库根 `.npmrc` 指向 `registry.npmmirror.com` |
| Maven | `repo.maven.apache.org` 不可达；用户级 `~/.m2/settings.xml` 配 aliyun 镜像；`backend/mvnw` 的 `distributionUrl` 也已改 aliyun 3.9.12 |
| Docker | Docker Hub 不可达；daemon 用 aliyun 镜像；daocloud 大镜像 blob 会 EOF（403/EOF） |
| Playwright | 浏览器已安装（Chromium 156.0.8078.4，`chromium-1248`）；下载走 `cdn.npmmirror.com` |
| Chrome | 品牌版 **155.0.8059.80**；Chrome 137+ 已移除品牌版 `--load-extension`，未打包扩展只能在 `chrome://extensions` 手动「加载已解压的扩展程序」 |
| Git | 当前目录**不是** git 仓库（无提交、无法 diff） |

## 5 当前唯一阻塞问题（请重点分析这个）

### 5.1 现象

用户在品牌版 Chrome 155 中手动加载 `apps/extension/dist`，打开学习通计分测验页
（`mooc1.chaoxing.com/mycourse/studentstudy?chapterId=...&courseId=...&clazzid=...`，
页面显示「本章在线测验 / 37 题 / Total score: 100.0 / 任务点」），侧边栏已登录本产品账号
（`student_demo`，供应商状态 VERIFIED），点击「读取当前题目」后侧边栏显示：

```text
FRAME_ACCESS_DENIED
没有目标框架的访问权限
page script injection denied: Cannot access contents of the page.
Extension manifest must request permission to access the respective host.
```

### 5.2 已有的代码事实

`apps/extension/src/background.ts` 中的注入路径：

```ts
const frameId = request.frameId ?? 0;
// 校验：sender.id、可信扩展页面路径、解析命令、tab 存在
await chrome.scripting.executeScript({
  target: { tabId: request.tabId, frameIds: [frameId] },
  files: ["page/entry.js"],
  world: "ISOLATED"
});
// 失败 → FRAME_ACCESS_DENIED，detail 为注入异常文本
```

侧边栏在点击时解析目标标签（`apps/extension/src/sidepanel/bridge.ts`）：

```ts
const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
const active = tabs[0];
return typeof active?.id === "number" ? active.id : null;
```

Manifest（构建产物）：

```json
{
  "permissions": ["activeTab", "scripting", "storage", "sidePanel"],
  "host_permissions": ["http://127.0.0.1:8080/*"],
  "background": { "service_worker": "background.js", "type": "module" },
  "action": { "default_title": "打开学习助手" },
  "side_panel": { "default_path": "sidepanel.html" },
  "content_security_policy": { "extension_pages": "script-src 'self'; object-src 'none'; connect-src http://127.0.0.1:8080" }
}
```

### 5.3 已排除

- **不是跨域 iframe 问题**：`frameId=0` 即顶层文档，错误是 host 权限缺失，而非框架访问异常。
- **不是内容脚本问题**：注入在 `world: "ISOLATED"`，失败发生在 `executeScript` 调用本身。
- **不是适配器问题**：注入成功后才进入适配器匹配；本次在注入阶段就被拒。

### 5.4 三个候选原因（按可能性排序）

1. **持久化的 `openPanelOnActionClick` 拦截了点击**：
   早期版本调用过 `chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true })`。
   该设置按扩展持久化。当前代码已删除该调用、改为 `chrome.action.onClicked → sidePanel.open()`，
   但 Chrome 中存留的旧值可能仍在生效，导致点击被 Chrome 内部处理、`onClicked` 不执行。
   若 Chrome 内部路径不授予 activeTab，就会出现此错误。
2. **授权绑到了别的标签页**：用户先在 `chrome://extensions` 刷新扩展、再切到测验页读取；
   activeTab 只绑定"点击图标时处于激活状态的标签页"，切页不迁移。
3. **点击后发生跨 Origin 导航**：跨 Origin 导航会撤销 activeTab；同源导航或通常的 SPA 路由切换本身不会撤销。原“SPA 导航立即撤销”说法不准确，已按 Chrome 官方文档修正。

### 5.5 结构性矛盾（这是关键判断）

产品交互是「侧边栏常驻 → 用户切换标签 → 点读取」；而 `activeTab` 的语义是
「一次图标点击授权对应标签页、跨 Origin 导航或关闭后失效」。侧边栏切换到未经调用授权的其他标签时不会继承权限；同源页面内跳转并不必然失效。所有者现已批准可选站点授权作为补充。

### 5.6 待选的三个方案（需要仓库所有者拍板）

| 方案 | 内容 | 代价 / 风险 |
|---|---|---|
| **A 可选站点权限** | manifest 增加 `optional_host_permissions: ["https://*.chaoxing.com/*"]`；侧边栏加「允许读取当前站点」按钮，调用 `chrome.permissions.request`（必须由用户手势触发），授权后注入不再依赖 activeTab | 改变规格 §7.1 权限模型；需同步改 manifest、构建脚本断言、`tests/build-manifest.test.ts`、`docs/architecture.md` §7.1、`docs/compatibility.md` §7、验收文档；仍读不到跨域子框架 |
| **B 严格 activeTab** | 保持现权限；提示"请在本标签页点图标后立即读取"；每次导航后重新授权 | 真实页面主流程几乎不可用；但权限最小、符合现行规格 |
| **C 混合（推荐）** | 先试 activeTab；失败时侧边栏显示一次性「授予本页读取权限（可选）」按钮走可选权限；不授予则退手工输入 | 代码量最大；需同时维护两条路径与测试；隐私边界最合理 |

### 5.7 建议先做的判定（20 秒，用户手动）

新开标签 → 打开该题页 → **在这个标签上点扩展图标** → **立刻**点「读取当前题目」（不要先切标签）：

- 得到 `PAGE_KIND_UNSUPPORTED` → 说明 activeTab 实际可用，问题在"切标签/持久化点击" → 修交互时序即可；
- 仍是同一 `FRAME_ACCESS_DENIED` → side panel 点击不授予 activeTab → 只能走方案 A/C。

**2026-10-19 用户实际反馈**：按上述步骤仍得到 `FRAME_ACCESS_DENIED`。按本节判定树归入第二分支，说明该次调用没有得到有效页面注入权限；不是适配器匹配失败。它不能单独证明旧 `openPanelOnActionClick` 一定是根因，也不能仅凭此结果断言 Chrome 永远无法授予 activeTab。用户随后明确回复“Approve C / 走 C，批准可选站点权限”。方案 C 的实现及本轮验证见 `docs/acceptance.md` 的最新记录。

## 6 若开始实现方案 C，必须改的文件清单

1. `apps/extension/manifest.base.json`：加 `optional_host_permissions`（仅 `https://*.chaoxing.com/*`，不加 `<all_urls>`）。
2. `scripts/build-extension.mjs`：构建断言当前会校验 permissions 白名单，需同步允许 optional 字段并继续拒绝新增必选权限。
3. `apps/extension/tests/build-manifest.test.ts`：现有断言 `expect(manifest.permissions).toEqual([...])`，需扩展为同时校验 optional 权限。
4. `apps/extension/src/background.ts`：
   - 启动时调 `chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false })` 重置历史持久化值；
   - 注入失败且原因为 "Cannot access contents of the page" 时返回可区分的失败（如新的本地码或在 detail 标注 `permission`），供 UI 决定是否给出授权按钮；
   - 授权成功后重新执行注入。
5. `apps/extension/src/sidepanel/App.vue` + `bridge.ts`：错误卡片上增加「允许读取当前站点」按钮（用户手势内调用 `chrome.permissions.request`），显示当前站点与可撤销说明。
6. `apps/extension/src/shared/codes.ts`：如需新码，必须同步 `shared/messages.ts` 的码表与 `docs/compatibility.md` §5。
7. 文档：`docs/architecture.md` §7.1（权限清单）、`docs/compatibility.md` §7、`docs/acceptance.md`、`HANDOFF.md`。
8. 测试：授权失败 → 手工输入路径；授权成功 → 注入；可选权限不请求时 manifest 仍为最小权限。

## 7 本地复现环境（已在本机搭好，可继续用）

```text
PostgreSQL: docker 容器 study-demo（127.0.0.1:5436，库 study_assistant）
后端:       java -jar backend/target/study-assistant-backend-0.1.0.jar  PORT=8080
伪上游:     node scripts/local-mock-upstream.mjs  (http://127.0.0.1:18080)
演示账号:   admin / 123456  （2026-10-19 按用户要求替换；本产品本地演示账号，不是学习通）
供应商:     DeepSeek 官方 deepseek-flash，真实 probe VERIFIED，已设为演示账号默认（原本地伪上游仍运行）
扩展构建:   node scripts/build-extension.mjs（local 模式，host 为 127.0.0.1:8080）
```

真机加载扩展：`chrome://extensions` → 开发者模式 → 加载已解压的扩展程序 → `apps/extension/dist`。

## 8 其他未验证项（不影响当前问题，但不要在报告中冒充完成）

- 真实学习通**可回填**页面：无脱敏 DOM 证据，只有计分页识别（拒绝）。
- 真实 AI 供应商连接测试：2026-10-19 从本机用户环境读取密钥，以 `deepseek-flash` 完成真实 probe VERIFIED 并设为默认；不等于真实题文或浏览器回填已联调。
- P6 部署：Docker Hub 不可达，`docker build`/`compose up`/`caddy validate` 未执行。
- Java DTO ↔ OpenAPI 字段级一致性未做（仅端点/错误码存在性校验）。
- 性能指标、Git 干净度未验证。

## 9 给接手模型的输出要求

1. 先判断 5.7 的判定结果对应哪种原因，再给结论；不要跳过判定直接改权限。
2. 若建议方案 A/C，必须明确这是**权限模型变更**，并列出上节第 6 条的全部同步修改点。
3. 不得建议：移除 readonly/disabled、伪造 isTrusted、扩大为 `<all_urls>`、使用 debugger/webRequest、
   在计分/考试页回填或自动答题、把题文/答案落库。
4. 给出可执行补丁时，遵守现有代码风格（TypeScript strict、无 any、纯文本渲染、失败码集中管理）。
5. 明确区分 Verified / Static analysis / Unverified，不得声称做过未执行的验证。
