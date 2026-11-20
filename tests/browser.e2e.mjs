import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, realpath, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { isAbsolute, relative, resolve, sep } from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { chromium } from "playwright-core";

const siteTitle = "Зачем мы делаем заметки в интернете";
const otherTitle = "Как читать внимательнее";
const quote = "Одинаковая фраза";
const firstComment = "Первая заметка о чтении.";
const secondComment = "Точное описание. Именно так я воспринимаю свои пометки.";
const markup = '<img src=x data-note-markup><b>Текст с разметкой</b>';
const competingFocus = `window.addEventListener("keydown", (event) => {
  const target = event.target;
  if (event.key.length === 1 && !target.closest("textarea, input, [contenteditable=true]")) {
    document.getElementById("page-composer").focus();
  }
}, { capture: true });`;

function fixture(path) {
  const other = path === "/reader";
  const focus = path === "/focus";
  const whitespace = path === "/whitespace";
  const imagePage = path === "/images";
  const title = other ? otherTitle : path === "/spa" ? "Новый раздел" : siteTitle;
  const noteMark = (id) => '<span id="' + id + '"><b>Одинаковая </b><em>фраза</em></span>';
  const paragraphs = imagePage
    ? '<div class="spacer"></div><figure><img id="photo" width="360" height="240" src="/photo.svg" alt="Маяк"><figcaption>Маяк у моря</figcaption></figure>'
    : whitespace
    ? '<p id="whitespace"><span>  Начало&nbsp;&nbsp;</span>\n\t <em>смысл</em> \t <strong>🌙 конец  </strong></p>'
    : other
    ? '<p id="other">Внимательное чтение требует времени и сосредоточенности.</p>'
    : '<p id="first-context">Введение о чтении и личных привычках. ' + noteMark("first") +
      ' помогает заметить, как меняется восприятие.</p>' +
      '<div class="spacer"></div><p id="second-context">Практический пример из редакторской работы. ' +
      noteMark("second") + ' здесь относится к независимой мысли в другом абзаце.</p>';
  return '<!doctype html><html lang="ru"><meta charset="utf-8"><title>' + title +
    '</title><meta http-equiv="Content-Security-Policy" content="default-src &apos;self&apos;; style-src &apos;unsafe-inline&apos;">' +
    '<style>body{margin:0;color:#272820;background:#fdfcf9;font:18px/1.65 system-ui}' +
    'article{max-width:710px;margin:46px auto;padding:0 24px 120px}h1{font:700 2.5rem/1.15 Georgia}' +
    '.spacer{height:630px}p{margin:14px 0}</style><article><h1>' + title + '</h1>' + paragraphs +
    '<p>Читать можно медленно, возвращаясь к важным местам и оставляя свои короткие замечания на полях.</p>' +
    '</article>' + (focus ? '<textarea id="page-composer" aria-label="Сообщение сайта"></textarea>' +
      '<script src="/competing-focus.js"></script>' : '') + '</html>';
}

async function waitFor(predicate, label, timeout = 8000) {
  const until = Date.now() + timeout;
  while (Date.now() < until) {
    if (await predicate()) return;
    await delay(90);
  }
  assert.fail(label);
}

async function hasText(locator, value) {
  await waitFor(async () => (await locator.textContent({ timeout: 800 }))?.includes(value), "Expected: " + value);
}

async function select(page, id) {
  await page.locator("#" + id).scrollIntoViewIfNeeded();
  await page.evaluate((id) => {
    const text = document.getElementById(id);
    const range = document.createRange();
    range.setStart(text.firstElementChild?.firstChild ?? text.firstChild, 0);
    const end = text.lastElementChild?.firstChild ?? text.lastChild;
    range.setEnd(end, end.length);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
  }, id);
}

async function axNode(cdp, name, role) {
  const full = await cdp.send("Accessibility.getFullAXTree");
  return full.nodes.find((node) => !node.ignored && node.name?.value === name && node.role?.value === role);
}

async function clickAx(page, cdp, name, role) {
  const node = await axNode(cdp, name, role);
  assert.ok(node, name + " is visible");
  const { model: { content } } = await cdp.send("DOM.getBoxModel", { backendNodeId: node.backendDOMNodeId });
  await page.mouse.click((content[0] + content[4]) / 2, (content[1] + content[5]) / 2);
}

