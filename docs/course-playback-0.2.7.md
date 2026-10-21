# Mixed course tasks / 混合课程任务 · 0.2.7

Videos and quizzes on the same knowledge card now have separate task identities and completion checks. Course-only mode continues through videos and supported PDF/PPT viewer resources, skipping quizzes without answering or submitting them.

同一知识卡片的视频与测验现按独立任务识别和核验完成。选择「只刷课：视频和资料，跳过题目」，视频完成后继续处理后续任务；测验按授权跳过，已打开的已适配 PDF/PPT 查看器继续越过，不答题、不提交测验。

## Cause and evidence / 原因与证据

The live Java course and the user's screenshot showed a video at its actual end with its own “任务点已完成” marker, followed by an unfinished quiz on the same card. The old adapter used one card-wide key and required every `.ans-job-icon` to be completed. Once a late quiz loaded, it could also take precedence over a video; the runner's video loop still waited for whole-card completion and eventually stopped.

真实 Java 课程和用户截图显示：视频实际播放结束，自身标记已完成，同卡片的测验仍未完成。旧适配器共用整张卡片的任务键，并要求所有 `.ans-job-icon` 都完成；延迟加载的测验还会抢占视频类型识别，视频循环却仍等待整卡完成，最终停止。

Read-only DOM evidence: each marked module was a `.ans-attach-ct` wrapper containing one `.ans-job-icon` and one iframe. Video wrappers additionally carried `videoContainer`, and completed wrappers carried `ans-job-finished`. Observed paths were `/ananas/modules/video/index.html` and `/ananas/modules/work/index.html`. The PDF viewer path `/ananas/modules/pdf/index.html` was already recorded in compatibility §6.5. No credentials, course IDs, full authenticated URLs, question text, or full-page HTML are stored here.

只读 DOM 证据：每个 `.ans-attach-ct` 模块有一个 `.ans-job-icon` 和一个 iframe；视频额外含 `videoContainer`，完成模块额外含 `ans-job-finished`。真实观察到 video/work 两种上述固定路径；PDF 查看器路径沿用兼容记录 §6.5 的既有证据。不保存凭据、课程标识、完整认证URL、题文或完整页面HTML。

## Behavior / 行为

- Each module has a stable ordinal in the card's task key. Inspect keeps the current module until an authorized NEXT. Same-card NEXT selects the next unfinished module; the site's chapter Next is clicked only after those modules are completed or explicitly skipped.
- Completion uses the current module's marker. A video started by this run also waits for its native ended state, so an early 90%-watched marker cannot cut off the final segment. Already-completed videos are not replayed.
- Reads, playback, popup handling and submission stay scoped to the selected module. Old module keys are rejected. An earlier authorized quiz/resource skip remains valid for the later unfinished-chapter notice, provided all remaining modules are completed or explicitly skipped.
- Course-only mode skips known quizzes even if their question frame is still loading. Recognized, loaded PDF viewer resources may be traversed with an explicit NEXT skip; they count as skipped unless the site confirms completion. General course mode continues to require completion evidence for marked resources.

- 每个模块有独立任务键，NEXT先处理同卡片后续模块，再点击站点的章节Next。
- 当前模块独立核验完成；本轮启动的视频还须实际ended，避免90%标记导致提前切走。已完成视频不重复播放。
- 读取、播放、弹题及提交限定当前模块；旧模块命令拒绝。最后一个视频完成后，之前明确跳过测验/资料的授权仍可用于章节提示。
- 只刷课模式可跳过仍在加载题面的已知测验；已加载的PDF查看器资料带显式授权继续越过，未确认资料只计越过。普通刷课模式仍等资料完成回执。

## Limits and installation / 限制与安装

Verified locally: final full unit suite **454/454**, root typecheck/build, 8 release-script tests, 11 contract tests and contract inventory checks. Five final MV3 browser regressions passed (52.8 seconds). Mixed-card fixtures tested both an unfinished and an already-completed first video; real native media ended events were 2 and 1 respectively, with exactly one chapter Next, one chapter-skip confirmation, one skipped quiz, one skipped resource, zero submissions and zero model requests. A unit regression covers an early completion marker while native ended is still false. ZIP 0.2.7: 16 entries, CRC and all packaged build-file bytes verified against dist by the packaging script.

本地已验证：最终全量454项单测、类型/构建、8项发布脚本测试、11项契约测试及契约检查通过；最终5项MV3浏览器回归通过（52.8秒）。首视频未完成/已完成两条混合任务链分别有2/1次原生媒体结束事件，章节Next与确认各一次，跳过测验和资料各一项，提交和模型请求均为0。另有单测覆盖90%标记出现但视频未ended时不能跳转。0.2.7安装包16条目，CRC及与dist逐文件字节一致性验证通过。

PPT support means the already-adapted PDF conversion viewer, not arbitrary slide viewers. Unknown, inaccessible, unloaded or structurally ambiguous modules stop safely; no progress/time/completion is fabricated. Browser tests use real media playback in synthetic course pages. The updated extension has not yet been executed on the user's live course because it still requires the user to reload the local build and reopen the runner.

PPT支持指已适配的PDF转换查看器，不代表所有课件查看器。未知、不可访问、未加载及结构不明确的模块仍停止；不伪造进度、时长或完成状态。浏览器回归使用合成课程和真实媒体播放。新版尚需用户重载本地扩展并重开调度页，不能将合成回归称为真实课程最终通过。

Stop the old runner, reload the existing extension from `apps/extension/dist` (or replace its folder using `release/study-assistant-extension.zip`), refresh the course tab, close the old runner tab and open a new one. Select **只刷课：视频和资料，跳过题目** and start once; subsequent task traversal is automatic. This is a local 0.2.7 build, not a verified public GitHub release.

停止旧任务，重新加载现有 `apps/extension/dist` 扩展（或用本地ZIP覆盖原扩展文件），刷新课程标签页，关闭旧调度页后重开。选择 **只刷课：视频和资料，跳过题目** 并启动一次，后续任务自动继续。当前为本地0.2.7构建，未声称公开发布。
