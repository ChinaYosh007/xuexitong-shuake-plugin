# ADR 0001：实施基线与关键架构决策

- 状态：Accepted（实施基线）
- 日期：2026-10-18
- 版本：1.0
- 决策来源：`docs/architecture.md` §2.1–§2.3、§5、§21.2；`docs/xuexitong-extension-adaptation.md`
- 范围：本仓库全部实现（扩展、控制台、后端、测试、部署）

## 背景

项目目标是隐私优先的学习通学习辅助：用户独立账号、自带 API Key（BYOK）、单题采集、用户主动发送、AI 解析、答案审核与受限练习回填。当前仓库从文档与骨架起步，**尚无真实学习通 DOM 证据**，因此真实页面适配不能被声明为已完成。

本 ADR 固化实施基线，避免后续实现偏离契约；细节以 `docs/architecture.md` 与 `docs/openapi.yaml` 为准。本文件是决策摘要，不是实现完成声明。

## 决策

| 编号 | 决策 | 代价 / 约束 |
|---|---|---|
| ADR 01 | **单 Maven 模块，按业务包划分**（auth、account、provider、study、operations、shared），不拆微服务 | 模块边界靠接口、测试与代码审查维护；禁止引入注册中心、配置中心、消息队列、Redis、API 管理网关 |
| ADR 02 | **每次请求读取用户配置快照**，使用整数 `version` 与 `If-Match` 乐观锁 | 每次请求多一次数据库读取；避免跨用户缓存错误；版本冲突返回 412 |
| ADR 03 | **非流式、单题生成** | 首版没有逐字输出；请求回执只记录版本与元数据 |
| ADR 04 | **不保存题文与答案** | 无云端历史，不能缓存答案重放；幂等机制不能重放答案正文 |
| ADR 05 | **供应商协议显式选择**（Chat Completions / Responses 分别适配） | 用户必须确认端点与模型能力；失败时不自动切换供应商、模型、协议或 Base URL |
| ADR 06 | **页面回填完全在扩展内完成** | 后端没有回填或提交端点；模型输出不能成为浏览器指令 |
| ADR 07 | **邀请制注册** | 需要本地运维命令创建邀请码；邀请码只存散列 |
| ADR 08 | **已有 API 网关视为普通供应商端点** | 不调用网关管理 API，不同步网关用户；网关是额外数据处理方 |

## 技术基线

| 部分 | 基线 |
|---|---|
| 扩展 | Chrome Manifest V3、Vue 3、TypeScript、Vite；权限仅 `activeTab`、`scripting`、`storage`、`sidePanel` |
| 前端 | Vue 3 + TypeScript + Vite；无组件库、Pinia、vue-router |
| 后端 | Java 21、Spring Boot 4.1.1、Spring MVC、Spring JDBC、Flyway |
| 数据库 | PostgreSQL 17；本地与生产同一种数据库 |
| 加密 | JDK AES-256-GCM；主密钥只读 Secret 文件注入；请求 HMAC 使用独立密钥 |
| 部署 | 单实例、Caddy TLS 反代、非 root 容器、无公网 PostgreSQL；MVP 不使用 Kubernetes |
| 测试 | Vitest、Playwright（真实 MV3 加载）、JUnit、Testcontainers；合成 Fixture 先于真实页面 |

Spring Boot 4.1.1 的具体 Starter/测试模块坐标必须在实施时核对，不直接照搬 Boot 3 示例；本文不虚构未经构建验证的依赖组合。

## 明确不引入

微服务、注册中心、配置中心、Redis、消息队列、任务调度平台、Elasticsearch、向量数据库、Spring AI/LangChain/Agent 框架、OpenAI SDK、独立 API 管理网关、ORM、Lombok、MapStruct、前端组件库、Pinia、前端路由器、统计/崩溃/广告 SDK。

## 安全与合规不变量

1. 不收集学习通密码、Cookie、浏览记录、完整页面 HTML。
2. 不伪造视频进度、学习时长或签到。
3. 不自动提交考试、作业或计分测验；不调用 `form.submit`/`requestSubmit`/提交按钮/提交 API。
4. 采集后必须预览，再由用户主动发送。
5. 只有已验证的练习适配器、且用户单次审核后才允许回填。
6. 不执行模型返回的脚本、HTML、选择器或动作；模型文本按纯文本渲染。
7. 题文与答案默认不落库；日志不得包含题文、答案、密钥。
8. API Key 使用 AES-GCM 加密，主密钥通过 Secret 文件注入。
9. Base URL 变更后在同一事务内清除旧密钥与验证状态。
10. 不凭记忆编造学习通 DOM 选择器；真实适配器必须有脱敏 DOM 证据并记入 `docs/compatibility.md`。

## 阶段与证据要求

按 `docs/architecture.md` §21.2 的 P0–P4 推进（P0 契约与骨架、P1 账号与配置、P2 AI 调用、P3 学习闭环、P4 受控回填）。P5（真实学习通适配）与 P6（部署）在有真实页面证据/部署记录前必须标为未验证。`docs/acceptance.md` 必须逐项区分 Verified / Static analysis / Unverified，并记录命令、环境、时间与证据位置。

## 影响

- 任何新增依赖或架构变更需要更新本 ADR 或新增后续 ADR，并同步 `docs/architecture.md`、`docs/openapi.yaml`、Java DTO 与 TypeScript 类型。
- ADR 不能替代实际测试。未执行、缺少环境或缺少真实页面证据的检查一律记录为 Unverified。
