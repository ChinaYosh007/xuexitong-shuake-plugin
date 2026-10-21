# 交接单（HANDOFF）

- 日期：2026-10-19（Asia/Shanghai）
- 负责人：Team Lead（Lead）
- 运行方式：4 个并发 subagent（backend-dev / frontend-dev / extension-dev / fixtures-dev）分范围实现，
  Lead 负责骨架、契约、环境修复、集成验证与最终修复。

> 需要把问题分析交给外部模型（如 GPT）时，使用 [docs/handoff-for-gpt.md](docs/handoff-for-gpt.md)：
> 它包含可独立阅读的约束、已验证证据、唯一阻塞问题（activeTab 授权）、三个候选方案与必改文件清单。

## 1 当前状态一句话

2026-10-19 最新追加：用户进一步明确要求“回填提交→下一任务；视频正常播放；鼠标自由使用”并要求执行，授权独立课程自动运行模式。实现和脱敏 DOM 证据见 `docs/course-automation.md`，入口为侧边栏“打开课程任务调度”。原手动模式及下方“计分页只识别”是原模式边界，不能代替新模式说明。新增单题图像协议、固定指令、绑定标签运行、回读与提交核验；真实运行验收见 acceptance 最新追加。

2026-10-19 追加：用户按外部交接 §5.7 操作后仍反馈 `FRAME_ACCESS_DENIED`，并显式批准方案 C 的权限模型变更。已实现 activeTab 优先、具体学习通 HTTPS Origin 可选授权、拒绝转手工输入、历史 panel behavior 重置；计分页仍只识别并拒绝。这个结果并未独立证实历史 panel behavior 就是根因。同源导航不会自动撤销 activeTab，之前的 SPA 说明已修正。本轮执行结果以 `docs/acceptance.md` 最新追加记录为准，以下原有数字为上一轮历史证据。

DeepSeek 配置使用既有 `CHAT_COMPLETIONS` 适配器、官方根地址 `https://api.deepseek.com` 和模型 ID `deepseek-flash`。本地配置脚本 `scripts/configure-deepseek.mjs` 从环境读取密钥与本产品账号，沿既有加密密钥 API 保存；`--probe` 才发合成连接测试并在成功后设为默认。密钥不写脚本、命令行参数或输出。它不实现自动刷课、计分题回填或学习进度伪造；真实可回填练习适配器仍缺 DOM 证据。

P0–P4 的全部代码已实现并通过本地验证（175 个前端单元测试、66 个后端测试含真实 PostgreSQL、
22 个 Fixture 浏览器测试、12 个真实 MV3 扩展集成测试、47 项真实进程端到端断言、契约 20/20 端点与 25/25 错误码）。
P5 真实学习通页面适配与 P6 生产部署**尚未验证**，不得宣称完成。

## 2 立即可复现的验证（全部实测通过）

```powershell
npm run typecheck        # 4 workspace exit 0
npm run test             # 175 passed
npm run build            # console + extension dist
npm run test:fixtures    # 22 passed
npm run test:e2e         # 12 passed
node scripts/verify-contracts.mjs
mvn -f backend/pom.xml -B verify   # 66 tests, 0 failures, 0 skipped
```

完整端到端（真实 PostgreSQL + 真实 jar + 本地伪上游）步骤见 `backend/README.md` 与
`docs/acceptance.md` §9.5，脚本为 `scripts/local-e2e.mjs`（47/47 断言）。

## 3 本轮修复的真实缺陷（重要，避免回退）

1. Spring Boot 4 的 Flyway 自动配置在 `spring-boot-starter-flyway`；只引 `flyway-core` 时迁移不执行。
2. `SUM(bigint)` 返回 `numeric`：`JdbcReceiptRepository.usage` 曾强转 `Long` 导致 `/me/usage`、
   `/me/export` 500；已改 `getBigDecimal` 并加回归测试。
3. 运维命令（`init-secrets`/`create-invite`）执行完不退出，脚本读 stdout 会挂起；已显式退出。
4. `backend/.mvn/wrapper/maven-wrapper.properties` 的 `distributionUrl` 曾 404，已指向 aliyun 3.9.12。
5. `PostgresIntegrationTest` 两处与迁移约束不一致的断言已修正。

## 4 环境事实（换机器/换网络必须知道）

| 项 | 现状 |
|---|---|
| registry.npmjs.org | 不可达；仓库根 `.npmrc` 指向 `registry.npmmirror.com` |
| repo.maven.apache.org | 不可达；用户级 `~/.m2/settings.xml` 已配 aliyun 镜像，`mvnw` 亦指向 aliyun |
| Docker Hub | 不可达；daemon 配 aliyun 镜像，小镜像可用，大镜像 blob 返回 403/EOF |
| Playwright 浏览器 | 通过 `PLAYWRIGHT_DOWNLOAD_HOST=https://cdn.npmmirror.com/binaries/playwright` 安装成功 |
| Testcontainers 镜像 | 需 `postgres:17-alpine` 与 `testcontainers/ryuk:0.14.0`，可从 daocloud 拉取后重打标签 |
| 本地伪上游 | `scripts/local-mock-upstream.mjs`（127.0.0.1:18080，支持 CHAT_COMPLETIONS/RESPONSES、401 与非法输出场景） |

## 5 目录与所有权

| 路径 | 内容 | 备注 |
|---|---|---|
| `apps/extension` | MV3 扩展（状态机、采集、回填、故障码） | 唯一适配器为 `fixture.practice v1.0.0` |
| `apps/console` | 配置控制台 | Token 仅内存（有静态测试守护） |
| `packages/contracts` | OpenAPI 对应 TS 类型 | 新增错误码需同步 openapi 与 `scripts/verify-contracts.mjs` |
| `packages/ui` | 共享组件 | 无第三方运行时依赖 |
| `backend` | 模块化单体 | 见 `backend/README.md` |
| `tests/fixtures` | 10 个合成练习页 | 含事件计数器契约，扩展适配器依赖 data-* 属性 |
| `tests/extension` | 真实 MV3 集成 | 占用 127.0.0.1:8080，勿与其他服务并发 |
| `scripts` | 构建/校验/打包/伪上游/端到端 | `local-e2e.mjs` 需要 `BASE`/`INVITE_1`/`INVITE_2` |
| `infra` | Dockerfile、compose、Caddy、secrets 说明 | 新增可选 `MAVEN_MIRROR_URL` 构建参数 |

## 6 未验证项与下一步（按优先级）

| 优先级 | 事项 | 具体下一步 |
|---|---|---|
| P0 | 真实学习通页面适配 | 获取脱敏 DOM + 事件副作用证据 → 实现真实 `PageAdapter` → 按适配规格 §8 填 `docs/compatibility.md`；在此之前真实页面只返回 `ADAPTER_NOT_MATCHED` |
| P1 | 真实供应商联调 | 用户显式输入自备 Key，按 `/probe` 手工验证两种协议、拒绝与截断路径，记录到 acceptance |
| P2 | Docker 镜像与 compose | 换用可访问的镜像仓库（或配置 registry 代理）后 `docker build -f infra/Dockerfile -t study-assistant-backend:verify .` → `docker compose -f infra/compose.local.yaml up -d --build` → 健康检查与 `/meta` 冒烟；再跑 `caddy validate` |
| P2 | Java DTO ↔ OpenAPI 字段级一致性 | 现有 `OpenApiContractTest` 只覆盖端点/错误码；可增加字段级反射断言或生成式校验 |
| P3 | 可信事件页面 | 合成“只接受 isTrusted 事件”的 fixture，断言扩展报 `UNTRUSTED_EVENT_REJECTED` |
| P3 | 性能与资源 | 在 2 vCPU / 2 GiB 参考机按规格 §21.4 测量 p95 与内存 |
| P4 | Git 仓库 | 当前目录不是 git 仓库，未做提交与干净度检查；需要时 `git init` 后首次提交 |

