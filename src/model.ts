export const FORMAT_VERSION = 2;
export const MAX_BODY = 30_000;
export const MAX_QUOTE = 30_000;
export const MAX_BACKUP_BYTES = 64 * 1024 * 1024;
export const CONTEXT_LENGTH = 72;
export const MAX_THUMBNAIL_SIDE = 160;
export const MAX_THUMBNAIL_BYTES = 16 * 1024;
export const THUMBNAIL_PREFIX = "data:image/webp;base64,";

export type Resolution = "found" | "missing";

export interface Anchor {
  exact: string;
  text: string;
  prefix: string;
  suffix: string;
  start: number;
  occurrences: number;
}

export interface ImageLocator {
  source: string;
  fallbackSource?: string;
  alt: string;
  caption: string;
  elementId: string;
  occurrence: number;
  occurrences: number;
}

export interface ImageAttachment extends ImageLocator {
  thumbnail?: string;
}

export interface NoteDraft {
  id: string;
  pageUrl: string;
  pageTitle: string;
  body: string;
  anchor?: Anchor;
  image?: ImageAttachment;
}

export interface Note extends NoteDraft {
  createdAt: number;
  updatedAt: number;
  resolution?: Resolution;
}

export interface ImportResult {
  added: number;
  skipped: number;
}

export interface Backup {
  format: "polya-fields";
  version: typeof FORMAT_VERSION;
  exportedAt: string;
  notes: Note[];
}

export function pageKey(input: string): string | null {
  try {
    const url = new URL(input);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) return null;
    if (/^#(?:\/|!)/.test(url.hash)) {
      url.hash = url.hash.split(":~:", 1)[0];
    } else {
      url.hash = "";
    }
    return url.href;
  } catch {
    return null;
  }
}

export function domain(url: string): string {
  return new URL(url).host;
}

export function newId(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Ожидалась запись.");
  return value as Record<string, unknown>;
}

function string(value: unknown, max: number, allowEmpty = false): string {
  if (typeof value !== "string" || value.length > max || (!allowEmpty && !value.trim())) {
    throw new Error("Текст отсутствует или превышает допустимую длину.");
  }
  return value;
}

function integer(value: unknown, min: number, max = Number.MAX_SAFE_INTEGER): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error("Число выходит за допустимые пределы.");
  }
  return value;
}

export function noteId(value: unknown): string {
  if (typeof value !== "string" || !/^[\w-]{16,128}$/.test(value)) throw new Error("Неверный ID заметки.");
  return value;
}

export function bodyText(value: unknown): string {
  return string(value, MAX_BODY).trim();
}

export function noteTimestamp(value: unknown): number {
  return integer(value, 0, 8_640_000_000_000_000);
}

function parseAnchor(value: unknown): Anchor {
  const raw = object(value);
  return {
    exact: string(raw.exact, MAX_QUOTE),
    text: string(raw.text, MAX_QUOTE),
    prefix: string(raw.prefix, CONTEXT_LENGTH, true),
    suffix: string(raw.suffix, CONTEXT_LENGTH, true),
    start: integer(raw.start, 0),
    occurrences: integer(raw.occurrences, 1),
  };
}

export function imageSource(value: string): string | undefined {
  if (/^data:image\//i.test(value)) {
    // A data URL contains the full image. Keep a short identifier instead of the bytes.
    let hash = 2166136261;
    const step = Math.max(1, Math.floor(value.length / 256));
    for (let i = 0; i < value.length; i += step) hash = Math.imul(hash ^ value.charCodeAt(i), 16777619);
    return "inline:" + value.length + "-" + (hash >>> 0).toString(16);
  }
  if (value.length > 65_536) return undefined;
  try {
    const url = new URL(value);
    if (["http:", "https:", "blob:"].includes(url.protocol) && !url.username && !url.password) return url.href;
  } catch { /* An invalid or unsupported image URL is not useful for reattachment. */ }
  return undefined;
}

function storedImageSource(value: unknown): string {
  const source = string(value, 65_536);
  if (/^inline:\d+-[0-9a-f]{1,8}$/.test(source)) return source;
  if (/^(https?:|blob:)/i.test(source)) {
    const url = imageSource(source);
    if (url) return url;
  }
  throw new Error("Неверный адрес изображения.");
}

