import { ContextEditor } from "./editor";
import { isThumbnail, MAX_QUOTE, newId, pageKey, type Anchor, type ImageAttachment, type Note, type Resolution } from "./model";
import { findPageImage, imageLocator, imageSources, imageThumbnail, pageImages, visibleImageCrop } from "./page-images";
import { ask, NOTE_REVISION, type PageRequest, type PageSnapshot, type ResolutionEntry } from "./protocol";
import { TextIndex } from "./text-index";

const NOTES = "polya-fields-notes";
const CURRENT = "polya-fields-current";
const PREVIEW = "polya-fields-preview";
const IMAGE_ATTRIBUTES = ["src", "srcset", "sizes", "alt", "id", "media"];
const registry = CSS.highlights;

let route: string | null = null;
let observedHref: string | undefined;
let title = document.title;
let requestNumber = 0;
let ready = false;
let notes: Note[] = [];
let hasAnchors = false;
let hasImages = false;
let index: TextIndex | undefined;
let images: ReturnType<typeof pageImages> | undefined;
let indexRevision = 0;
let renderedRevision = -1;
let body = document.body;
let timer: number | undefined;
let flashTimer: number | undefined;
let ranges = new Map<string, Range>();
let renderedAnchors = new Map<string, Anchor>();
let imageElements = new Map<string, HTMLImageElement>();
let resolutions: Record<string, Resolution> = {};
const pendingResolutions = new Map<string, ResolutionEntry>();
const draftIds = new WeakMap<Anchor | ImageAttachment, string>();
let contextImage: { element: WeakRef<HTMLImageElement>; time: number } | undefined;
let preparedImage: { token: string; image: ImageAttachment; url: string; element?: WeakRef<HTMLImageElement> } | undefined;
let preparedTimer: number | undefined;
let pendingImageJump: string | undefined;
let imageJumpTimer: number | undefined;

function textIndex(): TextIndex | undefined {
  if (document.body) index ??= new TextIndex(document.body);
  return index;
}

function announce(): void {
  void ask({ type: "pageChanged" }).catch(() => undefined);
}

const editor = new ContextEditor({
  capture(range, exact) {
    if (!route || exact.length > MAX_QUOTE) return null;
    const anchor = textIndex()?.capture(range, exact) ?? null;
    return anchor && anchor.text.length <= MAX_QUOTE ? anchor : null;
  },
  preview(range) {
    if (range) registry?.set(PREVIEW, new Highlight(range));
    else registry?.delete(PREVIEW);
  },
  async save(target, body) {
    const url = pageKey(location.href);
    if (!route || url !== route) throw new Error("Страница изменилась. Выделите цитату заново.");
    const attachment = target.anchor ?? target.image;
    const id = draftIds.get(attachment) ?? newId();
    draftIds.set(attachment, id);
    await ask({ type: "create", draft: { id, pageUrl: url, pageTitle: document.title.slice(0, 4096), body, ...target } });
    await loadNotes();
  },
});

window.addEventListener("contextmenu", (event) => {
  if (!event.isTrusted) return;
  const element = event.composedPath().find((item) => item instanceof HTMLImageElement);
  contextImage = element ? { element: new WeakRef(element), time: Date.now() } : undefined;
}, { capture: true, passive: true });

function clearImagePreparation(): void {
  preparedImage = undefined;
  window.clearTimeout(preparedTimer);
}

