# 验收报告（Acceptance）

- 生成时间：2026-10-18（Asia/Shanghai）
- 范围：本仓库当前状态，重点覆盖 tests/**、scripts/**、infra/**、docs/privacy.md、docs/acceptance.md、docs/adr/**
- 生成者：fixtures-dev（共享任务 task-4）
- 判定规则：**只有实际执行并有命令输出的检查才算 Verified**；仅通过代码/文档阅读确认的写 Static analysis；受环境、密钥或页面资料限制未执行的写 Unverified。禁止只写“全部通过”。

## 1 验证环境

| 项 | 值 |
|---|---|
| 操作系统 | Windows 11 |
| Node.js | v22.22.2 |
| npm | 10.9.7 |
| Playwright | 1.64.1；Chromium Headless Shell 156.0.8078.4（chromium-headless-shell v1248）+ Chromium 1248 |
| Docker | 29.5.3 / Docker Compose v5.1.4（desktop-linux） |
| 网络 | registry.npmjs.org 不可达；npm 使用 registry.npmmirror.com，Playwright 浏览器通过 cdn.npmmirror.com 下载；Docker Hub 镜像经 aliyun 镜像返回 403 |
| Git | 当前工作目录不是 Git 仓库（`git status` → `fatal: not a git repository`），因此无法执行提交/干净度检查 |
| 真实学习通页面 | 未提供 DOM 证据；无真实账号 |
| 真实 AI 供应商 | 未提供 API Key；测试仅使用本地伪后端 |

## 2 Verified（实际执行）

### V1 Fixture 自身行为（Playwright，无扩展）

```powershell
npx playwright test -c tests/fixtures/playwright.config.ts
```

- 结果：**22 passed（10.9s）**，退出码 0（2026-10-18 23:20 左右）。
- 覆盖：10 个 fixture 的元数据/只读计数/重置按钮/无外网请求、practice 5 容器与零提交零网络、no-paste 阻止粘贴仍可控件写入、selection-disabled 空 Selection、controlled-input 受控回弹（blank_2 恢复初始值）、readonly 属性保持、autosubmit 副作用存在性、iframe 同源可访问与 sandbox 无权限框架不可访问、changed-question 延迟变化、graded 计分页 + 模拟提交只计数、prompt-injection 金丝雀未执行 + 未知编辑器结构。
- 证据：`tests/fixtures/behavior.spec.ts`、`tests/fixtures/playwright.config.ts`、`tests/fixtures/README.md`。
- 限制：仅证明合成 Fixture 行为，不代表真实学习通页面兼容。

### V2 OpenAPI ↔ TypeScript 契约校验脚本

```powershell
node scripts/verify-contracts.mjs
```

- 结果：**PASS**，退出码 0（2026-10-18 23:24）。
  ```text
  endpoints : expected=20 found=20
  errorCodes: expected=25 found=25 (extraction=ErrorCode-schema)
  properties: interfaces=27 openapiProperties=89
  RESULT: PASS
  ```
- 检查内容：docs/architecture.md §12.2 的 20 个端点全部存在；`packages/contracts` 的 25 个错误码与 openapi `ErrorCode` 枚举一致；27 个契约接口的字段在 openapi schema properties 中出现；额外端点仅产生警告，但路径含 submit/fill/grade/progress 关键字时直接报错。
- 限制：这是“一致性/存在性”校验，不校验 JSON Schema 语义、`$ref` 完整性或 OpenAPI 规范合法性（未引入 YAML/Schema 校验依赖）。Java DTO 未在此校验范围内。
- 证据：`scripts/verify-contracts.mjs`、`docs/openapi.yaml`、`packages/contracts/src/errors.ts`。

### V3 契约测试 + 控制台跨端契约/打包测试（node:test）

```powershell
node --test tests/contracts/verify-contracts.test.mjs tests/console/console-contract.test.mjs tests/console/package-console.test.mjs
```

- 结果：**19 pass / 0 fail / 0 skipped**，退出码 0（openapi.yaml 出现后重跑；此前 openapi 缺失时“实际仓库一致”一项为 skip）。
- 覆盖：校验脚本的正/反例（缺失端点、禁止端点、错误码多余/缺失、字段缺失、文件缺失、引号路径）、真实仓库契约、控制台 API 路径 ⊆ §12.2 端点、console 不调用 study/fill/submit 路径、console 无 cookie/localStorage token/v-html、console 依赖 @study/contracts 并设置 `credentials: "omit"`、tar 结构、tar.gz 确定性哈希、缺失 dist 明确失败、实际 `apps/console/dist` 可打包。
- 证据：`tests/contracts/verify-contracts.test.mjs`、`tests/console/console-contract.test.mjs`、`tests/console/package-console.test.mjs`。

### V4 控制台产物打包

```powershell
node scripts/package-console.mjs --version 0.1.0
```

- 结果：**PASS**，退出码 0。
  ```text
  archive : infra/artifacts/console-0.1.0.tar.gz
  files   : 3 (147813 bytes uncompressed)
  sha256  : 81acf53f5940409916361206ca07f0ca1b0315623c4b401648ada423ba805b79
  manifest: infra/artifacts/console-0.1.0.tar.gz.manifest.json
  ```
- 证据：`scripts/package-console.mjs`、`infra/artifacts/`（`.gitignore` 忽略产物）。

### V5 Docker Compose 配置解析

```powershell
docker compose -f infra/compose.local.yaml config --quiet        # exit 0
# 需注入示例环境变量：
$env:BACKEND_IMAGE='example.invalid/study@sha256:0...'
$env:APP_DOMAIN='study.example.invalid'; $env:ACME_EMAIL='ops@example.invalid'
docker compose -f infra/compose.prod.yaml config --quiet         # exit 0
```

- 结果：两个文件均解析成功（退出码 0，2026-10-18 23:26）。
- 覆盖：local 为 postgres:17-alpine + 后端构建 + 健康检查 + 命名卷 + 非 root/只读/secret 文件；prod 为 PostgreSQL 无公网端口 + 后端 + Caddy + internal/edge 网络 + secret 文件 + 双健康检查依赖。
- 限制：实际 `up` 与镜像构建未执行（见 U3/U4）。

### V6 Playwright 浏览器安装

```powershell
$env:PLAYWRIGHT_DOWNLOAD_HOST='https://cdn.npmmirror.com/binaries/playwright'
npx playwright install chromium
```

- 结果：退出码 0；下载并安装 Chrome Headless Shell 156.0.8078.4（chromium-headless-shell v1248）与 winldd v1007。
- 限制：通过第三方镜像下载；CI 应固定镜像或使用缓存。

### V7 扩展真实 MV3 集成测试（Playwright persistent context）

```powershell
node scripts/build-extension.mjs     # 由 extension-dev 产出 apps/extension/dist
npx playwright test -c tests/extension/playwright.config.ts
```

- 结果：**12 passed（14.4s）**，退出码 0（2026-10-18 23:29 左右，8080 端口独占）。
- 方法：真实加载 `apps/extension/dist` 的 MV3 扩展（persistent context，未使用页面内等价脚本）；本地伪后端在扩展构建的 `http://127.0.0.1:8080` 上同时提供 fixture 静态页与契约端点（login/me/provider-profiles/study-answers），记录所有请求；扩展适配器为 `fixture.practice v1.0.0`。
- 覆盖与断言：
  1. manifest 权限恰为 `activeTab/scripting/storage/sidePanel`，无 cookies/webRequest/debugger/unlimitedStorage，host_permissions 仅为本地后端，CSP 无 unsafe-eval/inline、无 externally_connectable。
  2. practice：多题候选列表 5 项；采集后 **零后端请求**、页面计数器全 0、无勾选；点击发送后才产生 1 次 `POST /study/answers`。
  3. graded：`PAGE_KIND_UNSUPPORTED`，零请求、零写入、零 submit。
  4. autosubmit：`EVENT_SIDE_EFFECT_UNVERIFIED` 阻止回填，页面 `data-auto-submit-triggered` 未出现，计数器全 0。
  5. readonly：`FIELD_READ_ONLY`，readonly/disabled 属性与值保持，零写入。
  6. changed-question：题目变化后 `QUESTION_CHANGED`，零写入。
  7. controlled-input：`PARTIAL_FILL` + `VALUE_REVERTED`，blank_1 成功写入、blank_2 回弹初始值，无 submit/fetch/xhr。
  8. no-paste：控件写入成功 `FILLED`，paste 计数 0。
  9. selection-disabled：Selection 为空仍完成 `FILLED`，copy 计数 0。
  10. iframe-question：同源 frame 采集/回填 `FILLED`，frame 计数器更新；sandbox 无权限 frame 仍不可访问。
  11. prompt-injection：注入文本按纯文本出现在发送预览、`window.__injectionExecuted=false`、无 script 节点；未知 contenteditable 报 `CONTROL_UNSUPPORTED` 且内容未改。
  12. 关闭侧边栏后重开：不恢复题文/答案（无 question-preview/answer-section）。
- 证据：`tests/extension/harness.ts`、`tests/extension/extension.spec.ts`、`tests/extension/playwright.config.ts`。
- 限制：伪后端不是真实后端；扩展登录/生成链路未经真实服务端与真实供应商验证；未验证真实学习通页面。

## 3 Static analysis（已阅读/静态核对，未执行对应真实链路）

| 检查 | 结论 | 依据 |
|---|---|---|
| 规格与硬性约束 | 已完整阅读 architecture.md（2505 行）、adaptation 规格、实施提示词、AGENTS.md，并据此实现 | 文档 |
| Fixture DOM 契约与扩展适配器一致 | 适配器读取 `data-fixture/data-page-kind/data-question-container/data-question-stem/data-option(+id)/data-blank-id/data-events-side-effect/data-unknown-editor`、`window.__counters`；fixture 按此生成 | `apps/extension/src/page/practice-fixture.ts` 与 `tests/fixtures/README.md` 交叉核对 |
| 扩展禁用提交 | 页面脚本只 preventDefault + 计数；扩展集成测试断言 submit 计数 0、无相应请求；适配器 apply 只写字段并回读 | 代码 + V7 |
| Infra 非 root / Secret 文件 | Dockerfile 使用 uid/gid 10001、只读根文件系统、`cap_drop: ALL`、`no-new-privileges`；compose 以 `/run/secrets` 文件注入主密钥与 HMAC | `infra/` |
| Infra 与后端配置对接 | compose 使用 `DB_URL/DB_USERNAME/DB_PASSWORD_FILE/APP_ENCRYPTION_KEY_FILE/APP_REQUEST_HMAC_KEY_FILE` 等约定；**未与 backend 实际 `application.yml` 逐项核对** | `infra/compose.*.yaml` |
| 隐私声明与 §1.3 一致 | 明确非零知识、供应商/网关是处理方、默认不落库、可自托管、日志与保留限制 | `docs/privacy.md` |

## 4 Unverified（未执行或因环境/资料受限）

| 编号 | 项 | 原因 / 证据 | 下一步 |
|---|---|---|---|
| U1 | 真实学习通页面采集与回填 | 无脱敏 DOM 证据、无测试账号；按 AGENTS.md 不得编造选择器 | 获取脱敏 DOM 后按 adaptation §8 记录到 docs/compatibility.md |
| U2 | 真实 AI 供应商调用/连接测试 | 无 API Key；测试使用伪后端 | 用户显式输入虚拟/真实 Key 后按 §10.6 手工联调 |
| U3 | 后端 Maven 构建与测试（`mvn verify`）、Flyway 迁移 | 不属于本任务范围；本次未执行 | backend-dev/Lead 执行并记录 |
| U4 | Docker 镜像构建 | `docker build` 失败：dockerfile 前端镜像与基础镜像拉取返回 403（aliyun 镜像拒绝） | 配置可用镜像仓库后重试：`docker build -f infra/Dockerfile -t study-assistant-backend:verify .` |
| U5 | `docker compose up` 实际启动与健康检查 | 需先完成 U4 并准备 secrets/环境变量；未启动 | 按 infra/secrets/README.md 生成密钥后 `docker compose -f infra/compose.local.yaml up -d --build` |
| U6 | Caddyfile 语法/运行时 TLS 校验 | `caddy:2.9-alpine` 镜像拉取 403，无法运行 `caddy validate`；未签发证书 | 有镜像后 `caddy validate --config infra/Caddyfile --adapter caddyfile` 并做 TLS 演练 |
| U7 | 根 `npm run typecheck/build/test` 全仓结果 | 由 Lead/各 owner 执行；本任务仅实际执行上述定向命令（未运行全仓命令） | Lead 统一收口时执行并记录 |
| U8 | Java DTO ↔ OpenAPI 字段一致性 | verify-contracts 只校验 TS 契约与 openapi；Java DTO 未解析 | backend-dev 提供 DTO 或补契约测试 |
| U9 | 日志不含题文/答案/密钥的运行时验证 | 未运行真实后端与日志搜索 | 用标记题文/虚拟密钥跑隐私测试（architecture §21.1） |
| U10 | 两用户隔离、密钥明文落库、SSRF、幂等/限流 | 后端未在本任务中运行/测试 | backend-dev 的 JUnit/Testcontainers 测试 |
| U11 | 性能目标（p95、内存、RSS） | 未测量 | 按 §21.4 在 2 vCPU/2 GiB 参考机测量 |
| U12 | Git 干净度/提交 | 工作目录不是 Git 仓库 | 初始化仓库后检查 `git status` |
| U13 | 真实浏览器加载真实学习通页面的手工验收 | 无账号/资料 | P5 阶段人工验证 |

## 5 Definition of Done（architecture.md §23）逐项状态

| 完成标准 | 状态 | 证据/说明 |
|---|---|---|
| 本地数据库与后端可按 README 启动 | Unverified | U3/U5 |
| 前端和扩展可构建 | Static analysis（产物被实际使用） | console dist 被 V4 打包；extension dist 被 V7 真实加载；构建命令由对应 owner 执行 |
| OpenAPI、Java DTO、TS 类型一致 | TS/openapi Verified；Java DTO Unverified | V2、U8 |
| 邀请注册与登录可运行 | Unverified | 后端未在本任务运行；扩展登录仅对伪后端验证（V7） |
| 退出、改密、删除账号能撤销会话 | Unverified | U3 |
| 两用户隔离测试通过 | Unverified | U10 |
| API Key 不以明文落库 | Unverified | U10 |
| 主密钥不在代码、镜像、日志或普通环境文件 | Static analysis | infra 设计与 docs；未做镜像/日志实测（U4/U9） |
| 修改 Base URL 会清除旧密钥 | Unverified | 需后端测试 |
| 动态配置保存后下一次请求生效 | Unverified | 需后端测试 |
| 两种协议都有独立构造与解析测试 | Unverified | 需后端测试 |
| 不支持的参数被省略 | Unverified | 需后端测试 |
| 无效输出不进入回填 | Static analysis | 代码路径存在，但未构造供应商无效输出做整链测试 |
| 插件是核心客户端，主流程不依赖复制/粘贴 | Verified（合成 Fixture） | V7 practice/no-paste/selection-disabled |
| 禁止粘贴与禁止选中的合成页面通过浏览器验收 | Verified | V1、V7 |
| 控件写入后回读，受控组件回弹不误报成功 | Verified | V1、V7 controlled-input |
| readonly、disabled、可信事件限制和未知编辑器正确报告 | 部分 Verified | readonly/unknown/autosubmit 已测（V7）；“只接受 isTrusted 事件”未合成测试 |
| 采集不会自动发送 | Verified | V7 practice（零请求） |
| 发送前展示精确内容与供应商 | Verified（扩展 UI） | V7 send-preview/provider-summary；真实供应商域名未测 |
| 题文和答案默认不落库 | Static analysis | 文档与设计；后端运行时未验证（U9） |
| 日志没有题文、密钥、Cookie | Unverified | U9 |
| 回填需要单次明确审核 | Verified | V7 approve-fill 仅在审核计划后出现；单次 nonce 由代码/测试覆盖 |
| 页面、题目或配置变化后拒绝旧回填 | 页面/题目变化 Verified；配置变化 Unverified | V7 changed-question；配置版本变化需后端+扩展联调 |
| 没有自动提交和进度伪造代码 | Static analysis | 本任务代码与 fixture 未调用 form.submit/requestSubmit；全仓静态扫描未发现（测试页仅计数模拟） |
| 幂等和超时不会静默重复付费调用 | Unverified | U10 |
| SSRF 防护通过连接阶段测试 | Unverified | U10 |
| 导出不包含可恢复密钥或认证材料 | Unverified | U3/U10 |
| 备份恢复会重新应用账号删除 | Unverified | U5/U10 |
| 真实供应商联调有单独记录 | Unverified | U2 |
| 真实学习通适配有样例和验证证据 | Unverified | U1 |
| 未完成项目明确列为 Unverified | Verified | 本文件 |

## 6 分阶段验收（architecture.md §21.2）

| 阶段 | 状态 | 说明 |
|---|---|---|
| P0 契约与骨架 | 部分 Verified | 目标目录、openapi、contracts 存在；契约校验 PASS（V2/V3）。新环境启动数据库/后端 Unverified（U3/U5） |
| P1 账号与配置 | Unverified | 依赖后端测试（U3/U10） |
| P2 AI 调用 | Unverified | 仅伪后端；真实供应商与协议测试未执行（U2） |
| P3 学习闭环 | Verified（合成 Fixture） | V1/V7：采集→预览→显式发送→解析→审核；真实页面 Unverified |
| P4 受控回填 | Verified（合成 Fixture） | V1/V7：非剪贴板写入、回读、变化拒绝、部分填写、readonly/计分拒绝 |
| P5 真实页面适配 | Unverified | U1 |
| P6 部署 | Unverified | U4/U5/U6 |

## 7 复现命令汇总

```powershell
# Fixture 行为
npx playwright test -c tests/fixtures/playwright.config.ts

# 契约一致性（需 docs/openapi.yaml）
node scripts/verify-contracts.mjs

# 契约/控制台测试
node --test tests/contracts/verify-contracts.test.mjs tests/console/console-contract.test.mjs tests/console/package-console.test.mjs

# 控制台打包
node scripts/package-console.mjs --version 0.1.0

# 扩展集成（需 apps/extension/dist 与空闲的 127.0.0.1:8080）
npx playwright test -c tests/extension/playwright.config.ts

# Compose 语法
docker compose -f infra/compose.local.yaml config --quiet
docker compose -f infra/compose.prod.yaml config --quiet   # 需 BACKEND_IMAGE/APP_DOMAIN/ACME_EMAIL
```

## 8 已知限制与待办（按优先级）

1. **真实学习通适配（P5）**：必须先获得脱敏 DOM 证据，按 adaptation §8 记录，不得凭记忆写选择器。
2. **后端与部署链路（P1/P2/P6）**：`mvn verify`、真实 PostgreSQL、Docker 镜像构建、compose up、Caddy TLS 均未验证；镜像仓库需可用。
3. **Java DTO ↔ OpenAPI 一致性**：需补充跨语言契约校验或由 backend-dev 记录。
4. **可信事件页面**：fixture 未模拟“只接受 isTrusted 事件”的站点；若真实页面如此，扩展必须报 UNTRUSTED_EVENT_REJECTED（当前代码路径存在，但无合成验收）。
5. **真实供应商与费用控制**：需在用户显式确认后单独联调，默认测试不得产生费用。
6. **全仓 typecheck/build/test**：由 Lead 统一执行并在本文件补记结果。

> 本报告不宣称任何未执行项“通过”。未在“2 Verified”中列出的检查一律为 Static analysis 或 Unverified。

---

## 9 Lead 独立复核（2026-10-19 上午）

环境：Windows 11；Node 22.22.2；Java 21.0.10；Maven 3.9.12；Docker 29.5.3（本轮启动 daemon）。
网络：npmjs / Maven Central / Docker Hub 直连不可达；npm 走 npmmirror、Maven 走 aliyun、
Docker 走 aliyun 镜像（大镜像 blob 仍 403/EOF）。

### 9.1 新增 Verified

| 编号 | 检查 | 命令 | 真实结果 |
|---|---|---|---|
| V8 | 后端完整构建与测试（含真实 PostgreSQL 17 + Flyway） | `mvn -f backend/pom.xml -B verify` | `Tests run: 66, Failures: 0, Errors: 0, Skipped: 0`，BUILD SUCCESS，产出 `study-assistant-backend-0.1.0.jar` |
| V9 | 全仓类型检查 | `npm run typecheck` | contracts / ui / console / extension 四个 workspace 全部 exit 0 |
| V10 | 全仓单元测试 | `npm run test` | ui 23 + console 55 + extension 97 = **175 passed，0 failed** |
| V11 | 全仓构建 | `npm run build` | console dist（js 129.42 kB / css 9.45 kB）与 extension dist（manifest/background/page/sidepanel/options）全部产出 |
| V12 | 契约一致性 | `node scripts/verify-contracts.mjs` | PASS：endpoints 20/20、errorCodes 25/25、interfaces 27 / properties 89 |
| V13 | Fixture Playwright | `npm run test:fixtures` | **22 passed (11.6s)** |
| V14 | 扩展真实 MV3 集成 | `npm run test:e2e` | **12 passed (19.4s)**（真实加载 dist 扩展 + 同源伪后端） |
| V15 | 真实进程端到端（真实 PostgreSQL + 真实 jar + 本地伪上游） | `node scripts/local-e2e.mjs` | **47/47 断言通过**（详见 9.2） |
| V16 | 后端运维命令可用性 | `init-secrets` / `create-invite` | 生成密钥文件与一次性邀请码后**退出码 0**（此前的挂起问题已修复） |
| V17 | 运行期日志隐私抽查 | 读取后端运行日志 | 不包含题文（"1 + 1" 未出现）、不包含 API Key 明文 |
| V18 | Testcontainers 真实执行 | `PostgresIntegrationTest` | 4/4 执行（此前因无 Docker daemon 被跳过）：迁移/约束、双用户隔离、Base URL 清密钥、幂等、用量聚合 |

### 9.2 端到端断言清单（V15，47 项）

健康与身份：`/meta` 200；注册 201（邀请码一次性，重复使用被拒）；登录 201 且为不透明 Token；
`/me` 200；改密后旧 Token 401，其他会话不受影响；登出后 Token 401。

配置与密钥：`/provider-catalog` 含本地伪上游；创建配置 201 + `ETag: "1"`；未知字段 400；
缺 `If-Match` 428；保存密钥后版本 +1 且 `hasKey=true`；响应不含密钥；陈旧 `If-Match` 412；
Base URL 变更后同事务清密钥与验证状态、版本 +1；变更后 probe 被拒 409。

生成与协议：未验证配置答题 409；probe 200 VERIFIED 且**不增加版本**；Chat Completions 答题 200
（结构完整、usage 200 tokens、`promptVersion=study-v1`）；Responses 配置 probe 与答题均 200；
伪上游计数证明两种适配器都真实发起了调用；幂等重放 409 `DUPLICATE_COMPLETED_NO_REPLAY`。

安全与错误映射：上游 401 → 502 `UPSTREAM_AUTH_FAILED`（绝不映射为本产品 401）；
不可解析的模型输出 → 502 `UPSTREAM_INVALID_OUTPUT`；跨用户读/删配置 404；不能把他人的配置设为默认；
probe 超过每分钟限额 → 429 `USER_RATE_LIMITED`。

账号数据：用量聚合 200 且不含题文；导出 200 且不含密文/Nonce/Token 散列；
`/me` 默认配置正确回显。

### 9.3 本轮修复的真实缺陷（均由端到端测试暴露）

1. **Flyway 迁移未执行**：Spring Boot 4 将自动配置拆到 `spring-boot-starter-flyway`，仅有
   `flyway-core` 时应用可启动但建表不执行。已在 `backend/pom.xml` 补该 starter。
2. **`/me/usage` 与 `/me/export` 500**：PostgreSQL `SUM(bigint)` 返回 `numeric`，仓库层
   `(Long) rs.getObject(...)` 抛 `ClassCastException`。已改为 `getBigDecimal` 读取并补回归测试
   `usageAggregatesSucceededReceiptsWithoutCastingErrors`。
3. **运维命令不退出**：`init-secrets`/`create-invite` 执行完 JVM 不退出（非守护线程），
   脚本读 stdout 会永久挂起。已在命令完成后显式退出。
4. **Maven Wrapper 404**：`distributionUrl` 指向不存在的 `apache-maven-3-bin.zip`，
   已改为 aliyun 上的 3.9.12 发行包并实测 `mvnw -v` 可用。
5. **`PostgresIntegrationTest` 两处断言行与迁移约束不一致**（构造行违反验证一致性约束；
   重复幂等键断言前缺少首次插入），已修正为符合真实迁移契约的写法。

### 9.4 状态更新

| 原编号 | 原状态 | 现状态 |
|---|---|---|
| U3 后端 Maven 构建/测试、Flyway | Unverified | **Verified（V8/V18）** |
| U7 根 typecheck/build/test | Unverified | **Verified（V9/V10/V11）** |
| U8 Java DTO ↔ OpenAPI | 未校验 | 仍为 **Unverified**（`OpenApiContractTest` 只校验端点与错误码存在性；字段级跨语言校验未实现） |
| U9 日志不含题文/密钥 | Unverified | **Verified（V17，日志抽查；非全量形式化验证）** |
| U10 双用户隔离、密钥明文、SSRF、幂等/限流 | Unverified | **Verified（V8 集成测试 + V15 端到端）** |
| U4 Docker 镜像构建 | 403 | 仍 **Unverified**：daocloud 大镜像 blob 返回 EOF，1panel/aliyun 镜像不可解析；`infra/Dockerfile` 新增可选 `MAVEN_MIRROR_URL` 构建参数以便受限网络构建 |
| U5 compose up | 未执行 | 仍 **Unverified**（依赖 U4） |
| U6 Caddy validate | 403 | 仍 **Unverified**（镜像不可得） |

P0 契约与骨架、P1 账号与配置、P2 AI 调用（伪上游）在本轮升级为 **Verified**；
P3/P4 维持「合成 Fixture Verified」；P5 真实页面与 P6 部署仍为 Unverified。

### 9.6 真实环境阶段 A（2026-10-19，真实浏览器 + 真实学习通域名）

| 编号 | 检查 | 命令/方式 | 结果 |
|---|---|---|---|
| V19 | 未打包 MV3 扩展在真实浏览器加载 | `node scripts/real-chrome-smoke.mjs --headful` | ✅ `extensionLoaded=true`；侧边栏可信页面正常渲染 |
| V20 | 真实学习通域名访问 | 同上（打开 `https://i.chaoxing.com`） | ✅ 跳转登录墙 `passport2.chaoxing.com`，25+ 学习通资源请求正常 |
| V21 | 真实页面「读取当前题目」安全失败 | 同上（本产品自有测试账号登录后点击） | ✅ 错误码 **`FRAME_ACCESS_DENIED`**，未绕过 activeTab 授权 |
| V22 | 真实域名下出站与写入审计 | 同上（记录全部请求） | ✅ 仅学习通域名 + 本产品后端 + 扩展自身；`/study/answers` 请求 **0**；控制台错误 **0** |

说明：品牌版 Google Chrome 155 已移除 `--load-extension`，自动化改用 Playwright 自带 Chromium
（同引擎）；品牌版 Chrome 需人工「加载已解压的扩展程序」。账号级（登录你本人学习通账号并读取真实题目）
验证因依赖用户点击 activeTab 授权，必须人工执行，步骤见 `docs/real-env-audit.md` §8。

### 9.5 复现命令

```powershell
npm run typecheck; npm run test; npm run build
npm run test:fixtures; npm run test:e2e
node scripts/verify-contracts.mjs
mvn -f backend/pom.xml -B verify

# 端到端（需先按下述步骤启动 PostgreSQL、密钥、邀请码、伪上游与后端）
docker run -d --name study-e2e -e POSTGRES_DB=study_assistant -e POSTGRES_USER=study_assistant `
  -e POSTGRES_PASSWORD=study_pass -p 127.0.0.1:5433:5432 postgres:17-alpine
node scripts/local-mock-upstream.mjs                       # 另开窗口，监听 18080
# init-secrets / create-invite 见 backend/README.md
java -jar backend\target\study-assistant-backend-0.1.0.jar # PORT=8081 + LOCAL MOCK 环境变量
$env:BASE='http://127.0.0.1:8081/api/v1'; $env:INVITE_1='...'; $env:INVITE_2='...'
node scripts/local-e2e.mjs
```
### 9.7 真实计分页识别适配器（2026-10-19）

背景：用户在真实学习通「本章在线测验」页（37 题/总分 100.0）实测时得到 `FRAME_ACCESS_DENIED`，
随后选择「B：只做计分页识别与拒绝」。

| 编号 | 检查 | 方式 | 结果 |
|---|---|---|---|
| V23 | 计分页识别适配器单元测试 | `npm run test -w @study/extension` | ✅ 11 文件 / **103 项通过**（新增 6 项：计分页判定、宿主限制、单信号不误判、普通练习页不误判、采集/建计划被拒） |
| V24 | 扩展类型检查与构建 | `npm run typecheck -w @study/extension`、`node scripts/build-extension.mjs` | ✅ 通过，dist 重新产出 |
| V25 | 真实页面复验（用户手动） | 用户在 Chrome 重新加载扩展后，于该测验页点「读取当前题目」 | ⏳ 待用户执行；预期由 `FRAME_ACCESS_DENIED`/`ADAPTER_NOT_MATCHED` 变为 **`PAGE_KIND_UNSUPPORTED`** |

实现约束：适配器只在 `*.chaoxing.com` 生效，仅扫描顶层与可访问同源子框架中的短文本做关键词判定；
不保存、不上传任何页面文本；不采集题文；采集与回填入口均直接返回 `PAGE_KIND_UNSUPPORTED`。
即使关键词漏判，页面也只会退回 `ADAPTER_NOT_MATCHED`（同样拒绝回填），不存在"误判成可回填"的路径。

### 9.8 方案 C 与真实 DeepSeek 接入（2026-10-19）

**判定及批准**：用户报告按外部交接 §5.7 在目标页点击图标后立即读取，仍得到 `FRAME_ACCESS_DENIED`；随后显式批准“走 C，批准可选站点权限”。本次结果证明该次注入缺少有效权限，不能独立证实旧 panel behavior 为根因。修正旧文档“同源 SPA 导航即撤销 activeTab”的错误描述。

第 6 节同步清单全部对应如下：

| 项 | 文件与实现 |
|---|---|
| 1 manifest | `apps/extension/manifest.base.json` 仅声明 `https://*.chaoxing.com/*` 为可选；运行时仅请求用户确认的具体 HTTPS Origin |
| 2 构建断言 | `scripts/build-extension.mjs` 保持四个必选权限及后端 host 白名单，断言可选 host 的唯一范围，拒绝额外 optional API 权限 |
| 3 manifest 测试 | `apps/extension/tests/build-manifest.test.ts` 覆盖可选范围及篡改拒绝；真实 MV3 测试校验默认未授予 |
| 4 后台 | `apps/extension/src/background.ts` 加载/安装/启动重置 `openPanelOnActionClick=false`；仅明确 host 权限失败加 `permission: ` detail 标记；用户授权后由 UI 重新发起读取并经同一后台注入路径 |
| 5 侧边栏 | `App.vue`、`bridge.ts` 增加用户点击授权、站点核对、撤销说明、拒绝手工输入及授权后的读取重试；URL 不可见时要求输入，无额外 `tabs` 权限；切换目标后不沿用旧回填计划 |
| 6 故障码/消息 | 不新增本地码，仍为 14 个；更新 `shared/codes.ts` 的引导、`shared/messages.ts` 的权限失败判别函数和兼容 §5 的 detail 约定 |
| 7 四份文档 | `docs/architecture.md` §7.1、`docs/compatibility.md` §7、本文、`HANDOFF.md`；另同步外部交接、真实环境审计与 README |
| 8 测试路径 | 拒绝/异常→手工输入；授权→重新注入；授权后标签变化→停止；未知 URL→显式核对；未授权默认最小权限；计分页仍拒绝 |

**Verified（本轮实际执行）**：

| 检查 | 实际结果 |
|---|---|
| `npm run typecheck` | 四个 workspace 通过；新增测试后再次执行扩展 typecheck 通过 |
| `npm run test` 与新增测试后扩展复跑 | UI 23、控制台 55；扩展最终 **121 项 / 14 文件**通过（总计 199 项，根命令首次运行时扩展为 119 项，后追加 2 项再单独验证） |
| `npm run build` | 控制台与扩展构建成功；最终 `apps/extension/dist` 使用 `127.0.0.1:8080` |
| 真实 MV3 Chromium | **13/13 通过**，包括默认未授予可选站点权限、panel behavior=false、练习回填、计分页拒绝与零提交；使用独立 `18081` 伪后端及 `.local-demo/extension-e2e`，未占用演示后端 |
| `node --test tests/providers/configure-deepseek.test.mjs` | **5/5 通过**：仅 loopback 接收密钥、probe 成功才改默认、失败保留默认并退出会话、拒绝远程后端、先核对供应商目录 |
| `node scripts/verify-contracts.mjs` | PASS（20/20 端点、25/25 错误码；不能替代完整 schema 校验） |
| `mvn -f backend/pom.xml -B -DskipTests package` | 成功构建可运行 jar；此命令跳过测试，不作为后端全测试通过证据 |
| 真实供应商 probe | 从 Windows 用户环境读取 `DEEPSEEK_API_KEY`，运行 `scripts/configure-deepseek.mjs --probe`；官方 `https://api.deepseek.com`，`CHAT_COMPLETIONS`、`deepseek-flash`、`JSON_OBJECT`；返回 **VERIFIED**，已为演示账号设为默认 |
| 本机运行状态 | 更新后的后端已在 `8080` 重启；原伪上游 `18080` 与 PostgreSQL `study-demo` 未停止；不在文档保存任何实际密钥 |

**未通过的完整后端检查**：`mvn -f backend/pom.xml -B verify` 运行 66 项，其中 62 项通过，`OutboundHttpClientTest` 的 4 项在创建 JDK `HttpServer` 时发生 `Unable to establish loopback connection` / `UnixDomainSockets.connect: Invalid argument`，不是业务断言失败。改测试临时目录或显式选择 WindowsSelectorProvider 后仍重现；未修改出站策略或放宽测试。当前不能声称后端完整 verify 通过。报告位于 `backend/target/surefire-reports`。

**Static analysis**：既有密钥 API 保持 AES-GCM 加密；配置脚本不打印密钥，不向任意远端上传本产品登录凭据；未修改页面写入器或计分页拒绝策略。

**Unverified / 未实现**：用户品牌版 Chrome 的真实授权弹窗与当前测验页需重新加载扩展后复验；当前预计返回 `PAGE_KIND_UNSUPPORTED`，不能冒充已经实测。真实可回填练习页、自动播放课程与本地无人值守调度未实现，仍缺真实练习 DOM/事件证据。可选站点权限本身不会增加真实回填适配器；计分页只识别、不采集题文、不回填、不提交。

### 9.9 用户授权的课程自动运行模式（2026-10-19，覆盖上一节“未实现”的后续状态）

用户明确要求“回填提交并进入下一个任务；视频正常播放；不占用鼠标”，再次确认后要求执行。已增加独立 `runner.html` 运行页、绑定标签的状态机、固定消息协议、同源课程适配、题目字体/图像渲染、多模态供应商输入、回填回读、一次提交及确认、站点完成后下一任务、视频正常播放/暂停与开始/暂停/停止控件。原手动模式保留原有计分页拒绝。

真实页面只读观察和完整脱敏结构见 [course-automation.md](course-automation.md)。本轮没有向真实测验提交答案，不把合成测试算作真实任务完成。

| 类别 | 实际验证 |
|---|---|
| Verified：类型 | 全仓四个 workspace typecheck 通过；最后清理后再次执行扩展 typecheck 通过 |
| Verified：扩展测试 | 17 文件 / **136 项通过**，含 9 项调度器、5 项课程适配、1 项指令校验及原有回归；后台测试新增仅可信 runner 可发自动化指令的断言 |
| Verified：真实 MV3 合成浏览器 | **14/14 通过**；新增课程调度案例在其他标签处于前台时完成图像请求、回填回读、单次提交、站点确认及下一任务 |
| Verified：混合题型合成案例 | 随后将该浏览器案例扩展为单选、iframe 富文本填空、iframe 富文本简答，单独复跑 **1/1 通过**；3 次图像请求、提交/确认/下一任务各 1 次 |
| Verified：后端 | `mvn -f backend/pom.xml -B '-Dtest=*,!OutboundHttpClientTest' test` → **64 项通过**（含真实 PostgreSQL/Flyway、图像验证和多模态请求）；该命令明确排除上节 Windows loopback 初始化失败的 4 项，不能称完整 verify 通过 |
| Verified：契约 | OpenAPI ↔ TypeScript：20/20 端点、25/25 错误码，90 个属性存在性检查 PASS；新图像字段 Java DTO、TS 与 OpenAPI 已同步 |
| Verified：构建/运行 | 后端重新打包并在原 `8080` 重启；`/meta` 返回 maxRequestBytes=524288；扩展最终产物使用 `8080`，可加载 `runner.html` 与固定 `page/automation-entry.js` |
| Verified：真实模型视觉 | 经更新后的本地后端向真实 `deepseek-flash` 发送无个人信息的合成算术图像，返回 ANSWERED、正确选项、0 caveats；不等于真实测验答案已经可靠或已提交 |
| Verified：日志抽查 | 本轮后端日志未发现合成题目文本或 `data:image/` 内容；仅为本轮样本，不宣称形式化全量证明 |
| Static analysis | 页面代码无系统鼠标/键盘控制、无 seek/播放速度/进度修改；只操作固定 DOM 控件和标准媒体播放；题目图像与答案保持内存处理，不新增数据库保存 |
| Unverified：真实课程运行 | 用户已确认重新加载并打开调度页，随后报告 `unsupported page command type` 与旧手动模式提示。已定位为手动页面监听器抢答自动化消息；当前连接安全策略拒绝观察 `chrome-extension:` 页面，未绕过该限制。修复后的真实自定义字体图像、跨域题图 CORS、UEditor 同步、站点提交结果、真实视频后台播放仍待验收 |

正式考试、未知任务、无法读取的题图、模型需要上下文或有不确定项、页面要求验证码、未确认完成的提交不会继续。验证码/站点校验未通过时可能先等待站点结果后超时停止。运行页关闭即停止后续动作；已发出的请求或提交不能撤回。未适配阅读/附件页面不会被静默跳过。

### 9.10 手动与自动消息监听器冲突修复（2026-10-19）

用户打开真实调度页后报告 `unsupported page command type` 和旧 Fixture-only 提示。根因是 `page/entry.ts` 手动监听器接收所有同扩展消息，把 `AUTOMATION_PAGE` 当作非法手动命令响应，抢占课程适配器的返回通道。已限制监听器只处理原有四种手动命令；仍校验发送者和命令内容，不增加权限。同步更新旧错误引导，区分手动入口与课程调度。

- **Verified**：扩展 typecheck、18 文件 / **137 项单元测试**通过；新增消息归属回归覆盖不响应自动化/未知消息、拒绝外部发送者、保留手动校验。
- **Verified**：真实 MV3 合成回归 **1/1 通过**（31.9 秒），先在同一文档执行手动读取以复现旧监听器驻留，再执行图像单选/富文本填空/简答，提交/确认/下一任务各 1 次；另一标签处于前台。模型使用伪后端。
- **Verified**：最终 `apps/extension/dist` 重新构建并使用原后端 `127.0.0.1:8080`；测试使用单独 `18081` 构建副本，未替换真实供应商。
- **Unverified**：浏览器连接明确拒绝观察 `chrome-extension:` 页面；没有通过其他工具绕过。用户需重新加载扩展、刷新课程标签清除旧监听器，关闭旧调度页并重新打开，再预览首题。真实课程尚无回填或提交成功证据。

### 9.11 三次采样、并行队列、FIFO 与任务监听（2026-10-19）

用户要求多次取样、并行取图/发送、FIFO 回填和本地“总监”定期监听视频。已实现三题滚动窗口、最多两路取图、遵守 `/meta` 的模型并发与滚动速率、每题 3 次有效答案多数投票（可选单次）、FIFO 回填回读、当前任务刷题按钮与连续任务按钮、答题心跳、视频停滞检测、任务循环检测及取消/排队收尾。没有增加权限、依赖、服务或 API 字段，也没有扩大后端调用额度。

| 类别 | 本轮证据 |
|---|---|
| 用户提供的真实页面证据 | 用户截图显示首题文字/选项图像可见、模型 VERIFIED、进度 5/37、完成任务 0、因不确定停止；不能由此推定前四题正确或真实提交已成功。没有将截图的题干或答案另存到文档 |
| Verified：类型与单元 | 扩展 typecheck 通过；20 文件 / **158 项通过**。包括逆序模型响应仍 FIFO、并发不超过 2、3 次多数及单次不确定恢复、无多数/非法答案阻止写入、滚动限流、停止取消队列/迟到答案、唤醒全部暂停者、监听发现任务变化、视频停滞/主动长暂停、循环任务、租约释放、富文本空格顺序及空白归一、队首错误立即展示而在途请求收尾 |
| Verified：完整 MV3 合成回归 | **15/15 通过（20.1 秒）**。前三题批量预览不调用答题 API；三种题型各 3 次（共 9 次），站点提交/确认/下一任务各 1 次；另一标签处于前台。当前任务单次模式仅 3 次请求，提交/确认各 1 次、下一任务 0 次 |
| Verified：本机额度 | 只读请求正在运行的 `/api/v1/meta`：并发 2、每分钟 10、每天 100。37 题三次采样需 111 次，超过每日总上限；界面显示这一估算。并行实现不会绕过服务端额度，也不能承诺无限收费调用 |
| Verified：构建 | 产物重新生成；最终 `apps/extension/dist` 指向原 `127.0.0.1:8080`。MV3 测试使用独立 `18081` 构建副本和伪后端，没有对真实供应商执行本轮批量测试 |
| Static analysis | 三题窗口与已完成 Promise 清理限制图像保留；后台监听不生成模型动作；固定控件、指纹、回读、单次提交与站点完成标记约束仍保留。浏览器后台节流可能影响 2.5 秒定时检查 |
| Unverified | 新版三次投票/FIFO 在用户真实课程的完成率、真实站点回填/提交、连续视频和跨任务推进仍未验收。当前连接的扩展 URL 访问限制仍在，未绕过；需用户重新加载构建并刷新课程页 |

完整浏览器检查初次运行发现旧手动计分页测试要求错误提示包含“计分”，而上一轮提示更新遗漏该关键词；已补全提示并重新跑完整 15 项通过。此为文案断言失败，没有掩盖回填或提交行为故障。最终租约释放、富文本规范化与错误立即展示补充后，定向复跑两个课程 MV3 案例 **2/2 通过（15.6 秒）**，最终类型与单元检查亦通过。
### 9.12 自动提交口径确认（2026-10-19 19:4x）

用户在确认文档冲突时答复「自动提交」，即：以 2026-10-19 授权的课程自动运行模式为准，
已适配章节任务允许自动提交；正式考试、未知任务、未适配页面仍然停止且不得提交。

**代码现状（已实现，非本轮新增）**

- `course-page.ts` 的 `SEND_WORK`：确认本任务全部题目均已回填并逐题回读一致后，才点击唯一的站点
  `a.btnSubmit`；同一任务只尝试一次（`sendAttempted`），不重复提交，也不调用 form.submit/requestSubmit/提交 API。
- `CONFIRM_WORK`：仅在 SEND 之后、且可见 `#confirmSubWin` 中唯一 `a.bluebtn` 文案匹配 OK/确定/确认提交 时点击一次。
- `runner.ts`：提交后每 1 秒检查任务完成标记，最多 60 秒；期间任务键变化、或超时仍未出现
  "任务点已完成" → 立即停止，不重复提交、不跳到下一任务。
- 正式考试：`inspect()` 对 `/exam`、`/examination` 路径直接拒绝；手动模式的计分页识别器仍返回
  `PAGE_KIND_UNSUPPORTED`。

**文档对齐（本轮修改）**

| 文件 | 修改 |
|---|---|
| `docs/architecture.md` §1.2 | 自动提交行改为「正式考试禁止；已适配章节任务在一次性授权与站点完成标记核验后允许」 |
| `docs/architecture.md` §23 | 验收项改为「正式考试无自动提交；课程任务只点站点按钮并以完成标记核验」 |
| `docs/architecture.md` §24.3/§24.4 | 测试断言与审查提示改为区分手动模式与课程自动运行模式 |
| `docs/xuexitong-extension-adaptation.md` | 第 10 行已有适用范围说明，无需再改 |
| 本文件 | 新增本节，作为口径落点 |

**Verified（本轮实际执行）**

| 检查 | 命令 | 结果 |
|---|---|---|
| 扩展类型检查 | `npm run typecheck -w @study/extension` | 通过 |
| 扩展测试 | `npm run test -w @study/extension` | **21 文件 / 178 项通过**（含提交一次性、未完成不跳转、回填回读不一致不提交） |
| 扩展构建 | `node scripts/build-extension.mjs` | 成功，含 `page/automation-entry.js` |

**仍未验证**

1. 真实学习通章节任务的提交结果、确认窗口与站点完成标记：只有合成 MV3 证据，真实账号未验收。
2. 自动提交一旦点击即不可撤回；平台若判定异常，责任与后果由账号持有者承担。
3. 视频自动播放受浏览器自动播放策略限制；被拒绝时只报错并要求人工点击，不绕过策略。

本节仅记录口径与实现事实，不宣称真实提交已经成功。
**2026-10-19 19:5x 追加：手动汇总的“再次并发请求”**

- runner.ts 新增 retryManual()：仅对可重试的未决题（非图片不可读）再并发 3 次，合并既有样本后用 choosePlurality 取命中最多者；
  要求命中 ≥ 2 且无并列，否则仍留人工；重试只回填、不提交。
- App.vue 增加按钮「再次并发请求（取命中最多的答案）」，不可重试项或非 NEEDS_INPUT 时禁用。
- consensus.ts 由 rankAnswers 复用校验逻辑，新增 choosePlurality；严格多数 chooseAnswer 行为不变。
- 实际执行：npm run typecheck -w @study/extension 通过；npm run test -w @study/extension → 21 文件 / 182 项通过；node scripts/build-extension.mjs 成功。
- 仍未验证：真实学习通汇总页的按钮交互与真实供应商下的多轮命中分布。
### 9.13 无限额 + 动态供应商与模型选择（2026-10-19 20:0x）

用户要求：后端取消调用限额（使用自己的 Key，费用自担）；支持动态填写供应商地址/协议/Key，并用 Key 拉取模型后选择；优化 UI。

**实现**

| 项 | 变更 |
|---|---|
| 限额 | `application.yml` 中 per-user-concurrency / requests-per-minute / requests-per-day / probes-per-minute 默认改为 0；`ReceiptService` 与 `StartupValidator` 把 0 解释为不限制；SaaS 模式仍要求正数 |
| 动态地址 | 新增 `app.providers.allow-arbitrary-https`（local 配置默认 true）；非目录地址必须是公网 HTTPS；SSRF/DNS/禁重定向策略不变 |
| 模型列表 | 新增 `GET /api/v1/provider-profiles/{id}/models`：用已存密文密钥请求 `{baseUrl}/models`，只返回模型 ID；OpenAPI、TS 契约、Java DTO 已同步 |
| 控制台 UI | 配置编辑页新增「从供应商获取模型」按钮与模型下拉（datalist），展示读取数量；新增次要按钮/行布局样式 |
| 扩展 | 限额 0 视为不限速；`/meta` 解析接受 0；无限额时不保留滚动窗口，避免长跑内存增长 |

**Verified（本轮实际执行）**

| 检查 | 结果 |
|---|---|
| `mvn -f backend/pom.xml -B verify` | **72 tests, 0 failures**，BUILD SUCCESS（含新 ProviderModelServiceTest、动态 HTTPS 校验） |
| `npm run test`（ui/console/extension） | ui 23 + console 55 + extension **183** 全部通过 |
| `node scripts/verify-contracts.mjs` | PASS：endpoints 21/21、errorCodes 25/25 |
| 真实供应商 `/models` | 使用演示账号 admin 已保存的 DeepSeek Key：`GET /provider-profiles/{id}/models` 返回 **deepseek-flash、deepseek-v4-pro**，耗时 448ms |
| `/meta` | perUserConcurrency=0、requestsPerMinute=0、requestsPerDay=0 |
| 构建 | 控制台与扩展 dist 均重新生成 |

**限制**

- 全局并发仍为 16（单实例内存保护），不是计费限制；SaaS 模式仍强制正数限额。
- 自动播放视频与自动提交的真实课程结果仍未验收（同 §9.9–§9.11）。
**2026-10-19 20:1x 追加：图片题检测、候选答案展示、最高票采用**

- 图片题判定：题干或选项内出现 img/canvas/svg、字体字形不可还原、题干为空或文本超限时走渲染图；选项文字全空不再单独强制附图（选项字母可能位于控件内），避免误判。
- 新增「所有题目都附带渲染图片」开关（runner 运行页），对应 CAPTURE 命令的可选 forceImage；默认仍为自动。
- 汇总表展示模型候选答案及票数，并支持「采用此答案」与「直接采用最高票答案」；补答后照常继续提交。
- 实际执行：extension typecheck 通过；21 文件 / 188 项测试通过；dist 重新构建。
**2026-10-19 20:1x 追加：多选选项兜底与坏题隔离**

- 真实多选页实测：源文字读取成功但选项未命中通用选择器，模型回答引用不存在的选项 ID → UPSTREAM_INVALID_OUTPUT，旧行为整轮中止。
- 已增加选项行兜底选择器；仍无选项的选择/判断题不调用模型、转人工；单题级无效输出不再终止整轮。
- 实际执行：extension typecheck 通过；21 文件 / 190 项测试通过；dist 重新构建。
- 未验证：该皮肤在真实页面上的选项读取与回填结果（需重新加载扩展后复跑）。
**2026-10-19 20:1x 追加：默认全图 + 选项字母映射**

- 「所有题目都附带渲染图片」改为默认开启（用户要求不再依赖文字提取）。
- 选项行无 `.num_option` 时按 li 行读取，并以行内字母 A/B/C 映射 opt_*；回读按字母匹配隐藏输入。
- 实际执行：extension typecheck 通过；21 文件 / 191 项测试通过；dist 重新构建。
- 未验证：真实多选页在默认全图模式下的作答与回填（需重新加载扩展后复跑）。
**2026-10-19 20:2x 追加：标准 radio/checkbox 测验皮肤**

- 真实页面（机器学习章节测验）实测：选项为真实 radio/checkbox，写入后旧回读读不到状态 → “页面没有保留回填结果，已停止”。
- 已改为按 input.checked / aria-checked / checked class 回读，并点击内部 input/label；老隐藏 answer 布局仍兼容。
- 实际执行：extension typecheck 通过；21 文件 / 193 项测试通过；dist 重新构建。

**2026-10-19 20:3x 追加：Submit 按钮、自动切换、刷题跳过视频**

- 真实章节测验皮肤使用 `button` 文本 Submit，旧只找 `a.btnSubmit` 会失败；已加按文本唯一匹配的兜底，Save 不匹配。
- 提交后站点自动切换任务：runner 识别任务键变化为成功推进，跳过 Next 点击；新增回归测试（不点 NEXT、连续完成 ≥2 个任务）。
- 刷题模式改为连续完成任务点并跳过视频（不调用 PLAY、直接 NEXT）；刷课模式保持播放视频。
- 实际执行：extension typecheck 通过；21 文件 / 196 项测试通过；dist 重新构建。
**2026-10-19 20:4x 追加：填完后停在提交阶段**

- 提交按钮改为跨全部同源文档查找并去重；失败详情包含候选数与文档数。
- 提交等待期间步骤栏显示剩余秒数；超时停止且不重复提交。
- 实际执行：extension typecheck 通过；21 文件 / 198 项测试通过；dist 重新构建。
**2026-10-19 20:5x 追加：回填点击、继续按钮、回读面板**

- 回填失效根因：选中判定曾把 active/on 等装饰 class 当作已选中，导致跳过真实点击；现只认 hidden 字母、input.checked、aria-checked/selected、checked/selected class，并为无原生 input 的选项行补发 pointerdown/mousedown/mouseup/click。
- 继续按钮：NEEDS_INPUT 下可点；有未决题时提示“还有 N 题待补答”，全部解决后继续调度（原先点击无任何反馈）。
- 模型原始回答改为可滚动小面板，避免长文本撑爆页面。
- 实际执行：extension typecheck 通过；21 文件 / 200 项测试通过；dist 重新构建。
**2026-10-19 20:5x 追加：不漏题（无多数时采用最高票）**

- 根因：三次采样无严格多数时旧逻辑只进人工清单，页面留空 → 用户看到漏题。
- 现改为：有有效候选即自动填最高票并显示一致度；无有效答案才转人工。
- 实际执行：extension typecheck 通过；21 文件 / 197 项测试通过；dist 重新构建。
**2026-10-19 21:0x 追加：题目 Markdown 化与一键复制**

- 侧边栏新增「复制题目 Markdown」「下载 .md」：把题型、题干、选项/空格转成可直接粘贴给其他 AI 的 Markdown。
- 导入模式（runner）人工卡片对图片题新增「复制题目图片」「下载图片」，用于图片无法自动识别的场景。
- 安全边界调整：剪贴板仅允许在可信扩展页（sidepanel/automation）由用户点击触发；页面脚本仍禁止 clipboard，静态测试已按此收窄。
- 实际执行：extension typecheck 通过；22 文件 / 200 项测试通过；dist 重新构建。
**2026-10-19 21:1x 追加：插件独立直连（无登录、无后端依赖）**

- 新增 `apps/extension/src/local/provider.ts`：本地供应商配置（预设/自定义、Key、协议、模型）、按域名申请可选站点权限、直连 chat/completions 与 responses、本地答案归一化与校验、`/models` 读取。
- 设置页重写为供应商管理（预设、Key、授权站点、读取模型、测试连接、默认供应商）。
- 侧边栏与课程调度页优先本地直连：有本地配置时不再显示登录、不请求后端；未配置时才回退旧后端模式。
- manifest 增加可选宿主权限 `https://*/*`、`http://127.0.0.1/*`、`http://localhost/*`，CSP `connect-src` 相应放开到 https 与回环；构建脚本断言同步更新。
- 实际执行：extension typecheck 通过；22 文件 / 200 项测试通过；dist 重新构建（manifest 含 optional_host_permissions）。
- 未验证：真实供应商 Key 下的直连请求（需在设置页由用户填写并授权域名）。
### 9.14 判断题回读修复、监控诊断与整轮中止修复（2026-10-19 21:2x–21:5x）

