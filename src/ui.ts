import { imagePreview } from "./image-preview";
import { errorText, MAX_BODY, type ImageAttachment, type Note } from "./model";
import { ask } from "./protocol";

export function get<T extends HTMLElement>(name: string): T {
  const node = document.getElementById(name);
  if (!node) throw new Error("Не найден элемент " + name);
  return node as T;
}

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K, className = "", value = "",
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = className;
  node.textContent = value;
  return node;
}

export function button(text: string, className = "text-button"): HTMLButtonElement {
  const node = el("button", className, text);
  node.type = "button";
  return node;
}

export function quote(text: string): HTMLQuoteElement {
  const node = el("blockquote", "quote", text);
  node.tabIndex = 0;
  return node;
}

export function status(node: HTMLElement, text: string, error = false): void {
  node.classList.toggle("is-error", error);
  node.textContent = text;
}

const plural = new Intl.PluralRules("ru");
const date = new Intl.DateTimeFormat("ru", { day: "numeric", month: "short", year: "numeric" });

export function countLabel(count: number, one: string, few: string, many: string): string {
  const form = plural.select(count);
  return count + " " + (form === "one" ? one : form === "few" ? few : many);
}

interface NoteActions {
  edit(note: Note): void;
  remove(note: Note): void;
  jump?(note: Note): void;
}

export function noteRow(
  note: Note,
  actions: NoteActions,
  state = "",
  canJump = false,
): HTMLElement {
  const row = el("article", "note");
  row.dataset.note = note.id;
  if (note.anchor) row.append(quote(note.anchor.exact));
  const body = el("p", "note-body", note.body);
  if (note.image) {
    const content = el("div", "image-note-content");
    const text = el("div");
    text.append(body);
    if (state) text.append(el("p", "anchor-status", state));
    content.append(imagePreview(note.image), text);
    row.append(content);
  } else {
    if (state) row.append(el("p", "anchor-status", state));
    row.append(body);
  }

  const footer = el("footer", "note-footer");
  const when = el("time", "note-date", date.format(note.updatedAt));
  when.dateTime = new Date(note.updatedAt).toISOString();
  when.title = "Последнее изменение";
  const controls = el("div", "note-actions");
  const addAction = (label: string, key: string, run: (note: Note) => void, style?: string) => {
    const control = button(label, style);
    control.dataset.focusKey = note.id + "-" + key;
    control.addEventListener("click", () => run(note));
    controls.append(control);
  };
  if (actions.jump && canJump) addAction(note.image ? "К изображению" : "К цитате", "jump", actions.jump);
  addAction("Изменить", "edit", actions.edit);
  addAction("Удалить", "delete", actions.remove, "text-button danger-text");
  footer.append(when, controls);
  row.append(footer);
  return row;
}

export function keepFocus(node: HTMLElement, render: () => void, fallback?: HTMLElement): void {
  const active = document.activeElement;
  const key = active instanceof HTMLElement ? active.dataset.focusKey : undefined;
  render();
  if (active instanceof HTMLElement && key && !active.isConnected) {
    const current = node.querySelector<HTMLElement>('[data-focus-key="' + CSS.escape(key) + '"]');
    (current ?? fallback)?.focus({ preventScroll: true });
  }
}

interface DialogOptions {
  title: string;
  action: string;
  description?: string;
  excerpt?: string;
  image?: ImageAttachment;
  value?: string;
  danger?: boolean;
  run(body: string): Promise<void>;
}

export class NoteDialog {
  private readonly dialog = el("dialog", "dialog");
  private readonly form = el("form", "dialog-form");
  private readonly title = el("h2", "dialog-title");
  private readonly description = el("p", "dialog-description");
  private readonly excerpt = quote("");
  private readonly image = el("div", "dialog-image");
  private readonly label = el("label", "field-label", "Комментарий");
  private readonly input = el("textarea", "field");
  private readonly error = el("p", "dialog-error");
  private readonly cancel = button("Отмена");
  private readonly submit = button("Сохранить", "button primary");
  private job?: DialogOptions;
  private busy = false;

