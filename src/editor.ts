import css from "../static/editor.css";
import imageCss from "../static/image.css";
import theme from "../static/theme.css";
import { imagePreview } from "./image-preview";
import { errorText, MAX_BODY, type Anchor, type ImageAttachment } from "./model";

interface SelectionDraft {
  range: Range;
  anchor: Anchor;
}

export type EditorTarget = { anchor: Anchor; image?: never } | { image: ImageAttachment; anchor?: never };

interface EditorDraft {
  target: EditorTarget;
  range?: Range;
  imageElement?: WeakRef<HTMLImageElement>;
}

interface EditorOptions {
  save(target: EditorTarget, body: string): Promise<void>;
  capture(range: Range, exact: string): Anchor | null;
  preview(range: Range | null): void;
}

const EDITING_EVENTS = [
  "focus", "focusin", "keydown", "keypress", "keyup", "beforeinput", "input",
  "compositionstart", "compositionupdate", "compositionend",
];

function element<K extends keyof HTMLElementTagNameMap>(
  tag: K, className = "", text = "",
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = className;
  node.textContent = text;
  return node;
}

function viewport() {
  const visual = window.visualViewport;
  return {
    x: visual?.offsetLeft ?? 0,
    y: visual?.offsetTop ?? 0,
    width: visual?.width ?? window.innerWidth,
    height: visual?.height ?? window.innerHeight,
  };
}

function selectionRect(range: Range, visibleOnly: boolean): DOMRect | undefined {
  const { x, y, width, height } = viewport();
  const rectangles = Array.from(range.getClientRects()).filter((rect) => rect.width && rect.height);
  return rectangles.findLast((rect) =>
    rect.bottom > y && rect.top < y + height && rect.right > x && rect.left < x + width,
  ) ?? (visibleOnly ? undefined : rectangles.at(-1));
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(value, max));
}

function place(node: HTMLElement, rectangle?: DOMRect): void {
  const { x, y, width, height } = viewport();
  const inset = 10;
  node.style.maxWidth = Math.max(0, width - 2 * inset) + "px";
  node.style.maxHeight = Math.max(0, height - 2 * inset) + "px";
  const { width: w, height: h } = node.getBoundingClientRect();
  const left = rectangle ? rectangle.left + Math.min(rectangle.width, w) / 2 - w / 2 : x + (width - w) / 2;
  const below = rectangle ? rectangle.bottom + 8 : y + (height - h) / 2;
  const top = rectangle && below + h > y + height - inset && rectangle.top - h - 8 >= y + inset
    ? rectangle.top - h - 8 : below;
  node.style.left = clamp(left, x + inset, x + width - w - inset) + "px";
  node.style.top = clamp(top, y + inset, y + height - h - inset) + "px";
}

export class ContextEditor {
  private readonly host = element("div");
  private readonly shadow = this.host.attachShadow({ mode: "closed" });
  private readonly chip = element("button", "chip", "+ Заметка");
  private readonly editor = element("form", "editor");
  private readonly quote = element("blockquote");
  private readonly image = element("div", "editor-image");
  private readonly imageFrame = element("div", "image-frame");
  private readonly textarea = element("textarea");
  private readonly error = element("p", "error");
  private readonly info = element("span", "sr-only");
  private selected?: SelectionDraft;
  private draft?: EditorDraft;
  private flashedImage?: HTMLImageElement;
  private imageFlashTimer?: number;
  private returnFocus?: HTMLElement;
  private timer?: number;
  private busy = false;
  private generation = 0;

