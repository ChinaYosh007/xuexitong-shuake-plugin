# Extension updates / 扩展更新发布

Version 0.2.0 provides an update dropdown on all three extension pages. ZIP users can check a public feed and download a newer release; they must replace the loaded folder and reload Chrome. Store installations use Chrome's update mechanism. The public GitHub feed and release links are listed below; there is no Chrome Web Store listing.

## 使用与限制

- 侧边栏、设置页、调度页顶部「更新 · v版本号」；选择商店或 ZIP 更新源。
- ZIP：用户点击时才请求清单所属的具体 Origin 权限；仅接受 HTTPS（本机测试可用 HTTP localhost/127.0.0.1）。不自动联网检查。
- 清单最大 16 KB，10 秒超时；验证数字版本、ZIP 地址和 SHA-256 格式；只显示更高版本，拒绝降级。
- 请求不带供应商 Key、课程内容、Cookie；不跟随重定向。ZIP 链接作为下载链接打开，不执行远程代码，不强制 reload。
- SHA-256 是发布者声明，界面不冒称已经验证下载内容；用户可在下载后核对。
- 用户先停止所有运行，覆盖原目录，再在扩展管理页重新加载；不要删掉扩展后新建另一目录，避免改变扩展身份和丢失配置。

Chrome 普通 Windows/macOS 用户的自动安装分发需要商店；自托管安装面向受管理的企业策略。详情见 [Chrome 分发文档](https://developer.chrome.com/docs/extensions/how-to/distribute)、[更新生命周期](https://developer.chrome.com/docs/extensions/develop/concepts/extensions-update-lifecycle)、[requestUpdateCheck](https://developer.chrome.com/docs/extensions/reference/api/runtime#method-requestUpdateCheck)。本功能不承诺解压版静默替换文件。

## 开发者发布步骤

1. 修改源码与测试，更新根 `package.json`、`apps/extension/package.json`、`apps/extension/manifest.base.json` 中版本号，然后 `npm install --package-lock-only --ignore-scripts` 同步锁文件；Chrome 版本须 1–4 个数字段（每段 0–65535、不得全为 0）。
2. 执行下列命令；Node ≥20、Python 3 为开发机依赖，收包用户不需要安装这些工具。

```powershell
npm ci
npm run typecheck
npm run test
npm run test:contracts:unit
npm run verify:contracts
npm run build
npm run test:fixtures
npm run test:e2e
npm run package:extension
```

3. 打包器直接从 dist 取文件，校验 CRC 和每个文件的字节一致性，输出：

```text
release/study-assistant-extension.zip
release/study-assistant-extension.zip.sha256
release/update.json
```

4. 把这三个文件放到自己的 HTTPS 静态托管目录。先上传并确认 ZIP，再上传清单，避免清单先指向不存在的包。给其他用户该目录下 `update.json` 的完整地址；这个地址不是 AI 供应商 Base URL。清单中的 zipUrl 是同目录相对路径，开发者可修改说明 notes，修改 ZIP 后须重新生成 SHA-256。
5. 用旧版本检查此 URL，确认新版本提示、下载后摘要一致，再按使用说明覆盖重载。保留最近版本便于人工回退；菜单不会自动提供降级。

清单结构：

```json
{
  "version": "0.2.0",
  "zipUrl": "study-assistant-extension.zip",
  "sha256": "由打包器填入实际的64位十六进制摘要",
  "notes": "本次更新说明"
}
```

上例是结构说明，真实摘要以打包器生成文件为准。未配置Chrome商店ID或签名发布密钥；现有公开分发使用下方GitHub Release和raw更新清单。


## GitHub 发布地址

仓库：https://github.com/ChinaYosh007/xuexitong-shuake-plugin

下载：https://github.com/ChinaYosh007/xuexitong-shuake-plugin/releases/latest

插件「更新」菜单选择ZIP渠道，填入：

```text
https://raw.githubusercontent.com/ChinaYosh007/xuexitong-shuake-plugin/main/updates/update.json
```

下次发布：先运行打包器，将ZIP、SHA-256文件与release/update.json上传对应版本Release；再同步根updates/update.json，将zipUrl改为该版本Release的绝对ZIP地址，并保留打包器算出的SHA-256。清单使用raw链接，ZIP使用Release下载链接；不要给清单填github.com页面地址。源码和Release分别保存，dist/node_modules、本机配置与浏览器运行记录不入库。
