# Async scan and responsive controls / 异步扫描与可操作界面（0.2.3）

Questions enter the request pool as they are scanned. The full scan no longer blocks the first request. Read-only previews/copying have independent loading state. Inconclusive consensus and recoverable first-response errors automatically try the whole question image before final manual input.

题目按题扫描后立即进入请求池，最多2个模型请求、2个图像/扫描任务并发，收齐结果后按题号核验回填。预览、复制和下载不受整个运行锁定，查看不会额外发送模型请求。长文本绘图每128字主动让出浏览器事件循环。任务模式改为下拉＋单个开始按钮；删除侧边栏手工输入按钮及过期引导，保留最终汇总的有效补答入口。

## Empty responses / 空回答

旧解析器将Chat Completions的content强制转成字符串；数组文本会变成[object Object]，Responses又只识别嵌套output[].content，未识别扁平output_text。这些兼容形态现有回归。null或其他非文本部分不会被误认为答案。

真实上游也可能返回content空但reasoning_content非空，尤其明确length/max_output_tokens截断时。现在明确区分缺字段、纯空回答、仅推理无最终答案；仅后一种且截断时，输出额度有界提升到最多8192 token（可能增加费用）；普通格式重试仍最多3次/4096额度。推理内容从不当作可回填答案，不记录响应、题文或密钥。截图那次没有原始供应商响应，不能把任一可能原因冒称已证实。

## Automatic fallback / 自动后备

首次上下文不足、看不清、可恢复输出错误自动发送整题和所有选项图；普通不确定答案追加共识仍不能确定时也自动图片重试。图片结果替换旧投票，但完整答案字段、合法ID、空格数量及网页回读校验必须通过。首次REFUSED也自动重发整题图片；无已支持题型/输入结构、两阶段都失败，或网页确实拒绝写入时，最终汇总供人工补答。认证、网络、限额等运行级错误明确停止，不当作每题输出错误。

用户浏览源题或其他窗口不会暂停网络请求，也不占用系统鼠标。模式/配置/提交等会改变运行状态的动作仍互斥；图片补答时可编辑其他题草稿与复制图片，但不会同时发起另一网页写操作。

## Verification / 验证

430单测、11契约单测、类型/构建与契约存在性通过；完整MV3 31/31，最终展示按钮改动后9界面单测和1次运行中查看浏览器复测通过。压缩包0.2.3/16条目/0.77MB、CRC/逐字节dist及使用说明/版本/摘要一致，详见验收§9.34。上游和课程页测试为合成Fixture/伪模型；本轮没有修改真实课程或请求真实付费模型。