## 7 已知风险

- 扩展集成测试与伪上游共用 127.0.0.1:8080，并发执行会互相干扰；测试脚本未做端口占用检测。
- 本地开发默认打开 `APP_PROVIDERS_ALLOW_LOCAL_MOCK` 仅用于伪上游；SaaS 模式启动校验会拒绝该配置，
  但部署时仍需确认 `APP_MODE=saas` 与显式 Origin 白名单。
- 密钥文件、`.local-e2e/`、`infra/artifacts/`、`dist/`、`target/` 已被 `.gitignore` 忽略，勿手工提交。
- 真实站点若在 >1s 后异步恢复受控字段值，当前有界复查窗口无法发现（已写入兼容性文档的限制）。

## 7.1 真实环境阶段 A（2026-10-19 已执行）

- 真实浏览器加载扩展：✅（Playwright Chromium headful；品牌版 Chrome 155 已不支持 `--load-extension`）
- 真实学习通域名：✅ `i.chaoxing.com` → 登录墙，资源加载正常
- 本产品自有测试账号登录侧边栏后，对真实页面点击「读取当前题目」：✅ 安全拒绝 `FRAME_ACCESS_DENIED`
- 出站审计：仅学习通 + 本产品后端 + 扩展自身；`/study/answers` 0 次；控制台 0 错误

**计分页识别（2026-10-19）**：新增真实适配器 `xuexitong.graded` v1.0.0，只识别并拒绝计分/测验页
（`PAGE_KIND_UNSUPPORTED`），不采集题文、不建回填计划、不写入。真实页面的复验需用户在 Chrome 重新加载扩展后手动点击一次。

**账号级测试（用你本人学习通账号读取真实题目）需要人工点击扩展图标（activeTab 授权），无法安全自动化。**
所需最小输入与步骤见 [docs/real-env-audit.md](docs/real-env-audit.md) §7–§8：
目标练习页 URL（须非计分）、品牌版 Chrome 手动「加载已解压的扩展程序」、脱敏 DOM 采集授权。

## 8 收尾状态

本轮结束时已停止后台后端与伪上游进程；本地 PostgreSQL 容器 `study-e2e` 与测试数据如需复跑请重新创建。
若继续开发，先读本文件第 2、3、4 节，再读 `docs/acceptance.md` §9。

### 8.1 方案 C 追加后的当前状态（覆盖上一段旧状态）

后端已更新并在 `127.0.0.1:8080` 运行；伪上游 `18080`、PostgreSQL `study-demo`（5436）保持运行。演示账号的默认供应商现为真实 `deepseek-flash`，probe 为 VERIFIED。前端类型检查/构建、扩展 121 项测试、真实 MV3 13 项与配置脚本 5 项通过。完整后端 verify 有 4 项 JDK loopback 初始化错误（62 项通过），打包使用 `-DskipTests` 成功，不能将其描述为全套后端测试通过。详见验收 §9.8。

### 8.2 课程自动运行追加后的当前状态

后端已更新为多模态输入版本，仍在 `8080` 运行；真实 DeepSeek 合成图像答题通过。扩展 136 项测试、14 项 MV3 合成测试通过；新增混合题型案例扩为单选/富文本填空/富文本简答后单独复跑通过。后端显式排除前述故障类后 64 项通过。新入口为“打开课程任务调度”；用户需在 Chrome 重新加载扩展，尚未对真实课程启动、回填或提交。入口、脱敏 DOM 与测试边界见 `docs/course-automation.md`、验收 §9.9。

### 8.3 消息冲突修复后的当前状态

用户已重新加载并打开真实调度页，报告 `unsupported page command type`。已修复旧手动监听器抢答自动消息的问题并更新 Fixture-only 旧提示；扩展 typecheck、18 文件 / 137 项测试通过。MV3 新回归先加载手动入口再运行三种题型，1/1 通过。最终 dist 仍指向 `8080`。需再加载扩展并刷新课程文档清除驻留旧监听器，重新打开调度页预览。当前浏览器连接安全策略拒绝观察扩展 URL，未绕过；真实课程回填/提交/视频仍未验证。详见验收 §9.10。

### 8.4 并行、投票与监听后的当前状态

用户截图显示真实题图预览成功，在 5/37 题因不确定停止、0 个任务完成；不据此宣称真实站点已提交。按新增要求实现三题滚动取图、两路并行模型请求、三次多数票（至少 2 份有效一致）、FIFO 回填、当前任务刷题按钮、本地答题/视频监听与取消队列。扩展 typecheck、20 文件 / 158 项单元、完整 MV3 15 项通过；最后改动后两个课程案例再次 2/2 通过，模型调用均为测试伪后端。没有修改浏览器权限或后端配额；实时 `/meta` 仍为 10 次/分钟、100 次/天、并发 2。37 题三次需 111 次，界面会显示超过每日总上限，也支持单次模式。最后产物仍使用原 `8080` 后端；需重新加载扩展、刷新课程页并打开调度器。真实新版连续运行未验证，详见课程运行文档与验收 §9.11。

### 8.5 本地演示账号更新

2026-10-19 按用户明确要求，将现有本产品本地 `student_demo` 账号改为 `admin / 123456`。仅对 `study-demo` 数据库内该账号维护：同一事务更新用户名与 BCrypt(12) 密码哈希、撤销旧会话，保留原用户 ID、供应商和加密密钥配置。没有修改全局注册/改密的 12 字符策略。实际通过 `8080` 登录、读取 `/me` 与供应商配置验证：新用户名为 admin，原默认 `deepseek-flash` 仍 VERIFIED；测试会话已退出。扩展现有会话需要重新登录。

### 8.6 判断题回读/监控/补答修复后的当前状态（2026-10-19 21:5x）

用户真实课程运行出现 `ERROR · 已停止，需要人工处理`，2 道**判断题**待人工补答（「页面没有保留回填结果（回读不一致）」）。按截图、运行状态与代码审计定位并修复 4 个缺陷：

1. 学习通判断题隐藏答案值是布尔语义（`true`/`false`、`对`/`错` 等），旧回读只按字母 A/B 比对 → 页面已选中却永远读不到，误判失败。现回读同时支持字母、布尔、可见文本、序号多 token 映射；歧义不猜测。
2. 回填后只等固定 300ms 读一次 → 现轮询回读最长 2.5s，容忍站点异步写回与题目重渲染；失败时附带脱敏诊断（隐藏值形态/原生控件/识别选中数），并允许重定位元素后补发一次写入。
3. 监控单次采样即 ERROR 且无具体原因 → 现首次差异后等 400ms 复核，仍差异才停止，并列出「任务标识/页面类型/题数」具体差异；瞬时重渲染不再误停。
4. 题型识别失败会中止整轮、补答重试一题失败会拖住整轮 → UNKNOWN 题转人工汇总（可「题型纠正」后补答，写入/补答时按答案形态推断）；`retryManual` 逐题隔离并更新失败原因。

