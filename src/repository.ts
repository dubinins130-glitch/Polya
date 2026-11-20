import { fingerprint, type ImportResult, type Note, type NoteDraft, type Resolution } from "./model";

const DB_NAME = "polya-fields";
const DB_VERSION = 1;
const STORE = "notes";
const PAGE_INDEX = "byPageUrl";

let connection: Promise<IDBDatabase> | undefined;

function database(): Promise<IDBDatabase> {
  connection ??= new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = (event) => {
      // Add future migrations in ascending version order.
      if (event.oldVersion < 1) {
        const notes = request.result.createObjectStore(STORE, { keyPath: "id" });
        notes.createIndex(PAGE_INDEX, "pageUrl");
      }
    };
    request.onsuccess = () => {
      const db = request.result;
      db.onversionchange = () => {
        db.close();
        connection = undefined;
      };
      db.onclose = () => { connection = undefined; };
      resolve(db);
    };
    request.onerror = () => reject(request.error);
  }).catch((error) => {
    connection = undefined;
    throw error;
  });
  return connection;
}

function result<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function transact<T>(
  mode: IDBTransactionMode,
  operation: (store: IDBObjectStore) => Promise<T>,
): Promise<T> {
  const db = await database();
  const tx = mode === "readwrite"
    ? db.transaction(STORE, mode, { durability: "strict" })
    : db.transaction(STORE, mode);
  const completion = new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error ?? new Error("Транзакция отменена."));
  });
  try {
    const [value] = await Promise.all([operation(tx.objectStore(STORE)), completion]);
    return value;
  } catch (error) {
    try { tx.abort(); } catch { /* Already finished. */ }
    await completion.catch(() => undefined);
    throw error;
  }
}

export function listNotes(pageUrl?: string): Promise<Note[]> {
  return transact("readonly", (store) =>
    result(pageUrl === undefined ? store.getAll() : store.index(PAGE_INDEX).getAll(pageUrl)),
  );
}

export function getNote(id: string): Promise<Note | undefined> {
  return transact("readonly", (store) => result(store.get(id)));
}

export function createNote(draft: NoteDraft): Promise<Note> {
  return transact("readwrite", async (store) => {
    const existing: Note | undefined = await result(store.get(draft.id));
    if (existing) {
      if (fingerprint(existing) === fingerprint(draft)) return existing;
      throw new Error("Этот ID уже используется. Откройте редактор заново.");
    }
    const now = Date.now();
    const note = { ...draft, createdAt: now, updatedAt: now };
    await result(store.add(note));
    return note;
  });
}

function ensureCurrent(note: Note, expected: number): void {
  if (note.updatedAt !== expected) {
    throw new Error("Заметка уже изменена. Закройте редактор и откройте актуальную версию.");
  }
}

export function editNote(id: string, body: string, expected: number): Promise<Note> {
  return transact("readwrite", async (store) => {
    const note: Note | undefined = await result(store.get(id));
    if (!note) throw new Error("Заметка уже удалена.");
    ensureCurrent(note, expected);
    if (note.body === body) return note;
    const edited = { ...note, body, updatedAt: Math.max(Date.now(), note.updatedAt + 1) };
    await result(store.put(edited));
    return edited;
  });
}

export function deleteNote(id: string, expected: number): Promise<void> {
  return transact("readwrite", async (store) => {
    const note: Note | undefined = await result(store.get(id));
    if (!note) return;
    ensureCurrent(note, expected);
    await result(store.delete(id));
  });
}

export function importNotes(incoming: Note[]): Promise<ImportResult> {
  return transact("readwrite", async (store) => {
    const current: Note[] = await result(store.getAll());
    const ids = new Set(current.map((note) => note.id));
    const fingerprints = new Set(current.map(fingerprint));
    let added = 0;
    for (const note of incoming) {
      const key = fingerprint(note);
      if (ids.has(note.id) || fingerprints.has(key)) continue;
      await result(store.add(note));
      ids.add(note.id);
      fingerprints.add(key);
      added++;
    }
    return { added, skipped: incoming.length - added };
  });
}

export function setResolutions(pageUrl: string, updates: Map<string, Resolution>): Promise<boolean> {
  return transact("readwrite", async (store) => {
    const notes: Note[] = await result(store.index(PAGE_INDEX).getAll(pageUrl));
    let changed = false;
    for (const note of notes) {
      const resolution = updates.get(note.id);
      if ((!note.anchor && !note.image) || !resolution || resolution === note.resolution) continue;
      await result(store.put({ ...note, resolution }));
      changed = true;
    }
    return changed;
  });
}
