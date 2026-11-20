import assert from "node:assert/strict";
import test from "node:test";

import { groupNotes } from "../src/groups.ts";
import { matchImage } from "../src/image-match.ts";
import { matchQuote, occurrences } from "../src/match.ts";
import { fingerprint, imageSource, isThumbnail, makeBackup, pageKey, parseBackup } from "../src/model.ts";

const excerpt = "одинаковая цитата";
function anchor(text, index) {
  return {
    exact: excerpt,
    text: excerpt,
    prefix: text.slice(Math.max(0, index - 72), index),
    suffix: text.slice(index + excerpt.length, index + excerpt.length + 72),
    start: index,
    occurrences: [...occurrences(text, excerpt)].length,
  };
}

const note = {
  id: "aaaaaaaaaaaaaaaa",
  pageUrl: "https://example.com/articles",
  pageTitle: "Заголовок статьи",
  body: "Заметка о привычках",
  createdAt: 100,
  updatedAt: 100,
};

test("page identity handles ordinary fragments, hash routes and query routes", () => {
  assert.equal(pageKey("https://EXAMPLE.com:443/articles?page=3#intro"), "https://example.com/articles?page=3");
  assert.equal(pageKey("https://example.com/#/reader?id=1:~:text=quoted"), "https://example.com/#/reader?id=1");
  assert.equal(pageKey("https://example.com/#!/reader"), "https://example.com/#!/reader");
  for (const input of ["javascript:alert(1)", "file:///note.txt", "chrome://settings", "https://a:b@example.com"]) {
    assert.equal(pageKey(input), null);
  }
});

test("match reattaches the correct occurrence after insertion", () => {
  const a = "Первая глава о медленной работе: " + excerpt + " и конец первой главы. ";
  const b = "Совсем другой контекст в новом разделе: " + excerpt + " завершается иначе.";
  const original = a + b;
  const second = anchor(original, original.lastIndexOf(excerpt));
  const altered = "Новое оглавление. " + original;
  assert.equal(matchQuote(altered, second), altered.lastIndexOf(excerpt));
  assert.equal(matchQuote(a + "Текст удалён.", second), null);
});

test("an unchanged position disambiguates identical contexts", () => {
  const paragraph = "а".repeat(80) + excerpt + "б".repeat(80);
  const article = paragraph + paragraph;
  const second = anchor(article, article.lastIndexOf(excerpt));
  assert.equal(matchQuote(article, second), second.start);
  assert.equal(matchQuote("Сдвиг: " + article, second), null);
});

test("an unambiguous quotation can move and its absence is represented", () => {
  const original = "Текст: " + excerpt + ".";
  const saved = anchor(original, original.indexOf(excerpt));
  assert.equal(matchQuote(excerpt + " с новым контекстом", saved), 0);
  assert.equal(matchQuote("Совершенно другой текст", saved), null);
});

test("backup round-trips note identity and treats HTML as plain text", () => {
  const html = { ...note, body: "<img src=x><b>Комментарий</b>", resolution: "missing" };
  const exported = makeBackup([html]);
  const [restored] = parseBackup(JSON.parse(JSON.stringify(exported)));
  assert.equal(restored.id, html.id);
  assert.equal(restored.body, html.body);
  assert.equal(restored.resolution, undefined);
});

test("backup validation rejects unsupported versions and malformed or unsafe records", () => {
  const exported = makeBackup([note]);
  assert.throws(() => parseBackup({ ...exported, version: 9000 }), /Формат/);
  assert.throws(() => parseBackup(makeBackup([note, { ...note, pageUrl: "javascript:alert(1)" }])), /Запись №2/);
  assert.throws(() => parseBackup(makeBackup([{ ...note, updatedAt: 0 }])), /предшествует/);
  assert.throws(() => parseBackup(makeBackup([{
    ...note, anchor: { ...anchor(excerpt, 0), start: -1 },
  }])), /пределы/);
});

test("backup duplicate matching distinguishes two positions on a page", () => {
  const first = { ...note, anchor: anchor(excerpt, 0) };
  const second = { ...first, id: "bbbbbbbbbbbbbbbb", anchor: { ...first.anchor, start: 100 } };
  assert.equal(fingerprint(first), fingerprint({ ...first, id: second.id }));
  assert.notEqual(fingerprint(first), fingerprint(second));
});

