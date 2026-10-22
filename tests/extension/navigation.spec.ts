import { test, expect, chromium, type BrowserContext } from "@playwright/test";
import { cpSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { EXTENSION_DIST, startMockBackend, openSidePanelForFixture, ensureLoggedIn, type MockBackend } from "./harness";

// Synthetic HTTPS pages are fulfilled locally. Required hosts exist only in this temporary
// test manifest so Chromium can exercise the real cross-origin MV3 bridge without a prompt.
// Production keeps both course and discussion origins optional and requests them by gesture.
let context: BrowserContext;
let backend: MockBackend;
let scratch: string;
let extensionId: string;
const sourceUrl = "https://mooc1.chaoxing.com/mycourse/studentstudy?courseId=1&clazzid=2&chapterId=1";
const discussionUrl = "https://groupweb.chaoxing.com/course/topic/v3/bbs/topic/thread/replysList?courseId=1&classId=2";

test.beforeAll(async () => {
  scratch = mkdtempSync(path.join(tmpdir(), "study-navigation-e2e-"));
  const dist = path.join(scratch, "extension");
  cpSync(EXTENSION_DIST, dist, { recursive: true });
  const manifestPath = path.join(dist, "manifest.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  manifest.host_permissions.push("https://mooc1.chaoxing.com/*", "https://groupweb.chaoxing.com/*");
  writeFileSync(manifestPath, JSON.stringify(manifest));
  backend = await startMockBackend({ port: 8080 });
  context = await chromium.launchPersistentContext(path.join(scratch, "profile"), {
    channel: "chromium", headless: true,
    args: [`--disable-extensions-except=${dist}`, `--load-extension=${dist}`, "--no-first-run",
      "--host-resolver-rules=MAP *.chaoxing.com ~NOTFOUND"]
  });
  const worker = context.serviceWorkers()[0] ?? await context.waitForEvent("serviceworker");
  extensionId = new URL(worker.url()).hostname;
});
test.afterAll(async () => {
  await context?.close(); await backend?.close();
  if (scratch && path.dirname(path.resolve(scratch)) === path.resolve(tmpdir()) && path.basename(scratch).startsWith("study-navigation-e2e-")) {
    rmSync(scratch, { recursive: true, force: true });
  }
});
test.afterEach(async () => {
  for (const page of context.pages()) await page.close();
  await context.unrouteAll({ behavior: "wait" });
});
async function openRunner() {
  const source = await context.newPage(); await source.goto(sourceUrl);
  const { panel, tabId } = await openSidePanelForFixture(context, backend, extensionId, source);
  await ensureLoggedIn(panel); await panel.close();
  const runner = await context.newPage();
  await runner.goto(`chrome-extension://${extensionId}/runner.html?tabId=${tabId}`);
  await expect(runner.getByTestId("runner-limits")).toBeVisible();
  await runner.getByTestId("runner-consent").check(); backend.reset();
  return { source, runner };
}

test("horizontal sections finish before chapter Next, with no false task completion", async () => {
  await context.route("https://mooc1.chaoxing.com/**", route => {
    const url = new URL(route.request().url());
    if (url.pathname === "/mooc-ans/knowledge/cards") return route.fulfill({ contentType: "text/html; charset=utf-8", body:
      url.searchParams.get("knowledgeid") === "2" ? '<!doctype html><div class="ans-job-icon" aria-label="任务点已完成"></div>' :
        '<!doctype html><div id="pageDiv" class="ans-cc"><p>Ordinary loaded lesson material</p></div>' });
    return route.fulfill({ contentType: "text/html; charset=utf-8", body: `<!doctype html><body><ul class="prev_ul">
      ${[1, 2, 3, 4, 5].map(i => `<li id="dct${i}" role="option" class="${i === 1 ? "active" : "c" + i}" onclick="switchTab(${i})">Section ${i}</li>`).join("")}
      </ul><iframe id="iframe" src="/mooc-ans/knowledge/cards?knowledgeid=1&num=0"></iframe><button id="prevNextFocusNext" onclick="nextChapter()">Next</button>
      <script>window.counters={sections:[],next:0}; function switchTab(i){counters.sections.push(i);document.querySelectorAll('li').forEach(e=>e.className=e.id==='dct'+i?'active':'c');document.querySelector('#iframe').src='/mooc-ans/knowledge/cards?knowledgeid=1&num='+(i-1);}
      function nextChapter(){counters.next++;document.querySelector('ul').remove();document.querySelector('#prevNextFocusNext').remove();document.querySelector('#iframe').src='/mooc-ans/knowledge/cards?knowledgeid=2&num=0';}</script>` });
  });
  const { source, runner } = await openRunner();
  await runner.getByTestId("runner-mode").selectOption("videos");
  await runner.getByTestId("runner-start").click();
  await expect(runner.getByTestId("runner-state")).toContainText("DONE", { timeout: 45000 });
  await expect(runner.getByTestId("runner-state")).toContainText("已确认完成 1 个任务");
  await expect(runner.getByTestId("runner-skipped-resources")).toContainText("已越过 5 个");
  expect(await source.evaluate(() => (window as unknown as { counters: unknown }).counters)).toEqual({ sections: [2, 3, 4, 5], next: 1 });
  expect(backend.studyAnswerRequests()).toHaveLength(0);
});

for (const count of [1, 2]) for (const mode of ["course", "questions", "videos"] as const) test(`${count} discussions publish once each before leaving the card in ${mode} mode`, async () => {
  await context.route("https://mooc1.chaoxing.com/**", route => {
    const url = new URL(route.request().url());
    const body = url.pathname === "/mycourse/studentstudy" ? `<iframe id="iframe" src="/mooc-ans/knowledge/cards?knowledgeid=1&num=1"></iframe><button id="prevNextFocusNext" onclick="document.querySelector('#iframe').src='/mooc-ans/knowledge/cards?knowledgeid=2&num=0';this.remove()">Next</button>` :
      url.searchParams.get("knowledgeid") === "2" ? '<div class="ans-job-icon" aria-label="任务点已完成"></div>' :
      url.pathname === "/mooc-ans/knowledge/cards" ? Array.from({ length: count }, (_, index) => `<iframe src="/ananas/modules/insertbbs/index.html?entry=${index}"></iframe>`).join("") :
      url.pathname === "/ananas/modules/insertbbs/index.html" ? `<iframe id="frame_content" src="/mooc-ans/bbscircle/chapter?entry=${url.searchParams.get("entry") ?? "0"}"></iframe>` :
        `<div id="topicMainDiv" class="PublicCardBox" data="${url.searchParams.get("entry") === "1" ? discussionUrl.replace("/thread/", "/thread2/") : discussionUrl}" onclick="openTopicUrl()">Discussion</div><script>function openTopicUrl(){throw new Error('Page popup unavailable');}</script>`;
    return route.fulfill({ contentType: "text/html; charset=utf-8", body: `<!doctype html><body>${body}</body>` });
  });
  await context.route("https://groupweb.chaoxing.com/**", route => route.fulfill({ contentType: "text/html; charset=utf-8", body:
    '<!doctype html><div id="bbsTopicDetail"><div class="topicDetail_title"><span>Topic</span></div><div class="topicDetail_main"><div class="replyContent">Explain this synthetic problem.</div></div></div>' +
    `<div class="topicDetail_replyList"></div><div class="replyEdit"><div class="textareawrap"><textarea>${mode === "videos" ? "Existing complete reply" : ""}</textarea></div><div class="addReply" onclick="publish()">Comment</div></div>
    <script>window.published=0;function publish(){window.published++;const item=document.createElement('div');item.className='topicDetail_replyItem';item.id='reply-'+window.published;const content=document.createElement('div');content.className='replyContent';content.textContent=document.querySelector('textarea').value;item.append(content);document.querySelector('.topicDetail_replyList').append(item);document.querySelector('textarea').value='';}</script>` }));
  const { runner, source } = await openRunner();
  await runner.getByTestId("runner-mode").selectOption(mode);
  const childPromise = context.waitForEvent("page");
  await runner.getByTestId("runner-start").click();
  const child = await childPromise;
  await child.waitForURL(discussionUrl, { timeout: 20000 });
  await test.info().attach("synthetic-child-tabs", { contentType: "application/json", body: JSON.stringify(await runner.evaluate(async () =>
    (await chrome.tabs.query({})).map(tab => ({ id: tab.id, opener: tab.openerTabId, url: tab.url, status: tab.status })))) });
  await expect(runner.getByTestId("runner-state")).toContainText("DONE", { timeout: 45000 });
  await expect(runner.getByTestId("runner-published-discussions")).toContainText(`已核验发表 ${count} 条`);
  await expect(runner.getByTestId("runner-state")).toContainText("已确认完成 1 个任务");
  const discussions = context.pages().filter(page => page.url().startsWith("https://groupweb.chaoxing.com/course/topic/"));
  expect(discussions).toHaveLength(count);
  expect(discussions.map(page => page.url())).toEqual(count === 1 ? [discussionUrl] : [discussionUrl, discussionUrl.replace("/thread/", "/thread2/")]);
  for (const discussion of discussions) {
    await expect(discussion.locator(".replyEdit textarea")).toHaveValue("");
    await expect(discussion.locator(".topicDetail_replyItem .replyContent")).not.toBeEmpty();
    expect(await discussion.evaluate(() => (window as unknown as { published: number }).published)).toBe(1);
  }
  await expect(source.locator("#iframe")).toHaveAttribute("src", /knowledgeid=2/);
  if (mode === "videos") expect(backend.studyAnswerRequests()).toHaveLength(0);
  else expect(backend.studyAnswerRequests().length).toBeGreaterThan(0);
});

for (const mode of ["course", "questions", "videos"] as const) test(`quiz confirms its parent-page dialog in ${mode} mode`, async () => {
  const inherited = mode === "videos";
  await context.route("https://mooc1.chaoxing.com/**", route => {
    const url = new URL(route.request().url());
    const body = url.pathname === "/mycourse/studentstudy" ? `<iframe id="iframe" src="/mooc-ans/knowledge/cards?knowledgeid=1&num=0"></iframe>
      <div id="confirm" style="display:${inherited ? "block" : "none"}"><p>Submit?</p><button>Cancel</button><button onclick="confirmWork()">Submit</button></div>
      <script>window.counts={submitted:0,confirmed:0};function showConfirm(){counts.submitted++;document.querySelector('#confirm').style.display='block';}function confirmWork(){counts.confirmed++;document.querySelector('#iframe').contentDocument.querySelector('.ans-job-icon').setAttribute('aria-label','任务点已完成');document.querySelector('#confirm').remove();}</script>` :
      url.pathname === "/mooc-ans/knowledge/cards" ? '<div class="ans-attach-ct"><div class="ans-job-icon" aria-label="任务点未完成"></div><iframe src="/ananas/modules/work/index.html"></iframe></div>' :
        '<div id="question1"><div class="TiMu"><div class="Zy_TItle"><span class="newZy_TItle">【Single Choice】</span>1 + 1?</div><ul class="Zy_ulTop"><li><span class="num_option" data="A" onclick="document.querySelector(\'#answer1\').value=\'A\'">A</span>2</li><li><span class="num_option" data="B">B</span>3</li></ul><input type="hidden" id="answer1" value="A"></div></div><a class="btnSubmit" onclick="parent.parent.showConfirm()">Submit</a>';
    return route.fulfill({ contentType: "text/html; charset=utf-8", body: `<!doctype html><body>${body}</body>` });
  });
  const { source, runner } = await openRunner(); await runner.getByTestId("runner-mode").selectOption(mode);
  await runner.getByTestId("runner-start").click();
  await expect(runner.getByTestId("runner-state")).toContainText("DONE", { timeout: 45000 });
  await expect(runner.getByTestId("runner-state")).toContainText("已确认完成 1 个任务");
  expect(await source.evaluate(() => (window as unknown as { counts: unknown }).counts)).toEqual({ submitted: inherited ? 0 : 1, confirmed: 1 });
  if (mode === "videos") expect(backend.studyAnswerRequests()).toHaveLength(0);
});
