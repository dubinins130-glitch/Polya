import { domain, errorText, newId, type Note } from "./model";
import { bindJournal } from "./journal";
import { ask, askPage, NOTE_REVISION, type PageSnapshot } from "./protocol";
import { get, keepFocus, noteActions, NoteDialog, noteRow, status } from "./ui";

const title = get("page-title");
const host = get("page-domain");
const addPage = get<HTMLButtonElement>("add-page");
const empty = get("empty");
const section = get("notes-section");
const container = get("notes");
const count = get("notes-count");
const feedback = get("feedback");
const dialog = new NoteDialog();
const refreshJournal = bindJournal(dialog);

let view: { tabId: number; url: string; title: string } | undefined;
let activeTab: number | undefined;
let generation = 0;

const announce = (text: string, error = false) => status(feedback, text, error);
const actions = {
  ...noteActions(dialog, refresh, announce),
  async jump(note: Note) {
    if (!view || note.pageUrl !== view.url) return;
    const subject = note.image ? "изображению" : "цитате";
    try {
      if (!await askPage(view.tabId, { type: "jump", id: note.id, url: view.url })) {
        announce(note.image ? "Изображение сейчас недоступно на странице." : "Цитата сейчас недоступна на странице.", true);
        refresh();
      }
    } catch {
      announce("Перейти к " + subject + " не удалось. Проверьте, открыта ли страница.", true);
      refresh();
    }
  },
};

function unavailable(text: string): void {
  view = undefined;
  title.textContent = "Текущая страница";
  host.hidden = addPage.hidden = section.hidden = true;
  container.replaceChildren();
  empty.hidden = false;
  empty.textContent = text;
}

function render(tabId: number, snapshot: PageSnapshot & { url: string }, notes: Note[]): void {
  view = { tabId, url: snapshot.url, title: snapshot.title || domain(snapshot.url) };
  title.textContent = view.title;
  host.textContent = domain(view.url);
  host.title = view.url;
  host.hidden = addPage.hidden = section.hidden = false;
  empty.hidden = notes.length > 0;
  empty.textContent = "Здесь пока нет заметок. Выделите текст на странице или добавьте заметку ко всей странице.";
  count.textContent = String(notes.length);
  keepFocus(container, () => {
    container.replaceChildren(...notes
      .sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id))
      .map((note) => {
        const resolution = snapshot.resolutions[note.id];
        const label = note.image
          ? resolution === "found" ? "" : resolution === "missing" ? "Изображение не найдено на странице" : "Проверяем изображение…"
          : !note.anchor || resolution === "found" ? ""
          : resolution === "missing" ? "Цитата не найдена на странице" : "Проверяем цитату…";
        return noteRow(note, actions, label, resolution === "found");
      }));
  }, addPage);
}

async function load(): Promise<void> {
  const current = ++generation;
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (current !== generation) return;
    if (tab?.id !== activeTab) {
      activeTab = tab?.id;
      announce("");
      unavailable("Открываем заметки…");
    }
    if (tab?.id === undefined) {
      unavailable("Откройте веб-страницу, чтобы добавить заметку.");
      return;
    }
    let snapshot: PageSnapshot;
    try {
      snapshot = await askPage(tab.id, { type: "snapshot" });
    } catch {
      if (current === generation) {
        unavailable(tab.status === "loading" ? "Страница загружается…"
          : "Страница недоступна. Откройте сайт по HTTP или HTTPS. Если вы только установили расширение, обновите вкладку.");
      }
      return;
    }
    if (current !== generation) return;
    const url = snapshot.url;
    if (!url) {
      unavailable("Эта страница недоступна для заметок.");
      return;
    }
    if (view && view.url !== url) {
      announce("");
      unavailable("Открываем заметки…");
    }
    const notes = await ask({ type: "page", url });
    if (current === generation) render(tab.id, { ...snapshot, url }, notes);
  } catch (error) {
    if (current === generation) {
      unavailable("Не удалось загрузить заметки.");
      announce(errorText(error), true);
    }
  }
}

function refresh(): void {
  void load();
}

addPage.addEventListener("click", () => {
  if (!view) return;
  const page = view;
  const id = newId();
  dialog.open({
    title: "Заметка к странице",
    description: page.title,
    action: "Сохранить",
    async run(body) {
      await ask({
        type: "create",
        draft: { id, body, pageUrl: page.url, pageTitle: page.title.slice(0, 4096) },
      });
      announce("Заметка сохранена.");
      refresh();
    },
  });
});

chrome.tabs.onActivated.addListener(() => { refresh(); });
chrome.tabs.onUpdated.addListener((id, changes) => {
  if (id === activeTab && (changes.status || changes.url || changes.title)) refresh();
});
chrome.runtime.onMessage.addListener((message) => {
  if (message?.event === "pageChanged" && message.tabId === activeTab) refresh();
});
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes[NOTE_REVISION]) refresh();
});
window.addEventListener("focus", refresh);
document.addEventListener("visibilitychange", () => { if (!document.hidden) refresh(); });

const tabs = [
  { button: get<HTMLButtonElement>("page-tab"), view: get("page-view"), refresh },
  { button: get<HTMLButtonElement>("journal-tab"), view: get("journal-view"), refresh: refreshJournal },
];

function selectTab(index: number): void {
  tabs.forEach(({ button, view }, position) => {
    const active = position === index;
    button.tabIndex = active ? 0 : -1;
    button.setAttribute("aria-selected", String(active));
    view.hidden = !active;
  });
  tabs[index].refresh();
}

tabs.forEach(({ button }, index) => {
  button.addEventListener("click", () => selectTab(index));
  button.addEventListener("keydown", (event) => {
    let next: number;
    switch (event.key) {
      case "ArrowLeft": case "ArrowRight": next = 1 - index; break;
      case "Home": next = 0; break;
      case "End": next = tabs.length - 1; break;
      default: return;
    }
    event.preventDefault();
    selectTab(next);
    tabs[next].button.focus();
  });
});

selectTab(location.hash === "#journal" ? 1 : 0);