验证（本轮实测）：`npm run typecheck` 4 workspace 通过；`npm run test -w @study/extension` **22 文件 / 215 项通过**；`node scripts/build-extension.mjs` 成功，最终 `apps/extension/dist` 指向 `http://127.0.0.1:8080`；使用临时 `http://127.0.0.1:18081` 构建 + mock 契约后端跑 MV3 Playwright **18/18 通过（33.2s）**，含新增「判断题 true/false 隐藏答案可回填并提交」端到端用例；课程调度 5/5。MV3 既有用例因 21:0x 本地直连改造过期（登录表单/manifest 可选权限/全图默认/刷题模式连续任务语义），本轮改为直接注入可信 `storage.session` 并更新断言，已恢复全量通过。

仍未验证：真实学习通页面上的判断题回填/提交需用户重新加载 `apps/extension/dist`（Chrome 扩展管理页“重新加载”）并刷新课程页/重开调度页后复测；真实账号本轮未再跑。

### 8.7 本地直连图像输入修复后的当前状态（2026-10-19 21:5x）

用户截图：课程调度页本地直连运行，待人工补答题的模型回答称「缺少题目图像/当前输入中未提供图像内容」；同页已能复制/下载题图，用户说明所用模型（4.1）支持图像且手动复制图片可作答。

根因：21:1x 新增的 `src/local/provider.ts` 直连只发题目 JSON 文本，`question.imageDataUrl` 从 `CAPTURE` 到请求构造的链路上被丢弃；后端模式的两个适配器本来就发送多模态图像块。

修复：本地直连 Chat Completions 发送 `text` + `image_url`，Responses 发送 `input_text` + `input_image`，文本块不重复 base64；提示词补充图像规则；新增 `LocalProvider.supportsImages`（设置页「支持图像输入（多模态）」，旧存储默认开启，DeepSeek 文本预设默认关闭）；调度页显示图像能力状态。

验证：`npm run typecheck` 4 workspace 通过；`npm run test -w @study/extension` **23 文件 / 223 项通过**（新增 `tests/local-provider.test.ts` 6 项）；`node scripts/build-extension.mjs` 成功，产物共享块含 `image_url`/`input_image`、runner/options 含新提示与勾选。详见验收 §9.15。

未验证：真实 4.1 供应商下的端到端请求需用户重新加载 `apps/extension/dist` 并刷新/重开调度页后复测；不支持图像的供应商需在设置里取消勾选，否则会显示供应商 4xx 原始错误。

### 8.8 新皮肤提交确认弹窗修复后的当前状态（2026-10-19 22:0x）

用户截图：真实章节测验点击 Submit 后弹出新皮肤确认框（`Tip` / `Submit?` / `Cancel` / `Submit`），调度器不点它，60 秒后按「站点未确认提交」停止，每次重跑都卡在提交这一步。

根因：`course-page.ts` 的 `CONFIRM_WORK` 只匹配旧 DOM 证据（`#confirmSubWin` + 唯一 `a.bluebtn`「OK」），新皮肤弹窗结构和文案不同。

修复：保留旧证据匹配；未命中时使用可见文本签名兜底（不硬编码新皮肤 class）：同一可见小容器内必须同时有含 `?/？` 的提交确认问句、恰好一个确定按钮（Submit/OK/确定/确认/确认提交/确定提交/提交/交卷）与恰好一个取消按钮（Cancel/取消/关闭）；按钮兼容 `button/a/[role=button]/[onclick]` 与精确文案的叶子 span/div；只在扩展自己点击提交之后、每任务最多一次；歧义或缺少取消按钮不点击。证据与限制记入 `docs/compatibility.md` §6.2（截图级，未取得脱敏 DOM）。

验证：扩展 23 文件 / **227 项通过**（course-page 34 项，新增 4 项：新皮肤弹窗确认一次、span 样式按钮、歧义弹窗不点、题干含「确定要提交？」不误判）；`npm run typecheck -w @study/extension` 通过；`node scripts/build-extension.mjs` 成功。详见验收 §9.17。

未验证：需用户重新加载扩展并重跑真实章节测验复测；若弹窗控件不是 `button/a/[role=button]/[onclick]` 或位于 Shadow DOM 仍无法识别，需要脱敏 DOM 做精确适配。当前弹窗如仍开着，请先手动关闭并刷新课程页再重跑（已尝试提交的任务不会重复点击）。

### 8.9 ERROR 后补答自动提交恢复（2026-10-19 22:1x）

用户反馈：提交阶段还要自己手动点提交，“完全可以自己点一下”。根因：自动提交链路只在 `NEEDS_INPUT` 生效；流水线以 ERROR 停止后（如监控在补答停车期间误判任务变化），补答核验完成只提示「请修正错误后重新启动以提交」，不自动点提交，而「重新启动」会对已回填题重新调用模型。

修复（`runner.ts`）：`submitNow` 抽出 `submitAndWait` 核心；新增 `recoverFromError`——ERROR 且补答全部核验时自动点击站点提交（单次、完成标记核验），成功后经拆出的 `runLoop` 继续任务链（起始题重置 1、保留计数）；`submitManual` / `adoptCandidate` / `acceptManualFromPage` 三个补答入口在 ERROR 下全部核验后自动触发（`acceptManualFromPage` 原在 ERROR 下点了没反应，一并修复）；`start` 增加 `manualSaving` 防重入。安全边界不变：逐题回读一致、唯一提交按钮、单次提交、缺题不提交、STOPPED 不恢复。

验证：`npm run typecheck` 4 workspace 通过；`npm run test -w @study/extension` **23 文件 / 230 项通过**（`automation-runner.test.ts` 新增 3 项 ERROR 恢复用例；随后并行轮次叠加站点权限卡片修复后为 24 文件 / 234 项）；MV3 真实浏览器（临时 18081 构建）**18/18 通过**，含补答后自动提交端到端用例，并顺带修复 §9.16 遗留的 5 处胶囊文案过期断言；最终 dist 同时包含本修复与 §9.19 卡片隐藏改动。详见验收 §9.18、课程文档「ERROR 后补答自动提交并继续」节。

未验证：真实学习通页面复测需重新加载 `apps/extension/dist`；ERROR 若由真实任务切换引起，补答会被任务键守卫拒绝、不会误提交到新任务（既有测试覆盖）。

### 8.10 题图失败不再丢弃文字可读题（2026-10-19 22:2x）

用户截图：调度页待人工补答 2 题（ACEBench 单选题、Claude Code 判断题），原因「图片无法读取，已跳过自动答题，请手动输入。」；卡片无任何模型回答/候选，「再次并发请求」「直接采用最高票答案」禁用。用户反馈「没有AI信息，无法作答，也无法再次发送请求」。