  constructor() {
    this.title.id = "dialog-title";
    this.dialog.setAttribute("aria-labelledby", this.title.id);
    this.description.id = "dialog-description";
    this.error.setAttribute("role", "alert");
    this.label.htmlFor = "dialog-body";
    this.input.id = this.label.htmlFor;
    this.input.rows = 5;
    this.input.maxLength = MAX_BODY;
    this.input.placeholder = "Что вы хотите запомнить?";
    this.submit.type = "submit";

    const actions = el("div", "dialog-actions");
    actions.append(this.cancel, this.submit);
    this.form.append(this.title, this.description, this.excerpt, this.image, this.label, this.input, this.error, actions);
    this.dialog.append(this.form);
    document.body.append(this.dialog);

    this.cancel.addEventListener("click", () => this.dialog.close());
    this.dialog.addEventListener("cancel", (event) => { if (this.busy) event.preventDefault(); });
    this.dialog.addEventListener("close", () => { if (!this.dialog.open) this.image.replaceChildren(); });
    this.form.addEventListener("submit", (event) => {
      event.preventDefault();
      void this.save();
    });
    this.form.addEventListener("keydown", (event) => {
      if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
        event.preventDefault();
        this.form.requestSubmit();
      }
    });
  }

  open(options: DialogOptions): void {
    if (this.dialog.open) return;
    this.job = options;
    this.title.textContent = options.title;
    this.description.textContent = options.description ?? "";
    this.description.hidden = !options.description;
    if (options.description) this.dialog.setAttribute("aria-describedby", this.description.id);
    else this.dialog.removeAttribute("aria-describedby");
    this.excerpt.hidden = !options.excerpt;
    this.excerpt.textContent = options.excerpt ?? "";
    this.image.hidden = !options.image;
    if (options.image) this.image.replaceChildren(imagePreview(options.image));
    this.label.hidden = this.input.hidden = !!options.danger;
    this.input.required = !options.danger;
    this.input.value = options.value ?? "";
    this.error.hidden = true;
    this.submit.textContent = options.action;
    this.submit.classList.toggle("danger", !!options.danger);
    this.dialog.showModal();
    (options.danger ? this.cancel : this.input).focus();
  }

  private async save(): Promise<void> {
    if (!this.job || this.busy) return;
    const body = this.input.value.trim();
    if (!this.job.danger && !body) {
      this.error.textContent = "Напишите комментарий.";
      this.error.hidden = false;
      this.input.focus();
      return;
    }
    this.busy = true;
    this.cancel.disabled = this.submit.disabled = this.input.readOnly = true;
    this.error.hidden = true;
    try {
      await this.job.run(body);
      this.dialog.close();
    } catch (error) {
      this.error.textContent = errorText(error);
      this.error.hidden = false;
      if (!this.input.hidden) this.input.focus();
    } finally {
      this.busy = false;
      this.cancel.disabled = this.submit.disabled = this.input.readOnly = false;
    }
  }
}

export function noteActions(
  dialog: NoteDialog, refresh: () => void, announce: (text: string) => void,
): NoteActions {
  return {
    edit(note) {
      dialog.open({
        title: "Редактирование",
        action: "Сохранить",
        excerpt: note.anchor?.exact,
        image: note.image,
        value: note.body,
        async run(body) {
          await ask({ type: "edit", id: note.id, body, expected: note.updatedAt });
          announce("Изменения сохранены.");
          refresh();
        },
      });
    },
    remove(note) {
      dialog.open({
        title: "Удалить заметку?",
        description: "Заметка будет удалена из журнала и со страницы.",
        action: "Удалить",
        danger: true,
        async run() {
          await ask({ type: "delete", id: note.id, expected: note.updatedAt });
          announce("Заметка удалена.");
          refresh();
        },
      });
    },
  };
}
