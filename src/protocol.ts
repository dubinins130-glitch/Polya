import type { ImportResult, Note, NoteDraft, Resolution } from "./model";

export const NOTE_REVISION = "noteRevision";
export const ANCHOR_REVISION = "anchorRevision";
export const JOURNAL_SORT = "journalSort";

export interface PageSnapshot {
  url: string | null;
  title: string;
  ready: boolean;
  resolutions: Record<string, Resolution>;
}

export interface ResolutionEntry {
  id: string;
  state: Resolution;
}

export interface ImageCrop {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface PreparedImage {
  token: string;
  crop?: ImageCrop;
}

export type Request =
  | { type: "all" }
  | { type: "page"; url: string }
  | { type: "create"; draft: NoteDraft }
  | { type: "edit"; id: string; body: string; expected: number }
  | { type: "delete"; id: string; expected: number }
  | { type: "openImage"; id: string }
  | { type: "takeImageJump"; url: string }
  | { type: "import"; backup: unknown }
  | { type: "resolutions"; url: string; entries: ResolutionEntry[] }
  | { type: "pageChanged" };

export type PageRequest =
  | { type: "snapshot" }
  | { type: "jump"; id: string; url: string }
  | { type: "refresh" }
  | { type: "prepareImage"; url: string; source: string }
  | { type: "verifyImageCrop"; token: string }
  | { type: "showImageEditor"; token: string; thumbnail?: string };

type Replies = {
  all: Note[];
  page: Note[];
  create: Note;
  edit: Note;
  delete: null;
  openImage: null;
  takeImageJump: string | null;
  import: ImportResult;
  resolutions: null;
  pageChanged: null;
};

type Reply<T> = { ok: true; value: T } | { ok: false; error: string };

function unwrap<T>(response: Reply<T> | undefined): T {
  if (!response) throw new Error("Расширение не ответило. Повторите действие.");
  if (!response.ok) throw new Error(response.error);
  return response.value;
}

export async function ask<R extends Request>(request: R): Promise<Replies[R["type"]]> {
  return unwrap(await chrome.runtime.sendMessage(request));
}

export function askPage(tabId: number, request: { type: "snapshot" }): Promise<PageSnapshot>;
export function askPage(tabId: number, request: { type: "jump"; id: string; url: string }): Promise<boolean>;
export async function askPage(tabId: number, request: PageRequest): Promise<PageSnapshot | boolean> {
  return unwrap(await chrome.tabs.sendMessage(tabId, request, { frameId: 0 }));
}
