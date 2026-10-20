# Lazy blank editor fix / 延迟填空编辑器修复（0.2.1）

后续0.2.2继续保留本修复，并增加整题图片直填与逐题补答，最新流程见 [image-retry-entry-flow.md](image-retry-entry-flow.md)。本页验证数字是0.2.1历史快照。

The reported page-change failure is caused by the adapter's editor lifecycle handling. Closed blanks were omitted from the captured schema. Version 0.2.1 counts stable blank slots, waits for each editor before writing, and sends the full question with an exact response template. A clearer prompt alone cannot restore blanks missing from the captured data.

## 根因

真实页面只读 DOM 证据见 compatibility §6.8。第6题有2个输入位置、第12题有5个、第16/17题分别有2/3个。关闭的输入位置仍有 `.InpDIV`，对应 UEditor 包在隐藏 `.textDIV` 中。

旧采集会点击所有占位位置，又立即统计可见编辑器。异步加载及切换后只有部分编辑器可见，导致 `blanks` 少空、资料题/分录题被归为一个简答。指纹也依赖可见编辑器，捕获其他题或页面关闭编辑器后指纹变化；因此模型即使返回正确答案仍在 APPLY 前被拒绝。固定返回格式不能弥补错误的输入位置数量。

## 修改

1. 以已观察的 `.blankItemInp` 内唯一占位位置/对应 textarea 标识作为逻辑空格；关闭和打开状态不改变空格数或身份，读取时不点开编辑器。
2. 每空按页面顺序固定 blank_1…blank_N；未知标签但符合此布局也按填空。完整题干/程序仍由既有源读取通道发送，图示沿既有图片规则处理。
3. 请求增加 blankCount、requiredIds 与完整 responseTemplate，要求每空分别返回 answer，不能把五空合并一个 textAnswer。漏空触发有界格式重试（最多3次），不静默补造答案。
4. 回填逐空点击站点原占位位置，等待其编辑器就绪，再写纯文本；等待后再次校验题目未变。只读/禁用、真实题文变化、槽位变化仍拒绝。
5. 编辑器加载/工具图标不算题目内容改变；不取消题目指纹校验，不改隐藏 textarea、不强制解除隐藏、不执行模型代码。

两空的返回结构示例（仅格式示意）：

```json
{
  "status": "ANSWERED",
  "selectedOptionIds": [],
  "blankAnswers": [
    { "blankId": "blank_1", "answer": "第一空内容" },
    { "blankId": "blank_2", "answer": "第二空内容" }
  ],
  "textAnswer": null,
  "explanation": "",
  "caveats": []
}
```

## 安装后重试

先停止旧运行、关闭旧调度页，覆盖原加载目录/重新加载扩展，**刷新课程页**后新开调度并重新读取全部题目。检查第6题显示两个空、第12题五个空；不要继续使用旧运行页缓存的单空/简答结构。模型未知内容或页面仍不支持时继续保留人工补答，不提交缺答任务。

## 验证边界

407单元测试、根类型检查、根构建与21接口/25故障码/92字段契约检查通过。新增回归覆盖：未打开的五空完整计数、活动编辑器/工具图标变化不改变指纹、槽位换序改变指纹、只读拒绝、等待中题目变化零写入、模型漏空重试与完整模板。

专项真实 MV3 + 合成页面测试已通过：3题分别2/5/2空，初次采集编辑器激活0次/iframe0个，模型逆序返回；9个输入位置分别正确写入，激活9次，Submit/确认各1次，模型请求3次，无人工汇总。

最终全量 MV3 **29/29通过（1.5分钟）**，0.2.1包15条目/0.77MB，CRC及扩展文件与dist逐字节一致，更新清单与SHA-256同步生成。截图`.local-demo/lazy-blanks-verified.png`，验收§9.32。

真实页面本轮仅只读取证；未重新加载用户扩展、写入或提交真实题目。真实供应商的答案正确性仍未验证，不把合成测试结果冒称真站端到端成功。