用户现场截图（真实课程，3 题任务）：运行页为 `ERROR · 已停止，需要人工处理`；待人工补答 2 题，均为**判断题**，原因是「页面没有保留回填结果（回读不一致）」；同时红色错误为「监听发现课程任务已变化，已取消未回填队列」。本轮调用 6 次（1+4+1）：说明「再次并发请求」在第一个被拒的 APPLY 处抛出，第二个待补答题没有获得重试机会。

**根因（代码审计；判断题隐藏值形态来自用户现场失败现象与既有真实 DOM 观察）**

| # | 现象 | 根因 |
|---|---|---|
| 1 | 判断题回填后必然「回读不一致」并转人工 | 学习通判断题的隐藏答案值是布尔语义（`true`/`false`、`对`/`错` 等），不是字母 `A`/`B`；旧 `optionSelected` 只把隐藏值与推导出的选项字母比对。页面上其实已选中，扩展永远读不到 → 误判失败。单选/字母皮肤正常，因此同一任务里出现「一题成功、两题失败」。 |
| 2 | 一题失败拖住整轮补答 | `retryManual` 未逐题隔离：第一题 APPLY 抛错就中断整轮，后面的待补答题不再重试，且第一题 reason 仍是旧文案，用户看不到真实原因。 |
| 3 | ERROR 原因笼统，且单次采样即判死 | 监控器只报「监听发现课程任务已变化」，不说明是任务标识、页面类型还是题数变化；且一次 2.5 秒采样发现差异就置 ERROR，站点重渲染/懒加载的瞬间变化可能被误判。 |
| 4 | 题型识别不到时整轮中止 | 题型标签只匹配少量中英文写法；识别为 UNKNOWN 时 `describe` 直接失败，整轮停止，用户无法在汇总里纠正题型后补答。 |