  constructor(private readonly options: EditorOptions) {
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(theme + "\n" + css + "\n" + imageCss);
    this.shadow.adoptedStyleSheets = [sheet];
    this.host.lang = "ru";
    this.chip.type = "button";
    this.chip.hidden = true;
    this.chip.title = "Добавить заметку (Alt+Shift+M)";
    this.chip.setAttribute("aria-label", "Заметка к выделению");
    this.chip.addEventListener("pointerdown", (event) => event.preventDefault());
    this.chip.addEventListener("click", () => this.open());

    this.editor.hidden = true;
    this.editor.setAttribute("role", "dialog");
    this.editor.setAttribute("aria-labelledby", "polya-editor-title");
    const heading = element("h2", "", "Новая заметка");
    heading.id = "polya-editor-title";
    const close = element("button", "close", "×");
    close.type = "button";
    close.setAttribute("aria-label", "Закрыть редактор");
    close.addEventListener("click", () => this.close());
    const header = element("div", "header");
    header.append(heading, close);
    this.quote.tabIndex = 0;
    const label = element("label", "", "Комментарий");
    label.htmlFor = "polya-body";
    this.textarea.id = label.htmlFor;
    this.textarea.rows = 3;
    this.textarea.maxLength = MAX_BODY;
    this.textarea.required = true;
    this.textarea.placeholder = "Что вы хотите запомнить?";
    this.error.setAttribute("role", "alert");
    this.error.hidden = true;
    this.info.setAttribute("role", "status");

    const actions = element("div", "actions");
    const cancel = element("button", "", "Отмена");
    cancel.type = "button";
    cancel.addEventListener("click", () => this.close());
    const save = element("button", "save", "Сохранить");
    save.type = "submit";
    actions.append(cancel, save);
    this.imageFrame.hidden = true;
    this.editor.append(header, this.quote, this.image, label, this.textarea, this.error, actions);
    this.shadow.append(this.imageFrame, this.chip, this.editor, this.info);
    this.editor.addEventListener("submit", (event) => {
      event.preventDefault();
      void this.submit();
    });

    for (const type of ["click", "pointerdown", "pointerup", "change", "submit"]) {
      this.shadow.addEventListener(type, (event) => event.stopPropagation());
    }
    for (const type of EDITING_EVENTS) window.addEventListener(type, this.isolateEditorEvent, { capture: true });

    document.addEventListener("selectionchange", this.queueSelection);
    document.addEventListener("pointerup", this.queueSelection);
    document.addEventListener("keyup", this.queueSelection);
    document.addEventListener("keydown", (event) => {
      if (event.defaultPrevented || event.repeat || !event.altKey || !event.shiftKey ||
          event.metaKey || event.ctrlKey || event.code !== "KeyM" || this.draft) return;
      this.readSelection();
      if (this.selected) {
        event.preventDefault();
        this.open();
      }
    });
    document.addEventListener("scroll", this.reposition, { capture: true, passive: true });
    window.addEventListener("resize", this.reposition);
    window.visualViewport?.addEventListener("resize", this.reposition);
    window.visualViewport?.addEventListener("scroll", this.reposition);
  }