根因：`runner.ts` 题图 `CAPTURE` 失败分支无条件转人工且 `retryable=false`，从不调用模型；而「所有题目都附带渲染图片」默认开启，文字已可靠读取的题也会强制取图。`render-question.ts` 还会因不可见/未加载图片整题失败，错误详情被通用文案覆盖。

修复：新增 `TaskQuestion.textUsable`；`needsImage=false` 的题图失败按源文字继续正常作答并回填，`needsImage=true` 且文字可读的题按文字请求一次并把回答/候选列入人工汇总（不自动回填），文字不可读的题保留具体原因与重试入口。`retryManual` 对题图失败项先重新 `CAPTURE`，成功则用带图请求投票回填，仍失败时只给纯文字候选；成功重读后清空此前纯文字样本。`render-question.ts` 跳过隐藏/无布局盒/无 src 图片并等待可见图片加载 3 秒。汇总卡新增「题图读取失败：具体原因」提示。

验证：`npm run typecheck` 4 workspace 通过；`npm run test -w @study/extension` **24 文件 / 237 项通过**（`automation-runner.test.ts` 原图片错误 1 项改为 4 项）；`node scripts/build-extension.mjs` 成功，最终 dist 指向 `http://127.0.0.1:8080`；临时 18081 构建 + mock 后端跑 MV3 Playwright **18/18 通过（53.6s）**；`node scripts/verify-contracts.mjs` PASS。详见验收 §9.20、课程文档「题图读取失败的回退与重试」。

未验证：真实学习通页面需重新加载 `apps/extension/dist` 后重跑复测；旧截图两题的具体渲染失败原因无法回溯，重跑后汇总卡会显示具体原因。

### 8.11 刷题视频不跳过、刷课视频不自动播放修复（2026-10-19 22:4x）

用户两张截图：①真实课程「AI伦理挑战概述」当前任务点是视频，播放器黑屏只有站点播放按钮；②调度页 `ERROR · 已停止，需要人工处理`，计数「已确认完成 1 / 已越过 1 个 PDF / 已跳过 0」，错误「站点尚未确认本任务完成，拒绝跳转。」。用户原话「无论是哪个模式，都没有自动播放的模块，刷题也不会跳过」。

两个独立根因：①刷题模式 runner 对未完成 VIDEO 直接发 `NEXT`，但 `course-page.ts` 的 NEXT 守卫只放行已完成或 PDF 资料页 → 整轮 ERROR；②刷课模式只调 `video.play()`，无用户手势下的有声自动播放被 Chrome 拒绝（`NotAllowedError`），黑屏不播。

修复：`protocol.ts` 新增 `allowSkipUnfinished`（仅 NEXT 且严格 true 生效）；`course-page.ts` NEXT 增加「显式授权且当前为 VIDEO」放行，新增 `startVideo()` 静音起播后恢复声音的自动播放兜底与具体失败诊断，已在播放的媒体不点控件；`runner.ts` 新增 `skippedVideos` 计数、只在该场景携带跳过授权、只对 PLAY 做最多 3 次总尝试的重试；`App.vue` 分开显示 PDF/视频跳过计数并提示自动播放兜底。详见 `docs/course-automation.md`「刷题模式跳过视频与刷课模式自动播放」、验收 §9.21。

验证：`npm run test -w @study/extension` **24 文件 / 252 项通过**；`npm run typecheck -w @study/extension` exit 0；`node scripts/build-extension.mjs` 成功；`npm run test:e2e`（新 dist + mock 契约后端）**19/19 通过（54.4s，含「刷题模式直接跳过未完成视频」端到端）**；`release/study-assistant-extension.zip` 已用新 dist 重新打包。未验证：真实学习通页面需用户重新加载 dist/解压 release 包并刷新课程页后复测；站点若在标签页后台主动暂停播放，扩展不绕过该限制。

### 8.12 非粘贴题目支持与同窗口并行会话（2026-10-19 22:4x–23:1x）

用户补充限制「还有的题目可能是采用非粘贴的方式，需要考虑一系列情况」。实现两类非粘贴处理：**非文本图示**（内联 SVG 序列化绘制、canvas 像素复制、open shadow root 文字读取/绘制、MathJax 隐藏 MathML 跳过、音视频/嵌入框架显式转人工不再误生成题图）；**非 UEditor 作答控件**（`TaskQuestion.answerMode`：通用 contenteditable 纯文本写入、纯输入框原生 setter 写入、排序/连线/拖拽等未知控件 `NONE` 降级为文字题请求候选并转人工核验，`READ_ALL` 不再因单题结构未知中止整轮）。详见 `docs/course-automation.md`「非粘贴题目」节、验收 §9.22。

验证（23:08 源码快照）：`npm run test -w @study/extension` **25 文件 / 273 项通过**（含非粘贴新用例：course-page 3 + source 3 + render-question 4 + MV3 1）；typecheck 0 诊断；build 默认 8080 成功；`node scripts/verify-contracts.mjs` PASS；MV3 全量 19 过 / 1 失败（并行会话的弹题用例，非本轮）/ nonpaste 用例单跑 PASS。

**同窗口并行会话（用户确认让其做完）**：2026-10-19 22:41–23:11+ 另一会话在同一仓库持续写入：视频跳过/自动播放（§8.11 已录）、只刷课模式 `videosOnly`、视频弹题免人工枚举 `ENUM_POPUP`、暂停声音告警 `shared/alarm.ts`、`play()` 竞速上限、`automation-video-popup.html` + 弹题 MV3 用例（**该用例 60s 超时失败，其会话仍在迭代**）、23:11 起开始 `model-json.ts` 新主题（未收尾）。该线的用户授权（只刷课/弹题枚举/声音告警）已补记入 AGENTS.md「2026-10-19 22:4x」段，功能文档见 `docs/course-automation.md` 同名节。两套改动经逐点审查正交共存，273 项测试同时覆盖。**遗留**：① 并行写入停止后需用最终 dist 重新打包 `release/study-assistant-extension.zip`（当前仍为 §8.11 版本）并重跑全量验证；② `model-json.ts` 与弹题 MV3 失败的验收记录缺失，由该会话补写。

### 8.13 本地直连模型非法 JSON 修复与单题错误分类（2026-10-19 23:0x–23:2x）

用户现场错误：`模型返回的不是有效 JSON：{"status":"ANSWERED",...,"textAnswer":，`（全角逗号+截断），已生成的 `blankAnswers` 被整段丢弃；用户质问「难道没有考虑这种情况吗」。根因：`local/provider.ts` 只做整段围栏剥离的 `JSON.parse`，任何标点/前后缀/截断偏差都抛错且无重试；本地直连错误无 `code`，`runner.ts` 无法按 `UPSTREAM_*`/`VALIDATION_ERROR` 单题隔离，整轮 ERROR。

修复：新增 `local/model-json.ts`（每个 `{` 起点提取对象、全角标点/引号/尾逗号/内层引号/原始换行/Python 空值归一、截断补全与回退，候选带 `truncated`/`uncertain` 可信度标记）；`askLocalProvider` 有界 3 次重试（仅解析失败/空/截断/引号不确定，`finish_reason=length` 时输出上限 2048→4096），**只有可信且通过题目校验的候选才被采用**，语义非法单次 `VALIDATION_ERROR` 不自动重问；错误带后端同名单题 code；填空答案必须与 `blankId` 一一对应且非空；提示词补充英文半角/闭合要求；runner 失败文案同步。安全边界不变：纯语法修复不猜答案，不可信候选绝不自动回填。

