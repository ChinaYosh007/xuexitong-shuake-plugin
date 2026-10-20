# Project audit / 项目检查（2026-10-20，v0.2.0）

**后续修复：v0.2.1**——用户实际反馈暴露了延迟 UEditor 漏空和可见性指纹变化问题，已按真实只读 DOM 证据补充适配。本文是 0.2.0 的历史检查快照，不代表问题全部消除；最新包已由 0.2.1 覆盖，最新结果见 [修复记录](blank-editor-fix-2026-10-20.md)、验收 §9.32。

The extension and contract packages build successfully. All 403 unit tests, 11 contract tests, 22 fixture browser tests, and 28 MV3 integration tests passed. This establishes the tested behavior below; it does not prove every live course or model answer is correct. Public update hosting and Chrome Web Store distribution are not configured.

## 范围

本轮检查实际仓库中的 `apps/extension`、`packages/contracts`、构建/契约/打包脚本、合成页面与 MV3 测试、安装和隐私文档。发行仓库已移除 Java 后端、控制台和容器基础设施，不能把历史后端测试当作本轮结果。此前完整扫描的其他缺陷修复见 HANDOFF §8.19，以下聚焦本轮新确认问题。

## 已确认问题与修复

| 问题 | 根因 / 修改 | 证据 |
|---|---|---|
| 结构化输出混用答案字段 | 旧校验只验证当前题型所需字段，未拒绝无关选择项、填空或简答；未知 status 被默认作 ANSWERED。现在状态严格枚举，按题型只允许对应字段，提示中附本题 answerContract；格式错误最多 3 次纠正 | provider 单测；MV3 首次混合字段被拒绝、第二次正确写入 |
| 对象被写成填空文字 | 旧代码 String(answer) 可生成 `[object Object]`。现在 blankId/answer 必须是字符串，拒绝对象/数组/数字；明确编号别名映射到已知 blankId，不猜测拆分文本 | 对象填空拒绝单测、逆序编号 MV3 回填 |
| 填空控件换序仍按旧答案写入 | 旧指纹只含题干/图片/字体，两个命名字段互换后指纹不变。新增按 DOM 顺序的控件 tag/id/name/所属框架 ID 及选项标识；不含当前值 | 新回归在修复前失败、修复后零写入拒绝；已命名控件换序测试 |
| 答案分歧仍自动采用首个候选 | 自动路径在无多数结果时回退到候选排序首位。现在不自动采用无多数/并列结果，放入人工汇总；ANSWERED 但声明“不确定”也触发追加 2 次；不同多选答案不取并集 | runner 单测覆盖分歧不写入、不提交，以及不确定重试后多数一致 |
| 选项文本匹配歧义 | 重复相同选项文字取首项；“不正确”可能被“正确”子串误认。现在重名要求 ID，真假按完整明确标记匹配 | provider 单测 |
| 模型列表读取可能无限等待 | 原超时在响应头到达后被清除，body 一直不结束就悬挂。计时覆盖完整 JSON 读取，校验 data 数组及空元素，错误保留合同 code | fake-timer 模型列表 body 挂起超时测试 |
| 手动改 API 地址沿用旧 Key | 预设切换已有清除逻辑，手工输入缺失。Base URL 输入事件清除草稿 Key，防止直接带到新地址 | 真实 MV3 设置页填假 Key → 修改地址 → Key 为空 |
| 契约测试硬编码 20 接口 | 实际架构和契约都为 21，但测试仍断言 20。现在直接比较 architecture §12.2 清单与脚本清单，覆盖数量和具体路径 | 11 项契约测试通过 |

题型标签只读显式标签、移除裸 `ul > li` 的通用选项兜底、支持裸/plaintext-only contenteditable 是开始本轮时已有的修复，本轮保留并补充编号文本框列表回归。APPLY 也优先核对控件实际类型，填空/简答容器不会被当选择行。

本轮增加更新模块、三个页面的更新下拉、0.2.0 版本号、锁文件及统一打包命令，未新增 manifest 权限。更新模块仅存分发渠道/清单地址，不接触课程答案或供应商 Key。详细部署见 [extension-updates.md](extension-updates.md)。

## Verified

| 命令 / 检查 | 实测结果 |
|---|---|
| `npm run test -w @study/extension` | **27 文件 / 403 项通过** |
| `npm run test:contracts:unit` | **11/11 通过**；从架构表逐项比较接口 |
| `npm run verify:contracts` | 21 endpoints / 25 errorCodes / 28 interfaces / 92 fields PASS（存在性，不是完整 OpenAPI 语义验证） |
| `npm run typecheck` | contracts、extension 均 0 诊断 |
| `npm run build` | contracts、extension 成功；Chrome MV3 0.2.0 |
| `npm run test:fixtures` | **22/22 通过** |
| `npm run test:e2e` | **28/28 通过（1.4 分钟）**，真实加载本地 MV3 扩展、合成页面、伪上游；无真实题目外发 |
| 新直连集成用例 | 首次响应混入 selectedOptionIds，第二次按 `2/1` 逆序编号；2 次请求，两个 UEditor 分别为对应值，Submit/确认各 1 次，产品后端答题请求 0 |
| 新更新菜单集成用例 | 0.2.0 检查到合成 0.3.0、相对 ZIP URL 正确；配置重载保留；0.1.0 不提供降级链接；清单请求无认证头、Cookie、请求体；已检查界面截图 |
| `npm run package:extension` + 独立复核 | **0.2.0 / 15 文件 / 0.77 MB**；CRC、逐字节 dist/使用说明一致、SHA-256 与清单一致；无源码、source map、.env 或 node_modules 条目 |

发布包 SHA-256：`6c68617ae6aec6980508055b00ff831821fb94ea96d337d574486cc0371096a3`。

合成截图：`.local-demo/update-menu-verified.png`、`.local-demo/local-structured-blanks-verified.png`。源码静态边界测试仍检查禁用代码执行/HTML 注入、存储与网络边界、最小权限。打包器从最新 dist 生成 ZIP，逐字节比对全部扩展文件并检查 CRC，生成实际 SHA-256 和同目录相对路径更新清单；发布产物见 release 目录。

## Static analysis / Unverified

- 静态检查与以上测试不能证明“项目没有任何 bug”。真实学习通的新页面、网络慢速回弹、复杂自定义编辑器和视觉模型能力仍需真实环境复测；本轮未修改用户课程、提交真实作业或完成整课。
- 普通选择题是否正确属于模型答案质量；通过类型/ID/多数一致校验不等于语义正确，更不能把票数当正确概率。无法确认时保留人工汇总，缺答不提交。
- 控件指纹覆盖已知 ID/名称/框架和顺序；完全同形、无标识控件被站点替换后的身份无法仅凭这些属性绝对区分。未知结构仍不能据此声称支持。
- 未发布公共 HTTPS 更新源、商店条目或签名包。更新源/ZIP 检查在本机合成服务上验证；实际商店发布升级尚未验证。普通 Windows 解压扩展不能自行覆盖安装目录。
- `npm audit` 未能取得漏洞报告：本机镜像 advisory API 返回 404/NOT_IMPLEMENTED；显式官方 registry 又在建立 TLS 前断开，日志 `.local-demo/npm-audit.json`。不能宣称依赖漏洞扫描通过；未关闭 TLS 校验或改动全局 registry。锁文件生成成功，但锁文件不是安全审计结论。
- 本地直连 Key 按既有选择保存在 `chrome.storage.local`，没有应用级加密。已在隐私文档顶部区分当前独立版与历史后端 AES-GCM 设计。
