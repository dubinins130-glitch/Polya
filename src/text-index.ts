import { CONTEXT_LENGTH, type Anchor } from "./model";
import { matchQuote, occurrences } from "./match";

interface Segment {
  node: Text;
  start: number;
  end: number;
}

interface Layout {
  visible: boolean;
  flow: Element | null;
}

const IGNORE = "script, style, noscript, template, textarea, select, input, [hidden], [inert], [contenteditable]:not([contenteditable='false'])";

function lowerBound(length: number, predicate: (index: number) => boolean): number {
  let start = 0;
  let end = length;
  while (start < end) {
    const mid = Math.floor((start + end) / 2);
    if (predicate(mid)) end = mid;
    else start = mid + 1;
  }
  return start;
}

export class TextIndex {
  private readonly segments: Segment[] = [];
  private readonly byNode = new Map<Node, Segment>();
  private readonly spaceEnds: number[] = [];
  private readonly removedCharacters: number[] = [];
  private readonly text: string;

  constructor(body: HTMLElement) {
    const layouts = new WeakMap<Element, Layout>();
    const layout = (element: Element): Layout => {
      const existing = layouts.get(element);
      if (existing) return existing;
      const style = getComputedStyle(element);
      const parent = element === body ? null : element.parentElement;
      const flow = /^(inline|contents)/.test(style.display) && parent ? layout(parent).flow : element;
      const resolved = {
        visible: style.display !== "none" && style.contentVisibility !== "hidden" &&
          style.visibility !== "hidden" && style.visibility !== "collapse",
        flow,
      };
      layouts.set(element, resolved);
      return resolved;
    };

    const walker = document.createTreeWalker(body, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        if (node instanceof Element) {
          if (node.matches(IGNORE) || !layout(node).visible) return NodeFilter.FILTER_REJECT;
          return node.localName === "br" ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP;
        }
        return node.parentElement && layout(node.parentElement).visible && node.textContent
          ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP;
      },
    });

    const chunks: string[] = [];
    let offset = 0;
    let lastFlow: Element | null = null;
    const separator = () => { chunks.push(" "); offset++; };
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (!(node instanceof Text)) {
        separator();
        continue;
      }
      const flow = node.parentElement ? layout(node.parentElement).flow : null;
      if (lastFlow && flow !== lastFlow) separator();
      const segment = { node, start: offset, end: offset + node.length };
      this.segments.push(segment);
      this.byNode.set(node, segment);
      chunks.push(node.data);
      offset = segment.end;
      lastFlow = flow;
    }

    let removed = 0;
    this.text = chunks.join("").replace(/\s{2,}|[^\S ]/g, (space: string, rawStart: number) => {
      if (space.length > 1) {
        removed += space.length - 1;
        this.spaceEnds.push(rawStart + space.length);
        this.removedCharacters.push(removed);
      }
      return " ";
    });
  }

  private rawOffset(boundary: number): number {
    // Only collapsed whitespace changes the offset. A run's normalized end includes its one retained space.
    const next = lowerBound(this.spaceEnds.length, (i) => this.spaceEnds[i] - this.removedCharacters[i] > boundary);
    return boundary + (this.removedCharacters[next - 1] ?? 0);
  }

  private normalizedOffset(raw: number, edge: "start" | "end"): number {
    const next = lowerBound(this.spaceEnds.length, (i) => this.spaceEnds[i] > raw);
    const before = this.removedCharacters[next - 1] ?? 0;
    const rawEnd = this.spaceEnds[next];
    const removed = this.removedCharacters[next];
    // Differencing consecutive totals gives the removed characters in this run.
    if (rawEnd !== undefined && raw > rawEnd - (removed - before + 1)) {
      const boundary = rawEnd - removed;
      return edge === "start" ? boundary - 1 : boundary;
    }
    return raw - before;
  }

  capture(range: Range, exact: string): Anchor | null {
    if (range.collapsed || !exact.trim()) return null;
    const first = this.byNode.get(range.startContainer);
    const last = this.byNode.get(range.endContainer);
    if ((!first && range.startContainer.nodeType === Node.TEXT_NODE) ||
        (!last && range.endContainer.nodeType === Node.TEXT_NODE)) return null;

    const selected = first && last ? [] : this.segments.filter(({ node }) => range.intersectsNode(node));
    const rawStart = first ? first.start + range.startOffset : selected[0]?.start;
    const rawEnd = last ? last.start + range.endOffset : selected.at(-1)?.end;
    if (rawStart === undefined || rawEnd === undefined || rawStart >= rawEnd) return null;

    let start = this.normalizedOffset(rawStart, "start");
    let end = this.normalizedOffset(rawEnd, "end");
    if (this.text[start] === " ") start++;
    if (this.text[end - 1] === " ") end--;
    if (end <= start) return null;

    const text = this.text.slice(start, end);
    let count = 0;
    for (const _ of occurrences(this.text, text)) count++;
    return {
      exact,
      text,
      start,
      prefix: this.text.slice(Math.max(0, start - CONTEXT_LENGTH), start),
      suffix: this.text.slice(end, end + CONTEXT_LENGTH),
      occurrences: count,
    };
  }

  restore(anchor: Anchor): Range | null {
    const match = matchQuote(this.text, anchor);
    if (match === null) return null;
    const start = this.rawOffset(match);
    const end = this.rawOffset(match + anchor.text.length);
    const first = this.segments[lowerBound(this.segments.length, (index) => this.segments[index].end > start)];
    const last = this.segments[lowerBound(this.segments.length, (index) => this.segments[index].end >= end)];
    if (!first || !last || !first.node.isConnected || !last.node.isConnected) return null;

    const range = document.createRange();
    range.setStart(first.node, start - first.start);
    range.setEnd(last.node, end - last.start);
    return range;
  }
}
