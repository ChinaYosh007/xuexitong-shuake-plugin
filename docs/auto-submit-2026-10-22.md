# Automatic submission in all runner modes / 全模式自动提交

Date / 日期: 2026-10-22 (Asia/Shanghai).

The user requested automatic submission in every mode and explicitly included publishing discussion replies. This supersedes the earlier draft-only discussion setting. Existing unrelated local changes were preserved. No public release or version bump was performed.

用户要求所有模式自动提交，并明确包括讨论发表，覆盖此前讨论仅草稿约定。本轮保留原有本地修改，未公开发布或升版本。

## Changes / 修改

- Quiz confirmation now searches the active task's documents and their same-origin ancestors. The underlying Submit button remains scoped to the task. An already-open confirmation can be adopted after every answer is verified, avoiding a second underlying submit click. Answers are checked again before the final confirmation; multiple dialogs stop the run.
- Course and question modes retain automatic answer generation and submission. Videos-only mode verifies existing answers and submits only a complete set; it does not generate missing answers. Incomplete tasks remain skippable in that mode.
- Discussion replies are verified and published exactly once through the observed `.replyEdit .addReply` control. Success requires a newly inserted `.topicDetail_replyList > .topicDetail_replyItem[id]` with matching visible `.replyContent` and the same editor becoming empty. An old matching reply, editor clearing alone or a click alone is insufficient.
- After publication, routing returns to the original course, verifies the original task identity and continues navigation. Published discussions have a separate counter; publication does not fabricate a green course task marker. Videos-only mode can publish an existing discussion draft without a model request; an empty draft is skipped.
- Completed runs ignore repeated Submit Now / Recheck clicks. A delayed discussion-publication recheck updates the discussion counter, without resending or incrementing course task completion.

测验确认查找补齐同源祖先文档，底层提交仍限定当前任务；已有确认框须完整核验后接管，最后确认前再次回读，多义即停。刷课/刷题继续自动生成与提交；只刷课提交已有完整答案，不补生成缺答。讨论单次发表，必须看到新匹配回复与原输入框清空才确认，之后核实原任务身份再继续课程。讨论发表数独立统计，不伪造站点绿标。已完成运行再次点提交/复核不会重发或重复计数。

## Evidence and limits / 证据与限制

The screenshot supplied by the user showed a pending Submit? dialog. Static inspection found that the old confirmation search was restricted to the active module document. Synthetic nested-frame tests reproduce that failure and verify the ancestor-document fix. The original real dialog was no longer open when the browser was inspected, so its exact frame ownership was not established live.

Real browser tools published one pre-existing discussion draft, then observed the matching new reply and cleared editor. This verified the site's control/result structure; it was not execution by the final rebuilt extension. The user's original reply and identity are not stored in the repository.

用户截图显示卡在 Submit?；代码审查发现确认查找仅限模块文档，合成嵌套框架复现并验证了修复。取证时真站已进入下一章，未现场确认截图弹框的实际归属，不能声称这是用户当次失败的唯一原因。浏览器工具曾发表一条用户已有讨论草稿并观察结果，仅用于真实控件与结果结构取证，不能冒充最终扩展实跑；仓库不保存回复与身份。

Formal exams, incomplete answers, changed fingerprints and unknown controls retain their existing guards. The final extension completing an entire real course remains unverified. Other dialog skins, rich discussion editors and result-list replacement instead of insertion are unsupported until verified. Publication state remains in memory, so a fresh document does not prove which old replies were sent by a previous run.

正式考试、缺答、指纹变化与未知控件继续保留现有守卫。最终扩展真实整课仍未验证；其它弹框皮肤、富文本讨论输入框、以整表替换代替追加的回复结果均需另行取证。发表证据仅在内存，新文档不能证明历史回复来自此前运行。

Final command results are recorded in acceptance §9.46.

最终命令结果见验收 §9.46。

Verified / 已验证：513 unit tests; 42 MV3 browser tests (3.5 min), including the seven all-mode/navigation checks on a fresh final-build copy; typecheck; build; `git diff --check`; local ZIP CRC and built-file byte equality (17 entries, 1.03 MB). No real-course end-to-end result is implied by these synthetic tests.

513 项单测与 42 项 MV3 浏览器回归通过，最终构建副本的七项重点覆盖包含在其中；类型、构建、差异空白检查及本地 ZIP 核验通过。合成浏览器测试不代表真实整课已验证。
