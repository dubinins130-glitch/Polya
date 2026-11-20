import { domain, errorText, makeBackup, MAX_BACKUP_BYTES, type Note } from "./model";
import { groupNotes, type SortOrder } from "./groups";
import { ANCHOR_REVISION, ask, JOURNAL_SORT, NOTE_REVISION } from "./protocol";
import { countLabel, el, get, keepFocus, noteActions, noteRow, status, type NoteDialog } from "./ui";

export function bindJournal(dialog: NoteDialog): () => void {
  const view = get("journal-view");
  const groups = get("groups");
  const count = get("journal-count");
  const query = get<HTMLInputElement>("query");
  const order = get<HTMLSelectElement>("sort");
  const importButton = get<HTMLButtonElement>("import");
  const exportButton = get<HTMLButtonElement>("export");
  const file = get<HTMLInputElement>("file");
  const feedback = get("journal-feedback");
  const empty = get("journal-empty");
  const emptyTitle = get("empty-title");
  const emptyDescription = get("empty-description");

  let notes: Note[] = [];
  let sequence = 0;
  let loaded = false;
  let sortTouched = false;

  const announce = (text: string, error = false) => status(feedback, text, error);
  const actions = {
    ...noteActions(dialog, refresh, announce),
    async jump(note: Note) {
      try { await ask({ type: "openImage", id: note.id }); }
      catch (error) { announce(errorText(error), true); }
    },
  };

  const noteCount = (total: number) => countLabel(total, "заметка", "заметки", "заметок");
  const pageCount = (total: number) => countLabel(total, "страница", "страницы", "страниц");

  function render(): void {
    if (!loaded) return;
    const active = groupNotes(notes, query.value, order.value as SortOrder);
    const visible = active.reduce((sum, group) => sum + group.notes.length, 0);
    count.textContent = pageCount(active.length) + " · " + noteCount(visible);
    keepFocus(groups, () => {
      const sections = active.map((group) => {
        const section = el("section", "page-group");
        const header = el("header", "group-header");
        const identity = el("div", "group-identity");
        const subtitle = el("p", "group-meta", domain(group.url) + " · " + noteCount(group.notes.length));
        subtitle.title = group.url;
        identity.append(el("h2", "group-title", group.title), subtitle);
        const open = el("a", "text-button open-page", "Открыть ↗");
        open.href = group.url;
        open.target = "_blank";
        open.rel = "noopener noreferrer";
        open.setAttribute("aria-label", "Открыть страницу «" + group.title + "»");
        open.dataset.focusKey = group.notes[0].id + "-open";
        header.append(identity, open);
        section.append(header);
        for (const note of group.notes) {
          const state = note.image
            ? note.resolution === "missing" ? "Изображение не найдено при последней проверке"
              : !note.resolution ? "Изображение ещё не проверялось" : ""
            : note.resolution === "missing" ? "Цитата не найдена при последней проверке"
            : note.anchor && !note.resolution ? "Цитата ещё не проверялась" : "";
          section.append(noteRow(note, actions, state, !!note.image));
        }
        return section;
      });
      groups.replaceChildren(...sections);
    }, query);
    empty.hidden = visible > 0;
    if (!visible) {
      emptyTitle.textContent = notes.length ? "Ничего не найдено" : "Журнал пока пуст";
      emptyDescription.textContent = notes.length ? "Измените запрос, чтобы найти нужную заметку."
        : "Добавьте заметку на веб-странице или импортируйте резервную копию.";
    }
  }

  function refresh(): void {
    if (view.hidden) return;
    const current = ++sequence;
    void ask({ type: "all" }).then((result) => {
      if (current !== sequence) return;
      notes = result;
      loaded = true;
      render();
    }).catch((error) => {
      if (current !== sequence) return;
      if (!loaded) {
        emptyTitle.textContent = "Журнал недоступен";
        emptyDescription.textContent = "Обновите страницу и повторите попытку.";
      }
      announce(errorText(error), true);
    });
  }

  query.addEventListener("input", render);
  order.addEventListener("change", () => {
    sortTouched = true;
    render();
    void chrome.storage.local.set({ [JOURNAL_SORT]: order.value })
      .catch((error) => announce(errorText(error), true));
  });

  importButton.addEventListener("click", () => file.click());
  file.addEventListener("change", async () => {
    const selected = file.files?.[0];
    file.value = "";
    if (!selected) return;
    importButton.disabled = true;
    announce("Импортируем заметки…");
    try {
      if (selected.size > MAX_BACKUP_BYTES) throw new Error("Файл превышает ограничение в 64 МиБ.");
      let backup: unknown;
      try {
        backup = JSON.parse(await selected.text());
      } catch {
        throw new Error("Не удалось прочитать файл JSON.");
      }
      const { added, skipped } = await ask({ type: "import", backup });
      announce("Добавлено " + added + ". Пропущено совпадений " + skipped + ".");
      refresh();
    } catch (error) {
      announce(errorText(error), true);
    } finally {
      importButton.disabled = false;
    }
  });

  exportButton.addEventListener("click", async () => {
    exportButton.disabled = true;
    try {
      const all = await ask({ type: "all" });
      const backup = makeBackup(all);
      const blob = new Blob([JSON.stringify(backup, null, 2)], { type: "application/json" });
      if (blob.size > MAX_BACKUP_BYTES) {
        throw new Error("Размер резервной копии превышает ограничение в 64 МиБ.");
      }
      const url = URL.createObjectURL(blob);
      const link = el("a");
      link.href = url;
      link.download = "polya-" + new Date().toISOString().slice(0, 10) + ".json";
      document.body.append(link);
      link.click();
      link.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 30000);
      announce("Экспортировано " + noteCount(all.length) + ".");
    } catch (error) {
      announce(errorText(error), true);
    } finally {
      exportButton.disabled = false;
    }
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    if (changes[JOURNAL_SORT]) {
      order.value = changes[JOURNAL_SORT].newValue === "oldest" ? "oldest" : "newest";
      render();
    }
    if (changes[NOTE_REVISION] || changes[ANCHOR_REVISION]) refresh();
  });
  window.addEventListener("focus", refresh);
  document.addEventListener("visibilitychange", () => { if (!document.hidden) refresh(); });
  void chrome.storage.local.get(JOURNAL_SORT).then((values) => {
    if (!sortTouched && values[JOURNAL_SORT] === "oldest") {
      order.value = "oldest";
      render();
    }
  }).catch((error) => announce(errorText(error), true));
  return refresh;
}
