# Extension updates / 扩展更新发布

Version 0.2.5 defaults to this repository's public GitHub feed. A higher version pushed to main is tested, packaged and published by GitHub Actions; the feed changes only after the published assets pass verification. Unpacked installations still require replacing files and reloading Chrome.

## 用户更新

侧边栏、设置页和调度页顶部「更新 · v版本号」默认选择「GitHub / ZIP 更新」。直接点「检查更新」，首次允许读取 raw.githubusercontent.com。无需填写清单地址。没有设置过其他来源的旧解压版默认商店配置会迁移；自定义源和显式商店设置保留。0.2.4 用户需要先手工填写下方清单或下载新版完成首次升级。

发现更高版本后：下载 ZIP → 停止全部任务并关闭旧调度页 → 覆盖原先加载的 extension 文件夹 → 点「覆盖文件后，打开扩展管理页」→「重新加载」。保持原路径，不删除扩展，本机配置通常保留。版本号相同不会提示升级，也不会降级。

普通 Windows/macOS 解压扩展无法静默替换自己的文件。本更新按钮提供检测、下载与管理页入口；完全自动安装需要商店分发或受管理的企业策略。见 [Chrome 分发文档](https://developer.chrome.com/docs/extensions/how-to/distribute) 和 [更新生命周期](https://developer.chrome.com/docs/extensions/develop/concepts/extensions-update-lifecycle)。目前未上架商店。

## 开发者发布：提高版本并推送 main

例如当前为 0.2.5，下一次完成开发后：

```powershell
npm run version:extension -- 0.2.6
git add .
git commit -m "Release v0.2.6"
git push origin main
```

版本命令一次同步根/扩展 package.json、Chrome manifest 与 package-lock.json 的六个版本字段。只接受更高的三段数字版本，每段不超过 65535；先验证所有旧版本一致，再写入。不执行提交、打标签或联网。

`.github/workflows/release-extension.yml` 在 main 的源码、构建脚本、测试、依赖/版本、使用说明或工作流变更时执行，也可在 Actions 的 Publish extension 页面手动运行。README 等纯文档更改无需发布。流程使用仓库自带 GITHUB_TOKEN 的 contents:write，无需配置个人 Token 或供应商 Key：

1. 全新环境 npm ci，验证版本一致，运行类型检查、全部扩展单测、发布脚本单测、契约单测与契约检查。
2. 构建扩展并打包。ZIP CRC 和每个构建文件逐字节验证。
3. 创建 v版本号草稿 Release，上传 ZIP、SHA-256 文件和 update.json，最后公开发布。已公开版本的文件不覆盖；同版本代码修改不会成为新版本，必须增加版本号。同一提交留下的草稿可在重跑时继续上传；其他提交的草稿会拒绝覆盖。
4. 从已发布 Release 重新下载三个文件，校验 ZIP、SHA-256 与包内 manifest 版本，再用 GitHub Contents API 原子写入 main/updates/update.json。下载链接自动生成绝对版本地址。版本较旧不能覆盖新清单，相同版本不能换不同包；重复运行相同发布可安全恢复清单同步。文件 SHA 冲突时失败，可重新运行。

检查 [Actions](https://github.com/ChinaYosh007/xuexitong-shuake-plugin/actions/workflows/release-extension.yml) 为绿色后，用户即可通过更新菜单检查到新版。推送本身并不等于发布成功；失败时已有更新清单继续可用。仓库若启用分支保护禁止机器人直接写 main，需要允许此更新或改用审核发布流程，否则最后一步会失败。

自动清单提交带 `[skip ci]`，且 updates 路径不在触发范围，避免发布循环。发布串行执行，不取消进行中的发布。不重复覆盖已公开 ZIP，不自动回滚用户版本。发布工作流只允许 main。

## 地址与隐私边界

- [仓库](https://github.com/ChinaYosh007/xuexitong-shuake-plugin)
- [最新安装包](https://github.com/ChinaYosh007/xuexitong-shuake-plugin/releases/latest)
- [公共更新清单](https://raw.githubusercontent.com/ChinaYosh007/xuexitong-shuake-plugin/main/updates/update.json)

清单请求仅在点击检查时发生，权限限定该来源；无凭据、无 Cookie、不带供应商 Key 或课程内容、不跟随重定向，16 KB 上限与 10 秒超时保留。只接受 HTTPS 或本机 HTTP，数字版本、ZIP 地址及 SHA-256 格式均校验。扩展只下载打包代码，不执行远程脚本，不强制重启正在运行的任务。SHA-256 在客户端显示为发布者声明，不冒称已校验用户下载的字节。

GitHub 源码 ZIP 不含 dist，用户必须下载 Release 的 study-assistant-extension.zip。release/、node_modules、本机设置与运行记录不进入仓库。

手工构建仍可执行 npm run package:extension，输出 release/study-assistant-extension.zip、对应 .sha256 与相对路径 release/update.json。仓库更新菜单使用的 main/updates/update.json 由发布流程改为对应 Release 的绝对 ZIP 地址；不要在上传安装包成功前手工提前改版本清单。