**修复内容**

- `course-page.ts` 回读：隐藏答案映射同时支持字母（`A`/`AB`）、布尔（`true`/`false`）、可见文本（`True`/`对`/`错`/`√`/`×`）与序号；选项身份取 `data`、字母、文本、布尔语义多个 token；歧义不猜测。
- 回填后**轮询回读最长 2.5 秒**（容忍站点异步写回与重渲染），必要时重新定位题目元素并补发一次点击/富文本写入；仍失败时错误信息带脱敏诊断：选项数、隐藏答案值形态（无/字母/布尔/数字/其他文本）、是否有原生选中控件、已识别选中数与期望数。
- 题型：标签匹配扩充（判断/对错/是非/True or False/T/F 等）；标签缺失时按控件结构推断（布尔文案优先，再 radio/checkbox）；仍无法识别则**不再中止整轮**，转人工汇总，用户在「题型纠正」中选择后补答；补答与写入时再按答案形态推断题型。
- 允许「ANSWERED 且带 caveats」的答案写入（与既有文档「带 caveats 仍参与回填」一致）；非 ANSWERED 仍拒绝。
- `runner.ts`：监控改为「首次差异 → 400ms 二次复核 → 仍差异才停止」，error 文案列出具体差异（任务标识/页面类型/题数）；`retryManual` 逐题 try/catch，单题被拒不中断其他题并更新 reason；`solveQuiz` 对 UNKNOWN 不调用模型直接转人工；`submitManual` 对 UNKNOWN 按答案形态推断题型。
- 未改变权限、额度、提交策略：正式考试仍拒绝；单次站点提交按钮、确认窗口、任务完成标记核验、提交前逐题回读一致均保留；默认全图模式、最高票回填、单次确定答案只调用一次的行为不变。