对抗性加固：只读子代理 83 例审计发现 5 类「错误成功」（漏逗号回退丢多选选项、答案内引号+全角逗号截短文本、截断但通过校验、`None` 成字符串、截断前缀恰为合法 id），全部由可信度标记+重试策略消除；单引号/注释等罕见形态由重试兜底转人工。

验证：`npm run test -w @study/extension` **26 文件 / 302 项通过**（新增修复器 18 项 + provider 8 项）；`npm run typecheck` 4 workspace 通过；`node scripts/build-extension.mjs` 成功（默认 8080）；`npm run test:e2e` **21/21 通过（1.0m）**；`node scripts/verify-contracts.mjs` PASS；`release/study-assistant-extension.zip` 已用最终 dist 重新暂存打包（0.76 MB，23:21，覆盖 §8.12 遗留①②与 §9.23 记录的 23:19 中间快照）。详见验收 §9.24、课程文档「本地直连模型返回非法 JSON 的修复与有界重试」节。

未验证：真实供应商（DeepSeek 等）复测需重载 dist/解压 release 包；模型持续输出不可修复内容时仍按单题人工补答，不静默回填。

### 8.14 截断修复按字段归因，填空不再全部转人工（2026-10-20 09:0x–09:1x）

用户真实复测：加载 §8.13 的 23:2x dist 重跑同一章节测验，6 道填空题全部「No.1：」空答——旧策略把「对象被截断」整体视为不可信，而其模型经常在 `textAnswer`/`explanation` 等非答案字段处截断（`blankAnswers` 已完整），每题都被判 `UPSTREAM_TRUNCATED` 转人工。

修复：`RecoveredJson` 新增 `affectedKeys`（未闭合字符串/数组、被丢弃的半截 `"key":`、回退丢尾均归属到所属键，归因不到记 `""` 保守处理；根对象闭合不归因）；provider 新增 `answerKeysOf(question)` 按题型给答案字段，截断/引号存疑候选**触及答案字段才重试**，只伤及非答案字段的候选直接采用并显式 caveat「答案字段本身完整，已采用」。提示词新增填空/简答格式约束（只写最常用单一写法、禁止括号别名，如『JVM（即时编译）』应写『JVM』）——针对上一轮『JVM』7.7 分、『Java虚拟机（JVM）』0 分的精确匹配判分。对抗探针 13 例复核：用户样例采用；截断答案文本/多选数组/`opt_1` 前缀/漏逗号丢选项等全部重试；截断 explanation 采用。

验证：`npm run test -w @study/extension` **26 文件 / 307 项通过**（修复器 20 项 + provider 19 项）；`npm run typecheck` 4 workspace 通过；build 默认 8080 成功；`npm run test:e2e` **21/21 通过（1.2m）**；契约 PASS；`release/study-assistant-extension.zip` 重新打包（0.76 MB，09:19）。详见验收 §9.25、课程文档同节「2026-10-20 追加」。

未验证：需用户重载 dist 后重跑该测验，确认填空恢复回填且简写答案得分；「站点按字符串精确匹配」仍是推断，未取得判分规则证据。

### 8.15 独立作业/测验作答页纳入刷题（2026-10-20 09:3x–09:5x）

用户截图：调度页 `ERROR · 已停止，需要人工处理`，红色错误「只允许在课程任务页面运行。」；用户原话**「这也算上，可以刷题」**，并给出真实标签地址路径 `/mooc-ans/mooc2/work/dowork`（学习通课程域，带 `courseId`/`classId`/`workId`/`answerId`）。澄清确认：把该页面纳入可运行/刷题范围，整卷核验后自动点站点提交。

根因：`course-page.ts` 的 `inspect()` 只接受 `/mycourse/studentstudy`；`runner.ts` 只有「课程任务点 + 下一任务」的循环，没有单卷作答路径。

修复：`protocol.ts` 新增 `TaskSnapshot.standalone`；`course-page.ts` 新增 `isWorkPagePath()`（仅 dowork）与 `isExamPath()`，`inspect()` 对作业页返回 standalone 快照（courseKey/taskKey 由页面参数派生、不读题文、`hasNext=false`），完成证据为结果视图「提交成功/已提交/查看答案/重新作答」文本节点（跳过 `script/style`）或本页已点提交且作答视图消失（题面与提交控件都不再出现）；提交控件搜索抽为共用函数；页面路径判定抽到 `shared/pages.ts`，侧边栏「读取当前题目」在作业页也直接打开调度器。`runner.ts` 新增 `runStandaloneWork()`：整卷读取→并发作答→排序回填→逐题回读核验→`SEND_WORK` 一次→`CONFIRM_WORK`→60 秒有界等待；只刷课模式在作业页拒绝；无下一任务，确认后 DONE；页面跳转或连续三次无法读取快照时如实结束，不重复提交、不宣称核验。

验证：扩展 **26 文件 / 332 项通过**（新增课程页 6 项、runner 5 项、侧边栏路由 1 项）；`npm run typecheck` 4 workspace 通过；`node scripts/build-extension.mjs` 成功；MV3 e2e **22/22 通过**（新增 `tests/fixtures/automation-work.html` 整卷回填→提交一次→结果视图用例）；契约 PASS；`release/study-assistant-extension.zip` 重新打包。详见验收 §9.27、`docs/course-automation.md`「独立作业/测验作答页纳入刷题」、`docs/compatibility.md` §6.4。

未验证：真实 dowork 页外层 DOM 未取得脱敏证据（用户选择先按已记录的题库结构实现）；提交后结果视图是留在原页还是跳转、结果文案是否命中，需用户重新加载 `apps/extension/dist` 后实测。若结构不同，扩展会在「题目结构未识别 / 无法唯一确认站点提交按钮 / 提交结果未核验」处明确停止。





### 8.16 普通图文卡片自动寻找下一任务点（2026-10-20 10:0x）

最新用户截图中的 ERROR 来源：测验完成后进入「每节一句」，只有静态图片/文字，无任务标记，但旧 MATERIAL 只识别 PDF。已只读获取真实 Chrome cards DOM 并记录 compatibility §6.5；新增 `staticContentCard()`，限定 cards 路径、complete、可见 `#pageDiv.ans-cc`、静态排版、图片加载成功、无交互/iframe/任务标记。沿用 MATERIAL 和原 Next 任务链自动寻找后续任务，连续资源可越过，不调用 AI、不提交、不计完成；UI 同步资源计数文案。无权限变更，未知/带未完成任务标记的模块不按普通资料跳过。

Verified：扩展 26 文件 / **347 单测**；根 typecheck；扩展 build（8080）；contracts 28 接口 / 92 字段 PASS；MV3 全套 **23/23**。新增真实扩展桥合成链路提交测验→图片格言→纯文字→下一测验，`send=2, confirm=2, next=3`，4 次模型请求，完成 2、越过 2。`release/study-assistant-extension.zip` 已更新（15 文件、0.76 MB），逐字节核对当前 dist、CRC 通过；stage 以覆盖生成文件方式同步，没有删除目录。验收 §9.28，合成截图 `.local-demo/static-card-navigation-verified.png`。

