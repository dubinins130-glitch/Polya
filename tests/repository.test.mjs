import "fake-indexeddb/auto";
import assert from "node:assert/strict";
import test from "node:test";

import { newId } from "../src/model.ts";
import { createNote, deleteNote, editNote, importNotes, listNotes, setResolutions } from "../src/repository.ts";

const url = (name) => "https://example.com/" + name;
const draft = (name, body) => ({ id: newId(), pageUrl: url(name), pageTitle: name, body });

test("parallel writes on different pages persist and page lookups stay isolated", async () => {
  const names = ["first", "second"];
  const pending = Array.from({ length: 18 }, (_, i) => draft(names[i % 2], "note " + i));
  await Promise.all(pending.map(createNote));
  assert.equal((await listNotes(url("first"))).length, 9);
  assert.equal((await listNotes(url("second"))).length, 9);
});

test("retrying creation is idempotent", async () => {
  const note = draft("retry", "one note");
  const [first, second] = await Promise.all([createNote(note), createNote(note)]);
  assert.deepEqual(first, second);
  assert.equal((await listNotes(note.pageUrl)).length, 1);
  await assert.rejects(createNote({ ...note, body: "different note" }), /ID/);
});

test("concurrent edits detect stale versions and deletion cannot erase a newer edit", async () => {
  const original = await createNote(draft("concurrency", "original"));
  const edits = await Promise.allSettled([
    editNote(original.id, "first edit", original.updatedAt),
    editNote(original.id, "second edit", original.updatedAt),
  ]);
  assert.equal(edits.filter(({ status }) => status === "fulfilled").length, 1);
  const [current] = await listNotes(original.pageUrl);
  await assert.rejects(deleteNote(original.id, original.updatedAt), /уже изменена/);
  await deleteNote(current.id, current.updatedAt);
  await assert.rejects(editNote(current.id, "restore?", current.updatedAt), /удалена/);
  assert.deepEqual(await listNotes(original.pageUrl), []);
});

test("parallel imports merge by ID and content without replacing local edits", async () => {
  const local = await createNote(draft("merge", "local version"));
  const newEntry = { ...draft("merge", "new entry"), createdAt: 40, updatedAt: 80 };
  const backup = [{ ...local, body: "older version" }, newEntry, { ...newEntry, id: newId() }];
  const summaries = await Promise.all([importNotes(backup), importNotes(backup)]);
  assert.deepEqual(summaries.map(({ added }) => added).sort(), [0, 1]);
  assert.equal(summaries.reduce((count, { skipped }) => count + skipped, 0), 5);
  assert.deepEqual((await listNotes(local.pageUrl)).map((note) => note.body).sort(), ["local version", "new entry"]);
});

test("resolution updates preserve concurrent edits, timestamps and page isolation", async () => {
  const note = await createNote({
    ...draft("resolution", "before"),
    anchor: { exact: "text", text: "text", prefix: "", suffix: "", start: 0, occurrences: 1 },
  });
  const [, edited] = await Promise.all([
    setResolutions(note.pageUrl, new Map([[note.id, "missing"]])),
    editNote(note.id, "after", note.updatedAt),
  ]);
  assert.equal(await setResolutions(url("unrelated"), new Map([[note.id, "found"]])), false);
  const [loaded] = await listNotes(note.pageUrl);
  assert.equal(loaded.resolution, "missing");
  assert.equal(loaded.body, "after");
  assert.equal(loaded.updatedAt, edited.updatedAt);
});
