import { bodyText, errorText, newId, noteId, noteTimestamp, pageKey, parseBackup, parseDraft } from "./model";
import { installImageMenu, onImageMenu } from "./image-menu";
import type { Resolution } from "./model";
import { ANCHOR_REVISION, NOTE_REVISION } from "./protocol";
import type { Request } from "./protocol";
import { createNote, deleteNote, editNote, getNote, importNotes, listNotes, setResolutions } from "./repository";

const panel = chrome.runtime.getURL("panel.html");

function enablePanel(): void {
  void chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(console.error);
}

chrome.runtime.onInstalled.addListener(enablePanel);
chrome.runtime.onInstalled.addListener(installImageMenu);
chrome.runtime.onStartup.addListener(enablePanel);
chrome.contextMenus.onClicked.addListener((info, tab) => { void onImageMenu(info, tab).catch(() => undefined); });
chrome.tabs.onActivated.addListener(({ tabId }) => {
  void chrome.tabs.sendMessage(tabId, { type: "refresh" }, { frameId: 0 }).catch(() => undefined);
});

const imageJumpKey = (tabId: number) => "imageJump:" + tabId;
interface PendingImageJump { id: string; url: string; expires: number }
chrome.tabs.onRemoved.addListener((tabId) => { void chrome.storage.session.remove(imageJumpKey(tabId)).catch(() => undefined); });

async function openImage(id: string): Promise<void> {
  const note = await getNote(id);
  if (!note?.image || pageKey(note.pageUrl) !== note.pageUrl) throw new Error("Заметка к изображению недоступна.");
  const tab = await chrome.tabs.create({ url: "about:blank" });
  if (tab.id === undefined) throw new Error("Не удалось открыть страницу.");
  const key = imageJumpKey(tab.id);
  try {
    // Register before loading the site. Session storage survives a service-worker restart.
    await chrome.storage.session.set({ [key]: { id, url: note.pageUrl, expires: Date.now() + 120_000 } });
    await chrome.tabs.update(tab.id, { url: note.pageUrl });
  } catch (error) {
    await chrome.storage.session.remove(key).catch(() => undefined);
    throw error;
  }
}

async function signal(key: string): Promise<void> {
  // IndexedDB is authoritative. The storage key only tells open views to read it again.
  await chrome.storage.local.set({ [key]: newId() }).catch(console.error);
}

async function handle(message: Request, sender: chrome.runtime.MessageSender): Promise<unknown> {
  if (sender.id !== chrome.runtime.id || !sender.url) throw new Error("Источник запроса не распознан.");
  const source = sender.url.split(/[?#]/, 1)[0];
  const isUi = source === panel;
  const contentUrl = sender.frameId === 0 && sender.tab?.id !== undefined ? pageKey(sender.url) : null;

  const checkPage = (value: string) => {
    const url = pageKey(value);
    if (!url || (!isUi && contentUrl !== url)) throw new Error("Страница изменилась. Повторите действие.");
    return url;
  };

  if (!isUi && !contentUrl) throw new Error("Страница недоступна для расширения.");

  switch (message.type) {
    case "page":
      return listNotes(checkPage(message.url));
    case "create": {
      const draft = parseDraft(message.draft);
      checkPage(draft.pageUrl);
      const note = await createNote(draft);
      await signal(NOTE_REVISION);
      return note;
    }
    case "pageChanged":
      if (!contentUrl) break;
      await chrome.runtime.sendMessage({ event: "pageChanged", tabId: sender.tab?.id }).catch(() => undefined);
      return null;
    case "takeImageJump": {
      if (!contentUrl || sender.tab?.id === undefined) break;
      const url = checkPage(message.url);
      const key = imageJumpKey(sender.tab.id);
      const pending = (await chrome.storage.session.get<Record<string, PendingImageJump>>(key))[key];
      if (!pending) return null;
      await chrome.storage.session.remove(key);
      return pending.url === url && pending.expires >= Date.now() ? pending.id : null;
    }
    case "openImage":
      if (!isUi) break;
      await openImage(noteId(message.id));
      return null;
    case "resolutions": {
      if (!contentUrl || !Array.isArray(message.entries)) break;
      const updates = new Map<string, Resolution>();
      for (const { id, state } of message.entries) {
        if (state !== "found" && state !== "missing") throw new Error("Неверный статус цитаты.");
        updates.set(noteId(id), state);
      }
      if (updates.size > 0 && await setResolutions(checkPage(message.url), updates)) {
        await signal(ANCHOR_REVISION);
      }
      return null;
    }
    case "all":
      if (isUi) return listNotes();
      break;
    case "edit": {
      if (!isUi) break;
      const note = await editNote(noteId(message.id), bodyText(message.body), noteTimestamp(message.expected));
      await signal(NOTE_REVISION);
      return note;
    }
    case "delete":
      if (!isUi) break;
      await deleteNote(noteId(message.id), noteTimestamp(message.expected));
      await signal(NOTE_REVISION);
      return null;
    case "import": {
      if (!isUi) break;
      const result = await importNotes(parseBackup(message.backup));
      if (result.added > 0) await signal(NOTE_REVISION);
      return result;
    }
  }
  throw new Error("Команда недоступна.");
}

chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (typeof message?.type !== "string") return;
  void handle(message, sender).then(
    (value) => respond({ ok: true, value }),
    (error) => respond({ ok: false, error: errorText(error) }),
  );
  return true;
});
