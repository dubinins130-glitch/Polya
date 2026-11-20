import { imageSource, isThumbnail, MAX_THUMBNAIL_SIDE, type ImageLocator } from "./model";
import { matchImage, sameImageSource, type ImageCandidate } from "./image-match";
import type { ImageCrop } from "./protocol";

interface PageImage extends ImageCandidate {
  element: HTMLImageElement;
}

export function imageSources(image: HTMLImageElement): string[] {
  return Array.from(new Set([image.currentSrc, image.src].filter(Boolean).map(imageSource).filter((source) => source !== undefined)));
}

const hint = (text: string) => text.trim().replace(/\s+/g, " ").slice(0, 256);

function describe(element: HTMLImageElement): PageImage | undefined {
  const [source, fallbackSource] = imageSources(element);
  if (!source) return undefined;
  const figure = element.closest("figure");
  return {
    source, fallbackSource, element,
    alt: hint(element.alt), caption: hint(figure?.querySelector(":scope > figcaption")?.textContent ?? ""),
    elementId: element.id.slice(0, 256),
  };
}

export function pageImages(): PageImage[] {
  const images: PageImage[] = [];
  for (const element of document.images) {
    const candidate = describe(element);
    if (candidate) images.push(candidate);
  }
  return images;
}

export function imageLocator(source: string, element: HTMLImageElement | undefined, images: PageImage[]): ImageLocator {
  const candidate = element && describe(element);
  if (!candidate) return { source, alt: "", caption: "", elementId: "", occurrences: 1, occurrence: 0 };
  const { alt, caption, elementId } = candidate;
  const fallbackSource = imageSources(element).find((item) => item !== source);
  const locator = { source, fallbackSource, alt, caption, elementId };
  const matching = images.filter((item) => sameImageSource(locator, item));
  return {
    ...locator,
    occurrence: Math.max(0, matching.findIndex((item) => item.element === element)),
    occurrences: Math.max(1, matching.length),
  };
}

export function findPageImage(locator: ImageLocator, images: PageImage[]): HTMLImageElement | undefined {
  const index = matchImage(locator, images);
  if (index === undefined) return undefined;
  const image = images[index].element;
  if (!image.isConnected || (image.complete && image.naturalWidth === 0)) return undefined;
  const { width, height } = image.getBoundingClientRect();
  return width > 0 && height > 0 ? image : undefined;
}

export function thumbnailDimensions(width: number, height: number, side = MAX_THUMBNAIL_SIDE): [number, number] {
  const scale = Math.min(1, side / Math.max(width, height));
  return [Math.max(1, Math.round(width * scale)), Math.max(1, Math.round(height * scale))];
}

export function imageThumbnail(image: HTMLImageElement): string | undefined {
  if (!image.naturalWidth || !image.naturalHeight) return undefined;
  const canvas = document.createElement("canvas");
  const context = canvas.getContext("2d", { alpha: false });
  if (!context) return undefined;
  try {
    for (const side of [MAX_THUMBNAIL_SIDE, 96]) {
      [canvas.width, canvas.height] = thumbnailDimensions(image.naturalWidth, image.naturalHeight, side);
      context.drawImage(image, 0, 0, canvas.width, canvas.height);
      const thumbnail = canvas.toDataURL("image/webp", 0.68);
      if (isThumbnail(thumbnail)) return thumbnail;
    }
  } catch { /* The canvas is tainted when the image comes from another origin. */ }
  return undefined;
}

export function visibleImageCrop(image: HTMLImageElement): ImageCrop | undefined {
  if (!image.isConnected || !image.naturalWidth || (window.visualViewport?.scale ?? 1) !== 1) return undefined;
  const rect = image.getBoundingClientRect();
  const width = window.innerWidth;
  const height = window.innerHeight;
  // Crop inside the element and the viewport, away from antialiased edges and scrollbars.
  const left = Math.max(rect.left + 2, 0);
  const top = Math.max(rect.top + 2, 0);
  const right = Math.min(rect.right - 2, document.documentElement.clientWidth);
  const bottom = Math.min(rect.bottom - 2, document.documentElement.clientHeight);
  if (right - left < 12 || bottom - top < 12 || !width || !height) return undefined;
  const xs = [left, (left + right) / 2, right];
  const ys = [top, (top + bottom) / 2, bottom];
  if (!xs.every((x) => ys.every((y) => document.elementFromPoint(x, y) === image))) return undefined;
  return { left: left / width, top: top / height, right: right / width, bottom: bottom / height };
}
