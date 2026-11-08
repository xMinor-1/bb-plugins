// The report a person fills in on the page: limits, checks and the parts that both the page and the server use.
export const MAX_SUBJECT_LENGTH = 200;
export const MAX_DESCRIPTION_LENGTH = 10_000;
export const MAX_IMAGES = 6;
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
/** All pictures of one report together: the page sends them in one JSON request. */
export const MAX_TOTAL_BYTES = 15 * 1024 * 1024;
export const IMAGE_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"] as const;
export type ImageType = (typeof IMAGE_TYPES)[number];

export type ReportImage = { name: string; type: ImageType; size: number };
export type ImageCheck = { ok: true } | { ok: false; reason: string };

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1).replace(/\.0$/, "")} MB`;
}

export function isImageType(type: string): type is ImageType {
  return (IMAGE_TYPES as readonly string[]).includes(type);
}

/** Whether one more picture fits next to the ones already attached. The reason is shown to the person as is. */
export function checkImage(next: { name: string; type: string; size: number }, attached: readonly ReportImage[]): ImageCheck {
  const name = next.name || "The picture";
  if (!isImageType(next.type)) return { ok: false, reason: `${name} is not a PNG, JPEG, GIF or WebP picture.` };
  if (next.size === 0) return { ok: false, reason: `${name} is empty.` };
  if (next.size > MAX_IMAGE_BYTES) {
    return { ok: false, reason: `${name} is ${formatBytes(next.size)}. A picture can be up to ${formatBytes(MAX_IMAGE_BYTES)}.` };
  }
  if (attached.length >= MAX_IMAGES) return { ok: false, reason: `A report can have up to ${MAX_IMAGES} pictures.` };
  const total = attached.reduce((sum, image) => sum + image.size, 0) + next.size;
  if (total > MAX_TOTAL_BYTES) {
    return { ok: false, reason: `All pictures together can be up to ${formatBytes(MAX_TOTAL_BYTES)}. Remove one or attach a smaller one.` };
  }
  return { ok: true };
}

/** A pasted screenshot has no name, or the same name every time: give each one its own. */
export function imageName(name: string, type: ImageType, taken: readonly string[]): string {
  const extension = type === "image/jpeg" ? "jpg" : type.slice("image/".length);
  const clean = name.replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_").trim().slice(0, 120);
  const base = clean && clean.toLowerCase() !== `image.${extension}` ? clean : `screenshot.${extension}`;
  if (!taken.includes(base)) return base;
  const dot = base.lastIndexOf(".");
  const [stem, ext] = dot > 0 ? [base.slice(0, dot), base.slice(dot)] : [base, ""];
  for (let n = 2; ; n++) if (!taken.includes(`${stem}-${n}${ext}`)) return `${stem}-${n}${ext}`;
}