Unverified：浏览器工具禁止访问扩展管理页，不能代用户重新加载已打开的扩展，当前真实调度未重启。真站 Next 从格言进入下一章节首张 PDF（带未完成任务标记，模块仍未加载完成），没有进一步跳过或虚报完成；两次真站截图超时，真实导航证据仅 DOM/可访问树。不要把合成 DONE 截图当作整门真实课程完成证明。

### 8.17 资料题两个空格被当成简答、跨域原图永远超时（2026-10-20 12:4x）

用户新截图属于 Resource Analysis 代码图片题，有 No.1/No.2 两个编辑区域，却请求了 `SHORT_ANSWER + blanks=[]`，采用单个答案时因 1 值/2 框报控件变化。`course-page.ts` 新增共用字段数量判定：UNKNOWN + 已支持多文本控件、显式 SHORT_ANSWER 多控件均归 FILL_BLANK，读取和 applyType 一致，保留真实字段变化拒绝守卫。`consensus.ts` 识别 NEEDS_CONTEXT 中缺程序代码/空白标记，自动触发现有原图通道。新增 e2e 首跑暴露 `extractOriginalImages()` 在 await load 之后才设 src，已把 src 设置移到 Promise 内等待之前；不绕过 CORS。

Verified：**357 单测** / 26 文件，extension typecheck/build，契约 PASS，完整 MV3 **24/24**。新 `automation-resource-blanks.html` 合成代码图片 + 两个 UEditor 端到端：两次请求都有两个 blankId，JPEG→PNG 原图，两个框按 ID 回填核验、提交/确认各一次，无人工补答。发布 ZIP 15 文件 / 0.76 MB，CRC 和逐字节 dist 校验通过，stage 已同步。验收 §9.29，compatibility §6.6；截图 `.local-demo/resource-blanks-verified.png`。

真实页面只读时已提交并显示答案；没有重开修订、重交或改变用户结果。原始可编辑控件 DOM 与真实模型图像能力仍未验证。需要重新加载扩展并关掉旧调度页、重开重新读取，不能沿用旧页缓存的错误简答结构；工具禁止访问扩展管理页，本轮未代用户重载。

### 8.18 章节还有未完成任务 Notice 不再卡住（2026-10-20 12:5x）

用户截图 Notice / unfinished tasks in current chapter / to learn / Next。旧任务链只点外层 Next，不处理章节未完成提示，原键不变 25 秒超时。真实顶层 DOM 已只读核实两皮肤 `.jobFinishTip` 与 `#jobFinishTip`（正文与按钮见 compatibility §6.7），取证时模板均隐藏，课程已在后续章节，本轮没有操作用户网页。

新增固定 CONFIRM_NEXT 与 nextNotice 结果；启动前处理遗留弹窗，NEXT 后轮询已识别可见提示。刷课默认 to learn；刷题跳过 VIDEO、只刷课跳过 QUIZ 才带模式显式授权确认 Next，重新核对确认时任务类型，不能把视频跳过沿用到刚加载的测验。按钮唯一/可见/可交互、正文匹配才处理，同一可见按钮不重复点。to learn 返回原键时撤回暂计计数、重读剩余任务，重复提示停止防循环。协议新指令仅接受绑定键，跳过 flag 只对 NEXT/CONFIRM_NEXT 严格 true 生效；无权限或后端契约变更。

Verified：370 单测 / 26 文件，extension typecheck/build，契约 PASS；最终构建完整 MV3 **26/26**，覆盖同页返回补齐（1 请求、提交/确认各 1）及只刷课按模式跳过（0 请求/0 提交）。发布 ZIP 15 文件 / 0.76 MB，CRC/逐字节 dist 检查通过，stage 更新。验收 §9.30；合成证据 `.local-demo/chapter-notice-learn.png`、`.local-demo/chapter-notice-skip.png`。

Unverified：真实提示取证时已关闭，新版真站操作仍待用户重载后验证；工具不能访问扩展管理页。若用 ZIP 安装，要覆盖实际加载目录，或直接加载 `apps/extension/dist`，再重开调度页以清掉旧运行状态。不要把合成 DONE 当作真实课程完成。
### 8.19 全项目缺陷扫描与修复轮（2026-10-20 13:0x–13:4x）

用户要求“扫描整个项目、检测并修复 bug，然后打包交付扩展与使用方式”。本轮由 Lead + 4 个只读审计子代理按范围（automation runner、DOM 适配、provider/UI/MV3、构建打包/文档）逐行审计，修复确认缺陷并补回归测试；没有新增权限、没有改变安全边界。

修复清单（均带回归测试或静态断言）：

1. 页面适配（`automation/course-page.ts`）：`input[type=submit]` 的 `value` 文案永不匹配（`textContent ?? value`）；题型识别把题干里的“多选/判断/填空”当成题型标签；作业页完成证据 `submittedCue()` 未校验可见性/题文（隐藏模板或题干“查看答案”会误报已完成）；提交确认弹窗不区分“还有 N 题未作答，确定提交吗？”（缺答警告可能被自动确认）；裸 `contenteditable` / `plaintext-only` 收集与写入判定不一致；`ul > li` 兜底把题干列表当选项并派发点击；UEditor 隐藏模板可能遮蔽可见控件。
2. 字体解析（`automation/true-type.ts`）：cmap 嵌套循环只有单组上限，构造字体可造成约 4e9 次迭代卡死；现加总迭代预算。
3. 页面适配器（`page/xuexitong-graded.ts`）：host 判定缺域名边界，`fakechaoxing.com` 被当成学习通；现要求 `chaoxing.com` 或其子域。
4. 本地供应商（`local/provider.ts`、`local/model-json.ts`）：所有 fetch 无超时（上游挂起会永久卡住侧边栏/整轮运行）；HTTP 4xx/5xx、网络、权限、信封解析错误没有合同 code；截断修复器丢弃无法归因的块时未记未知键，简答题截断答案可能被当作“非答案字段”自动采用；Base URL 只查前缀且“读取模型”用未归一化地址；预设按钮会沿用上一个供应商的 API Key。
5. 课程调度（`automation/runner.ts`）：ERROR 恢复提交后 `manualSaving` 一直持有，续跑后下一个任务再需补答时所有补答入口被锁死（P1）；提交后站点立即换页时 `CONFIRM_WORK` 先抛错导致假 ERROR；自动换页时用新任务快照计数导致完成/跳过数虚高；收集期 fatal 会丢弃已收集的人工项；`retryManual` 期间转 ERROR 后不恢复；章节未完成提示返回后只等 1 秒就判定失败；`VALIDATION_ERROR` 增加来源标记（后端请求校验错误不再逐题转人工）。
6. 侧边栏（`sidepanel/App.vue`）：审核→重校验期间未置 busy，交叉采集会被旧响应覆盖；供应商请求失败后 `setFailure` 把阶段改成 ERROR，发送按钮无法重试；`chrome.tabs.get` 二次读取无 catch 会静默失败；发送前重新读取已保存供应商配置。
7. 调度页面（`automation/App.vue`）：APPLY 失败后追加的人工项没有输入表单（浅 watch + `manualDrafts` 缺失，点补答抛 TypeError）；题型纠正为简答/填空时 UI 仍按原始题型渲染/取值；“按多选勾选”不参与题型推断；本地供应商验证状态不再硬编码 `VERIFIED`（改为 `UNVERIFIED` + “配置已保存”文案）。
8. 后台（`background.ts`、`automation/page-entry.ts`）：每条调度指令都重新注入 1.37 MB 页面脚本（视频轮询每 2.5 秒一次）；改为先 `AUTOMATION_PING` 探活，缺失时才注入。
9. 构建/打包（`scripts/build-extension.mjs`、`release/make_zip.py`）：`FORBIDDEN_OUTPUT_TOKENS` 的 `"sessionStorage?"` 是无效字面量；esbuild 未固定 `absWorkingDir`，从仓库根构建与 workspace 构建产物注释不同；`release/make_zip.py` 现在直接读 `apps/extension/dist` 打包并校验 manifest，避免旧 stage 残留（已删除过期 `release/stage`）。
10. 文档：`README.md`、`使用说明.md`、`docs/course-automation.md`、`docs/compatibility.md` 同步实际模式名、图像输入前置条件、权限/CSP 实际声明、90 秒超时、本地验证状态与测试数字。

