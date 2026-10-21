# 学习通刷课插件

Xuexitong course and question automation extension · Chrome / Edge · Bring your own AI provider.

[下载最新扩展](https://github.com/ChinaYosh007/xuexitong-shuake-plugin/releases/latest) · [安装与使用](使用说明.md) · [更新清单](https://raw.githubusercontent.com/ChinaYosh007/xuexitong-shuake-plugin/main/updates/update.json)

下载 Release 中的 `study-assistant-extension.zip`，解压后在 `chrome://extensions` 开启开发者模式并加载 `extension` 文件夹。GitHub 的源码 ZIP 不包含构建产物，直接安装请使用 Release 安装包。

Release 0.2.0 adds strict answer validation, blank-field identity checks, and an update dropdown. Build and package with `npm run package:extension`. See [audit results](docs/project-audit-2026-10-20.md) and [release instructions](docs/extension-updates.md).

Current local build: **0.2.7**. Process mixed cards one task at a time; course-only mode continues through videos and supported documents while skipping quizzes. / 当前本地构建：修复同页测验阻塞视频结束后跳转的问题，只刷课模式自动寻找后续视频和已适配的资料任务；见 [混合任务修复](docs/course-playback-0.2.7.md)。公开发布状态以 GitHub Release 为准；更新机制见 [更新发布说明](docs/extension-updates.md)。

隐私优先的学习辅助 Chrome MV3 扩展：读取当前题目 → 预览确认 → 发送给**用户自己的** OpenAI 兼容供应商（DeepSeek 等）→ 审核答案 → 非剪贴板回填 → 回读验证。默认不保存题目与答案，不自动提交考试。

> **2026-10-19 起，本仓库为「扩展独立模式」发行版**：后端、控制台及配套基础设施已移除。
> 扩展直连用户自配的供应商（本地直连，无需登录），历史后端模式的验证记录保留在
> [docs/acceptance.md](docs/acceptance.md) 中供追溯。给最终用户的安装使用步骤见 **[使用说明.md](使用说明.md)**。

## 目录结构

```text
apps/extension     Chrome MV3 扩展（核心与唯一客户端）：src 源码 + dist 可加载产物
packages/contracts OpenAPI 对应的 TypeScript 契约类型（扩展与契约校验共用）
tests/fixtures     合成练习页面（禁止粘贴、只读、自动提交、计分、iframe、提示注入等）
tests/extension    真实加载 MV3 扩展的 Playwright 集成测试
tests/contracts    OpenAPI ↔ TS 契约一致性测试
scripts            扩展构建、字体参照生成、契约校验、真实浏览器冒烟
docs               架构/适配规格、验收记录、兼容性、隐私声明
使用说明.md         面向收到扩展包的最终用户
```

## 插件独立模式（无需登录，拿到就能用）

1. `chrome://extensions` 开启开发者模式，加载 `apps/extension/dist`；
2. 扩展「设置」→ 选预设（DeepSeek / OpenAI 兼容）或自定义 Base URL；
3. 填 API Key（仅存本机 `chrome.storage.local`）→「授权此站点」→「读取模型」→ 保存并设为默认；
4. 侧边栏直接读取题目并发送；标题栏显示「本地直连 · 无需登录」。

详细步骤、常见问题与安全边界见 [使用说明.md](使用说明.md)。

## 课程任务调度（自动运行模式）

2026-10-19 新增（详见 [docs/course-automation.md](docs/course-automation.md)）：在侧边栏打开「课程任务调度」，
核对题目图像并确认本次授权后，对绑定课程标签连续生成、回填核验、提交章节任务、正常播放视频并进入下一任务；
无需接管系统鼠标。正式考试、未知结构、无法读取的图像和无法确认的结果会停止。原手动模式保持逐题审核。

调度逐题读取源文字（含已验证字形还原），边扫描边异步发送、汇总排序后回填；明确答案只调用一次，
不确定自动追加共识，仍未决或首次回答不可用时后台发送整题图片；最终失败统一补答，可指定起始题号。
三个模式为「刷课模式（播放视频＋完成题目任务）」「刷题模式（连续完成任务点，遇到未完成视频直接跳过）」与「只刷课
模式（仅播放视频，题目任务直接跳过、不调用模型）」。刷课/只刷课途中视频被强制弹题暂停时会按页面选项顺序免人工枚举
作答（不调模型）；运行出错或需要人工时除文字提示外还会声音告警，出错每 30 秒重复响铃。
供应商请求带 90 秒超时；图片题需要供应商支持图像输入（设置页勾选「支持图像输入（多模态）」）。

## 开发

前置：Node.js ≥ 20。

```powershell
npm ci                          # 首次：按 package-lock.json 安装
npm run typecheck               # workspace 类型检查
npm run test                    # 扩展单元测试
npm run build                   # 重新构建 apps/extension/dist
npm run package:extension       # 构建并打包 ZIP + SHA256 + update.json（需 Python 3）
node scripts/verify-contracts.mjs   # OpenAPI ↔ TS 契约一致性

npm run test:fixtures           # 合成 Fixture 浏览器测试
npm run test:e2e                # 真实 MV3 扩展集成测试（本机 8080 需空闲，测试自带伪后端）
node scripts/real-chrome-smoke.mjs  # Playwright Chromium 冒烟（可选 --channel chrome，仅限 Chrome for Testing）
```

构建变量：`EXTENSION_BACKEND_ORIGIN` 仅影响 dist 中回退用后端 Origin 的默认值，独立模式不使用。

v0.2.0 的「更新」下拉位于侧边栏、设置页和调度页：支持 Chrome 商店检查或自定义 ZIP 更新源。解压版下载后仍需覆盖原加载目录并重新加载，发布者上传 ZIP 与 update.json 的流程见 [extension-updates.md](docs/extension-updates.md)。

## 安全与隐私要点

- 不收集学习通密码、Cookie、浏览记录或整页 HTML；不伪造学习进度。
- 采集后必须预览，只有用户点击才发送；模型输出按纯文本渲染，不执行其中任何脚本/选择器/动作。
- 自动运行模式的章节任务提交须每次启动授权；正式考试不支持，计分/只读/未知页面拒绝回填。
- API Key 仅存本机 `chrome.storage.local`，题目只发给你配置的供应商；日志不记录题文、答案与密钥。

## 文档入口

| 文件 | 用途 |
|---|---|
| [使用说明.md](使用说明.md) | 最终用户安装/配置/使用/FAQ |
| [完整架构与实现规格](docs/architecture.md) | 技术决策、API、数据模型、安全（含已移除后端的历史契约） |
| [学习通插件适配规格](docs/xuexitong-extension-adaptation.md) | 禁止粘贴/禁止选中、非剪贴板控件写入、回读验证与兼容边界 |
| [课程任务调度](docs/course-automation.md) | 自动运行模式的能力、授权与停止边界 |
| [验收报告](docs/acceptance.md) | 逐条 Verified / Static analysis / Unverified 证据与复现命令 |
| [兼容性记录](docs/compatibility.md) | 适配器版本、Fixture 矩阵；真实页面一栏为空（无 DOM 证据） |
| [隐私声明](docs/privacy.md) | 数据边界、非零知识说明、供应商与网关角色 |
| [交接单](HANDOFF.md) | 当前状态、环境事实、已修复缺陷、未验证项与下一步 |
| [API 契约](docs/openapi.yaml) | 契约权威，与 `packages/contracts` 类型同步 |

## 实施状态

| 阶段 | 状态 |
|---|---|
| P0 契约与骨架 | Verified |
| P1–P2 账号/配置/AI 调用 | 后端已移除；本地直连供应商 Verified |
| P3 学习闭环 | Verified（合成 Fixture） |
| P4 受控回填 | Verified（合成 Fixture） |
| P5 真实学习通页面 | 部分 Verified —— 真实域名下加载与安全拒绝已实测（`FRAME_ACCESS_DENIED`，零答题请求）；真实题目回填仍 Unverified，需脱敏 DOM 证据 |
| 课程任务调度 | 真实 37 题源数据读取与正常视频播放已验证；真实提交边界见 docs/course-automation.md |

不要编造真实学习通选择器或测试结果；未执行的检查一律标记 Unverified。