function prepareImage(url: string, source: string) {
  if (!route || route !== url) return undefined;
  clearImagePreparation();
  const candidates = pageImages();
  const recent = contextImage;
  const clicked = recent?.element.deref();
  contextImage = undefined;
  let element: HTMLImageElement | undefined;
  if (recent && clicked?.isConnected && Date.now() - recent.time < 120_000 && imageSources(clicked).includes(source)) {
    element = clicked;
  } else {
    const matches = candidates.filter((item) => item.source === source || item.fallbackSource === source);
    if (matches.length === 1) element = matches[0].element;
    else if (matches.length > 1) return undefined;
  }
  const image = imageLocator(source, element, candidates);
  const thumbnail = element && imageThumbnail(element);
  const token = newId();
  preparedImage = { token, image: { ...image, thumbnail }, url, element: element && new WeakRef(element) };
  preparedTimer = window.setTimeout(clearImagePreparation, 30_000);
  const crop = element && !thumbnail ? visibleImageCrop(element) : undefined;
  return { token, crop };
}

function imagePreparation(token: string) {
  const prepared = preparedImage;
  return prepared?.token === token && prepared.url === route ? prepared : undefined;
}

function clearImageJump(): void {
  pendingImageJump = undefined;
  window.clearTimeout(imageJumpTimer);
}

function jumpToImage(id: string): boolean {
  const image = imageElements.get(id);
  if (!image?.isConnected) return false;
  image.scrollIntoView({ block: "center", inline: "nearest", behavior: "instant" });
  editor.flashImage(image);
  return true;
}

function tryImageJump(): void {
  if (pendingImageJump && jumpToImage(pendingImageJump)) clearImageJump();
}

async function reportResolutions(url: string, entries: ResolutionEntry[]): Promise<void> {
  for (const entry of entries) pendingResolutions.set(entry.id, entry);
  try {
    await ask({ type: "resolutions", url, entries });
    const saved = new Map(entries.map((entry) => [entry.id, entry]));
    for (const note of notes) {
      const entry = saved.get(note.id);
      if (entry && pendingResolutions.get(note.id) === entry) note.resolution = entry.state;
    }
  } catch {
    // The next check can retry if the worker or page changed mid-request.
  } finally {
    for (const entry of entries) {
      if (pendingResolutions.get(entry.id) === entry) pendingResolutions.delete(entry.id);
    }
  }
}

function sameAnchor(previous: Anchor | undefined, anchor: Anchor): boolean {
  return previous?.text === anchor.text && previous.prefix === anchor.prefix && previous.suffix === anchor.suffix &&
    previous.start === anchor.start && previous.occurrences === anchor.occurrences;
}

function render(): void {
  if (timer !== undefined) window.clearTimeout(timer);
  timer = undefined;
  const nextRanges = new Map<string, Range>();
  const nextAnchors = new Map<string, Anchor>();
  const nextImages = new Map<string, HTMLImageElement>();
  const nextStates: Record<string, Resolution> = {};
  const updates: ResolutionEntry[] = [];
  const resolved = hasAnchors ? textIndex() : undefined;
  const candidates = hasImages ? images ??= pageImages() : undefined;
  const sameIndex = resolved !== undefined && renderedRevision === indexRevision;
  let rangesChanged = false;

  for (const note of notes) {
    const { id, anchor, image } = note;
    let state: Resolution = "missing";
    if (image && candidates) {
      const element = findPageImage(image, candidates);
      if (element) {
        nextImages.set(id, element);
        state = "found";
      }
    } else if (anchor) {
      const previousRange = ranges.get(id);
      const range = sameIndex && sameAnchor(renderedAnchors.get(id), anchor)
        ? previousRange : resolved?.restore(anchor) ?? undefined;
      nextAnchors.set(id, anchor);
      if (range) {
        nextRanges.set(id, range);
        state = "found";
      }
      if (range !== previousRange) rangesChanged = true;
    } else continue;
    nextStates[id] = state;
    const previous = pendingResolutions.get(id)?.state ?? note.resolution;
    if (previous !== state) updates.push({ id, state });
  }

  const registeredCount = registry?.get(NOTES)?.size ?? 0;
  if (registry && (rangesChanged || nextRanges.size !== ranges.size || nextRanges.size !== registeredCount)) {
    if (nextRanges.size) {
      const highlight = new Highlight();
      for (const range of nextRanges.values()) highlight.add(range);
      registry.set(NOTES, highlight);
    } else {
      registry.delete(NOTES);
    }
  }
  ranges = nextRanges;
  imageElements = nextImages;
  renderedAnchors = nextAnchors;
  renderedRevision = resolved ? indexRevision : -1;
  const changed = Object.keys(resolutions).length !== Object.keys(nextStates).length ||
    Object.entries(nextStates).some(([id, state]) => resolutions[id] !== state);
  resolutions = nextStates;
  if (changed) announce();
  tryImageJump();

  const url = route;
  if (url && (resolved || candidates) && updates.length) void reportResolutions(url, updates);
}