async function editor(page, cdp, id, body, { pointer = false, screenshot, cancel = false } = {}) {
  await select(page, id);
  await waitFor(() => axNode(cdp, "Заметка к выделению", "button"), "Selection button is visible");
  if (pointer) {
    await clickAx(page, cdp, "Заметка к выделению", "button");
  } else {
    await page.keyboard.press("Alt+Shift+M");
  }

  await waitFor(() => axNode(cdp, "Новая заметка", "dialog"), "Context editor is visible");
  await page.keyboard.insertText(body);
  if (screenshot) await page.screenshot({ path: screenshot, animations: "disabled" });
  await page.keyboard.press(cancel ? "Escape" : "Control+Enter");
  await waitFor(async () => !(await axNode(cdp, "Новая заметка", "dialog")), "Context editor closed");
}

function highlightIds(page, kind = "notes") {
  return page.evaluate((kind) => Array.from(CSS.highlights.get("polya-fields-" + kind) ?? [], (range) => (
    range.startContainer.parentElement?.closest("[id]")?.id ?? ""
  )).sort(), kind);
}

async function highlighted(page, expected) {
  await waitFor(async () => JSON.stringify(await highlightIds(page)) === JSON.stringify(expected),
    "Highlighted ranges: " + expected.join(", "));
}

async function createPageNote(panel, body) {
  await panel.locator("#add-page").click();
  const dialog = panel.getByRole("dialog");
  await dialog.getByRole("textbox").fill(body);
  await dialog.getByRole("button", { name: "Сохранить" }).click();
  await dialog.waitFor({ state: "hidden" });
  await hasText(panel.locator("#notes"), body);
}