验证（本机实测）：

```text
npm run typecheck                                   # 0 诊断
npm run test -w @study/extension                    # 26 文件 / 383 项通过（新增 13 项回归）
node scripts/verify-contracts.mjs                   # PASS（21 endpoints / 25 errorCodes / 92 fields）
node scripts/build-extension.mjs                    # 成功，产物 apps/extension/dist
npx playwright test -c tests/extension/playwright.config.ts  # 26/26 通过（1.6m）
python release/make_zip.py                          # 15 条目：14 个 extension/** + 使用说明.md
```

未验证/仍需真实环境复测：

- 真实学习通课程上的本轮新增行为（输入型提交按钮、缺答警告弹窗不点、完成证据可见性、慢加载提示返回、混合控件）未取得脱敏 DOM 证据，需用户重新加载扩展后实测；未按记忆编造站点选择器。
- 品牌版 Chrome 手动“加载已解压的扩展程序”未由工具代操作；MV3 集成使用 Playwright Chromium。
- 真实供应商 90 秒超时按实际网络触发才可验证；单次 4xx 图像题转人工的策略用单测覆盖。
- 供应商配置仍按用户既有决定明文存于本机 `chrome.storage.local`（独立版无后端主密钥）；这是与 AGENTS 第 8 条后端加密约束不同的独立版设计，未在本轮改变。

### 8.20 结构化输出、填空可靠性与更新分发（2026-10-20，0.2.0）

Version 0.2.0 is built and locally tested. See docs/project-audit-2026-10-20.md and acceptance §9.31 for evidence and limitations.

用户继续要求处理模型输出发散、空格未正确写入/误多选，以及开发者发布后其他用户通过下拉更新。严格按题型隔离答案字段，拒绝未知状态与非字符串填空；格式错误最多三次纠正；明确 1/2/blank-1/第1空编号只映射到已知 blank_#。控件 tag/id/name/框架与顺序写入前重核。无多数结果不再自动取候选首位；ANSWERED 声明不确定也追加两次；不同多选不取并集。模型列表读取 body 有超时，手动 API 地址输入清除旧草稿 Key。

新增 src/updates/{updates.ts,UpdateMenu.vue} 与三个页面顶部下拉。商店调用 requestUpdateCheck，ZIP 点击时请求清单 Origin、读取最大16KB/10秒清单、显示更高版本下载；不自动联网、不强制 reload、不执行远程代码、不带供应商 Key/题目/Cookie。解压版仍需覆盖原目录手动重载，公共 HTTPS 更新源与商店没有部署；不能提供不存在的公网地址。

Verified：403 extension unit（27文件）、11 contract unit、类型与构建、21接口/25故障码/92字段一致性、22 Fixture browser、28 MV3 browser。新直连回归模拟混合字段→重试明确空号，两个 UEditor 分别写入、提交仅1次；更新菜单合成0.3.0可下载、0.1.0不降级、配置保留、无凭据请求、Base URL改动清空假Key。截图在 .local-demo/update-menu-verified.png、local-structured-blanks-verified.png。

打包使用 `npm run package:extension`（需 Python3），直接读 dist，不依赖 stage；输出 release/study-assistant-extension.zip、同名.sha256、update.json。发布者上传三者到自己的 HTTPS 同目录，再给用户 update.json 地址。当前版本统一0.2.0，package-lock已生成。使用与发布步骤见 使用说明.md、docs/extension-updates.md。

Unverified：真实课程本轮行为、真实模型正确性、公共发布/商店升级；npm audit镜像404且官方TLS失败，未获取漏洞报告。没有后端源码可审计，不沿用历史Java测试。完整范围和限制见本轮audit。

### 8.21 实际延迟编辑器漏空与假 DOCUMENT_CHANGED（2026-10-20，0.2.1）

Fixed stable blank-slot capture and per-slot activation. Final local validation: 407 unit tests, 29 MV3 tests, typecheck/build and contract consistency pass. Live course was inspected read-only.

用户实际反馈证实上一版仍漏掉延迟加载机制：第6题2空读1空，第12题5空当简答；后续几题APPLY均在fingerprint前检查失败。只读真实DOM发现 `.blankItemInp` 每空一套 `.InpDIV` + 隐藏 `.textDIV` 内 `textarea[id^=answerEditor]`/`iframe[id^=ueditor_]`；占位稳定、iframe只在编辑时显示。旧describe连点占位、只数可见body，所以先漏空、之后编辑器显隐又导致指纹变化。

新增LAZY_UEDITOR内部模式，基于稳定占位和对应textarea ID计数与指纹，采集不点击；写入逐空通过站点点击激活、等待2.5秒内可见且可编辑body，再纯文本写入，等待后重核题目。只读/禁用/真实题干或位置变化拒绝，隐藏textarea只读不写，不强制显示。完整题干/程序仍沿原通道发送，增加blankCount/requiredIds/responseTemplate，漏空最多3次纠正。未知/正式考试等边界不变。源DOM记录compatibility §6.8。

最终407单测、根typecheck/build、契约存在性通过；完整29/29 MV3浏览器测试通过（1.5m）。新增合成延迟编辑器3题2/5/2空：读时0次激活/0frame，逆序回答按空定位，9次激活，Submit/确认各1，3次模型请求，无人工项。截图.local-demo/lazy-blanks-verified.png。包0.2.1/15条目/0.77MB，ZIP与dist逐字节及CRC通过，update.json/摘要已同步。

必须停止旧运行、关闭旧调度页、重载扩展并刷新课程后新开调度重新读取，旧缓存不自动修正。真实课程本轮没有点击/填写/提交，真站交互与真实模型准确性仍未验证。使用说明、课程运行、compatibility和新修复记录docs/blank-editor-fix-2026-10-20.md已同步。验收§9.32。

### 8.22 图片选项整题二次直填、逐题录入反馈（2026-10-20，0.2.2）