**Verified（本轮实际执行）**

| 检查 | 命令 | 结果 |
|---|---|---|
| 全 workspace 类型检查 | `npm run typecheck` | 4 个 workspace 通过 |
| 扩展单元/集成测试 | `npm run test -w @study/extension` | **22 文件 / 215 项通过**（基线 201；新增判断题 true/false 回读、延迟回读、重渲染、题型推断、脱敏诊断、监控双确认、补答单题容错、UNKNOWN 转人工等 14 项） |
| 扩展构建 | `node scripts/build-extension.mjs` | 成功；最终 `apps/extension/dist` 指向 `http://127.0.0.1:8080` |
| MV3 真实浏览器（临时 `http://127.0.0.1:18081` 构建 + mock 契约后端） | `EXTENSION_DIST=<tmp-dist> npx playwright test -c tests/extension/playwright.config.ts` | **18/18 通过（33.2 秒）**。新增「课程调度：判断题 true/false 隐藏答案可回填并提交」：读取 1 题 → 模型返回 True → 隐藏 `#answer1` 得到 `true` → 回读通过 → 站点 `send=1`、`confirm=1` → DONE「已到最后一个任务」，且无人工补答汇总；课程调度 5/5 通过 |
| 既有 MV3 过期用例修复 | 同上 | 21:0x 本地直连改造后侧边栏不再渲染登录表单、manifest 可选权限、全图默认、刷题模式连续任务语义均已变化；本轮改为直接注入可信 `storage.session`（`ensureLoggedIn`）、更新 manifest 期望、在两处 auto 语义用例显式关闭全图、更新刷题模式断言。全量由原先无法运行恢复为 18/18 通过 |

**仍未验证**

1. 真实学习通页面的判断题回填/提交仍需用户在 Chrome 重新加载扩展后复测。本轮浏览器证据来自与真实形态同构的夹具（`true`/`false` 隐藏值、点击写回、提交确认、任务点完成标记），判断题隐藏值的布尔形态未再次抓取真实页面 DOM。
2. 回读轮询上限 2.5 秒；站点若在更晚才同步状态仍会转人工，但会显示脱敏诊断。
3. 监控 400ms 二次确认是确定性去抖，不是绝对可靠；真实任务变化仍会停止且不写、不提交。
4. UNKNOWN 题型的补答依赖用户在汇总中核对/选择题型（界面已存在该选择器），不会猜测。

### 9.15 本地直连图像输入修复（2026-10-19 21:5x）

用户现场截图（真实课程，3 题任务，本地直连，本轮调用 15 次）：待补答 1 题的模型回答为「需要更多上下文（不确定：缺少题目图像，无法作答）—— 题目引用了附图图像，但当前输入中未提供图像内容」。用户说明所用模型（4.1）支持图像，且把题目图片手动复制给同一模型可以正常作答。截图同页面已提供「复制题目图片 / 下载图片」，说明页面渲染图存在，但请求没有把它发给模型。

**根因（代码审计）**：`apps/extension/src/local/provider.ts` 的本地直连把题目 JSON 文本放进 `messages`/`input`；`question.imageDataUrl` 虽然已经由课程页渲染并随 `CAPTURE` 返回，但直连请求构造从未把它作为多模态内容块发送，也没有任何能力开关。后端模式（`ChatCompletionsAdapter`/`ResponsesAdapter`）早已支持图像，因此问题只出现在 21:1x 新增的本地直连路径。该现象解释了「图片没法过去」；手动复制图片给模型可以识别，对应「第二次/手动发过去就可以」。

**修复内容**

- `local/provider.ts` 的 Chat Completions 请求：题目带本地渲染的 `data:image/...` 时，首次请求即发送 `[{type:"text",text:题目JSON},{type:"image_url",image_url:{url:...}}]`；Responses 请求发送 `input_image`；base64 不再重复写进文本块。
- 提示词补充：附带题目图像时结合图像阅读题干、公式、表格与选项；未附带图像时不要臆测；图像无法看清时仍返回 `NEEDS_CONTEXT`。
- 能力显式化：新增 `LocalProvider.supportsImages`（设置页「支持图像输入（多模态）」）。新建/旧存储默认开启；DeepSeek 文本预设默认关闭，避免文字模型收到图像块报错；调度页显示「图像输入：已开启/未开启」。
- 只接受本地渲染的 `data:image/`（不接受远程图像 URL），继续遵守题目与答案不落库、Key 仅本机存储等约束；未新增权限、依赖或后端字段。

**Verified（本轮实际执行）**

| 检查 | 命令 | 结果 |
|---|---|---|
| 全 workspace 类型检查 | `npm run typecheck` | 4 个 workspace 通过 |
| 扩展测试 | `npm run test -w @study/extension` | **23 文件 / 223 项通过**；其中新增 `tests/local-provider.test.ts` 6 项：首次请求携带 `image_url`、文本块不含 base64、无图题保持纯文本、文字模型不附图、Responses 协议 `input_image`、旧存储默认能力、供应商拒绝图像时的显式提示 |
| 扩展构建 | `node scripts/build-extension.mjs` | 成功；产物共享块包含 `image_url`/`input_image`，runner 含「图像输入」提示，options 含「支持图像输入」勾选 |
| 静态检查 | 构建断言 | manifest/权限/CSP 断言通过，未新增权限 |

**仍未验证**

1. 用户真实 4.1 供应商下需重新加载 `apps/extension/dist` 并重开调度页后复测；本轮只用单元测试断言请求体，没有对真实供应商发送带个人信息的题目图像。
2. 若供应商实际不支持图像输入，会在设置中关闭该能力或收到供应商 4xx 报错；界面会显示原始错误，不静默降级。
3. 图像体积仍受 400000 字符上限；超过时该题转人工。

### 9.16 整份题目 Markdown 复制、剪贴板兜底与 GitHub 风格 UI（2026-10-19 21:5x–22:0x）

用户反馈：文档复制要可用；界面难看，明确要求按 GitHub 风格重做。

**变更内容**

- 整份导出（文档复制）：`shared/question-markdown.ts` 新增 `questionsToMarkdown`，把课程任务「读取全部题目」的结果按页内顺序编号导出为一份 Markdown（题型、题干、选项/空格、图像兜底标记与来源原因、结尾按题号作答指令）。调度页库存区新增「复制整份 Markdown」「下载整份 .md」（`runner-copy-all`/`runner-download-all`），每题展开区新增「复制本题 Markdown」（`runner-copy-question-N`）；侧边栏单题复制保留。
- 剪贴板可靠性：新增 `sidepanel/clipboard.ts`（剪贴板仍只在可信扩展页触发，静态测试边界不变）：写入被拒（如侧边栏 "document is not focused"）时先 `window.focus()` 重试一次；仍失败则页面内展示已全选的只读文本框，用户按 Ctrl+C 即可完成（`copy-fallback`），不再静默失败；图片复制同样经 focus 重试，失败给出改用下载的提示。
- UI 重做（GitHub Primer 风格，用户指定「直接抄 GitHub」）：`sidepanel/styles.css`（侧边栏/设置页/调度页共用）整体重写为 Primer 明/暗双色板（canvas `#f6f8fa`/`#0d1117`、边框 `#d0d7de`/`#3d444d`、链接蓝 `#0969da`/`#4493f8`、主按钮绿 `#1f883d`/`#238636` 等），含按钮族（默认灰/绿色主操作/隐形链接）、表单控件（inset 底色 + 蓝色焦点环）、标签胶囊、计数胶囊、代码块、表格、`details`/`fieldset`、成功/警告/危险卡片闪条、步骤序号（侧边栏 1–4 步流程）、`prefers-reduced-motion` 降级；调度页统计行改为 GitHub 计数胶囊，主操作按钮统一绿色。功能与流程语义、全部 `data-testid` 未变。

**Verified（本轮实际执行）**

| 检查 | 命令 | 结果 |
|---|---|---|
| 扩展测试 | `vitest run`（workspace node_modules） | **23 文件 / 223 项通过**；`question-markdown.test.ts` 新增整份导出 2 项（顺序编号、图像兜底标记）；`security-static.test.ts` 剪贴板边界 33 项全部通过（clipboard 字样仅出现在 `sidepanel/`） |
| 类型检查 | `vue-tsc --noEmit -p tsconfig.json` | 通过 |
| 扩展构建 | `node scripts/build-extension.mjs` | 成功；dist 含 `runner-copy-all`/`runner-download-all`/`runner-copy-question-`/`copy-fallback` 与 Primer 色板 |

**仍未验证**

1. 侧边栏剪贴板自动复制在个别 Chrome 版本的侧边栏焦点策略下可能仍走兜底文本框；兜底保证可用（全选 + Ctrl+C），未在真实浏览器手工复测。
2. UI 仅有代码级实现与构建验证，未做浏览器截图比对；用户重新加载扩展后如对细节不满意可继续调整。

### 9.17 新皮肤提交确认弹窗导致卡在提交阶段（2026-10-19 22:0x）

用户截图（真实学习通课程任务页，章节测验 3 题）：点击 Submit 后页面弹出 `Tip` / `Submit?` / `Cancel` / `Submit` 确认框；调度器没有点它，60 秒后按「站点未确认提交」停止，每次重跑都卡在这一步。

**根因**：`course-page.ts` 的 `CONFIRM_WORK` 只认已记录的旧 DOM 证据（`#confirmSubWin` + 唯一 `a.bluebtn`「OK」）。这次章节测验的新皮肤弹窗结构和文案都不同，所以既不点击、也不给出具体原因，只能超时。

**修复内容**

- 保留旧证据路径；未命中时使用**可见文本签名兜底**（不硬编码站点 class）：同一可见小容器内必须同时满足①含 `?`/`？` 的提交确认问句，②恰好一个确定按钮（Submit/OK/确定/确认/确认提交/确定提交/提交/交卷），③恰好一个取消按钮（Cancel/取消/关闭），才点击该确定按钮。
- 只在扩展自己点击提交按钮之后尝试；每任务最多确认一次；文案歧义或缺取消按钮一律不点，避免误点页面其他 Submit 或造成重复提交。
- 该皮肤证据为**用户截图级**，未取得脱敏 DOM，已记入 `docs/compatibility.md` §6.2；若控件不是 `button`/`a`/`[role=button]`/`[onclick]` 或位于 Shadow DOM，仍无法识别。

**Verified（本轮实际执行）**

| 检查 | 命令 | 结果 |
|---|---|---|
| 题型/提交适配单元测试 | `npm run test -w @study/extension` | **23 文件 / 227 项通过**；`automation-course-page.test.ts` 34 项，新增 4 项：新皮肤 `Tip` 弹窗确认一次且不重复点页面提交、span 样式按钮的弹窗可确认、歧义弹窗不点击、题干含「确定要提交？」不误判 |
| 类型检查 | `npm run typecheck -w @study/extension` | 通过 |
| 扩展构建 | `node scripts/build-extension.mjs` | 成功；`apps/extension/dist` 使用 `http://127.0.0.1:8080` |

**仍未验证**

1. 需用户重新加载 `apps/extension/dist` 后在真实章节测验复测；本轮没有在真实页面自动确认过。
2. 若该皮肤弹窗控件不是 `button`/`a`/`[role=button]`/`[onclick]` 或位于 Shadow DOM，文本签名兜底仍无法识别；此时需要用户提供脱敏 DOM 后做精确适配。
3. 当前若弹窗仍开着，请先手动点 Cancel/Submit 关闭并刷新课程页再重跑；同一任务已尝试提交后不会重复点击。

### 9.18 ERROR 后补答仍需人工提交的恢复缺口（2026-10-19 22:1x）

用户反馈：学习通运行到提交阶段还要自己手动点提交，“完全可以自己点一下的啊，为啥要卡那一下人工”。

**根因（代码审计）**：自动提交链路（补答 → `finishManual` → `SEND_WORK`）只在 `NEEDS_INPUT` 状态生效。流水线一旦以 `ERROR` 停止——典型如监控器在补答停车期间判定任务变化（§9.14 用户截图场景）、或提交链路任何一步失败——补答核验完成后只提示「已补填人工答案；请修正错误后重新启动以提交」。此时 `submitNow()` 明明具备点击站点提交按钮的完整能力，却不自动执行；而「重新启动」会对已回填的题重新调用模型（费用与时间），用户实际上只能自己点学习通的提交按钮。

**修复内容（`apps/extension/src/automation/runner.ts`）**

| 项 | 变更 |
|---|---|
| 提交核心 | 从 `submitNow()` 抽出 `submitAndWait()`：点击一次站点提交按钮 → 每秒 `CONFIRM_WORK` + 完成标记核验，最多 60 秒；返回已确认完成 / 站点已自动切下一任务 / 未确认 / 失败 |
| 恢复入口 | 新增 `recoverFromError()`：ERROR 且全部待补答题已核验时自动 `submitAndWait()`，成功后经 `runLoop()` 继续任务链（起始题重置为 1、保留本轮计数）；未确认/失败停在 ERROR，不重复提交、不跳任务 |
| 调度循环 | `start()` 的循环体拆为 `runLoop()`，正常启动与错误恢复共用同一循环及全部停止条件（任务循环检测、未完成不跳转、视频核验等）；`start()` 增补 `manualSaving` 防重入 |
| 三个补答入口 | `submitManual`（汇总表补答）、`adoptCandidate`（采用候选）、`acceptManualFromPage`（网页补答核验）在 ERROR 下全部核验后自动触发恢复提交；`acceptManualFromPage` 此前在 ERROR 下按钮可点但无动作，现同样可用 |
| UI | 汇总卡说明更新为“补全核验后会自动点击站点提交按钮并继续任务链（运行出错停止后同样自动恢复，无需手动点提交或重启）” |

**安全边界（不变）**：提交仍受 course-page 逐题回读一致、唯一提交按钮、单次提交（`sendAttempted`）约束；缺题不提交；正式考试 / 未知任务 / 显式停止（STOPPED）不自动恢复；不重复提交。

**Verified（本轮实际执行）**

| 检查 | 命令 | 结果 |
|---|---|---|
| 扩展测试 | `npm run test -w @study/extension` | **23 文件 / 230 项通过**；`automation-runner.test.ts` 新增 3 项：监控误报 ERROR 后补答自动提交并完成链路（`SEND_WORK`×1 + `CONFIRM_WORK`、`completedTasks=1`、无残留定时器）、采用最后候选后自动提交、网页补答核验后自动提交 |
| 类型检查 | `npm run typecheck`（4 workspace） | 通过 |
| 扩展构建 | `node scripts/build-extension.mjs` | 成功；dist 的 runner 块含“补答已核验，自动提交本任务并继续”，旧文案“请修正错误后重新启动”已消失 |
| MV3 真实浏览器 | `EXTENSION_DIST=<临时 18081 构建> npx playwright test -c tests/extension/playwright.config.ts` | **18/18 通过（49.1s）**；含「模糊题补全后自动继续提交」端到端用例。顺带修复 §9.16 UI 重做后未同步的 5 处过期断言（`已读取 3 题`→`3已读取`、`本轮调用 3`→`3本轮调用` 等胶囊文案）——此前 MV3 套件因这些断言已无法通过，与本次 runner 改动无关 |

**仍未验证**

1. 真实学习通页面上的 ERROR 恢复提交需用户重新加载 `apps/extension/dist` 后复测；本轮证据来自与真实流程同构的单元测试（fake 计时器驱动监控、端口桩驱动站点命令）。
2. 若 ERROR 由站点真实切换任务引起，补答 `APPLY` 会被任务键守卫拒绝（「课程或任务已变化，请重新启动」），不会误提交到新任务；该路径有既有测试覆盖。

### 9.19 调度页「可选站点权限」卡片在已授权时自动隐藏（2026-10-19 22:18）

用户截图「课程任务调度」页底部的「可选站点权限」卡片（输入框预填 `https://mooc1.chaoxing.com`、「允许读取此站点」按钮），表示「不需要这个」；确认后的口径为：**已授权时自动隐藏，未授权才显示**，保留兜底入口而不是删除功能。

**变更内容**

| 项 | 变更 |
|---|---|
| `sidepanel/bridge.ts` | 新增 `isSitePermissionGranted(site)`：只对 `sitePermissionOrigin` 认可的精确 HTTPS 学习通 Origin 调用 `chrome.permissions.contains`；非法 Origin 直接返回 false，API 异常也 fail-closed 返回 false |
| `automation/App.vue` | 卡片改为 `v-if="!siteGranted"`（新增 `data-testid="site-permission-card"`）；面板加载时读取绑定标签站点后查询一次授权状态；点击授权成功后立即隐藏；输入站点变更、页面重新可见或重新获得焦点时复查（用户可能在侧边栏或 Chrome 扩展详情里授权/撤销）；卸载时移除监听 |
| 未改动 | manifest 的 `optional_host_permissions`、请求函数、侧边栏「允许读取当前站点（可选）」兜底提示、本地直连供应商的站点授权逻辑均不变；仍只在用户点击手势内调用 `chrome.permissions.request` |

**安全边界（不变）**：只查询/申请用户确认的具体 HTTPS 学习通 Origin，不申请通配子域、`<all_urls>`、`tabs`；未授权或查询失败时卡片保留可见，不伪造已授权状态；查询本身不读取页面内容、不发网络请求。

**Verified（本轮实际执行）**

| 检查 | 命令 | 结果 |
|---|---|---|
| 扩展测试 | `npm run test -w @study/extension` | **24 文件 / 234 项通过**；`site-permission.test.ts` 新增 2 项（已授权查询只查精确 Origin 且不触发 request、非法 Origin 不查询、API 异常 fail-closed）；新增 `automation-permission-card.test.ts` 2 项（已授权时卡片不渲染、未授权时渲染且授权成功后立即隐藏） |
| 类型检查 | `npm run typecheck -w @study/extension` | 通过 |
| 扩展构建 | `node scripts/build-extension.mjs` | 成功；dist 的 runner 块含 `site-permission-card`，manifest 未变 |

**仍未验证**

