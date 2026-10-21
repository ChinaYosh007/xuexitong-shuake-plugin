# Course playback fixes / 刷课修复 · 0.2.6

The local 0.2.6 build fixes task-card identity, brief playback interruptions, and nested video-question controls. Tests use synthetic course pages; compatibility with the reported live page remains unverified.

本地 0.2.6 构建修复任务卡片识别、短暂播放中断及嵌套视频弹题控件。测试使用合成课程页面；用户截图对应的真实课程兼容性仍未验证，不能据此断定站点网络提示的具体原因。

## Changes / 改动

- `cardIndexOf()` previously accepted `num` from every iframe. A nested media module could overwrite the knowledge-card number, causing the next card to retain the old task key. Only `/mooc-ans/knowledge/cards` now contributes its card number.
- Three paused polling samples previously stopped a video, and any media error stopped it immediately. Recovery now uses the existing 60-second no-progress window, with PLAY attempts spaced at least five seconds apart. Persistent failure still stops without advancing or counting completion.
- An already-open video question is handled before initial PLAY. The popup scope includes a sibling confirm button within a small overlay. Identical options are re-read after DOM replacement; changed options stop enumeration. Pause/release cancels pending clicks.

- 任务编号原先读取所有 iframe 的 `num`，嵌套媒体模块可能覆盖 cards 编号，使下一卡片仍沿用旧任务键。现只接受已适配 cards 路径的编号。
- 原先连续三次暂停轮询或任意媒体错误即停止。现采用既有的连续 60 秒无播放进展上限，恢复播放尝试至少相隔 5 秒；持续失败仍停止，不跳转、不计完成。
- 启动时先处理已弹出的题目再播放。确认按钮可位于选项列表外的小弹层中；答错后重新获取同一组选项，真实选项变化时停止。暂停或释放运行取消后续弹题点击。

## Verified / 已验证

- `npm test`: 27 files, 440 tests passed. After adding two persistent-pause/error cases, the complete runner file passed again: 93 tests.
- `npm run typecheck` and `npm run build` passed.
- Five targeted MV3 browser tests passed: startup popup → real media playback → static card → second real media playback; direct popup bridge; quiz → two static cards → next quiz; unfinished-chapter recovery in both course and videos-only modes.
- The new browser fixture uses real two-second PCM media, native currentTime and ended events. Its nested helper iframe carries `num=0` while the enclosing cards change from 0 to 2. Observed counters: `next=2`, `ended=2`, `popupOptions=2`; completed tasks 2, skipped static cards 1, model requests 0.

- 全量单测 27 文件、440 项通过；随后新增持续暂停/报错两项用例，调度器整文件 93 项再次通过。根类型检查、构建通过；五项针对性 MV3 浏览器回归通过。
- 新夹具使用实际播放的两秒 PCM 媒体，未伪造媒体时间或 ended；两段真实结束事件、两次下一页点击、两次弹题提交。确认完成 2 项、越过普通资料 1 项、模型请求 0。

## Install and limits / 安装与限制

Stop the current run, close old runner pages, replace files in the existing extension folder with the local ZIP, reload the extension, refresh the course tab, and open a new runner. Packaging verifies CRC and compares every packaged build file with dist.

停止当前运行并关闭旧调度页，将本地安装包 `release/study-assistant-extension.zip` 中的文件覆盖到原扩展目录，重新加载扩展、刷新课程标签页，再打开新调度页。打包脚本核验 ZIP CRC，并逐文件比较包内构建产物与 dist。

Live-site popup DOM, network alerts, and completion acknowledgements remain unverified in this session: no live course tab was open. Structural popup limits remain (2–12 options, small visible container, bounded enumeration); unsupported pages and unfinished marked resources remain blocked. Site completion evidence is still required. Version 0.2.6 is prepared locally; a public GitHub release and installation in the user's browser are not verified.

本轮没有打开的真实课程标签页，真实弹题 DOM、网络提示与站点完成回执仍未验证。结构性弹题仍限定可见小容器、2–12 个选项及有界枚举；未知页面、未完成的带任务标记资料仍停止，仍须真实站点完成证据。0.2.6 为本地构建，不代表已经公开发布或已安装到用户浏览器。

## Follow-up live check / 后续真实课程检查（2026-10-21）

The user subsequently opened a signed-in Java course tab. The site's own play button started “Java的发展”; observed native currentTime advanced from 0.023 to 58.840 seconds without a media error. Playback was paused normally at 65.261 seconds. The video marker was already completed before this check; this run did not establish a newly completed task.

用户随后打开了已登录的 Java 课程。通过站点自身播放按钮启动「Java的发展」，原生播放时间从0.023秒推进到58.840秒，未出现媒体错误；65.261秒时正常暂停。该视频在测试前已标记完成，本次不计为新完成任务。

Clicking the site's Next opened the unfinished-chapter notice because a quiz remained on the same card. The visible “to learn” control was inside `.jobFinishTip`/`#jobFinishTip` and carried `.popMoveDele`, matching the existing handler. Clicking it returned to the current lesson. Other selected chapters initially displayed blank or loading content frames; this observation alone does not establish a network root cause.

点击站点Next后出现当前章节仍有未完成任务的提示，同一卡片存在未完成测验。「to learn」按钮位于既有`.jobFinishTip`/`#jobFinishTip`结构内，并带`.popMoveDele`，与现有适配器一致；点击后回到当前课程。其他所选章节曾出现内容框架空白/加载中，不能仅据此断定网络故障原因。

Unverified: the installed extension's version, v0.2.6 execution, automatic next-video playback, completion acknowledgement for a new video, and forced video-question handling. No forced question appeared during the playback sample. Browser policy rejected `chrome://extensions/` because it permits only HTTP(S), so extension reload/runner control was not attempted through an alternate surface. No course quiz was answered or submitted; no credentials, course identifiers, or full authenticated URLs are stored in this record.

未验证：已安装扩展版本、0.2.6实际运行、自动续播、新视频完成回执及强制弹题处理。本段抽样未出现弹题。浏览器策略仅允许HTTP(S)，拒绝访问扩展管理页，因此未通过其他手段绕过限制去重载或控制调度器。未作答或提交课程测验；本记录不保存凭据、课程标识或完整认证URL。