test("Chrome MV3 extension UI, notes, routing and restart", { timeout: 180000 }, async (t) => {
  const root = resolve(".qa");
  await mkdir(root, { recursive: true });
  const work = await mkdtemp(resolve(root, "browser-"));
  const profile = resolve(work, "profile");
  const downloads = resolve(work, "downloads");
  await mkdir(downloads);
  process.env.TMPDIR = process.env.TMP = process.env.TEMP = work;
  const screenshotDir = process.env.POLYA_SCREENSHOTS ? root : null;
  const shot = (name) => screenshotDir ? resolve(screenshotDir, name + ".png") : undefined;
  const useChromium = process.env.POLYA_BROWSER === "chromium";
  const headed = process.env.POLYA_HEADED === "1";
  const extensionDir = resolve("dist");
  const server = createServer((request, response) => {
    if (request.url === "/photo.svg") {
      response.setHeader("Content-Type", "image/svg+xml");
      response.end('<svg xmlns="http://www.w3.org/2000/svg" width="720" height="480"><rect width="720" height="480" fill="#343941"/><circle cx="360" cy="190" r="90" fill="#e7ebf0"/></svg>');
      return;
    }
    if (request.url === "/competing-focus.js") {
      response.setHeader("Content-Type", "text/javascript; charset=utf-8");
      response.end(competingFocus);
      return;
    }
    response.setHeader("Content-Type", "text/html; charset=utf-8");
    response.end(fixture(new URL(request.url, "http://fixture").pathname));
  });
  await new Promise((ready) => server.listen(0, ready));
  const port = server.address().port;
  const urlA = "http://127.0.0.1:" + port + "/article";
  const urlB = "http://localhost:" + port + "/reader";

  let context;
  const launch = () => chromium.launchPersistentContext(profile, {
    channel: useChromium ? "chromium" : "chrome",
    headless: !headed,
    downloadsPath: downloads,
    artifactsDir: work,
    viewport: { width: 980, height: 760 },
    reducedMotion: "reduce",
    ignoreDefaultArgs: ["--disable-extensions"],
    args: [
      "--disable-backgrounding-occluded-windows",
      "--disable-renderer-backgrounding",
      ...(useChromium ? ["--disable-extensions-except=" + extensionDir, "--load-extension=" + extensionDir]
        : ["--enable-unsafe-extension-debugging"]),
    ],
  });
  t.after(async () => {
    try {
      await context?.close();
    } finally {
      server.close();
      if (process.env.POLYA_KEEP_PROFILE === "1") {
        t.diagnostic("Test profile kept at " + profile);
      } else {
        const checkedRoot = await realpath(root);
        const checkedWork = await realpath(work);
        const child = relative(checkedRoot, checkedWork);
        assert.ok(child.startsWith("browser-") && !child.includes(sep) && !isAbsolute(child));
        await rm(checkedWork, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
      }
    }
  });

  context = await launch();
  const site = context.pages()[0];
  const siteCdp = await context.newCDPSession(site);
  const cdp = await context.browser()?.newBrowserCDPSession() ?? siteCdp;
  const version = await cdp.send("Browser.getVersion");
  t.diagnostic(version.product + (headed ? " with browser UI" : " in headless mode"));

  let extensionId;
  if (useChromium) {
    const worker = context.serviceWorkers()[0] ?? await context.waitForEvent("serviceworker");
    extensionId = new URL(worker.url()).host;
  } else {
    ({ id: extensionId } = await cdp.send("Extensions.loadUnpacked", { path: extensionDir }));
  }
  const base = "chrome-extension://" + extensionId;
  await site.goto(urlA);
  let toolbarTarget;
  if (headed) {
    const { targetInfos } = await cdp.send("Target.getTargets", { filter: [{ type: "tab" }, { exclude: true }] });
    toolbarTarget = (targetInfos.find(({ url }) => url === urlA) ??
      (targetInfos.length === 1 ? targetInfos[0] : undefined))?.targetId;
  }

  let panel;
  let journal;
  let other;
  let backup;
  const pageErrors = [];
  const track = (page) => page.on("pageerror", (error) => pageErrors.push(error.message));
  track(site);

  await t.test("toolbar is configured and panel follows the active tab", async () => {
    panel = await context.newPage();
    track(panel);
    await panel.setViewportSize({ width: 345, height: 745 });
    await panel.goto(base + "/panel.html");
    journal = panel.locator("#journal-view");
    assert.deepEqual(await panel.evaluate(async () => ({
      behavior: await chrome.sidePanel.getPanelBehavior(),
      options: await chrome.sidePanel.getOptions({}),
    })), { behavior: { openPanelOnActionClick: true }, options: { enabled: true, path: "panel.html" } });
    await site.bringToFront();
    await hasText(panel.locator("#page-title"), siteTitle);
    await hasText(panel.locator("#empty"), "Здесь пока нет заметок");
    if (headed) {
      assert.ok(toolbarTarget, "Found browser tab target for the fixture");
      await cdp.send("Extensions.triggerAction", { id: extensionId, targetId: toolbarTarget });
      await waitFor(async () => (await panel.evaluate(() => chrome.runtime.getContexts({
        contextTypes: ["SIDE_PANEL"],
      }))).some(({ documentUrl }) => documentUrl?.endsWith("/panel.html")),
      "Toolbar action opened the native side panel");
    }
  });

  await t.test("panel switches journal and page in place by pointer and keyboard", async () => {
    const pageTab = panel.getByRole("tab", { name: "Страница" });
    const journalTab = panel.getByRole("tab", { name: "Журнал" });
    const pageView = panel.getByRole("tabpanel", { name: "Страница" });
    const countTabs = () => panel.evaluate(async () => (await chrome.tabs.query({})).length);
    const before = await countTabs();
    assert.equal(await pageTab.getAttribute("aria-selected"), "true");
    assert.equal(await journal.isVisible(), false);

    await journalTab.click();
    await hasText(journal.locator("#empty-title"), "Журнал пока пуст");
    assert.equal(await journalTab.getAttribute("aria-selected"), "true");
    assert.equal(await pageView.isVisible(), false);
    assert.equal(await countTabs(), before);
    assert.equal(panel.url(), base + "/panel.html");

    await journalTab.press("Home");
    assert.equal(await pageView.isVisible(), true);
    assert.equal(await pageTab.evaluate((node) => node === document.activeElement && node.tabIndex === 0), true);
    await pageTab.press("ArrowRight");
    assert.equal(await journal.isVisible(), true);
    assert.equal(await journalTab.evaluate((node) => node === document.activeElement && node.tabIndex === 0), true);
    await journalTab.press("ArrowLeft");
    assert.equal(await pageView.isVisible(), true);
    assert.equal(await countTabs(), before);
    await site.bringToFront();
  });

  await t.test("pointer and keyboard editors save duplicate multi-node quotes and cancel cleanly", async () => {
    const original = await site.locator("article").evaluate((node) => node.outerHTML);
    await editor(site, siteCdp, "first", firstComment, { pointer: true, screenshot: shot("editor") });
    await highlighted(site, ["first"]);
    await editor(site, siteCdp, "second", secondComment);
    await highlighted(site, ["first", "second"]);
    await editor(site, siteCdp, "second", "Отменённая заметка", { cancel: true });
    await hasText(panel.locator("#notes-count"), "2");
    assert.equal(await site.locator("article").evaluate((node) => node.outerHTML), original);
    assert.deepEqual(await site.evaluate(() => Array.from(CSS.highlights.get("polya-fields-notes"), (range) => range.toString())),
      [quote, quote]);
    assert.equal(await panel.locator("#notes article").count(), 2);
    assert.equal(await panel.getByText("Отменённая заметка").count(), 0);
    await site.reload();
    await highlighted(site, ["first", "second"]);
    await site.evaluate(() => window.scrollTo(0, 0));
    const second = panel.locator(".note").filter({ hasText: secondComment });
    await second.getByRole("button", { name: "К цитате" }).click();
    await waitFor(async () => (await highlightIds(site, "current"))[0] === "second",
      "Jump prioritised the matching duplicate");
    assert.ok(await site.evaluate(() => window.scrollY > 200));
  });

  await t.test("dynamic removal and recovery are reflected in the panel and journal", async () => {
    await site.evaluate(() => {
      window.savedParagraph = document.getElementById("second-context");
      window.savedParagraph.remove();
    });
    await highlighted(site, ["first"]);
    await hasText(panel.locator("#notes"), "Цитата не найдена на странице");
    await panel.locator("#journal-tab").click();
    await hasText(journal.locator("#groups"), "Цитата не найдена при последней проверке");
    await site.evaluate(() => document.querySelector(".spacer").after(window.savedParagraph));
    await highlighted(site, ["first", "second"]);
    await waitFor(async () => await journal.getByText("Цитата не найдена при последней проверке").count() === 0,
      "Journal status updated after the quote recovered");
    await hasText(panel.locator("#notes"), secondComment);

    const mirror = await context.newPage();
    await mirror.goto(urlA);
    await highlighted(mirror, ["first", "second"]);
    await mirror.evaluate(() => document.getElementById("second-context").remove());
    await hasText(journal.locator("#groups"), "Цитата не найдена при последней проверке");
    await site.bringToFront();
    await waitFor(async () => await journal.getByText("Цитата не найдена при последней проверке").count() === 0,
      "Rechecking the original tab clears the status recorded by the other tab");
    await mirror.close();
    await panel.locator("#page-tab").click();
  });

  await t.test("switching sites, page notes, search, editing and confirmed deletion", async () => {
    other = await context.newPage();
    track(other);
    await other.goto(urlB);
    await other.bringToFront();
    await hasText(panel.locator("#page-title"), otherTitle);
    await createPageNote(panel, "Хорошая общая мысль о роли личных заметок.");
    await createPageNote(panel, "Временная заметка для удаления");
    const otherCdp = await context.newCDPSession(other);
    await editor(other, otherCdp, "other", markup);
    await highlighted(other, ["other"]);

    await panel.locator("#journal-tab").click();
    const temporary = journal.locator(".note").filter({ hasText: "Временная заметка для удаления" });
    await temporary.getByRole("button", { name: "Удалить" }).click();
    await panel.getByRole("dialog").getByRole("button", { name: "Отмена" }).click();
    assert.equal(await temporary.count(), 1);
    await temporary.getByRole("button", { name: "Удалить" }).click();
    await panel.getByRole("dialog").getByRole("button", { name: "Удалить" }).click();
    await temporary.waitFor({ state: "detached" });

    await hasText(journal.locator("#journal-count"), "2 страницы · 4 заметки");
    const entry = journal.locator(".note").filter({ hasText: firstComment });
    await entry.getByRole("button", { name: "Изменить" }).click();
    const dialog = panel.getByRole("dialog");
    await dialog.getByRole("textbox").fill("Обновлённая мысль о чтении.");
    await dialog.getByRole("button", { name: "Сохранить" }).click();
    await dialog.waitFor({ state: "hidden" });
    await site.bringToFront();
    await panel.locator("#page-tab").click();
    await hasText(panel.locator("#page-title"), siteTitle);
    await hasText(panel.locator("#notes"), "Обновлённая мысль о чтении.");
    if (screenshotDir) await panel.screenshot({ path: shot("panel-page"), animations: "disabled" });
    await panel.locator("#journal-tab").click();
    const search = journal.locator("#query");
    await search.fill("localhost внимательнее сосредоточенности разметкой");
    await hasText(journal.locator("#journal-count"), "1 страница · 1 заметка");
    assert.equal(await journal.locator(".note-body").textContent(), markup);
    assert.equal(await journal.locator("[data-note-markup]").count(), 0);
    assert.equal(await other.locator("[data-note-markup]").count(), 0);
    await panel.locator("#page-tab").click();
    await panel.locator("#journal-tab").click();
    assert.equal(await search.inputValue(), "localhost внимательнее сосредоточенности разметкой");
    await hasText(journal.locator("#journal-count"), "1 страница · 1 заметка");
    await search.fill("невозможный запрос");
    await hasText(journal.locator("#empty-title"), "Ничего не найдено");
    await search.fill("");
    await journal.locator("#sort").selectOption("oldest");
    await hasText(journal.locator(".group-title").first(), otherTitle);
    await journal.locator("#sort").selectOption("newest");
    for (const width of [300, 500]) {
      await panel.setViewportSize({ width, height: 510 });
      assert.ok(await journal.evaluate((view) => view.scrollWidth <= view.clientWidth),
        "Journal does not scroll horizontally at " + width + " px");
      assert.ok(await journal.evaluate((view) => view.scrollHeight > view.clientHeight),
        "Journal cards can scroll vertically at " + width + " px");
      if (screenshotDir) await panel.screenshot({ path: shot("panel-journal-" + width), animations: "disabled" });
    }
    const opened = context.waitForEvent("page");
    await journal.getByRole("link", { name: "Открыть страницу «" + otherTitle + "»" }).click();
    const original = await opened;
    await original.waitForURL(urlB);
    await original.close();
    await panel.locator("#page-tab").click();
  });

  await t.test("SPA navigation, inaccessible pages and JSON backup handling", async () => {
    await site.bringToFront();
    await site.evaluate(() => {
      history.pushState({}, "", "/spa");
      document.title = "Новый раздел";
    });
    await hasText(panel.locator("#page-title"), "Новый раздел");
    await highlighted(site, []);
    await createPageNote(panel, "Маршрут SPA");
    await site.evaluate(() => {
      addEventListener("popstate", () => { document.title = document.querySelector("h1").textContent; }, { once: true });
      history.back();
    });
    await highlighted(site, ["first", "second"]);
    await hasText(panel.locator("#page-title"), siteTitle);
    await hasText(panel.locator("#notes-count"), "2");

    const restricted = await context.newPage();
    await restricted.goto("chrome://version/");
    await restricted.bringToFront();
    await hasText(panel.locator("#empty"), "Страница недоступна");
    assert.equal(await panel.locator("#add-page").isVisible(), false);
    await panel.locator("#journal-tab").click();
    await hasText(journal.locator("#journal-count"), "3 страницы · 5 заметок");
    assert.equal(await journal.isVisible(), true);

    const downloading = panel.waitForEvent("download");
    await journal.locator("#export").click();
    const download = await downloading;
    backup = JSON.parse(await readFile(await download.path(), "utf8"));
    assert.equal(backup.format, "polya-fields");
    assert.equal(backup.notes.length, 5);
    const importData = (value) => journal.locator("#file").setInputFiles({
      name: "backup.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(value)),
    });
    await importData(backup);
    await hasText(journal.locator("#journal-feedback"), "Добавлено 0. Пропущено совпадений 5.");
    const pageNote = backup.notes.find((note) => !note.anchor);
    assert.ok(pageNote);
    const incoming = { ...pageNote, id: "importedrecord123", body: "Только из резервной копии" };
    await importData({ ...backup, notes: [incoming, { ...incoming, id: "invalidrecord1234", pageUrl: "javascript:void(0)" }] });
    await hasText(journal.locator("#journal-feedback"), "Запись №2");
    await hasText(journal.locator("#journal-count"), "3 страницы · 5 заметок");
    await importData({ ...backup, notes: [incoming, { ...incoming, id: "duplicaterecord001" }] });
    await hasText(journal.locator("#journal-feedback"), "Добавлено 1. Пропущено совпадений 1.");
    await hasText(journal.locator("#journal-count"), "3 страницы · 6 заметок");
    await panel.locator("#page-tab").click();
    await hasText(panel.locator("#empty"), "Страница недоступна");
    await restricted.close();
    assert.deepEqual(pageErrors, []);
  });

  await t.test("notes and highlights survive a full Chrome restart", async () => {
    await context.close();
    context = await launch();
    const reopened = context.pages()[0];
    const restartCdp = await context.browser()?.newBrowserCDPSession() ?? await context.newCDPSession(reopened);
    if (!useChromium) {
      const { extensions } = await restartCdp.send("Extensions.getExtensions");
      if (!extensions.some(({ id, enabled }) => id === extensionId && enabled)) {
        // Chrome can scope a DevTools-loaded extension registration to one browser process.
        const { id } = await restartCdp.send("Extensions.loadUnpacked", { path: extensionDir });
        assert.equal(id, extensionId, "Reloaded the same extension origin in the same profile");
        t.diagnostic("DevTools reloaded the unpacked extension after restart");
      }
    }
    await reopened.goto(urlA);
    await highlighted(reopened, ["first", "second"]);
    panel = await context.newPage();
    await panel.goto(base + "/panel.html");
    await panel.locator("#journal-tab").click();
    journal = panel.locator("#journal-view");
    await hasText(journal.locator("#journal-count"), "3 страницы · 6 заметок");
    await hasText(journal.locator("#groups"), "Только из резервной копии");
    await hasText(journal.locator("#groups"), "Обновлённая мысль о чтении.");
  });

  await t.test("context editor keeps typing private from a page's capturing keyboard listener", async () => {
    const page = await context.newPage();
    await page.goto(new URL("/focus", urlA).href);
    const cdp = await context.newCDPSession(page);
    await select(page, "first");
    await waitFor(() => axNode(cdp, "Заметка к выделению", "button"), "Selection button is visible");
    await clickAx(page, cdp, "Заметка к выделению", "button");
    await clickAx(page, cdp, "Комментарий", "textbox");
    const input = () => axNode(cdp, "Комментарий", "textbox");
    assert.ok((await input()).properties.some(({ name, value }) => name === "focused" && value.value));

    // CDP key presses exercise keydown listeners. insertText() bypasses them.
    for (const [key, code, windowsVirtualKeyCode] of [
      ["А", "KeyF", 70], ["Б", "Comma", 188], ["В", "KeyD", 68], ["Г", "KeyU", 85], ["Д", "KeyL", 76],
    ]) {
      const event = { key, code, windowsVirtualKeyCode, modifiers: 8 };
      await cdp.send("Input.dispatchKeyEvent", { ...event, type: "keyDown", text: key });
      await cdp.send("Input.dispatchKeyEvent", { ...event, type: "keyUp" });
    }
    const composer = page.locator("#page-composer");
    assert.equal(await composer.inputValue(), "", "Page composer must not receive the comment");
    assert.equal((await input()).value?.value, "АБВГД");

    await composer.click();
    await page.keyboard.type("outside");
    assert.equal(await composer.inputValue(), "outside");
    await clickAx(page, cdp, "Сохранить", "button");
    await highlighted(page, ["first"]);

    await journal.getByText("АБВГД", { exact: true }).waitFor();
  });

  await t.test("a multi-node quote restores through collapsed spaces and emoji", async () => {
    const page = await context.newPage();
    await page.goto(new URL("/whitespace", urlA).href);
    const cdp = await context.newCDPSession(page);
    await editor(page, cdp, "whitespace", "Проверка позиции цитаты");
    const quote = () => page.evaluate(() => Array.from(CSS.highlights.get("polya-fields-notes") ?? [],
      (range) => range.toString())[0]);
    const original = "Начало\u00a0\u00a0\n\t смысл \t 🌙 конец";
    await waitFor(async () => await quote() === original, "The range trims only its boundary whitespace");

    await page.evaluate(() => {
      document.querySelector("#whitespace span").firstChild.data = " \tНачало\u3000 ";
      document.querySelector("#whitespace strong").firstChild.data = "🌙 конец\u00a0";
    });
    await waitFor(async () => await quote() === "Начало\u3000 \n\t смысл \t 🌙 конец",
      "The quote tracks the normalized text after its raw offsets change");
    await page.reload();
    await waitFor(async () => await quote() === original, "The original DOM range is restored after reloading");
    await page.evaluate(() => {
      CSS.highlights.clear();
      window.dispatchEvent(new Event("focus"));
    });
    await waitFor(async () => await quote() === original, "A page clearing the registry does not lose the note highlight");
  });

  await t.test("image notes retain a local thumbnail and jump from the journal after reload", async () => {
    const page = await context.newPage();
    const url = new URL("/images", urlA).href;
    const source = new URL("/photo.svg", url).href;
    await page.goto(url);
    await page.bringToFront();
    const photo = page.locator("#photo");
    await photo.evaluate((image) => image.decode());

    const send = (request) => panel.evaluate(async (request) => {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      return chrome.tabs.sendMessage(tab.id, request, { frameId: 0 });
    }, request);
    const prepared = await send({ type: "prepareImage", url, source });
    assert.ok(prepared.value.token);
    assert.equal(prepared.value.crop, undefined, "A same-origin image does not require a screenshot");
    assert.deepEqual(await send({ type: "showImageEditor", token: prepared.value.token }), { ok: true, value: true });
    const devtools = await context.newCDPSession(page);
    await waitFor(() => axNode(devtools, "Новая заметка", "dialog"), "Image editor opens");
    await page.keyboard.insertText("Проверка заметки к маяку");
    await page.keyboard.press("Control+Enter");
    const entry = journal.locator(".note").filter({ hasText: "Проверка заметки к маяку" });
    await entry.waitFor();
    const thumbnail = entry.getByRole("img", { name: "Маяк" });
    await waitFor(async () => await thumbnail.evaluate((image) => image.complete && image.naturalWidth === 160), "Local miniature is decoded");
    assert.match(await thumbnail.getAttribute("src"), /^data:image\/webp;base64,/);

    await page.reload();
    await page.bringToFront();
    await panel.getByRole("tab", { name: "Страница" }).click();
    const pageEntry = panel.locator("#notes .note").filter({ hasText: "Проверка заметки к маяку" });
    await pageEntry.getByRole("button", { name: "К изображению" }).waitFor();
    await photo.evaluate((image) => document.querySelector("article").prepend(image.closest("figure")));
    await pageEntry.getByRole("button", { name: "К изображению" }).waitFor();
    await photo.evaluate((image) => image.remove());
    await hasText(pageEntry, "Изображение не найдено на странице");

    await panel.getByRole("tab", { name: "Журнал" }).click();
    await hasText(entry, "Изображение не найдено при последней проверке");
    const opening = context.waitForEvent("page");
    await entry.getByRole("button", { name: "К изображению" }).click();
    const opened = await opening;
    await opened.waitForURL(url);
    await waitFor(() => opened.evaluate(() => window.scrollY > 200), "The original page scrolls to the image");
    const openedCdp = await context.newCDPSession(opened);
    const frameVisible = async () => {
      const { root } = await openedCdp.send("DOM.getDocument", { depth: -1, pierce: true });
      const nodes = [root];
      while (nodes.length) {
        const node = nodes.pop();
        if (node.attributes?.includes("image-frame")) return !node.attributes.includes("hidden");
        nodes.push(...(node.children ?? []), ...(node.shadowRoots ?? []));
      }
      return false;
    };
    await waitFor(frameVisible, "Matching image gets a brief outline");
    await waitFor(async () => !await frameVisible(), "The outline clears automatically");

    const downloading = panel.waitForEvent("download");
    await journal.getByRole("button", { name: "Экспорт" }).click();
    const data = JSON.parse(await readFile(await (await downloading).path(), "utf8"));
    const stored = data.notes.find((note) => note.body === "Проверка заметки к маяку");
    assert.equal(data.version, 2);
    assert.equal(stored.image.source, source);
    assert.equal(stored.image.alt, "Маяк");
    assert.ok(Buffer.from(stored.image.thumbnail.split(",")[1], "base64").length <= 16 * 1024);
    assert.ok(data.notes.some((note) => note.anchor?.exact === quote), "Existing text notes are exported too");
    await journal.locator("#file").setInputFiles({
      name: "images.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(data)),
    });
    await hasText(journal.locator("#journal-feedback"), "Добавлено 0. Пропущено совпадений " + data.notes.length + ".");
    await opened.close();
    await page.close();
  });
});
