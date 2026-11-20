import type { Note } from "./model";

export type SortOrder = "newest" | "oldest";

interface PageGroup {
  url: string;
  title: string;
  latest: number;
  notes: Note[];
}

function searchable(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase("ru");
}

export function groupNotes(notes: Note[], query: string, order: SortOrder): PageGroup[] {
  const terms = searchable(query).trim().split(/\s+/).filter(Boolean);
  const groups = new Map<string, PageGroup>();
  const byNewest = (a: Note, b: Note) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id);
  const factor = order === "newest" ? 1 : -1;
  const matches = terms.length ? notes.filter((note) => {
    const haystack = searchable([note.pageUrl, note.pageTitle, note.anchor?.exact,
      note.image?.alt, note.image?.caption, note.image?.source, note.body].join(" "));
    return terms.every((term) => haystack.includes(term));
  }) : [...notes];

  for (const note of matches.sort(byNewest)) {
    let group = groups.get(note.pageUrl);
    if (!group) {
      group = { url: note.pageUrl, title: note.pageTitle, latest: note.updatedAt, notes: [] };
      groups.set(note.pageUrl, group);
    }
    group.notes.push(note);
  }
  const result = Array.from(groups.values());
  if (order === "oldest") {
    for (const group of result) group.notes.reverse();
  }
  return result.sort((a, b) => factor * (b.latest - a.latest) || a.url.localeCompare(b.url));
}
