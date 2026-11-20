import { imageSource, isThumbnail, MAX_THUMBNAIL_BYTES, MAX_THUMBNAIL_SIDE, pageKey, THUMBNAIL_PREFIX } from "./model";
import { thumbnailDimensions } from "./page-images";
import type { ImageCrop, PageRequest, PreparedImage } from "./protocol";

const MENU_ID = "polya-add-image-note";

export function installImageMenu(): void {
  chrome.contextMenus.create({
    id: MENU_ID,
    title: "Добавить заметку в Поля",
    contexts: ["image"],
    documentUrlPatterns: ["http://*/*", "https://*/*"],
  }, () => { void chrome.runtime.lastError; });
}

async function send<T>(tabId: number, request: PageRequest): Promise<T | undefined> {
  const reply = await chrome.tabs.sendMessage(tabId, request, { frameId: 0 });
  return reply?.ok ? reply.value : undefined;
}

function sameCrop(a: ImageCrop, b: ImageCrop | undefined): boolean {
  if (!b) return false;
  const values = [b.left, b.top, b.right, b.bottom];
  return values.every((value) => Number.isFinite(value) && value >= 0 && value <= 1) &&
    a.left === b.left && a.top === b.top && a.right === b.right && a.bottom === b.bottom &&
    b.right > b.left && b.bottom > b.top;
}

async function cropThumbnail(screenshot: string, crop: ImageCrop): Promise<string | undefined> {
  const bitmap = await createImageBitmap(await (await fetch(screenshot)).blob());
  try {
    const x = Math.ceil(crop.left * bitmap.width);
    const y = Math.ceil(crop.top * bitmap.height);
    const width = Math.floor(crop.right * bitmap.width) - x;
    const height = Math.floor(crop.bottom * bitmap.height) - y;
    if (width < 1 || height < 1) return undefined;
    for (const side of [MAX_THUMBNAIL_SIDE, 96]) {
      const [w, h] = thumbnailDimensions(width, height, side);
      const canvas = new OffscreenCanvas(w, h);
      const context = canvas.getContext("2d", { alpha: false });
      if (!context) return undefined;
      context.drawImage(bitmap, x, y, width, height, 0, 0, w, h);
      const blob = await canvas.convertToBlob({ type: "image/webp", quality: 0.68 });
      if (blob.type !== "image/webp" || blob.size > MAX_THUMBNAIL_BYTES) continue;
      const bytes = new Uint8Array(await blob.arrayBuffer());
      const thumbnail = THUMBNAIL_PREFIX + btoa(String.fromCharCode(...bytes));
      if (isThumbnail(thumbnail)) return thumbnail;
    }
    return undefined;
  } finally {
    bitmap.close();
  }
}

async function captureImage(tabId: number, windowId: number, token: string, crop: ImageCrop): Promise<string | undefined> {
  let switched = false;
  const onActivated = (active: { windowId: number; tabId: number }) => {
    if (active.windowId === windowId && active.tabId !== tabId) switched = true;
  };
  const isActive = async () => (await chrome.tabs.query({ active: true, windowId }))[0]?.id === tabId;
  chrome.tabs.onActivated.addListener(onActivated);
  try {
    if (!await isActive() || switched) return undefined;
    // The screenshot lives only in memory and is taken on explicit invocation of the image menu.
    const screenshot = await chrome.tabs.captureVisibleTab(windowId, { format: "jpeg", quality: 85 });
    if (!await isActive() || switched) return undefined;
    const confirmed = await send<ImageCrop>(tabId, { type: "verifyImageCrop", token });
    if (!sameCrop(crop, confirmed) || switched) return undefined;
    return await cropThumbnail(screenshot, crop);
  } catch { return undefined; }
  finally { chrome.tabs.onActivated.removeListener(onActivated); }
}

export async function onImageMenu(info: chrome.contextMenus.OnClickData, tab?: chrome.tabs.Tab): Promise<void> {
  if (info.menuItemId !== MENU_ID || tab?.id === undefined || (info.frameId ?? 0) !== 0 || !info.srcUrl) return;
  const url = pageKey(info.pageUrl ?? tab.url ?? "");
  const source = imageSource(info.srcUrl);
  if (!url || !source) return;
  const prepared = await send<PreparedImage>(tab.id, { type: "prepareImage", url, source });
  if (!prepared) return;
  const thumbnail = prepared.crop && await captureImage(tab.id, tab.windowId, prepared.token, prepared.crop);
  await send(tab.id, { type: "showImageEditor", token: prepared.token, thumbnail });
}