test("journal groups by URL and searches title, URL, quote and body", () => {
  const second = {
    ...note, id: "bbbbbbbbbbbbbbbb", body: "другой комментарий", updatedAt: 200, anchor: anchor(excerpt, 0),
  };
  const third = { ...note, id: "cccccccccccccccc", pageUrl: "https://else.example/reader", updatedAt: 300 };
  const notes = [note, second, third];
  assert.deepEqual(groupNotes(notes, "", "newest").map((group) => group.notes.length), [1, 2]);
  assert.deepEqual(groupNotes(notes, "", "oldest").map((group) => group.latest), [200, 300]);
  assert.deepEqual(groupNotes(notes, "ARTICLES заголовок цитата КомМентарий", "newest")[0].notes, [second]);
  assert.deepEqual(groupNotes(notes, "привычках", "newest").flatMap((group) => group.notes), [third, note]);
});

const thumbnail = "data:image/webp;base64,UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEADsD+JaQAA3AAAAAA";
const photo = {
  source: "https://images.example/large.webp",
  fallbackSource: "https://images.example/fallback.webp",
  alt: "Северный маяк", caption: "Маяк у моря", elementId: "lighthouse", occurrence: 0, occurrences: 1,
};

test("image backups retain a bounded thumbnail and read the old text format", () => {
  assert.equal(isThumbnail(thumbnail), true);
  const imageNote = { ...note, image: { ...photo, thumbnail } };
  const exported = makeBackup([imageNote]);
  assert.equal(exported.version, 2);
  assert.deepEqual(parseBackup(JSON.parse(JSON.stringify(exported))), [imageNote]);
  const oldQuote = { ...note, anchor: { exact: excerpt, text: excerpt, prefix: "", suffix: "", start: 0, occurrences: 1 } };
  assert.deepEqual(parseBackup({ ...makeBackup([oldQuote]), version: 1 }), [oldQuote]);
  const inline = imageSource("data:image/png;base64," + "x".repeat(50000));
  assert.match(inline, /^inline:\d+-[a-f0-9]+$/);
  assert.ok(inline.length < 32);
  assert.notEqual(fingerprint(imageNote), fingerprint(note));
  assert.equal(groupNotes([imageNote], "маяк", "newest")[0].notes[0], imageNote);
});

test("image backup rejects remote, oversized or mislabelled thumbnails and mixed attachments", () => {
  const wrongSize = Buffer.from(thumbnail.split(",")[1], "base64");
  wrongSize.writeUInt16LE(800, 26);
  for (const preview of ["https://example.com/large.webp", "data:image/svg+xml;base64,AAAA", thumbnail + "A".repeat(30000),
    "data:image/webp;base64," + wrongSize.toString("base64")]) {
    assert.throws(() => parseBackup(makeBackup([{ ...note, image: { ...photo, thumbnail: preview } }])), /миниатюра/);
  }
  assert.throws(() => parseBackup(makeBackup([{ ...note, image: { ...photo, source: "javascript:void(0)" } }])), /адрес/);
  assert.throws(() => parseBackup(makeBackup([{ ...note, image: photo, anchor: anchor(excerpt, 0) }])), /одну привязку/);
});

test("image matching handles moved and responsive images and avoids ambiguous duplicates", () => {
  const other = { ...photo, elementId: "other", alt: "Другая подпись", caption: "Другой снимок" };
  const snapshot = { ...photo, occurrences: 2 };
  assert.equal(matchImage(snapshot, [other, photo]), 1);
  assert.equal(matchImage(snapshot, [other]), undefined);
  assert.equal(matchImage(photo, [{ ...photo, source: photo.fallbackSource, fallbackSource: undefined }]), 0);
  assert.equal(matchImage(photo, [{ ...photo, source: "https://example.com/moved.webp", fallbackSource: undefined }]), 0);
  const noHint = { ...photo, elementId: "", alt: "", caption: "", occurrence: 1, occurrences: 2 };
  assert.equal(matchImage(noHint, [noHint, noHint]), 1);
  assert.equal(matchImage(noHint, [noHint, noHint, noHint]), undefined);
  assert.equal(matchImage(photo, []), undefined);
});