1. 真实 Chrome 中需用户重新加载 `apps/extension/dist` 后复测：授权过的站点打开调度页时卡片不再出现，撤销授权后重新聚焦页面卡片重新出现；本轮证据来自 jsdom 组件测试与构建产物检查。
2. 通过 Chrome 扩展详情「网站访问权限」整体放开站点访问时，`permissions.contains` 是否对该 Origin 返回 true 取决于 Chrome 版本实现；若返回 false 则卡片仍显示（不会误隐藏），用户可自行忽略。

### 9.20 题图读取失败导致无 AI 候选且重试禁用（2026-10-19 22:2x）

用户现场截图：调度页「待人工补答汇总：2 题」，两题（ACEBench 单选题、Claude Code 判断题）原因均为「图片无法读取，已跳过自动答题，请手动输入。」；卡片里没有任何模型回答或候选，「再次并发请求」「直接采用最高票答案」均为禁用，用户只能凭题干凭空作答。用户原话：「没有AI信息，无法作答，也无法再次发送请求」。

**根因（代码审计）**

1. `runner.ts` 的题图 `CAPTURE` 失败分支无条件 `issue(captured, "图片无法读取，已跳过自动答题，请手动输入。")`：既不调用模型（因此 `samples`/`candidates` 为空），也把 `retryable` 设为 false（因此「再次并发请求」禁用）。而「所有题目都附带渲染图片」默认开启，文字已经可靠读取的题也会强制 `CAPTURE`；题图只是补充信息，渲染失败却把整题答案一起丢掉。
2. 失败原因被压缩成一句通用文案，`QuestionImageError` 里的具体原因（不可见/尚未加载/跨域/超限）没有进入汇总，用户和排查都无法得知。
3. `render-question.ts` 对不可见图片、坏图与尚未加载完成的图片直接抛错，任一无布局盒的图片即可让整题渲染失败。

**修复内容**

| 项 | 变更 |
|---|---|
| `TaskQuestion.textUsable` | `course-page.describe` 按「可靠源文字是否非空」写入；`needsImage=true` 与文字可读可以同时成立（图示题），纯图片/字形未知题则为 false |
| 三类回退 | ①`needsImage=false`（全图模式的补充图像）→ 丢弃图片、按源文字继续正常模型作答并回填；②`needsImage=true` 且文字可读 → 不自动回填，按文字请求一次模型，把回答/候选列进汇总；③文字不可读 → 人工处理，`retryable=true` 保留重试入口 |
| 重试增强 | `ManualQuestion.imageError` 记录具体原因；`retryManual` 先重新 `CAPTURE`（瞬时加载/CORS 失败可恢复），成功则清空此前纯文字样本并用带图请求走三次投票回填；仍失败且文字可读时只展示纯文字候选，**不自动回填必需题图的题**；成功重读后清空 `imageError` 并显示「复制/下载题目图片」 |
| 渲染健壮性 | `render-question.ts` 跳过无可见布局盒/隐藏/无 src 的图片；可见图片先有界等待加载（3 秒）再读取；`capture` 把「源数据是否检出图示」传给渲染器：图示题的图片未完整显示或加载失败必须报错转人工/文字回退，绝不生成缺少图示的题图让模型猜答案。跨域读取规则与 400 KB 上限不变，仍不做屏幕截图、不绕过 CORS |
| UI | 汇总卡说明与 `runner-local-images` 提示更新；每个题图失败项显示 `manual-image-error`：「题图读取失败：具体原因」及下一步建议 |

**安全边界（不变）**：模型文本仍按纯文本渲染；不执行模型返回的脚本/选择器；题图只接受本地渲染的 `data:image/`；必需题图未取到时绝不凭文字答案自动回填，由用户核对后采用；提交仍受逐题回读一致、唯一提交按钮、单次提交约束。

**Verified（本轮实际执行）**

| 检查 | 命令 | 结果 |
|---|---|---|
| 扩展测试 | `npm run test -w @study/extension` | **24 文件 / 237 项通过**；`automation-runner.test.ts` 由原「图片错误直接跳过」1 项改为 4 项：全图模式下题图失败仍按文字作答并回填两题、必需题图失败保留人工项但请求 1 次文字候选、重试重新读图成功后只用带图样本投票回填、纯图片题重试仍失败时无模型调用并保留网页核验路径 |
| 类型检查 | `npm run typecheck`（4 workspace） | 通过 |
| 扩展构建 | `node scripts/build-extension.mjs` | 成功；dist 的 runner 块含「题图读取失败」「改用源文字作答」「题图仍无法读取」「manual-image-error」，manifest 与权限未变，最终产物指向 `http://127.0.0.1:8080` |
| MV3 真实浏览器 | 临时 `EXTENSION_BACKEND_ORIGIN=http://127.0.0.1:18081` 构建后 `npx playwright test -c tests/extension/playwright.config.ts` | **18/18 通过（53.6s）**；含「只给图示题附图」「模糊题人工补答」与课程任务连续运行用例；随后已按默认 8080 重新构建 dist |
| 契约 | `node scripts/verify-contracts.mjs` | PASS（21 端点 / 25 错误码 / 91 字段） |

**仍未验证**

1. 用户真实学习通页面需重新加载 `apps/extension/dist` 后重跑复测；本轮未在真实账号上提交。重跑后若仍出现题图失败，汇总卡会显示具体原因（如「题目图片不允许跨域读取」「题目图片加载失败」），可据此继续精确适配。
2. 两题的具体渲染失败原因在旧版被通用文案覆盖，无法回溯；若重跑时题图成功，将按修复后的带图流程处理；若文字可读则至少会得到文字候选并可重试，不再出现「无 AI 信息 + 重试禁用」。

### 9.21 刷题模式视频不跳过、刷课模式视频不自动播放（2026-10-19 22:4x）

用户两张现场截图：①真实学习通课程「AI伦理挑战概述」当前任务点为**视频**，播放器黑屏只显示站点圆形播放按钮，页面仍提示「完成条件 观看时长≥总时长的 90%（未完成任务前当前视频不可拖拽，观看时不可离开或将页面最小化）」；②调度页（`runner.html?tabId=1471432730`）为 `ERROR · 已停止，需要人工处理`，计数「本轮已收集 0 题 · 当前任务共 0 题 · 已确认完成 1 个任务 / 已越过 1 个无任务标记的 PDF 资料页」，红色错误 **「站点尚未确认本任务完成，拒绝跳转。」**，监听检查 5 次。用户原话：「无论是哪个模式，都没有自动播放的模块，刷题也不会跳过，解决一下」。

**根因（代码审计，两个独立缺陷）**

1. **刷题模式跳不过视频**：`runner.ts` 的刷题模式（`skipVideos=true`）对未完成 `VIDEO` 任务不调用 `PLAY`，直接发 `NEXT`；但 `course-page.ts` 的 `NEXT` 守卫只放行「站点已完成」和「无任务标记 PDF 资料页」。页面因此报「站点尚未确认本任务完成，拒绝跳转。」，runner 转 ERROR——视频既没播放也没被跳过，且「已跳过」计数仍是 0。
2. **刷课模式不自动播放**：`course-page.ts` 对视频只做「点一次站点按钮 + `video.play()` + 失败再点一次」。真实媒体帧没有可信用户手势，Chrome 自动播放策略对**有声** `play()` 抛 `NotAllowedError`，播放器保持黑屏；旧错误路径也不过是把整轮停掉，用户看到的就是「没有自动播放」。

**修复内容**

| 文件 | 变更 |
|---|---|
| `automation/protocol.ts` | `AutomationCommand` 新增 `allowSkipUnfinished?: boolean`；`parseAutomationCommand` 只在 `action==="NEXT"` 且值**严格为 `true`** 时回填，其他 action/非布尔 true 一律丢弃（不扩大命令面） |
| `automation/course-page.ts` | `NEXT` 放行条件改为 `completed \|\| kind==="MATERIAL" \|\| (allowSkipUnfinished===true && kind==="VIDEO")`；其他未完成任务继续拒绝。新增 `startVideo()`：站点播放按钮 → 有界等待 metadata → 标准 `play()` → 再点控件重试 → **静音起播并立即恢复原静音状态**（只调用 `HTMLMediaElement.play()`，不改 `currentTime`/`playbackRate`、不伪造 `ended`/平台进度）；已在播放的媒体直接返回，不点播放/暂停控件（不会误暂停）。失败信息带具体异常名（如 `NotAllowedError`）与人工点击提示 |
| `automation/runner.ts` | `RunnerState` 新增 `skippedVideos`；`skippedResources` 只统计无任务标记 PDF 资料页，刷题模式越过的未完成视频单独计数且不计入 `completedTasks`；仅该场景的 `NEXT` 携带 `{ allowSkipUnfinished: true }`；新增 `playWithRetry()`：只对 `PLAY` 做最多 3 次总尝试，每次失败后 2 秒且暂停/停止照常生效，其他动作不重试 |
| `automation/App.vue` | 状态卡分别显示「已越过 N 个 PDF 资料页」和「刷题模式已跳过 N 个未完成的视频任务点（不计入已完成；可回到刷课模式补看）」；新增自动播放兜底说明 |
| 同轮补充（并行修复） | 运行页新增视频状态行 `runner-video-status`（自动播放中 `mm:ss / 总时长`、「检测到暂停，正在恢复播放」、「播放已结束，等待站点确认完成」），让用户能直接看到视频模块在工作；课程页视频 iframe/题目文档懒加载导致首次 `INSPECT` 读到 `UNKNOWN` 时，先有界等待页面稳定（最多 25 秒）再判定未适配，不再把尚未建好的播放器误判为未知任务并立刻停止 |
| `tests/automation-course-page.test.ts` | 新增 7 项：未授权不跳未完成视频、显式授权才跳且只对 VIDEO 生效、自动播放被拒时静音起播并恢复声音、用户原本静音则保持静音、全部尝试失败报 `NotAllowedError`、起播过程不 seek/改速、已在播放时不点击不重播 |
| `tests/automation-runner.test.ts` / `automation-protocol.test.ts` | 新增 7 项：刷题模式发带授权 `NEXT` 且 `skippedVideos=1`、已完成视频不跳过、刷课模式播放后普通 `NEXT`、PLAY 拒绝 2 次后第 3 次成功、拒绝 3 次报最后错误、重试等待中停止不继续、协议仅 NEXT/严格 true 生效 |

**安全边界（不变）**：视频仍必须由站点自己的完成标记确认后才推进；不 seek、不加速、不伪造进度/时长；静音只用于越过浏览器自动播放限制，起播后恢复原状态；不新增权限、不读 Cookie、不自动提交考试/作业；未完成非视频任务仍拒绝跳转；正式考试/未知任务/验证码仍停止。

**Verified（本轮实际执行）**

| 检查 | 命令 | 结果 |
|---|---|---|
| 扩展测试 | `npm run test -w @study/extension` | **24 文件 / 252 项通过**，exit 0（`automation-course-page.test.ts` 41 项、`automation-runner.test.ts` 54 项、`automation-protocol.test.ts` 3 项） |
| 类型检查 | `npm run typecheck -w @study/extension` | exit 0（`vue-tsc --noEmit`） |
| 扩展构建 | `node scripts/build-extension.mjs` | 成功；`page/automation-entry.js` 含 `startVideo`/`allowSkipUnfinished`/静音兜底（esbuild 将中文转义为 `\uXXXX`），runner 块含 `skippedVideos`/`runner-skipped-videos`/`runner-autoplay-hint` |
| MV3 真实浏览器 | `npm run test:e2e`（加载新 dist，mock 契约后端） | **19/19 通过（54.4s）**，含课程调度连续任务、刷题模式连续任务点、模糊题补答、图示题、判断题，以及新增「刷题模式直接跳过未完成的视频任务点且不尝试播放」端到端用例 |
| 发布包 | `python release/make_zip.py` | 重新打包 `release/study-assistant-extension.zip`（0.74 MB），内含新 dist（runner 资源与 `automation-entry.js` 均已更新） |

**仍未验证**

1. 真实学习通页面复测需用户重新加载 `apps/extension/dist`（扩展管理页「重新加载」）或重新解压 release 包，并刷新课程页/重开调度页；本轮证据来自单元测试与合成 MV3 浏览器用例，未在真实账号上播放或跳转视频。
2. 若站点在标签页切后台时主动暂停（页面要求「观看时不可离开或将页面最小化」），扩展不会绕过站点限制，会停在该状态并提示「视频持续暂停或需要前台播放」。
3. 静音起播只越过 Chrome 自动播放策略，不改变站点进度逻辑；若某皮肤不认静音起播的播放事件，仍需用户手点一次播放并把结果反馈给适配。

### 9.22 非粘贴题目：非文本图示渲染与作答控件回退（2026-10-19 22:4x–23:1x）

用户补充限制：「还有的题目可能是采用非粘贴的方式，这个时候你就需要考虑一系列的情况」。据此覆盖两类非粘贴情况：**题目内容无法复制/粘贴为文字**与**作答控件不是 UEditor 富文本**。

**变更内容**

| 文件 | 变更 |
|---|---|
| `automation/protocol.ts` | `TaskQuestion` 新增 `answerMode?: "UEDITOR" \| "CONTENTEDITABLE" \| "TEXT_FIELD" \| "NONE"` 与 `answerReason?: string`（题型→作答方式的显式声明，未扩大命令面） |
| `automation/course-page.ts` | 新增 `answerFields()`：按 UEditor iframe body → 题内 `[contenteditable=true]` → 可见纯输入框（排除 hidden/radio/checkbox/`#answer*`/选项行）的顺序发现作答控件；`describe()` 不再因「不是 UEditor」抛错中止整轮——无可写控件时降级为文字题（简答）并携带 `answerReason`；题型标签命中 排序/连线/拖拽/匹配/归类/组合/画图/绘图/完形/听力/口语/朗读/编程/代码 且无控件时同样降级；「简答」多编辑区按填空处理；标签未知但有已识别编辑器按简答处理。`apply()` 按控件写入（contenteditable=纯文本+input/change/blur；输入框=原生 value setter+input/change/blur），`answerMode=NONE` 时明确拒绝写入；`readAnswer()` 按控件回读，无控件时只读站点自身隐藏答案（仅用于网页补答核验，空值不算已答） |
| `automation/source-reader.ts` | 文字遍历进入 open shadow root；跳过 MathJax 隐藏 MathML（`mjx-assistive-mml`）、`select/option/noscript`；`video/audio/iframe/embed/object` 标记为非粘贴内容（`needsImage=true` + 专属原因文案） |
| `automation/render-question.ts` | 不再对 svg/canvas 整题报错：`<canvas>` 用 `ctx.drawImage` 复制已渲染像素；内联 `<svg>` 克隆补宽高后序列化为 data URI 图像再绘制（不继承页面 CSS、不执行脚本）；音视频/嵌入框架直接报「无法生成静态题图，请人工补答」；文字绘制进入 open shadow root、跳过已栅格化的 svg/canvas 与 `mjx-assistive-mml`；保留 14000 字符上限与 400KB 题图上限 |
| `automation/runner.ts` | UNKNOWN 题的人工汇总原因优先使用 `answerReason`（非文本题型有具体说明，不再是泛化的「题型无法识别」） |
| 测试（tests-dev） | `render-question.test.ts`（新）4 项：canvas drawImage、SVG data URI 序列化绘制、可见 SVG 加载失败抛具体 QuestionImageError、shadow root 文本绘制 + 跳过助读/脚本/样式/textarea；`automation-source.test.ts` +3：shadow root 题干读取、SVG 图示标记、音视频/嵌入框架 needsImage+原因；`automation-course-page.test.ts` +3：TEXT_FIELD 写入+事件+回读+SEND_WORK、CONTENTEDITABLE 写入+回读、NONE 时 READ_ALL 成功且 APPLY 明确拒绝；`tests/fixtures/automation-nonpaste.html`（新）+ MV3 用例「课程调度：Shadow DOM 题干与纯输入框填空可用，SVG 图示题渲染题图」 |

**安全边界（不变）**：不模拟粘贴/剪贴板、不派发键盘事件、不伪造 `isTrusted`、不做 HTML 注入/浏览器编辑命令、不移除只读属性、不写隐藏答案字段（只读）；排序/连线/拖拽类控件在取得脱敏 DOM 证据前不做任何合成操作；音视频/嵌入框架绝不生成缺内容的题图；缺题不提交。

**Verified（本轮实际执行）**

| 检查 | 命令 | 结果 |
|---|---|---|
| 扩展测试 | `npm run test -w @study/extension` | **25 文件 / 273 项通过**（2026-10-19 23:06–23:08 源码快照；含本轮非粘贴 10 项新用例与同窗口另一会话的视频/弹题用例；22:50 首跑 259/259 时非粘贴用例已全绿） |
| 类型检查 | `npm run typecheck -w @study/extension` | exit 0（`vue-tsc` 0 诊断） |
| 扩展构建 | `node scripts/build-extension.mjs` | 成功（默认 8080；临时 18081 构建亦成功，manifest host_permissions 已核对） |
| MV3 真实浏览器 | 临时 18081 构建 + mock 契约后端 `npx playwright test` | 21 用例：**19 通过 / 1 失败 / 1 未运行**。失败为另一会话的弹题用例「只刷课模式…枚举视频弹题」（60s 超时未到 DONE，非本轮范围，该会话仍在迭代）；未运行的是本轮 nonpaste 用例（serial 模式排在最后被中断）——**单独重跑 `-g "Shadow DOM"` PASS（5.1s）**：纯输入框写入并回读「答案1」、隐藏答案同步、SVG 题 `imageDataUrl` 为 `data:image/`、shadow 题干进入请求、`{send:1,confirm:1,next:1}`、3 次模型请求 |
| 契约 | `node scripts/verify-contracts.mjs` | PASS（21 端点 / 25 错误码 / 91 字段） |

**同窗口并行改动记录（来源：另一会话，用户确认让其做完）**：2026-10-19 22:41–23:11+ 另一会话在本仓库持续写入并已完成（a）视频跳过授权/自动播放兜底（§9.21，MV3 19/19）；（b）只刷课模式 `videosOnly`、视频弹题免人工枚举 `ENUM_POPUP`、暂停声音告警 `shared/alarm.ts`、`play()` 永不 settle 的竞速上限修复、`automation-video-popup.html` fixture 与 MV3 用例（**其弹题 MV3 用例本轮 1 失败，该会话仍在迭代修复中**）——该线的用户授权（只刷课跳题、弹题免人工枚举、声音告警，含用户原话）已正式补记入 AGENTS.md「2026-10-19 22:4x」段，功能详情见 `docs/course-automation.md`「只刷课模式、视频弹题免人工枚举与声音告警」节；（c）23:11 起开始 `model-json.ts`（模型 JSON 修复）新主题，尚未收尾。两套改动经 Lead 逐点审查为正交合并：`answerFields`/`describe`/`apply`（非粘贴）与 `ENUM_POPUP`/`startVideo`/`videosOnly`（视频链路）共存，273 项单元测试同时覆盖两套功能。

**仍未验证**