Image-stage answers replace older votes. Two main per-question actions now support image retry/write and direct entry, with inline results and preserved drafts. Local validation passes; live-site/model behavior remains unverified.

最新用户授权：图片选项等首次不可读时，第二阶段发送完整题干+全部选项图片并直接用该结果，不与旧答案投票；先展示模型回答，主要是图片重试与录入两个按钮，允许自行改答案，重点解决录入没反应。

新增内部CAPTURE imagePass=whole、imageRequired，course-page.handle必须把whole原样转给capture（新回归首跑发现旧三元式会吞掉whole，已修复）。question-roots复用已支持的.Zy_ulTop/主题ulTop，源图示检测、fingerprint与绘图一致；绘图右侧加opt_N，不覆盖原选项图片。强制图片请求在text-only配置下明确拒绝，不静默删图。首次合成图全失败且保留文字参考时也再试完整题图；旧原图兜底仍用于首次图像读取恢复。第二阶段完整ANSWERED可映射即回填，允许caveat，不伪造缺答/未知ID。

补答UI先展示raw samples，候选预填可改；每题「采用图片重新发送并回写」「一键录入本题」。旧投票/最高票主入口已移除，批量/网页核验在折叠区。submitManual允许非重复待答子集，保留其他题；草稿按完成任务数/指纹维持，不被其他样本或列表变化清空。错误/成功在本题旁反馈，网页缺答核验不再静默。ERROR下图片重试可恢复，停止后响应不回填。

Verified：418单测（27文件）、11契约单测、根typecheck/build、21接口/25错误/92字段存在性检查；完整MV3 **30/30（1.9m）**。新合成图片选项+两文字题：选项整图第二回答带不确定说明仍填B；另一题图片按钮填成功；末题空录入有错误，提前键入的草稿不丢，逐题完成后提交/确认各1次，总5请求。截图.local-demo/image-retry-and-entry.png。包0.2.2/15条目/.77MB，CRC、逐字节dist/使用说明、SHA256/feed一致；摘要见验收9.33。

Unverified：真实课程新流程、真实视觉模型能力和准确性；本轮未外发真实题目或操作真站，未改权限/CORS/只读/考试/回读守卫。重载扩展并刷新课程、新开调度后使用。文档docs/image-retry-entry-flow.md和使用说明已更新；包release/study-assistant-extension.zip、feed/update清单与摘要已更新。



### 8.23 增量扫描、后台二次图片与运行中预览（2026-10-20，0.2.3）

Scan dispatch is incremental; previews/copying remain interactive. Mode selection is a dropdown, and the side-panel manual-input entry is removed. Automatic whole-image retries now precede final manual handling, including first REFUSED and unsettled consensus.

READ_ONE复用现有describe源读取器，协议校验索引与任务绑定；RunnerPort.readQuestion可选，旧仅READ_ALL端口仍兼容，真实App提供增量读取。3工作者、2请求与2扫描/图像处理有界，全部收齐后仍按题号回填。预览池独立2并发、缓存仅本任务内存，题目变更拒绝展示错误图像；复制/下载与模型/补答写入锁分开。人工摘要到自动处理/回填尾部才公布。保留缺答、非法ID/空格、正式考试、任务变化/只读/回读守卫。

provider兼容Chat文本分段和Responses扁平output_text，避免String(array)；null/对象不当作文本。诊断缺结构、空最终答案、只有reasoning_content；明确截断的仅推理输出可提高额度至8192，后续格式重试不得降低已提高额度。推理从不作为答案。没有实际供应商失败原响应，不能声称截图空内容的唯一根因已验证。

长题renderQuestion每128字交出事件循环，滚动时更新相对原点，尺寸变化拒绝损坏图像。UI的模式下拉、复选框布局、折叠/限高图像预览已改；边栏手工录入和过期授权引导已删，最终补答的两个入口保留。文档docs/async-scan-ui-0.2.3.md、课程运行、兼容性、使用说明与README同步。最终验证与包摘要见验收§9.34。

Verified：430单测（27文件），11契约单测、契约存在性、根类型/构建，完整MV3 31/31（1.9m）；最终展示按钮调整后9界面单测及1/1运行中查看浏览器复测通过。包0.2.3/16条目/0.77MB、CRC/逐字节dist+说明/版本/feed摘要一致，SHA-256 `faa493c599620cd02fdcb9d1605949d432dcb264c0ddb9dd3d5ab4d2796c4f35`。真实模型/真站本轮未运行。使用前停止旧运行、关闭旧调度页，重载扩展，保存网页未提交答案后刷新课程，再新开调度页；旧页脚本不会随扩展重载更新。


### 8.24 签到表、双栏查看与大图（2026-10-20，0.2.4）

QuestionBoard replaces vertical cards with compact text/image/final-failure tiles; opens a two-pane Markdown/image native dialog. Removed the local 400KB rejection and original-image encoded budget compression.

绿＝普通文字、蓝＝必需图像/原图/二次整图、红＝最终未回填且未补答（优先），普通题额外附图或仅预览不改分类，补答核验后恢复对应颜色。题号状态用源指纹对齐，图片路径缓存任务切换清除。dialog使用纯文本Markdown，左右两窗、复制下载/原尺寸/前后题/Esc，按需异步预览；补答卡也复用同一窗口，避免重复大图。UI不声明绿色就已提交成功。

render删除400000拒绝，原图保留PNG原尺寸，不再按400000/460000预算JPEG缩放；极大画布资源预算保留，真实CORS/供应商/浏览器限制可能失败。当前独立版直连无旧backend字节上限；历史OpenAPI未改变。关键代码src/automation/QuestionBoard.vue、App.vue、render-question.ts。使用说明、README、隐私/兼容/课程运行与docs/question-board-0.2.4.md同步。

Verified：432单测、最终9界面复测、根类型/构建；最终4/4重点MV3通过（29.2s），覆盖浏览器>400000图两阶段、20题两行、挂起请求期间双栏/切换/复制、红蓝及核验恢复；截图.local-demo/question-{board,dual-view}-0.2.4.png已检查。未声称最终版本完整31/31干净通过，详见验收9.35的测试断言与fixture计时竞争记录。本轮没有真实课程或付费模型操作。

包0.2.4 / 16条目 / 0.78MB，CRC、dist和使用说明逐字节一致，根/扩展/锁/manifest/feed版本一致，SHA-256与feed/摘要文件一致：`c5a95f16e263c4bc2511865d61172bbda5be320e304ac16e6b8b7a4819a6689a`。

### 8.25 GitHub 更新发布（2026-10-21，0.2.5）

内置官方更新源，ZIP 默认与旧空白商店配置迁移；支持下载后直接打开管理页，仍需覆盖原文件夹并重新加载。main 新版本工作流自动校验/打包/公开 Release/重新下载校验/原子同步 updates/update.json。版本用 npm run version:extension -- 0.2.6 一次同步六处；相同版本不能覆盖发布文件。补齐已有测试依赖及平台可选依赖锁记录，详见 docs/extension-updates.md。Verified 本机 434 单测、8 发布单测、11 契约测试、契约检查、类型/构建和 2 项 MV3 更新检查；公网运行结果待补记。
