// Several pictures into one, for a form that takes a single file: stacked top to bottom with a gap, in the order they
// were attached. Runs in the page, which has a canvas.
import { MAX_IMAGE_BYTES } from "./report";

const MAX_WIDTH = 1920;
// Chrome and Safari refuse bigger canvases.
const MAX_HEIGHT = 16_000;
const GAP = 16;
const BACKGROUND = "#d4d4d8";

export type Size = { width: number; height: number };
export type Layout = { width: number; height: number; boxes: Array<{ x: number; y: number; width: number; height: number }> };

/**
 * Where each picture goes: the canvas is as wide as the widest picture (at most MAX_WIDTH); a narrower one keeps its
 * own size and stands in the middle, so its text stays sharp. The whole stays within MAX_HEIGHT.
 */
export function layout(sizes: readonly Size[], shrink = 1): Layout {
  const gaps = GAP * (sizes.length - 1);
  const fit = (scale: number) => sizes.map((size) => Math.min(size.width, MAX_WIDTH) * scale);
  const heightAt = (scale: number) => fit(scale).reduce((sum, width, i) => sum + (sizes[i]!.height * width) / sizes[i]!.width, 0);
  let scale = shrink;
  if (heightAt(scale) + gaps > MAX_HEIGHT) scale = (scale * (MAX_HEIGHT - gaps)) / heightAt(scale);
  const widths = fit(scale).map((width) => Math.max(1, Math.floor(width)));
  const width = Math.max(...widths);
  const boxes: Layout["boxes"] = [];
  let y = 0;
  widths.forEach((w, i) => {
    const h = Math.max(1, Math.round((sizes[i]!.height * w) / sizes[i]!.width));
    boxes.push({ x: Math.floor((width - w) / 2), y, width: w, height: h });
    y += h + GAP;
  });
  return { width, height: y - GAP, boxes };
}

function toBlob(canvas: HTMLCanvasElement, type: string, quality?: number): Promise<Blob> {
  return new Promise((resolve, reject) =>
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error("The pictures could not be joined."))), type, quality),
  );
}

/** One picture of every picture, within the size limit: PNG, then JPEG of falling quality, then smaller. */
export async function combineImages(files: readonly Blob[]): Promise<Blob> {
  const bitmaps = await Promise.all(files.map((file) => createImageBitmap(file)));
  try {
    for (const shrink of [1, 0.75, 0.5, 0.35]) {
      const place = layout(bitmaps, shrink);
      const canvas = document.createElement("canvas");
      canvas.width = place.width;
      canvas.height = place.height;
      const context = canvas.getContext("2d");
      if (!context) throw new Error("The pictures could not be joined.");
      context.fillStyle = BACKGROUND;
      context.fillRect(0, 0, place.width, place.height);
      context.imageSmoothingQuality = "high";
      bitmaps.forEach((bitmap, index) => {
        const box = place.boxes[index]!;
        context.drawImage(bitmap, box.x, box.y, box.width, box.height);
      });
      const attempts: Array<[string, number | undefined]> = [["image/png", undefined], ["image/jpeg", 0.9], ["image/jpeg", 0.8], ["image/jpeg", 0.7]];
      for (const [type, quality] of attempts) {
        const blob = await toBlob(canvas, type, quality);
        if (blob.size <= MAX_IMAGE_BYTES) return blob;
      }
    }
    throw new Error("The pictures are too large to join into one. Remove one and send again.");
  } finally {
    for (const bitmap of bitmaps) bitmap.close();
  }
}
