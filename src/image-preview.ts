import { THUMBNAIL_PREFIX, type ImageAttachment } from "./model";

export function imagePreview(image: ImageAttachment, onPage = false): HTMLElement {
  const preview = document.createElement("div");
  preview.className = "image-preview";
  const unavailable = () => { preview.textContent = "Миниатюра недоступна"; };
  const label = image.alt || "Миниатюра изображения";
  if (!image.thumbnail) {
    unavailable();
  } else if (onPage) {
    // The site's image CSP can block a data URL in an <img>. Paint the local bytes instead.
    const canvas = document.createElement("canvas");
    canvas.setAttribute("role", "img");
    canvas.setAttribute("aria-label", label);
    const data = atob(image.thumbnail.slice(THUMBNAIL_PREFIX.length));
    const bytes = Uint8Array.from(data, (character) => character.charCodeAt(0));
    void createImageBitmap(new Blob([bytes], { type: "image/webp" })).then((bitmap) => {
      try {
        canvas.width = bitmap.width;
        canvas.height = bitmap.height;
        canvas.getContext("2d")?.drawImage(bitmap, 0, 0);
        preview.replaceChildren(canvas);
      } finally { bitmap.close(); }
    }).catch(unavailable);
  } else {
    const miniature = document.createElement("img");
    miniature.alt = label;
    miniature.decoding = "async";
    miniature.loading = "lazy";
    miniature.addEventListener("error", unavailable, { once: true });
    miniature.src = image.thumbnail;
    preview.append(miniature);
  }
  return preview;
}