  private readonly isolateEditorEvent = (event: Event): void => {
    if (!this.draft || event.target !== this.host || !this.editor.contains(this.shadow.activeElement)) return;

    // A closed shadow retargets composed events to the host. An earlier page listener
    // could treat the host as a non-editable element and refocus its own composer.
    event.stopImmediatePropagation();
    if (!(event instanceof KeyboardEvent) || event.type !== "keydown" || event.isComposing) return;
    if (event.key === "Escape") {
      event.preventDefault();
      this.close();
    } else if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      this.editor.requestSubmit();
    }
  };

  private attach(): void {
    if (!this.host.isConnected) document.documentElement.append(this.host);
  }

  private readonly queueSelection = (): void => {
    if (this.draft) return;
    window.clearTimeout(this.timer);
    this.timer = window.setTimeout(() => this.readSelection(), 85);
  };

  private readSelection(): void {
    if (this.draft) return;
    const selection = window.getSelection();
    const exact = selection?.toString() ?? "";
    if (!selection?.rangeCount || selection.isCollapsed || !exact.trim()) {
      this.clearChip();
      return;
    }
    const range = selection.getRangeAt(0).cloneRange();
    if (!document.body?.contains(range.commonAncestorContainer) || !selectionRect(range, true)) {
      this.clearChip();
      return;
    }
    const anchor = this.options.capture(range, exact);
    if (!anchor) {
      this.clearChip();
      return;
    }
    this.attach();
    this.selected = { range, anchor };
    this.reposition();
  }

  private clearChip(): void {
    this.selected = undefined;
    this.chip.hidden = true;
  }

  private readonly reposition = (): void => {
    this.positionImageFrame();
    if (this.draft) {
      const { range, imageElement } = this.draft;
      const image = imageElement?.deref();
      place(this.editor, range ? selectionRect(range, false) : image?.isConnected ? image.getBoundingClientRect() : undefined);
    } else if (this.selected) {
      const rectangle = selectionRect(this.selected.range, true);
      this.chip.hidden = !rectangle;
      if (rectangle) place(this.chip, rectangle);
    }
  };

  private open(): void {
    if (!this.selected) return;
    this.show({ target: { anchor: this.selected.anchor }, range: this.selected.range });
  }

  openImage(image: ImageAttachment, imageElement?: HTMLImageElement): boolean {
    if (this.draft) return false;
    this.attach();
    this.show({ target: { image }, imageElement: imageElement && new WeakRef(imageElement) });
    return true;
  }

  private show(draft: EditorDraft): void {
    this.draft = draft;
    this.returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
    this.clearChip();
    this.quote.hidden = !draft.target.anchor;
    this.quote.textContent = draft.target.anchor?.exact ?? "";
    this.image.hidden = !draft.target.image;
    if (draft.target.image) this.image.replaceChildren(imagePreview(draft.target.image, true));
    this.textarea.value = "";
    this.error.hidden = true;
    this.editor.hidden = false;
    this.options.preview(draft.range ?? null);
    window.getSelection()?.removeAllRanges();
    this.reposition();
    this.textarea.focus({ preventScroll: true });
  }

  flashImage(image: HTMLImageElement): void {
    this.attach();
    this.flashedImage = image;
    this.positionImageFrame();
    this.info.textContent = "Изображение найдено.";
    window.clearTimeout(this.imageFlashTimer);
    this.imageFlashTimer = window.setTimeout(() => this.clearImageFrame(), 2300);
  }

  private positionImageFrame(): void {
    if (!this.flashedImage?.isConnected) {
      this.imageFrame.hidden = true;
      return;
    }
    const { left, top, width, height } = this.flashedImage.getBoundingClientRect();
    this.imageFrame.hidden = !width || !height;
    Object.assign(this.imageFrame.style, { left: left + "px", top: top + "px", width: width + "px", height: height + "px" });
  }

  private clearImageFrame(): void {
    this.flashedImage = undefined;
    this.imageFrame.hidden = true;
    window.clearTimeout(this.imageFlashTimer);
  }

  private close(saved = false): void {
    if (this.busy) return;
    this.draft = undefined;
    this.editor.hidden = true;
    this.image.replaceChildren();
    this.options.preview(null);
    this.returnFocus?.focus({ preventScroll: true });
    this.returnFocus = undefined;
    this.info.textContent = saved ? "Заметка сохранена." : "";
  }

  reset(): void {
    this.generation++;
    this.setBusy(false);
    this.clearChip();
    this.clearImageFrame();
    if (this.draft) this.close();
  }

  private setBusy(busy: boolean): void {
    this.busy = busy;
    this.textarea.readOnly = busy;
    for (const button of this.editor.querySelectorAll("button")) button.disabled = busy;
  }

  private async submit(): Promise<void> {
    if (this.busy || !this.draft) return;
    const body = this.textarea.value.trim();
    if (!body) {
      this.error.textContent = "Напишите комментарий.";
      this.error.hidden = false;
      this.textarea.focus();
      return;
    }

    const generation = this.generation;
    this.setBusy(true);
    this.error.hidden = true;
    try {
      await this.options.save(this.draft.target, body);
      if (generation === this.generation) {
        this.setBusy(false);
        this.close(true);
      }
    } catch (error) {
      if (generation === this.generation) {
        this.error.textContent = errorText(error);
        this.error.hidden = false;
        this.reposition();
      }
    } finally {
      if (generation === this.generation) this.setBusy(false);
    }
  }
}
