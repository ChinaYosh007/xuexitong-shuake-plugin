# Course navigation and discussion draft audit / 刷课导航与讨论草稿检查

Date / 日期: 2026-10-21, Asia/Shanghai.

**Later change / 后续变更:** On 2026-10-22 the user explicitly enabled automatic discussion publication and automatic submission in all modes. The draft-only behavior below describes the earlier implementation. Current behavior and limits: [automatic submission report](auto-submit-2026-10-22.md).

2026-10-22 用户已明确要求各模式自动提交并包括讨论发表，下文草稿限制属于历史实现，现行行为见上述报告。

The actual checkout is `D:\project\xue-xi-tong`. The chat directory was an empty Git repository. Existing uncommitted changes were preserved; no merge, commit, push or public release was performed.

实际代码位于上述目录，聊天目录是空仓库。本轮保留已有未提交改动，未合并、提交、推送或公开发布。

## Findings and changes / 发现与修改

1. **Horizontal navigation was not connected.** NEXT now processes pending modules, then subsequent visible chapter tabs, then the site's chapter Next. Switching waits for active-tab state, matching card number and the loaded document. Unfinished/unknown tasks still block unauthorized advancement.
   **横向导航此前未接入。** 现按同卡片模块→后续横向页签→站点 Next 推进。必须核实活动页签、卡片序号及新文档加载，未完成或未知任务仍受跳转守卫约束。
2. **Module discovery was all-or-nothing and used array positions as identity.** Malformed marked modules now remain UNKNOWN while valid siblings remain available. Active and skipped modules use marker identities; task keys remain stable through sibling reordering. The observed `ans-job-finished` completion class is recognized. The main card frame's knowledgeid distinguishes chapter changes even if the top URL stays unchanged.
   **单个异常模块曾清空队列，数组位置曾充当身份。** 现保留正常模块，异常模块仍阻塞；重排不会把已跳过/正在处理的模块错位。补充既有完成类与主卡片章节身份。
3. **A navigation-time INSPECT failure immediately stopped the runner.** Loading/navigation waits now tolerate up to eight consecutive failures within the existing bounded window. Mutating commands are never replayed after dispatch if a response is lost; read-only commands retain the single reinjection recovery.
   **导航瞬时通信失败曾直接中断。** 现有界容忍；已发送的写入、提交或跳转若结果不明，不再自动重发，避免重复动作。
4. **Discussion tasks opened another origin/tab that the runner did not follow.** The observed entry exposes its destination in `data`. Following a user report that popup discovery timed out, the bridge now validates that destination and directly creates a tab, binds only the returned ID, and verifies its loaded course/class again. Exact optional-origin permission remains required. A separate adapter reads only the original topic, uses the existing answer pipeline, writes plain text, and verifies it. Existing drafts are preserved. The user's latest instruction limits this to drafts: no publish and no completion count; the run stops for review.
   **讨论任务在新源/新标签打开，原调度器无法跟随。** 用户随后反馈旧弹窗查找超时；重取证确认入口 `data` 含目标地址，现改为核验后直接创建标签、只绑定返回 ID，加载后再次核验课程班级。准确域权限与纯文本草稿管线保留。已有草稿不覆盖；不发表、不计完成，填入后等用户检查。

## Evidence / 证据

- Baseline: 470 unit tests passed before edits. The pre-existing local changes included seek/scroll/diagnostics improvements and submission dwell, but the horizontal operation was not in the navigation chain.
- Git remote HEAD: `c200890` (public v0.2.7 feed update); local HEAD: `86cbcff`. No remote source fix was waiting to be merged.
- GitHub connector issue/PR searches returned no results. Public REST was rate-limited; the public [Issues page](https://github.com/ChinaYosh007/xuexitong-shuake-plugin/issues) was then read and showed **0 open issues**. Closed/private issue history was not verified. Local bug reports in `docs/analysis` and the user's latest screenshot drove the fixes.
- Real browser inspection confirmed the discussion frame chain, exact original-topic structure and reply textarea. One example reply was filled with browser UI tools and left unpublished. Its text/image is not stored in this repository. This is distinct from extension automation verification.

基线 470 单测已通过。远端最新提交仅更新公开版本清单，没有待合并的源码修复。GitHub 搜索为空、REST 限流，随后网页核实公开未关闭 issue 为 0；关闭/私有历史未核实。本轮依据本地分析及用户截图修复。真站完成了结构取证和浏览器工具示例填入，不能冒充新版扩展的真实课程联调。

## Verification / 验证

Final checks passed: 495 unit tests, 37 built-extension MV3 browser tests, 22 fixture tests, 8 release tests and 11 contract unit tests. Typecheck, build and contract verification passed. The local ZIP passed CRC and byte-for-byte checks for all 17 entries. Detailed commands and limits are recorded in acceptance §9.43.

最终检查通过：495 项单测、37 项构建后 MV3 浏览器测试、22 项 fixture 测试、8 项发布测试及 11 项契约单测；类型检查、构建和契约检查通过。本地 ZIP 共 17 条目，CRC 与构建文件逐字节核验通过。详细命令与限制见验收 §9.43。

Follow-up after the user's popup timeout: the full unit suite passed 500 tests; the final tab-creation bridge passed its 11 targeted unit tests and the built-extension discussion browser test with the site's popup handler disabled. See acceptance §9.44 for the final follow-up results; the 37-test result above belongs to the preceding implementation.

用户反馈弹窗查找超时后的复核：全量 500 单测通过；最终创建标签桥接的 11 项针对性单测及禁用网页弹窗函数的构建后讨论浏览器测试通过。最终补丁结果见验收 §9.44；上面的 37 项全量浏览器结果属于此前实现。

During development, the new browser tests caught three concrete integration gaps: the synthetic page's missing UTF-8 declaration, Chromium attributing the popup to the invoking runner instead of the background course tab, and the shared image renderer lacking the discussion content root. Each cause was corrected without weakening success assertions or enabling publication.

新增浏览器测试先后检出了测试页面编码缺失、Chromium 新标签来源归属差异、共享题图渲染器缺少讨论正文根三个集成问题；均修复原因，未放宽成功断言，未增加发表动作。

## Limits / 限制

- **Verified:** checks listed in acceptance; synthetic browser tests load the real built MV3 extension, with mock model output and local synthetic pages.
- **Static analysis:** unknown modules remain blocking; production permissions remain optional; discussions have no publish implementation.
- **Unverified:** the rebuilt extension running an entire real course, real model answer quality, alternate discussion/editor skins, popup-blocked sites, and submit buttons/confirmation dialogs located outside the known module documents. Unsupported structures stop with an error instead of being guessed or counted complete.

Verified 仅指实际执行的检查与合成 MV3 浏览器流程。新版扩展真实整课运行、模型答案质量、其它页面皮肤、弹窗拦截及提交按钮位于未知作用域等仍未验证；未知结构停止，不猜测、不伪造完成。