1. 真实学习通页面需重新加载 `apps/extension/dist`（23:10 后的 8080 构建）后重跑：SVG/canvas 图示题的题图内容质量、纯输入框填空皮肤、非文本题型（排序/连线等）的人工汇总路径。合成 fixture 已覆盖上述路径的机制正确性。
2. 序列化 SVG 不继承页面 CSS：复杂公式/图表在题图中的字体、颜色可能与屏幕不同；若影响模型识题，需按具体站点反馈再迭代。
3. closed shadow root、CSS background-image/伪元素图示仍不可采集（限制，显式转图像/人工路径）。
4. 并行会话仍在写入（23:11 后）：`release/study-assistant-extension.zip` 仍为 §9.21 版本（不含弹题与非粘贴改动），**需在写入停止后用最终 dist 重新打包**；其弹题 MV3 用例失败与 model-json 新主题的结果由该会话自行验收记录。

### 9.23 只刷课模式、视频弹题免人工枚举与声音告警（2026-10-19 22:4x–23:1x）

用户补充（本节为该授权的直接来源，已同步记入 AGENTS.md「2026-10-19 22:4x」段）：①“有一种情况，就是我只想刷课的情况下，你没有列举”；②“刷课的时候中间可能有题目，这个时候需要点击并且跳过的，这个时候你不需要上报人工，直接撰写即可，因为只有对了才能继续，所以可以采用枚举的方法”；③“题目出问题了，你可以发出声音，告诉使用者出现了问题，而不是文字警告，因为他们可能在刷抖音”。

**实现内容**

| 项 | 变更 |
|---|---|
| 只刷课模式 | `RunOptions.videosOnly`（与 `skipVideos` 互斥，同时开启报“调度参数无效”）：视频照常真实播放；未完成 `QUIZ` 任务点带显式 `allowSkipUnfinished` 越过（不 `READ_ALL`/不 `APPLY`/不 `SEND_WORK`/不调用模型），单独计数 `RunnerState.skippedQuizzes` 并在状态卡显示；运行页第三个主按钮 `runner-videos-only`，该模式不要求配置供应商即可启动（不发任何题目数据） |
| 页面侧 NEXT 守卫 | `allowSkipUnfinished===true` 现允许越过未完成 `VIDEO`（刷题）或未完成 `QUIZ`（只刷课）；其余未完成任务仍拒绝跳转，正式考试/未知任务边界不变 |
| 弹题枚举 | 新增固定命令 `ENUM_POPUP`（协议白名单 + `PopupOutcome{found,resolved,attempts,options}`）。视频轮询发现 `paused && !ended` 时先枚举、再走原恢复播放路径；命令失败按未发现处理。页面侧**结构性识别**（无真实弹题 DOM 证据，不编造学习通类名）：排除 `[id^="question"]` 章节题容器后，找可见小容器（可见文本 ≤800 字符）＋互斥选项控件（可见原生 radio 组 ≥2，或共享小父容器、带字母分隔符/布尔措辞的选项行 ≥2；总数 2–12）→ 按 DOM 顺序点站点选项 → 容器内恰有一个确认按钮时点击 → 每选项有界等待 ≈4.8s，容器消失或视频恢复即通过。只返回计数；题文/答案不离开页面、不落日志、不调模型。全选项试完未通过 → ERROR（错误含 `N/M` 计数）；同一视频连续通过 >10 次停止 |
| 声音告警 | 新增 `shared/alarm.ts`（Web Audio 固定双音 880/660Hz，音频时钟预排程；`AudioContext` 在启动按钮手势解锁；无 API/被拒时静默降级为仅文字）。运行页 `runner-sound` 开关默认开启：ERROR 响三组并每 30 秒重复（≤20 次，用户点击/按键回页即停），NEEDS_INPUT 响一组；文字提示保留 |
| 播放挂起修复 | `tryPlay` 以 12 秒竞速上限等待 `play()` Promise：无可选源/管道卡死的播放器不再让整轮永久停在 RUNNING，超时按「开始播放超时」进入失败诊断与既有重试。该缺陷由本轮 e2e 首次尝试暴露（见下“过程记录”） |
| 诊断暴露 | 运行页暴露 `window.__courseRunId`（随机临时 ID，不含题文/密钥），供端到端测试与诊断以同一租约身份寻址固定命令 |

**Verified（本轮实际执行）**

| 检查 | 命令 | 结果 |
|---|---|---|
| 扩展类型检查 | `npm run typecheck -w @study/extension` | 通过（含 `alarm.ts`、`App.vue`、协议/页面/runner 改动；顺带修复并行会话遗留的 `tests/render-question.test.ts` delete 可选属性类型错误） |
| 扩展单元/集成测试 | `npm run test -w @study/extension` | **26 文件 / 295 项通过**（23:12:35）。本轮新增：protocol `ENUM_POPUP` 绑定校验；course-page 弹题 radio 枚举（A 错 B 对 attempts=2）、无弹题 found=false、全选项失败、自定义行弹题、章节题选项绝不被弹题路径点击、QUIZ 显式授权跳过、`play()` 永不 settle 有界失败；runner 只刷课跳过题目（带授权 NEXT、零模型/零写入、`skippedQuizzes=1`）、只刷课仍播视频、双模式互斥、弹题通过后继续播放并完成、弹题失败 ERROR 含 `3/3` |
| 全 workspace 类型检查 | `npm run typecheck` | 4 workspace 通过（exit 0） |
| 扩展构建 | `node scripts/build-extension.mjs` | 成功（默认 8080）；dist 的 `page/automation-entry.js` 含 `ENUM_POPUP`/`allowSkipUnfinished`，runner 块含 `runner-videos-only`/`runner-sound`/`runner-skipped-quizzes`/`AudioContext` |
| MV3 真实浏览器 | `npx playwright test -c tests/extension/playwright.config.ts`（8080 空闲，mock 契约后端，默认 dist） | **21/21 通过（52.4s，23:12）**，含新增「视频弹题经真实 MV3 桥枚举作答（A 错 B 对），全程不调用模型」：运行页 → background → 内容脚本 → 夹具 DOM 全链路，`popup={found:true,resolved:true,attempts:2,options:3}`，夹具计数 `popupOptions:2, popupPass:1`，弹题隐藏，模型请求 0。§9.22 记录的该用例失败（23:06–23:08 快照）即下述过程记录问题，已修复 |

**过程记录（首版 e2e 失败暴露的真实缺陷）**：首版弹题夹具在页面主世界用 `Object.defineProperty` 覆写视频属性并替换 `video.play`；扩展内容脚本运行于 ISOLATED 世界，看不到这些覆写——无源视频的 `video.play()` Promise 在真实 Chromium 中**永不 settle**，页面命令永不返回，运行页永久停在 `RUNNING · 正常播放视频`（监听检查 1 次）。除改为静态弹题夹具（`automation-video-popup.html`：弹题常显、正确项 B）+ 探针式用例（运行页经 `__courseRunId` 以同一租约先 `INSPECT` 取任务键再 `ENUM_POPUP`）外，顺势修复产品缺陷：`tryPlay` 12 秒竞速上限，真实播放器无可选源/管道卡死时给出「开始播放超时」具体失败而非挂起。

**仍未验证**

1. 真实学习通视频弹题表单：仍无脱敏 DOM 证据。结构性识别可能漏判（弹题在 closed Shadow DOM、选项无字母分隔/布尔措辞、控件 >12）或误判（暂停瞬间恰有其他 radio 组可见）；漏判走原暂停恢复/停止路径，误判最多点错弹题选项一次。取得真实弹题 DOM 后应按 compatibility §6.3 精确适配。
2. 只刷课模式与弹题枚举的端到端真实运行（真实视频播放、站点完成标记、连续推进）需用户重新加载 `apps/extension/dist` 后复测；e2e 覆盖的是弹题枚举的完整 MV3 桥路（真实视频回放受自动播放策略与站点前台要求限制，同 §9.21）。
3. 声音告警在真实浏览器的实际出声依赖启动按钮手势解锁的 `AudioContext`；系统静音/浏览器策略拒绝时静默降级为仅文字，本轮未在真实 Chrome 人工听测。
4. 弹题枚举会先提交错误选项再提交正确选项（按用户授权“只有对了才能继续，所以可以采用枚举”）。若某课程弹题判错即计分或锁定，需提供脱敏 DOM 改为一次性作答策略。
5. ~~`release/study-assistant-extension.zip` 需在所有并行写入停止后用最终 dist 重新打包~~ 已于 23:19 用包含弹题/只刷课/声音告警、非粘贴题与 model-json 的最终 dist 重新打包（787,575 字节），此前 23:17 快照测试 295/295、typecheck 0，23:18 重建后 MV3 e2e 21/21（1.1m）。

### 9.24 本地直连模型返回非法 JSON 导致整题/整轮失败（2026-10-19 23:0x–23:2x）

用户现场反馈（红色错误原文）：`模型返回的不是有效 JSON：{"status":"ANSWERED","selectedOptionIds":[],"blankAnswers":[{"blankId":"blank_1","answer":"Java虚拟机（JVM）"}],"textAnswer":，`——模型在 JSON 里写了全角逗号并在 `textAnswer` 处中止，已生成的 `blankAnswers` 被整段丢弃。用户原话：「难道没有考虑这种情况吗」。

**根因（代码审计，两处独立缺口）**

1. `apps/extension/src/local/provider.ts` 的 `parseJson` 只做「整段被 ``` 包裹时去掉围栏」的 `JSON.parse`。模型在 `response_format=json_object` 下仍可能输出前后缀文字、全角标点（`，`/`：`/`“”`）、围栏、尾逗号、未转义的内层引号或字符串内原始换行，并在输出预算用尽时停在对象中间；任何一项都会抛错，示例中已完整的 `blankAnswers` 也被丢弃。
2. 本地直连抛出的普通 `Error` 没有 `code`；`automation/runner.ts` 的 `QUESTION_SCOPED_CODES` 只识别 `UPSTREAM_INVALID_OUTPUT`/`UPSTREAM_TRUNCATED`/`VALIDATION_ERROR`。于是单题 JSON 抖动从「转人工、其他题继续」（课程文档既有承诺）升级为整轮 `ERROR`。

**修复内容**

| 文件 | 变更 |
|---|---|
| `local/model-json.ts`（新增） | 纯语法修复 `recoverModelJson`/`recoverModelJsonCandidates`：按顺序尝试每个 `{`（含全角 `｛`）为起点提取首个配对完整的对象（字符串感知，支持全角括号/引号定界）；归一化全角结构标点 `，：；｛｝［］`、不可见空白；容忍未加引号的键/枚举值、`None`/`nil` 等 Python 空值（转 `null`）、字符串内原始换行/制表符、尾逗号（含全角逗号）、未转义内层引号、单元素数组包裹、二次 JSON 字符串编码；截断时闭合字符串、丢弃半截 `"key":`、按栈补 `}`/`]`，仍失败则回退到最后一个逗号（≤6 次）。每个候选带**可信度标记**：`truncated`（对象未闭合/丢尾/回退过）与 `uncertain`（引号启发式改动过字符串边界） |
| `local/provider.ts` | `askLocalProvider` 最多 3 次尝试：仅「无法解析/空内容/截断/引号不确定」时追加格式纠正消息重试；`finish_reason=length`（Responses 为 `incomplete`/`max_output_tokens`）时输出上限 2048→4096。**只有 `truncated=false && uncertain=false` 且通过题目校验的候选才会被采用**——截断但恰好能通过字段校验的答案（多选只剩部分选项、填空答案被截半）一律重试，仍失败则报 `UPSTREAM_TRUNCATED` 转人工，绝不静默回填。错误分类：解析失败 `UPSTREAM_INVALID_OUTPUT`、空/截断 `UPSTREAM_TRUNCATED`、结构合法但语义非法 `VALIDATION_ERROR`（**不自动重问**，保持 architecture §11.3 不猜映射）。`validate` 防御性收敛非数组/非字符串形状，填空答案必须与 `blankId` 一一对应且非空；提示词补充「只输出 JSON 本体、英文半角标点、括号引号完整闭合、字符串内不出现原始换行」 |
| `automation/runner.ts` | 单题失败原因文案改为「不是有效 JSON 或答案不合法」，与新增分类一致 |
| `tests/model-json-repair.test.ts`（新） | 18 项：用户样例、前后缀+围栏、全角定界符+尾逗号、未加引号键/枚举、Python 空值、原始换行、全角引号作内容、内层引号（含全角逗号变体）、未闭合字符串/半截键、漏逗号回退、数组包裹、二次编码、全角花括号（含 ASCII 数组）、前导占位对象、无对象报错 |
| `tests/local-provider.test.ts` | 新增 8 项：用户样例触发重试而非采用半成品、填空被截半仍重试、漏逗号多选绝不静默丢选项、全部截断报 `UPSTREAM_TRUNCATED`、解析失败重试（含纠正提示）、截断提升 token 上限、3 次后 `UPSTREAM_INVALID_OUTPUT`、语义非法单次 `VALIDATION_ERROR`、空内容重试 |

**对抗性审计驱动的加固**：只读子代理以 83 个畸形样例（修复器 51 / provider 31 / 共识 1）审计首版，发现 5 类「错误成功」（漏逗号回退丢多选选项仍标完整、答案文本内 ASCII 引号+全角逗号被误判字符串结束、截断但通过校验不重试、`None` 被加引号成字符串、截断前缀恰为合法选项 id）。据此引入 `truncated`/`uncertain` 可信度标记与「不可信候选不采用」策略，并复核修复：全部高危样例现均触发重试或转人工，无一静默通过。

**安全边界（不变）**：修复只做语法归一化，不生成/替换选项 ID、空格 ID、答案或解析内容；不可信（截断/引号不确定）的修复结果绝不进入自动回填；修复后的对象仍按题目逐字段校验；模型文本按纯文本渲染、不执行；不新增权限、不落库题文/答案、不提交；后端 `/study/answers` 契约不变。

**Verified（本轮实际执行）**

| 检查 | 命令 | 结果 |
|---|---|---|
| 扩展测试 | `npm run test -w @study/extension` | **26 文件 / 302 项通过**（23:19 最终源码；含本节 26 项新用例与并行会话全部改动） |
| 类型检查 | `npm run typecheck` | 4 workspace 通过（exit 0） |
| 扩展构建 | `node scripts/build-extension.mjs` | 成功；默认后端 `http://127.0.0.1:8080`；共享块含「重试要求」「未自动采用不完整的答案」「无法可靠判定的引号」等新逻辑 |
| MV3 真实浏览器 | `npm run test:e2e`（最终 dist + mock 契约后端） | **21/21 通过（1.0m，23:20）**，含弹题枚举、非粘贴题与既有全部用例 |
| 契约 | `node scripts/verify-contracts.mjs` | PASS（21 端点 / 25 错误码 / 91 字段） |
| 发布包 | `release/stage/extension` 重新暂存 + `python release/make_zip.py` | **0.76 MB**，manifest 指向 8080，共享块含本节修复（23:21，覆盖 §9.23 记录的 23:19 中间快照） |

**仍未验证**

1. 真实供应商（DeepSeek 等）上的重试与截断恢复需用户重新加载 `apps/extension/dist`（或解压新 release 包）后复测；模型持续输出不可修复内容时仍按单题转人工补答，不会静默回填错误答案。
2. 单引号 JSON、注释、`key=value` 等更罕见形态不做修复，由有界重试兜底后转人工（对抗审计确认其失败路径安全）。
3. 答案文本内「ASCII 引号 + ASCII 逗号」的歧义无法语法判别，标记 `uncertain` 后重试；若真实模型高频出现，可再按站点反馈迭代。

### 9.25 截断修复过度保守导致填空题全部转人工（2026-10-20 09:0x–09:1x）

用户真实复测反馈（加载 §9.24 的 23:2x dist 后重跑同一章节测验）：6 道填空题页面全部显示「No.1：」且答案为空——没有任何自动回填发生。

**根因**：§9.24 把「对象被截断」整体视为不可信。该供应商的模型经常在 `textAnswer`/`explanation` 等**非答案字段**处截断（`blankAnswers` 本身已完整终止，正如用户最初上报的 `...,"textAnswer":，` 样例），于是每题都被判 `UPSTREAM_TRUNCATED`、全部转人工。审计要求的 5 类「错误成功」里真正危险的只是**答案字段本身被修复动过**（多选丢选项、填空答案被补全引号、`opt_1` 是 `opt_10` 前缀），解析/说明字段被截断并不影响已完整终止的答案。

**修复内容（按字段归因的采用策略）**

| 文件 | 变更 |
|---|---|
| `local/model-json.ts` | `RecoveredJson` 新增 `affectedKeys`：未闭合字符串归属其所属键（`answer`/`explanation`/…）、未闭合数组归属其所属键（`selectedOptionIds`/`blankAnswers`）、被丢弃的半截 `"key":` 与回退丢尾按键名归因、归因不到记 `""`（保守视为触及答案）；根对象自身闭合不归因 |
| `local/provider.ts` | 新增 `answerKeysOf(question)` 按题型给答案字段（选择/判断=`selectedOptionIds`；填空=`blankAnswers`+`answer`；简答=`textAnswer`；UNKNOWN=全部）。截断/引号存疑的候选**触及答案字段才重试**（重试后仍如此报 `UPSTREAM_TRUNCATED` 转人工）；只伤及非答案字段的候选直接采用，并在 caveats 首位标注「模型输出不完整或格式存疑，但答案字段本身完整，已采用；解析内容可能缺失」 |
| `local/provider.ts` 提示词 | 填空/简答新增格式约束：只写空格中应填的标准答案本身（最常用单一写法）、禁止括号别名（『JVM（即时编译）』应写『JVM』）。背景：上一轮真实得分显示站点疑似按字符串精确匹配——『JVM』得 7.7 分而『Java虚拟机（JVM）』等带括号写法 0 分 |
| 测试 | `tests/model-json-repair.test.ts` 20 项（新增 affectedKeys 归因断言：截断填空归因 `answer`、未闭合选项数组归因 `selectedOptionIds`、未闭合 explanation 归因 `explanation` 且不影响选项）；`tests/local-provider.test.ts` 19 项（新增：用户样例零重试采用+caveat、截断简答重试、截断 explanation 的选择题采用+caveat、全部截断触及答案时报 `UPSTREAM_TRUNCATED`） |

**对抗样例复核（本轮实测，13 例探针）**：用户样例（填空，尾部悬空 `textAnswer`）→ **采用**；截断填空答案文本 / 截断多选数组 / `opt_1` 前缀 / 漏逗号丢选项 / 双逗号 / 数组后垃圾 → 归因到答案字段、**重试**；截断 explanation 的选择题 → 采用+caveat；简答截断 `textAnswer` → 重试；答案文本内引号存疑 → 重试；explanation 内引号存疑但答案完整 → 采用。

**安全边界（不变）**：修复仍纯语法、不猜答案；答案字段被修复动过的候选绝不自动回填；采用「非答案字段受损」的候选必须通过逐字段校验并显式 caveat；不新增权限、不落库、不提交。

**Verified（本轮实际执行）**