function scheduleRender(resetText = true): void {
  if (resetText) {
    index = undefined;
    indexRevision++;
  }
  images = undefined;
  if (ready && (hasAnchors || hasImages) && timer === undefined) {
    timer = window.setTimeout(render, 180);
  }
}

async function loadNotes(): Promise<void> {
  const url = route;
  if (!url) return;
  const request = ++requestNumber;
  try {
    const result = await ask({ type: "page", url });
    if (request !== requestNumber || url !== pageKey(location.href)) return;
    notes = result;
    const hadAnchors = hasAnchors;
    hasAnchors = notes.some((note) => note.anchor);
    if (hadAnchors && !hasAnchors) index = undefined;
    hasImages = notes.some((note) => note.image);
    if (!hasImages) images = undefined;
    if (pendingResolutions.size) {
      const ids = new Set(notes.map((note) => note.id));
      for (const id of pendingResolutions.keys()) {
        if (!ids.has(id)) pendingResolutions.delete(id);
      }
    }
    const firstLoad = !ready;
    ready = true;
    render();
    if (firstLoad) {
      announce();
      if (hasImages) {
        void ask({ type: "takeImageJump", url }).then((id) => {
          if (!id || route !== url) return;
          pendingImageJump = id;
          imageJumpTimer = window.setTimeout(clearImageJump, 12_000);
          tryImageJump();
        }).catch(() => undefined);
      }
    }
  } catch {
    // A navigation or worker restart can interrupt the request. Focus retries it.
  }
}

function syncRoute(): void {
  const href = location.href;
  const currentTitle = document.title;
  if (href === observedHref && currentTitle === title) return;
  const next = href === observedHref ? route : pageKey(href);
  const titleChanged = title !== currentTitle;
  observedHref = href;
  title = currentTitle;
  if (next === route) {
    if (titleChanged && route) announce();
    return;
  }
  route = next;
  requestNumber++;
  ready = false;
  notes = [];
  hasAnchors = false;
  hasImages = false;
  ranges.clear();
  imageElements.clear();
  renderedAnchors.clear();
  renderedRevision = -1;
  resolutions = {};
  pendingResolutions.clear();
  if (timer !== undefined) window.clearTimeout(timer);
  timer = undefined;
  registry?.delete(NOTES);
  registry?.delete(CURRENT);
  index = undefined;
  images = undefined;
  contextImage = undefined;
  clearImagePreparation();
  clearImageJump();
  editor.reset();
  announce();
  void loadNotes();
}

function jump(id: string): boolean {
  if (timer !== undefined) render();
  if (jumpToImage(id)) return true;
  const range = ranges.get(id);
  if (!range?.startContainer.isConnected || !range.getClientRects().length) return false;
  for (let element = range.startContainer.parentElement; element && element !== document.body; element = element.parentElement) {
    if (element.scrollHeight <= element.clientHeight && element.scrollWidth <= element.clientWidth) continue;
    const style = getComputedStyle(element);
    if (!/(auto|scroll)/.test(style.overflowX + " " + style.overflowY)) continue;
    const quote = range.getBoundingClientRect();
    const target = element.getBoundingClientRect();
    element.scrollBy({
      top: quote.top - target.top - Math.max(0, (target.height - quote.height) / 2),
      left: quote.left < target.left || quote.right > target.right ? quote.left - target.left - 12 : 0,
      behavior: "instant",
    });
  }
  const rect = range.getBoundingClientRect();
  window.scrollBy({
    top: rect.top - Math.max(16, (window.innerHeight - rect.height) / 3),
    left: rect.left < 0 || rect.right > innerWidth ? rect.left - 16 : 0,
    behavior: "instant",
  });

  if (registry) {
    const current = new Highlight(range);
    current.priority = 2;
    registry.set(CURRENT, current);
    window.clearTimeout(flashTimer);
    flashTimer = window.setTimeout(() => registry.delete(CURRENT), 2300);
  }
  return true;
}

