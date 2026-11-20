import type { Anchor } from "./model";

export function* occurrences(text: string, quote: string): Generator<number> {
  if (!quote) return;
  let from = 0;
  while (from <= text.length - quote.length) {
    const index = text.indexOf(quote, from);
    if (index < 0) return;
    yield index;
    from = index + 1;
  }
}

export function matchQuote(text: string, anchor: Anchor): number | null {
  const candidates = Array.from(occurrences(text, anchor.text));
  if (candidates.length === 0) return null;
  if (candidates.length === 1 && anchor.occurrences === 1) return candidates[0];

  let highest = -1;
  let winners: number[] = [];
  for (const index of candidates) {
    const end = index + anchor.text.length;
    let before = 0;
    let after = 0;
    while (before < anchor.prefix.length && index > before &&
      anchor.prefix[anchor.prefix.length - 1 - before] === text[index - 1 - before]) before++;
    while (after < anchor.suffix.length && end + after < text.length &&
      anchor.suffix[after] === text[end + after]) after++;

    const fullBefore = before > 0 && before === anchor.prefix.length;
    const fullAfter = after > 0 && after === anchor.suffix.length;
    const samePosition = candidates.length === anchor.occurrences && index === anchor.start;
    // Position only breaks ties between candidates with evidence from surrounding text.
    if (!(fullBefore || fullAfter || before + after >= 12 ||
      (samePosition && before + after > 0))) continue;
    const score = 2 * (before + after) + Number(fullBefore) + Number(fullAfter);
    if (score > highest) {
      highest = score;
      winners = [index];
    } else if (score === highest) {
      winners.push(index);
    }
  }
  if (winners.length === 1) return winners[0];
  if (candidates.length === anchor.occurrences && winners.includes(anchor.start)) return anchor.start;
  return null;
}