| 检查 | 命令 | 结果 |
|---|---|---|
| 扩展测试 | `npm run test -w @study/extension` | **26 文件 / 307 项通过**（09:15 最终源码） |
| 类型检查 | `npm run typecheck` | 4 workspace 通过 |
| 扩展构建 | `node scripts/build-extension.mjs` | 成功；默认 8080；共享块含 `affectedKeys`/「答案字段本身完整」/「禁止括号别名」 |
| 契约 | `node scripts/verify-contracts.mjs` | PASS |
| MV3 真实浏览器 | `npm run test:e2e`（新 dist + mock 契约后端） | **21/21 通过（1.2m，09:18）** |
| 发布包 | 重新暂存 `release/stage/extension` + `python release/make_zip.py` | 0.76 MB（09:19），共享块已含本节逻辑 |

**仍未验证**

1. 用户需重新加载 `apps/extension/dist`（或解压新 release 包）后重跑该章节测验：确认填空题恢复自动回填，且答案采用无括号的简写形式得分。
2. 「站点按字符串精确匹配」是从上一轮得分推断的，未取得站点判分规则证据；若重跑后简写仍 0 分，需按具体题目反馈再调整填空答案策略（例如取多次采样的一致写法）。
3. 填空答案的括号别名靠提示词约束，未做答案内容的自动改写（不猜判分器期望的写法）。

### 9.26 纯图片题未解决：自动原图直发与自动二次处理（2026-10-20 09:2x–09:4x）

用户现场反馈：**「也有纯图片的题目，你没有得到解决，所以我需要你帮我解决这一问题，当无法读取的时候就发送图片，原版数据过去，当然这里可以采用二次处理，不过我希望二次处理也是自动的，最终实现完全自动化」**。即：文字无法读取的纯图片题（以及模型报告「图片不清」的题）此前只会进人工汇总，用户需要手动复制图片给模型才能得到答案；要求把「原版图像数据」的发送与二次处理全部自动化。

**根因（代码审计，三处独立缺口）**

1. `runner.ts` 的题图失败三分支中，纯图片题（`needsImage=true && textUsable=false`）直接 `issue()` 进人工清单，**从不尝试任何图像通道**；`textUsable=true` 分支也只发一次纯文字请求。
2. `imageIsUnclear(first)`（模型回答「图片不清/无法看清」）直接 `issue()` 转人工并明确「已跳过重复调用」，**没有第二次图像尝试**。
3. 只有一条图像通道——`renderQuestion()` 的合成画布（布局缩放 ≤1.5、JPEG 0.9、单图 ≤400000 字符）。原图原尺寸数据从未被读取，合成图质量不足或合成失败（跨域画布/超限/文本遍历异常）时无补救。

**修复内容（全自动，无需人工介入）**

| 文件 | 变更 |
|---|---|
| `automation/protocol.ts` | `AutomationCommand` 新增 `imagePass?: "render" \| "originals"`（仅 CAPTURE、严格字面量；其他动作或非法值丢弃，退回合成渲染）；`TaskQuestion` 新增 `imageSource`（`render`/`originals`）诊断标记 |
| `render-question.ts` | 新增 `extractOriginalImages()`：只读已验证题干结构（`.Zy_TItle`/`.Zy_ulTop`）内可见 `<img>`，**按 naturalWidth×naturalHeight 原尺寸**读取；跨域图仍需正常 CORS 匿名读取（不绕过）；隐藏/坏图跳过、含音视频/嵌入框架直接拒绝；按面积降序最多 3 张；每张先 PNG，超 400000 字符转 JPEG 0.92，仍超按 0.8 步进有界降尺度；所有图像合计约 460000 字符封顶，保证请求体不超过后端 `maxRequestBytes=524288` |
| `course-page.ts` | `capture(index, forceImage, imagePass)` 新增 `originals` 通道：最大原图进 `imageDataUrl`、其余（≤2 张）进 `extraImageDataUrls`；无可用原图按 `IMAGE_UNREADABLE` 返回具体原因 |
| `runner.ts` | worker 内新增 `originalImagePass()`；三条触发路径全部自动先走原图通道再考虑人工：①纯图片题合成题图失败 → 自动改发原图继续正常作答（一次命中即回填）；②文字可读但题图必要且合成失败 → 先改发原图，原图可用则按带图题作答，不可用才走文字候选+人工；③`imageIsUnclear` → 自动改发原图重试，原图可读则沿用既有共识（一次命中即采用、不确定追加两次、无多数取最高票），原图样本与合成图样本不混投票。两轮都失败才进人工，卡片同时给出两次失败原因；原人工重试入口保留 |
| `contracts/study.ts` + `docs/openapi.yaml` | `StudyQuestion` 新增可选 `extraImageDataUrls`（≤2 张、每张 ≤400000 字符、`data:image/(png\|jpeg);base64`，拒绝远程 URL；总量须在 body 上限内）；`verify-contracts` PASS（92 字段） |
| `local/provider.ts` | 多图输入：Chat Completions 按主图→原图顺序发多个 `image_url` 块，Responses 发多个 `input_image` 块；去重；文本块仍不含 base64；提示词改为「一或多张图像逐张结合阅读，所有图像均无法看清才 NEEDS_CONTEXT」 |
| 测试 | 新增 15 项：`render-question.test.ts` 原图提取 6 项（原尺寸、隐藏跳过、全坏报错、媒体拒绝、超限自动降尺度、跨域涂污报错）、`automation-runner.test.ts` 自动原图二次处理 3 项＋更新 1 项、`automation-course-page.test.ts` originals 通道 2 项（原图提取、无原图报错）、`local-provider.test.ts` 多图 1 项、`automation-protocol.test.ts` imagePass 解析 1 项 |

**安全边界（不变）**：原图只来自用户已选定题目容器内的可见 `<img>`，不截屏、不读 MediaStream、不新增任何浏览器权限；跨域原图仍必须通过正常 CORS 匿名读取，被污染画布按题报告；远程图像 URL 仍被拒绝；单图 ≤400000 字符、附加图 ≤2 张、总量约 460000 字符封顶，不突破后端 524288 字节 body 上限；题型/选项校验、2/3 多数共识、回读一致才提交、单次提交、正式考试与未知任务拒绝等约束不变；两轮图像都失败只降级为人工补答，绝不猜测、不跳过完成核验；题目与答案仍不落库。

**Verified（本轮实际执行）**

| 检查 | 命令 | 结果 |
|---|---|---|
| 扩展测试 | `npm run test -w @study/extension` | **26 文件 / 330 项通过**（09:38 最终源码；含本会话新增 15 项与并行会话改动） |
| 类型检查 | `npm run typecheck` | 4 workspace 通过 |
| 扩展构建 | `node scripts/build-extension.mjs` | 成功；默认 8080；dist 含 `imagePass`/`extraImageDataUrls`/原图提取逻辑 |
| 契约 | `node scripts/verify-contracts.mjs` | PASS（21 端点 / 25 错误码 / 92 字段） |
| MV3 真实浏览器 | `npm run test:e2e`（新 dist + mock 契约后端） | **21/21 通过（55.2s）**，含纯图片/模糊题、非粘贴题、视频弹题等全部既有用例 |
| 发布包 | 重新暂存 `release/stage/extension` + `python release/make_zip.py` | **0.76 MB**，manifest 指向 8080 |

**仍未验证**

1. 真实学习通页面上的纯图片题需用户重新加载 `apps/extension/dist`（或解压新 release 包）后复测：合成题图失败/模型看不清时应自动改发原图并回填，人工汇总只在两轮都失败时出现。
2. 原图能否读取取决于站点图像主机的 CORS 策略（脱敏证据记录题内图片来自当前站点和 `p.ananas.chaoxing.com`）；若真实主机不允许匿名读取，会按题给出具体原因并保留人工兜底，不绕过。
3. 多图请求（主图+2 张原图）在真实供应商上的多模态接受度与计费需复测；总量封顶按字符数估算，未对每种供应商的图片数量上限做穷举验证。




### 9.27 独立作业/测验作答页纳入刷题自动运行（2026-10-20 09:3x–09:5x）

用户截图：调度页 `ERROR · 已停止，需要人工处理`，红色错误原文 **「只允许在课程任务页面运行。」**，本轮 0 题、0 个完成；用户原话 **「这也算上，可以刷题」**，并给出该标签真实地址路径：学习通课程域的 `/mooc-ans/mooc2/work/dowork` 作答页（带 `courseId`/`classId`/`workId`/`answerId` 参数；仓库不保存完整 URL 与课程标识）。澄清确认后授权：**把这个页面也纳入可运行/刷题范围，自动作答+回填+逐题回读核验后自动点站点提交**。

**根因（两处独立缺口）**

1. `course-page.ts` 的 `inspect()` 把可运行页面写死为 `/mycourse/studentstudy`；从课程「作业/测验」任务点单独打开的作答页在第一次 `INSPECT` 即被拒，调度页只显示泛化错误。
2. `runner.ts` 的调度循环只处理「课程任务点 + `#prevNextFocusNext`」任务链：没有下一任务的单卷作答页即使通过页面校验也没有「整卷作答→核验→提交一次→结束」的路径。

**实现**

| 文件 | 变更 |
|---|---|
| `automation/protocol.ts` | `TaskSnapshot` 新增可选 `standalone`：独立单卷页（无任务链）标记 |
| `automation/course-page.ts` | 新增 `isWorkPagePath()`（仅 `/mooc-ans/mooc2/work/dowork`，忽略末尾斜杠）与 `isExamPath()`（统一正式考试拒绝）；`inspect()` 对作业页返回 standalone 快照：`courseKey`=`courseId+classId` 派生、`taskKey`=`workId` 派生（不读取题文、不落库课程标识）、`hasNext=false`、题数=已适配题目容器数；完成证据=结果视图明确的「提交成功/已提交/提交完毕/交卷成功/查看答案/重新作答」**文本节点**（跳过 `script/style` 等非渲染内容——首版按 `body.textContent` 误把页面脚本里的“提交成功”字样当成结果视图，已由 e2e 暴露并修正），或本页已点提交且作答视图消失（题面与提交控件都不再出现，仅隐藏提交按钮不算）；提交按钮搜索抽为 `submitControls()`/`submitSearchDocuments()`，与既有多文档语义一致 |
| `automation/runner.ts` | 新增 `runStandaloneWork()`：整卷读取→并发作答→排序回填→逐题回读核验→`SEND_WORK` 只点一次→`CONFIRM_WORK`→60 秒内有界等待可核验完成；只刷课模式在作业页直接拒绝；无下一任务，确认后 DONE；提交后页面跳转或连续三次读不到快照时**如实结束**（不重复提交、不宣称核验、不计完成）；站点提交后离开作业页（如返回课程任务页）计为已提交完成 |
| `shared/pages.ts` + `sidepanel/bridge.ts` | 页面路径判定抽为共用纯函数（课程任务页/作业页/考试路径，避免两处正则漂移）；侧边栏「读取当前题目」在作业/测验作答页也直接打开课程调度器，不再落到“计分页面不支持”的手动提示 |
| 测试 | 课程页 6 项（独立页快照、路径与考试判定、未填满拒提交、重复提交拒绝、完成证据两条路径、仅隐藏提交按钮不算完成）；runner 5 项（单卷只提交一次且不 NEXT、只刷课拒绝、已提交不重答、页面跳转后如实结束、跳转离开作业页计完成）；侧边栏路由 1 项；新增 MV3 端到端用例与 `tests/fixtures/automation-work.html` |

**安全边界（不变）**

- 只新增**已确认的这一条**路径；`/exam`、`/examination` 正式考试路径仍拒绝（在 `inspect()` 首页统一检查），未知页面结构仍停止。
- 提交仍受既有约束：整卷逐题回读一致才允许提交、唯一提交按钮、单次提交；缺题、回读不一致、按钮不唯一一律停止，不重复提交。
- 完成判定不推断成绩：只有明确结果文案或「本页已提交且作答视图消失（题面与提交控件都不再出现）」才计完成；仅隐藏提交按钮而题面仍在（可能在提交中）不算完成；页面跳转无法核验时明确显示「站点未返回可核验的完成标记，请人工确认结果」。
- 不新增浏览器权限、不读取 Cookie、不落库题文/答案；作业页复用已记录题库 DOM 结构，未新增猜测性站点选择器。

**Verified（本轮实际执行）**

| 检查 | 命令 | 结果 |
|---|---|---|
| 扩展测试 | `npm run test -w @study/extension` | **26 文件 / 332 项通过**（含本轮新增课程页 6 项、runner 5 项、侧边栏路由 1 项；09:52 最终源码） |
| 类型检查 | `npm run typecheck` | 4 workspace 通过 |
| 扩展构建 | `node scripts/build-extension.mjs` | 成功；默认 8080；`runner-BH0FVheM.js` 含 `standalone` 分支 |
| 契约 | `node scripts/verify-contracts.mjs` | PASS（28 接口 / 92 字段） |
| MV3 真实浏览器 | `npm run test:e2e`（新 dist + mock 契约后端） | **22/22 通过（1.2m）**，新增「独立作业/测验作答页整卷回填核验后只提交一次并无下一任务」用例（整卷 2 题→回填核验→`send=1`/`confirm=1`→结果视图确认→DONE） |
| 发布包 | 重新暂存 `release/stage/extension` + `python release/make_zip.py` | **0.76 MB**（09:54），manifest 指向 8080；`page/automation-entry.js` 含 `standalone`/`dowork` 分支 |

**仍未验证**

1. 真实 `/mooc-ans/mooc2/work/dowork` 页的**外层 DOM 未取得脱敏证据**（用户选择先按已记录的题库结构实现）。需用户重新加载 `apps/extension/dist`（或解压新 release 包）后在该页复测：整卷回填→回读核验→点击站点提交一次→结束后显示「作业页刷题完成，站点已确认提交」或如实的未核验提示。
2. 真实站点提交后是留在结果视图还是跳转、结果文案是否命中上述文本签名，均待实测；若外层结构与题库组件不同，扩展会在「题目结构未识别 / 无法唯一确认站点提交按钮 / 提交结果未核验」处停止，不会误点或重复提交。
3. 正式考试路径拒绝依据路径与既有考试识别；未对每一种考试皮肤做穷举验证。


### 9.28 普通图文卡片不再中断课程任务链（2026-10-20 10:0x）

**需求与根因**：用户截图显示测验完成后在「每节一句」图片卡片报未知类型，并明确授权这类情况自动寻找下一任务点。当前适配器仅把无任务标记 PDF 识别为 MATERIAL，普通静态卡片落入 UNKNOWN。新增严格的静态内容识别，沿用站点 Next 与现有任务链，不把任意 UNKNOWN 当成可跳过页。

**真实 DOM 证据**：Chrome 当前 cards 框架 `#pageDiv.ans-cc` 后代只有 H2/SPAN/IMG/P/BR，图片已加载，0 任务标记、0 子 iframe、文档 complete；顶层 Next 唯一可用。站点正常 Next 已进入下一章节（初始 PDF 卡片、有未完成任务标记），不宣称完成该 PDF。结构记录见 compatibility §6.5；两次真实截图采集均超时，以 DOM 和可访问树为证，不保存 URL 参数或页面 HTML。

| 检查 | 结果 |
|---|---|
| 扩展单测 | `npm run test -w @study/extension`：26 文件 / **347 项通过**；新增静态卡片识别与拒绝边界 12 项、连续任务链/末尾资源/无效 Next 3 项 |
| 类型检查 | `npm run typecheck` 通过；本次命令实际执行 contracts、extension 两个 workspace |
| 构建 | `npm run build -w @study/extension` 成功；默认本地后端 8080；无权限变更 |
| 契约 | `npm run verify:contracts`：28 接口 / 92 字段，PASS（存在性验证） |
| MV3 浏览器集成 | `npm run test:e2e`：**23/23 通过（1.1m）**；新增完成测验→图片格言→纯文字→下一测验链路；4 次请求，提交/确认各 2 次、Next 3 次；完成计数 2、资源计数 2 |
| 截图 | 合成链路最终 DONE 截图：`.local-demo/static-card-navigation-verified.png`，不是用户真实课程完成证明 |
| 发布包 | `release/study-assistant-extension.zip`：**15 文件，0.76 MB**；逐文件核对等于当前 dist，ZIP CRC 检查通过；同步覆盖 stage 生成文件，ZIP 直接从 dist 打包避免带入旧哈希资源 |

**未验证与剩余边界**：浏览器工具禁止访问扩展管理页，用户已打开的扩展仍是旧加载版本，需一次重新加载；没有声称已启动新版真实刷课或完成整课。真正带任务标记的 PDF、未知模块、站点未确认提交结果仍保留停止边界。无任务卡片 NEXT 前重新检查，不能利用此前的静态分类越过后来出现的未完成任务。

### 9.29 Resource Analysis 多空映射与跨域原图加载顺序（2026-10-20 12:4x）

**用户反馈**：代码图片题有两个空格，模型称未提供 blankId/程序代码，手工采用答案又报“答题控件在回填前发生变化”。

**根因与修改**：①UNKNOWN 类型即使两个文本输入区域仍被归为 SHORT_ANSWER；显式简答多空在读取/回填两侧判定也不一致。统一复用字段数量判定，发送 FILL_BLANK + 两个 blankId 并按 ID 回填。②模型说缺少代码/空白标记时原图重试未触发，新增该 NEEDS_CONTEXT 模式。③新增浏览器测试首跑实际失败（只发 1 次请求后进人工），查出原图加载 await 在 src 赋值之前，导致匿名跨域加载必超时；设置 src 移到等待之前。保留 CORS 及真实字段变化时拒绝写入。

| 验证 | 结果 |
|---|---|
| 扩展单测 | 26 文件 / **357 项通过**；新增课程页 5 项（3 标签多框、单框、真实数量变化拒绝）、共识 4 项、跨域图片加载顺序 1 项 |
| 类型与构建 | `npm run typecheck -w @study/extension`、`npm run build -w @study/extension` 成功；默认 8080，未改权限/契约 |
| 契约 | `node scripts/verify-contracts.mjs` PASS：28 接口 / 92 字段（存在性校验） |
| MV3 浏览器 | **24/24 通过（1.3m）**；新夹具 `automation-resource-blanks.html` 使用合成代码图片和两个 UEditor，首个 mock 回答“未提供具体程序代码、空白标记或选项”，自动改发 PNG 原图，第二次回答后两个编辑器分别为对应值，提交/确认各 1 次，人工汇总 0 |
| 实际请求断言 | 共 2 次；两次均 `FILL_BLANK`、`blank_1/blank_2`；第一张 JPEG、第二张 PNG 原图，不以图片字符串存在就冒充视觉模型实测 |
| 发布包 | `release/study-assistant-extension.zip` 15 文件 / 0.76 MB，CRC 通过，每个扩展文件逐字节等于最新 dist；stage 生成文件已覆盖更新 |
| 证据 | 合成最终状态截图 `.local-demo/resource-blanks-verified.png`；真实只读 DOM 记录 compatibility §6.6 |

**Unverified**：用户真实页面取证时已是提交结果视图，未重开修订或改动已提交内容；真实原始可编辑控件 DOM 未重新取得。代码图在当前结果视图的 `.Zy_TItle` 中，不能声称原选择器漏图或真实模型视觉能力已核验。浏览器工具仍禁止访问扩展管理页，当前 Chrome 未由本轮自动重载，新版真站回填要重新加载后用新调度页读取验证。