function start(): void {
  body = document.body;

  chrome.runtime.onMessage.addListener((request: PageRequest, sender, respond) => {
    if (sender.id !== chrome.runtime.id || sender.tab || !request) return;
    syncRoute();
    if (request.type === "refresh") void loadNotes();
    if (request.type === "snapshot") {
      const snapshot: PageSnapshot = { url: route, title, ready, resolutions };
      respond({ ok: true, value: snapshot });
    }
    if (request.type === "jump") {
      respond({ ok: true, value: request.url === route && jump(request.id) });
    }
    if (request.type === "prepareImage") {
      respond({ ok: true, value: prepareImage(request.url, request.source) });
    }
    if (request.type === "verifyImageCrop") {
      const element = imagePreparation(request.token)?.element?.deref();
      respond({ ok: true, value: element && visibleImageCrop(element) });
    }
    if (request.type === "showImageEditor") {
      const prepared = imagePreparation(request.token);
      if (!prepared) { respond({ ok: true, value: false }); return; }
      clearImagePreparation();
      const thumbnail = prepared.image.thumbnail ?? (request.thumbnail && isThumbnail(request.thumbnail) ? request.thumbnail : undefined);
      respond({ ok: true, value: editor.openImage({ ...prepared.image, thumbnail }, prepared.element?.deref()) });
    }
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes[NOTE_REVISION]) void loadNotes();
  });

  new MutationObserver((mutations) => {
    const resetBody = body !== document.body;
    const affectsText = (index || hasAnchors) && mutations.some((mutation) =>
      body?.contains(mutation.target) && !IMAGE_ATTRIBUTES.includes(mutation.attributeName ?? ""));
    if (resetBody || affectsText || (hasImages && mutations.some((mutation) => body?.contains(mutation.target)))) {
      body = document.body;
      scheduleRender(resetBody || !!affectsText);
    }
    syncRoute();
  }).observe(document.documentElement, {
    childList: true,
    subtree: true,
    characterData: true,
    attributes: true,
    attributeFilter: ["class", "style", "hidden", "open", "inert", "contenteditable", ...IMAGE_ATTRIBUTES],
  });
  for (const type of ["load", "error"]) document.addEventListener(type, (event) => {
    if (hasImages && event.target instanceof HTMLImageElement) scheduleRender(false);
  }, true);

  const navigation = (window as Window & { navigation?: EventTarget }).navigation;
  navigation?.addEventListener("currententrychange", syncRoute);
  window.addEventListener("popstate", syncRoute);
  window.addEventListener("hashchange", syncRoute);
  window.addEventListener("pageshow", () => { syncRoute(); scheduleRender(); void loadNotes(); });
  window.addEventListener("focus", () => { syncRoute(); void loadNotes(); });
  window.addEventListener("resize", () => scheduleRender(), { passive: true });
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) { syncRoute(); void loadNotes(); }
  });
  window.setInterval(() => {
    if (!document.hidden && location.href !== observedHref) syncRoute();
  }, 900);

  syncRoute();
}

// Install the editor's capture listeners before page scripts register theirs.
// Page tracking needs the document body, so start it once the DOM is available.
if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start, { once: true });
else start();
