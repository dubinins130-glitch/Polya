import type { ImageLocator } from "./model";

export type ImageCandidate = Pick<ImageLocator, "source" | "fallbackSource" | "alt" | "caption" | "elementId">;

export function sameImageSource(a: ImageCandidate, b: ImageCandidate): boolean {
  return a.source === b.source || a.source === b.fallbackSource ||
    (a.fallbackSource !== undefined && (a.fallbackSource === b.source || a.fallbackSource === b.fallbackSource));
}

export function matchImage(locator: ImageLocator, candidates: ImageCandidate[]): number | undefined {
  const matching = candidates.flatMap((candidate, index) => sameImageSource(locator, candidate) ? [index] : []);
  const sameId = (candidate: ImageCandidate) => !!locator.elementId && locator.elementId === candidate.elementId;
  const sameAlt = (candidate: ImageCandidate) => !!locator.alt && locator.alt === candidate.alt;
  const sameCaption = (candidate: ImageCandidate) => !!locator.caption && locator.caption === candidate.caption;

  if (!matching.length) {
    // A stable identifier or a matching caption and alternative text can survive a URL change.
    const contextual = candidates.flatMap((candidate, index) =>
      sameId(candidate) || (sameAlt(candidate) && sameCaption(candidate)) ? [index] : []);
    return contextual.length === 1 ? contextual[0] : undefined;
  }

  let score = -1;
  let best: number[] = [];
  for (const index of matching) {
    const candidate = candidates[index];
    const points = (sameId(candidate) ? 4 : 0) + (sameCaption(candidate) ? 2 : 0) + (sameAlt(candidate) ? 1 : 0);
    if (points > score) {
      score = points;
      best = [index];
    } else if (points === score) {
      best.push(index);
    }
  }
  if (best.length === 1 && (locator.occurrences === 1 || matching.length === locator.occurrences || score >= 2)) {
    return best[0];
  }
  const ordinal = matching[locator.occurrence];
  return matching.length === locator.occurrences && best.includes(ordinal) ? ordinal : undefined;
}