### 9.30 章节未完成提示自动返回/确认（2026-10-20 12:5x）

用户仅发新截图继续报告阻塞：Notice 提示当前章节有未完成任务，按钮 to learn / Next。旧 NEXT 没有提示确认分支，导航未变后 25 秒超时报错。真实 Chrome 只读取证：提示已消失，顶层 DOM 保留 `.jobFinishTip` 与 `#jobFinishTip` 两套隐藏模板，控件和正文见 compatibility §6.7；本轮没有点击用户课程、重交或修改答案。

新增绑定课程/任务的固定指令 CONFIRM_NEXT，正文与容器双重匹配、目标唯一且可见才操作，默认 to learn；只有原模式明确跳过且确认时任务类型仍匹配 VIDEO/QUIZ 才点 Next。同一可见按钮不轮询重复点击。启动时处理遗留提示，NEXT 后轮询迟到提示。返回同一任务键时撤回该卡片暂计计数、重读剩余任务并允许继续一次；同键反复返回则停止，避免循环作答或重复提交。没有修改站点完成标记、权限或公共后端契约。

| 验证 | 结果 |
|---|---|
| 单元测试 | **26 文件 / 370 项通过**；比 §9.29 新增 13 项：课程页 6（两皮肤默认返回/显式跳过且单次、未知任务不能跳过、隐藏/无关/不唯一拒绝），runner 6（遗留提示、同页重读与回退计数、两种模式、重复提示停止、视频跳过不能沿用到新测验），协议 1（绑定与严格布尔值） |
| 类型/构建 | extension typecheck、build 通过；最终源码含确认时任务类型重核；8080、权限声明保持原值 |
| 契约 | 28 接口 / 92 字段 PASS（存在性检查） |
| MV3 浏览器 | 最终构建完整 **26/26 通过（1.6m）**；新 fixture `automation-chapter-notice.html` 真实扩展桥、延迟 200ms 弹窗；刷课：to learn→原键加载测验→1 次模型请求→回填核验→提交/确认各 1 次，完成计数撤回后为 1；只刷课：先返回定位测验，再按模式 Next 确认，`next=2, learn=1, skip=1, send=0, confirm=0`、模型请求 0、题目跳过 1 |
| 发布包 | ZIP 15 文件 / 0.76 MB；CRC 与逐字节 dist 一致性检查通过，确认含 CONFIRM_NEXT；stage 已覆盖更新 |
| 证据 | 合成 `chapter-notice-learn.png` 与 `chapter-notice-skip.png`，复制至 `.local-demo/`；真实保留模板结构记录 compatibility §6.7 |

Unverified：用户原提示框在取证时已关闭，故仅真实 DOM 模板/截图确认，真实站点新版确认点击与连续完成仍未实测。浏览器工具禁止访问扩展管理页，不能自动重载用户当前扩展；需要覆盖实际加载的扩展目录并重载、关闭旧调度页后重开。没有声称整课已完成或未知页面均可无人值守。

### 9.31 全项目检查、结构化答案校验与更新菜单（2026-10-20，v0.2.0）

Version 0.2.0 passes the local test suites. Live course behavior, real provider accuracy, and public update deployment remain unverified. Full evidence: [project audit](project-audit-2026-10-20.md).

用户要求扫描项目、排查结构化输出发散/填空错位/误多选、打包给地址与用法，并要求开发后其他用户通过下拉更新。基于现有实现最小修改：严格状态与按题型字段校验，拒绝对象填空与混合字段；明确空格编号别名映射；控件标识/顺序进入写入前指纹；不确定答案追加两次、无多数/并列不自动采用；精确真假和重复选项文字匹配；模型列表 body 超时、手动 Base URL 输入清除草稿 Key。既有题型标签/裸列表/contenteditable 修复保留。

新增三个页面的更新下拉，支持商店检查和可配置 ZIP 更新源，数字版本防降级、10 秒/16 KB 限制、具体 Origin 授权、请求不含供应商凭据与课程内容；没有自动运行远程代码或强制 reload。Windows 解压版需要用户覆盖原目录并重载；未部署公共清单/商店。统一打包脚本生成 ZIP、SHA-256 与相对 URL 的 update.json，新增锁文件，不新增依赖或 manifest 权限。同步 README、使用说明、课程调度、兼容性、隐私范围与发布文档。

| 本轮执行 | 结果 |
|---|---|
| extension unit | **27 文件 / 403 通过** |
| contract unit / consistency | **11/11**；21 endpoints、25 errorCodes、28 interfaces、92 fields PASS |
| typecheck / build | 全部通过，manifest **0.2.0** |
| Fixture / MV3 browser | **22/22 + 28/28 通过** |
| 本地直连回填证据 | 合成上游第一份混合字段拒绝、第二份显式 2/1 空格编号正常匹配两个 UEditor，2 请求、提交/确认各 1、产品后端答题请求 0 |
| 更新与 Key 证据 | 合成 0.3.0 显示下载链接；0.1.0 不降级；重载保留清单配置；请求无认证/Cookie/请求体；手动更改 API 地址后草稿 Key 为空 |
| 发布包 | **0.2.0 / 15 文件 / 0.77 MB**；ZIP CRC、全部 dist 文件与当前使用说明逐字节一致，SHA-256 与 update.json 一致；未含源码、map、.env、node_modules |

完整根因、测试命令和截图路径见 [本轮检查](project-audit-2026-10-20.md)。契约测试旧的“20 接口”硬编码已替换为与架构表逐项比较。`npm audit` 因镜像 API 不实现及官方 registry TLS 失败未取得报告，不标记通过。真实学习通本轮行为、真实模型视觉/答案正确性、实际商店升级与公共托管尚未验证；本轮没有提交真实题目或声称完全无 bug。

### 9.32 延迟 UEditor 漏空和假题目变化（2026-10-20，v0.2.1）

The adapter omitted closed blank editors. Fixed-format prompting is now based on the full, stable blank list. Real DOM was inspected read-only; filling and submission were verified on synthetic fixtures.

用户贴出第6/7/8/11/12/16/17/18题：模型有答案但 APPLY 全部报“题目内容已变化”，两空只读一空、五空被视为简答。真实课程只读取证确认 `.blankItemInp > .InpDIV + .textDIV`、隐藏 textarea 与 UEditor 组合，第6/12/16/17题分别2/5/2/3个逻辑位置；具体脱敏结构见 compatibility §6.8。本轮没有点击用户课程、填写或提交真实题目。

旧 describe 点开所有占位位置后立即按可见 iframe 计数；异步初始化与切换让数量少读，指纹又随可见编辑器改变。现按唯一且稳定的逻辑位置/对应存储字段ID计数，捕获不激活，逐空点击站点自身控件、等就绪再写入；等待后再次重核题文与位置，实际换题/换序/只读/禁用仍拒绝。工具图标不作题干图片；不绕过指纹、不改隐藏 textarea、不强制显示或执行模型代码。

完整题干和代码沿既有源读取通道发送，填空附 blankCount/requiredIds/完整 responseTemplate；漏空触发最多3次格式重试，不能把五空塞一个 textAnswer。Resource Analysis、Entry 等符合逻辑空格布局时按多个填空返回。

| 本轮验证 | 结果 |
|---|---|
| unit | **27文件 / 407项通过**；新增逻辑五空稳定计数、编辑器显隐/工具图标不影响指纹、换序改变指纹、只读拒绝、加载中真换题零写入、完整模板与漏空重试 |
| 类型/构建/契约 | 根 typecheck/build 成功；21接口、25故障码、28类型、92字段存在性检查 PASS |
| MV3 | **29/29 通过（1.5m）**；新增3题分别2/5/2空，初次读取激活0次/iframe0个；逆序模型回答逐空回填，9次激活，提交/确认各1次，3次模型请求，人工汇总0 |
| 发布包 | **v0.2.1 / 15文件 / 0.77MB**，直接从最终 dist 打包，CRC和逐字节一致性通过；同目录 update.json/SHA-256 同步生成 |
| 证据 | `.local-demo/lazy-blanks-verified.png`（合成）；真实结构记录 compatibility §6.8 |

仍需用户重载扩展、刷新课程、新开调度读取后验证真站行为；旧运行缓存的错误空格数不会自动纠正。没有声称真实AI答案正确或真站新版自动完成已验证。详见 [本次修复](blank-editor-fix-2026-10-20.md)。

### 9.33 整题图片二次直填、逐题双入口与录入反馈（2026-10-20，v0.2.2）

Whole-question image retries and independent manual entry pass local validation. The image-stage answer is used directly, without older-answer voting. Live course and real vision-provider behavior were not exercised.

用户要求图片选项无法读取时第二阶段无论原路径如何都发送整题与全部选项图，直接采用第二阶段结果；先展示模型回答，每题图片重试回写/直接录入两个主要入口，解决录入无反馈。

实现：CAPTURE 增加内部 whole 模式并端到端传递，整题绘图包含已支持的主题选项列表与 opt_N 边栏标识；首次缺上下文/看不清/输出不可用走完整图片第二阶段，完整可映射的图片答案即便有不确定说明也直接回填，不与旧样本投票。图片能力关闭时明确拒绝而非删图改发文字。保留损坏/CORS失败、缺答、非法ID、正式考试、只读、真实题目变化和回读守卫。

补答先展示模型原始回答，候选预填到可编辑区域；主要按钮「采用图片重新发送并回写」「一键录入本题」。后者允许待答子集，不再被其他未填写题目阻止；草稿按任务/指纹保留，列表或样本变化不擦掉用户输入；失败/成功在当前题旁明确显示。网页核验缺答列出题号。ERROR监测停止后允许图片补答恢复；停止中的请求返回后不写入。

| 最终验证 | 结果 |
|---|---|
| 单测 | **27文件 / 418项通过**，覆盖图片模式传递、全部图选项/标签、强制图片拒绝文字降级、子集录入、图片失败、缺答反馈、ERROR恢复和停止后不回填 |
| 类型/构建 | 根 typecheck、build 通过；版本0.2.2，未新增依赖或manifest权限 |
| 契约 | **11/11 单测通过**；21接口/25故障码/28类型/92字段存在性校验PASS（公开后端契约未变） |
| MV3 | **30/30通过（1.9m）**；合成图片选项第1次需上下文、第2次即使有不确定说明仍回填B；第2题图片按钮回填、第3题先空录入报错、输入草稿在第2题请求后保留，最后逐题录入成功才提交/确认各1次，总请求5次 |
| 产物 | **0.2.2 / 15条目 / 0.77MB**；ZIP CRC、dist及当前使用说明逐字节一致，update.json的实际SHA-256一致，根/扩展/锁文件/manifest版本一致 |
| 截图 | `.local-demo/image-retry-and-entry.png`（合成，已检查双入口和反馈界面） |

包SHA-256：`61494cff1f5fd1dc56b252d1884651d4babadb7b08e7b926b1840fe31d65aa16`。

本轮没有对用户真实课程作答/提交、没有发送真实模型请求，也没有新增截图或绕过跨域能力。模型视觉能力与答案正确性仍需实际配置验证。使用前停止旧运行、关闭旧页、重载扩展并刷新课程后新开调度。完整流程与边界见 [image-retry-entry-flow.md](image-retry-entry-flow.md)。


### 9.34 边扫描边发送、后台图片重试与运行中可查看（2026-10-20，v0.2.3）

Incremental scanning dispatches the first request before later source reads complete. Preview/copy controls remain available during requests. Empty-output parsing now accepts text parts and flat output_text, with separate reasoning-only diagnostics.

真实根因（代码可确认）：旧Chat解析器String(content)不支持文本分段；Responses只读嵌套output遗漏扁平output_text。旧UI把预览/复制按钮绑在整个running状态，runner先等READ_ALL全部结束。没有截图那次供应商原始响应，因此不能确定该次是结构兼容、真实空回答还是仅推理耗尽额度。当前只在明确推理且截断时有界增加至8192，不解析推理为答案，不记录题文/凭据。

实现：绑定课程/任务/题号的READ_ONE复用describe；三工作者边读边发、请求池2/图像扫描池2，答案汇总后按题号写入。首次拒答/可恢复输出失败、上下文不足与看不清，及追加共识仍未决，自动完整题图第二阶段；二次完整答案直接采用，最终失败才人工汇总。第一阶段文字参考失败也继续自动图片尝试。明确必需图像时不允许text-only配置静默删图。

UI：任务模式下拉＋单开始按钮；删除侧边栏手工输入入口及过期引导。逐题预览独立忙态并最多2个并行，复用本任务图像缓存，拒绝跨任务/指纹错配；模型运行中可展开/看图/复制/下载，不新增模型请求。人工图片请求不再禁用整张卡片的查看与复制，可编辑其他题草稿，网页写入仍互斥。长文本绘图每128字让出事件循环，滚动保持相对坐标，布局尺寸变化则报错重读。

验证记录：

- Verified：**27文件 / 430单元测试通过**。新增文本分段/扁平输出/null/仅推理额度及不降低额度、首题先发晚题仍待扫描、自动图片先于人工、长题可响应输入/滚动/布局变化测试。
- Verified：根typecheck、build通过；契约11/11及21接口/25故障码/28类型/92字段存在性通过。无新增依赖、manifest权限、真实站点选择器。
- Verified：完整MV3 **31/31通过（1.9m）**；最终仅复制按钮解锁与缩进调整后的包再次运行“运行中仍可展开”用例，**1/1通过（8.7s）**。模型响应挂起时可展开、读取题图、复制、停止，模型请求数不增加；图像/录入补答用例额外确认首次拒答自动图片重试后，最终仍未解才出现两个补答入口，总7次模型请求且提交/确认各1次。最终界面相关9单测再次通过。
- Verified：包 **0.2.3 / 16条目 / 0.77MB**，ZIP CRC、dist所有文件与使用说明逐字节一致；根/扩展/锁文件/manifest/feed版本一致，ZIP摘要文件及feed SHA-256一致。截图`.local-demo/async-preview-0.2.3.png`（合成，已检查界面）。

包SHA-256：`faa493c599620cd02fdcb9d1605949d432dcb264c0ddb9dd3d5ab4d2796c4f35`。

Unverified：真实课程新版完整交互、真实视觉模型的输出形态与答案正确性；本轮没有发送真实付费模型请求或修改真实课程。


### 9.35 彩色题号签到表、Markdown/图片双栏与大图（2026-10-20，v0.2.4）

Both UI requests are implemented together. A compact numbered board replaces the vertical list; each question opens a Markdown/image dialog. Encoded image size no longer causes the local 400 KB rejection or original-image budget compression.

实现：新增QuestionBoard组件，复用现有语义色。绿色是源文字读取，蓝色是必需图像/原图/二次整图，红色是最终未回填且未补答的题，优先级最高。普通文字额外附图不变蓝，单纯查看图像不改变处理路径。补答核验后清除红色。题号含文/图/!与可访问标签，20题仅两行；最多264px滚动容纳长清单。点击题号或补答查看按钮打开原生dialog，左侧纯文本Markdown，右侧完整图像，独立滚动、原尺寸、复制下载、上一/下一题、Esc关闭；移除补答卡重复的大图/题文。列表/指纹失效自动关闭旧窗口。预览不发送模型，后台调度继续。

大图：renderQuestion删除400000字符拒绝；extractOriginalImages删除400000/总460000预算及重复JPEG/缩放循环，优先原尺寸PNG。极大原图仅按6400万像素/最长边16384控制画布分配；合成图既有布局尺寸与14000字符边界仍在。保留CORS/不可读图像/只读/考试/任务变化及完整答案核验。独立版直连Chat/Responses无旧后端字节上限；没有把历史OpenAPI后端限额伪称已修改。

- Verified：27文件、**432单测通过**；最终统一补答查看按钮后相关UI **9/9再通过**。新增700000字符合成图、两张超旧总预算原图仍原尺寸PNG、900000字符图经两协议原样发送回归。
- Verified：最终根typecheck、build通过；无新增依赖、权限或站点DOM选择器。
- Verified：最终重点MV3 **4/4通过（29.2s）**：题变拒写；真实浏览器合成与二次整图请求均>400000字符仍核验提交；红蓝状态与补答后恢复；20题两行<150px，模型挂起时双栏查看/复制/切题/Esc不新增模型请求，后台最终20次请求完成。另一次较早全套执行30通过、最后一例测试断言用了错误题干而失败；随后全套遇changed-question的1500ms自动变化测试前置竞争，不能声称最终版本31/31干净全跑。测试改为确保采集后再实际变更题干，4项针对复测通过，不更改产品题变守卫。
- 已目视检查合成截图：`.local-demo/question-board-0.2.4.png`、`.local-demo/question-dual-view-0.2.4.png`。
- Verified：包0.2.4 / 16条目 / 0.78MB，CRC、dist和使用说明逐字节一致，根/扩展/锁/manifest/feed版本一致，SHA-256与feed/摘要文件一致：`c5a95f16e263c4bc2511865d61172bbda5be320e304ac16e6b8b7a4819a6689a`。

Unverified：真实课程交互、真实供应商的大图额度/视觉准确性。本轮未发送真实付费模型请求或操作真实课程。

### 9.36 GitHub 更新发布（2026-10-21，0.2.5）

更新菜单默认内置本仓库 raw 更新源，未配置的旧解压版商店默认项迁移到 ZIP；自定义来源保留。高级设置收起，保留手工改源与恢复官方源，下载后可直接打开本扩展管理页。没有新增权限、后台轮询或静默替换文件。Windows 解压版仍须下载、覆盖原文件夹并重新加载。

新增版本同步命令和 main 自动发布工作流：类型/单测/契约检查后构建，草稿上传后公开，再重新下载公开产物核对摘要、CRC 和 manifest，最后原子同步更新清单。已公开版本不覆盖、不降级清单、同版本换不同字节拒绝。补齐原有未声明的 @vue/test-utils 开发依赖和缺失的可选平台锁文件记录，现有运行依赖版本未变。

Verified（本机）：434 扩展单测、8 发布脚本单测、11 契约单测、契约检查、类型与构建通过；2 项 MV3 更新菜单测试通过（7.6s），覆盖默认源/旧配置迁移、无主动点击不请求、新版链接、管理页入口、自定义源持久化和无降级。官方源测试模拟原生权限弹窗的批准及版本服务器响应，未把该测试称为真实公网更新请求；具体来源授权/拒绝路径由单测验证。更新菜单截图已目视检查。

Verified（公网）：源码提交 f13415e 推送后自动触发 [GitHub Actions 39526119126](https://github.com/ChinaYosh007/xuexitong-shuake-plugin/actions/runs/39526119126)，全新 Ubuntu 环境所有步骤成功，包括 npm ci、全部测试、构建、Release 公开上传及重新下载校验。机器人自动提交 767da46 同步更新清单；匿名 raw 请求已返回 0.2.5 和正确版本下载地址。

本机另行从公开 v0.2.5 下载三个发布文件，确认 ZIP CRC、包内 manifest、SHA-256 文件与仓库公开清单一致。ZIP 806983 字节，SHA-256：`3b2772c560f67c033fe23cd0d8107b463396d84a6eb97e0ce032837718bd37af`。本条不宣称已完成解压版自动安装或商店上架。
