# 测试目录

本目录包含合成 Fixture、扩展集成测试与 OpenAPI/TypeScript 契约校验。所有测试默认离线运行，不访问真实学习通页面，也不调用真实 AI 供应商。

| 目录 | 内容 | 运行方式 |
|---|---|---|
| `fixtures/` | 10 个自包含学习通练习/故障场景页面 + 契约 README | `npx playwright test -c tests/fixtures/playwright.config.ts` |
| `extension/` | 真实 MV3 扩展加载 + 本地伪后端的 Playwright 集成测试 | 先 `node scripts/build-extension.mjs`，再 `npx playwright test -c tests/extension/playwright.config.ts` |
| `contracts/` | `docs/openapi.yaml` ↔ `packages/contracts` 端点/错误码/字段一致性测试 | `node --test tests/contracts/verify-contracts.test.mjs` |

## 前置条件

1. 仓库根已执行 `npm install`（根 devDependencies 含 `@playwright/test`）。不要在本目录重复安装。
2. Playwright 浏览器已安装。若 npm/CDN 访问受限，可用镜像：
   ```powershell
   $env:PLAYWRIGHT_DOWNLOAD_HOST='https://cdn.npmmirror.com/binaries/playwright'
   npx playwright install chromium
   ```
3. 扩展集成测试需要 `apps/extension/dist`，由 `scripts/build-extension.mjs` 生成；测试读取构建产物中的本机后端 Origin（默认 `http://127.0.0.1:8080`），并启动只实现契约端点的伪后端。**端口 8080 必须空闲**，否则测试会在 setup 阶段跳过并给出原因，不会伪造结果。
4. `node --test` 需要显式文件路径（Node 22 不会把目录当作测试集），因此命令中列出了文件。

## 扩展集成测试做什么

- 读取构建出的 `manifest.json`，断言权限仅为 `activeTab/scripting/storage/sidePanel`，不请求 `cookies/webRequest/debugger/<all_urls>`，CSP 不含 `unsafe-eval/unsafe-inline`。
- 用 persistent context 真实加载 MV3 扩展（不用页面内等价脚本代替），通过伪后端登录并驱动侧边栏。
- Fixture 通过伪后端同源 HTTP 服务提供，扩展 host permission 覆盖该 Origin，因此脚本注入走真实 `chrome.scripting.executeScript` 路径。
- 覆盖：采集不发请求、审核前零写入、发送需要显式点击、graded 不回填、autosubmit 拒绝、readonly 拒绝、changed-question 零写入、controlled-input 部分填写、no-paste 控件写入、selection-disabled 不依赖 Selection、iframe 同源绑定、prompt-injection 按数据渲染、关闭侧边栏不恢复题文。

集成测试的伪后端只实现测试所需端点，记录所有请求；不会请求真实供应商，也不会产生费用。

## 限制

- 真实学习通页面、真实供应商与真实部署未验证；合成 Fixture 通过不等于真实页面适配成功。
- `docs/openapi.yaml` 由 backend-dev 维护；文件不存在时 `scripts/verify-contracts.mjs` 会以非 0 退出，契约测试中“实际仓库一致”一项标记为 skip。
- 具体执行结果与时间见 `docs/acceptance.md`；未执行或环境受限的检查必须标为 Unverified。