function thumbnailSize(value: string): [number, number] | undefined {
  if (!value.startsWith(THUMBNAIL_PREFIX)) return undefined;
  const encoded = value.slice(THUMBNAIL_PREFIX.length);
  if (encoded.length > 4 * Math.ceil(MAX_THUMBNAIL_BYTES / 3) || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) return undefined;
  const bytes = atob(encoded);
  if (bytes.length < 25 || bytes.length > MAX_THUMBNAIL_BYTES || bytes.slice(0, 4) !== "RIFF" || bytes.slice(8, 12) !== "WEBP") {
    return undefined;
  }
  const byte = (i: number) => bytes.charCodeAt(i);
  const chunk = bytes.slice(12, 16);
  if (chunk === "VP8 " && bytes.length >= 30 && bytes.slice(23, 26) === "\x9d\x01\x2a") {
    return [(byte(26) | byte(27) << 8) & 0x3fff, (byte(28) | byte(29) << 8) & 0x3fff];
  }
  if (chunk === "VP8L" && byte(20) === 0x2f) {
    return [1 + (byte(21) | (byte(22) & 63) << 8), 1 + (byte(22) >> 6 | byte(23) << 2 | (byte(24) & 15) << 10)];
  }
  if (chunk === "VP8X" && bytes.length >= 30) {
    return [1 + (byte(24) | byte(25) << 8 | byte(26) << 16), 1 + (byte(27) | byte(28) << 8 | byte(29) << 16)];
  }
  return undefined;
}

export function isThumbnail(value: string): boolean {
  try {
    return thumbnailSize(value)?.every((size) => size > 0 && size <= MAX_THUMBNAIL_SIDE) ?? false;
  } catch {
    return false;
  }
}

function parseImage(value: unknown): ImageAttachment {
  const raw = object(value);
  const occurrences = integer(raw.occurrences, 1);
  const thumbnail = raw.thumbnail;
  if (thumbnail !== undefined && (typeof thumbnail !== "string" || !isThumbnail(thumbnail))) {
    throw new Error("Неверная или слишком большая миниатюра изображения.");
  }
  return {
    source: storedImageSource(raw.source),
    ...(raw.fallbackSource === undefined ? {} : { fallbackSource: storedImageSource(raw.fallbackSource) }),
    alt: string(raw.alt, 256, true),
    caption: string(raw.caption, 256, true),
    elementId: string(raw.elementId, 256, true),
    occurrence: integer(raw.occurrence, 0, occurrences - 1),
    occurrences,
    ...(thumbnail === undefined ? {} : { thumbnail }),
  };
}

export function parseDraft(value: unknown): NoteDraft {
  const raw = object(value);
  const pageUrl = pageKey(string(raw.pageUrl, 65_536));
  if (!pageUrl) throw new Error("Поддерживаются ссылки HTTP и HTTPS.");
  if (raw.image !== undefined && raw.anchor !== undefined) throw new Error("Заметка должна иметь одну привязку.");
  return {
    id: noteId(raw.id),
    pageUrl,
    pageTitle: string(raw.pageTitle, 4_096, true).trim() || domain(pageUrl),
    body: bodyText(raw.body),
    ...(raw.anchor === undefined ? {} : { anchor: parseAnchor(raw.anchor) }),
    ...(raw.image === undefined ? {} : { image: parseImage(raw.image) }),
  };
}

export function parseBackup(value: unknown): Note[] {
  const data = object(value);
  if (data.format !== "polya-fields" || (data.version !== 1 && data.version !== FORMAT_VERSION) || !Array.isArray(data.notes)) {
    throw new Error("Формат резервной копии не поддерживается.");
  }
  return data.notes.map((value, index) => {
    try {
      const raw = object(value);
      const createdAt = noteTimestamp(raw.createdAt);
      const updatedAt = noteTimestamp(raw.updatedAt);
      if (updatedAt < createdAt) throw new Error("Дата изменения предшествует созданию.");
      return { ...parseDraft(raw), createdAt, updatedAt };
    } catch (error) {
      throw new Error("Запись №" + (index + 1) + ". " + errorText(error));
    }
  });
}

export function makeBackup(notes: Note[]): Backup {
  return {
    format: "polya-fields",
    version: FORMAT_VERSION,
    exportedAt: new Date().toISOString(),
    notes: notes.map(({ resolution: _resolution, ...note }) => note),
  };
}

export function fingerprint(note: NoteDraft): string {
  if (note.image) {
    const image = note.image;
    return JSON.stringify([note.pageUrl, note.body, "image", image.source, image.elementId || image.occurrence]);
  }
  const anchor = note.anchor;
  return JSON.stringify([note.pageUrl, note.body, anchor && [
    anchor.exact, anchor.text, anchor.prefix, anchor.suffix, anchor.start,
  ]]);
}

export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : "Возникла непредвиденная ошибка.";
}
