// The model-in-parts setting, read without the SDK so it can be tested alone.

/** One part: where it is and the SHA-256 it must have. */
export interface PartSpec {
  url: string;
  sha256: string;
}

/**
 * Model parts as `<address> <sha256>` pairs, either order, separated by
 * spaces, commas or new lines. An address without a sum keeps an empty one,
 * so the download says which part is incomplete instead of skipping it.
 */
export function parseParts(raw: string): PartSpec[] {
  const parts: PartSpec[] = [];
  let url: string | null = null;
  let sha: string | null = null;
  const flush = () => {
    if (url !== null || sha !== null) parts.push({ url: url ?? "", sha256: sha ?? "" });
    url = null;
    sha = null;
  };
  for (const token of raw.split(/[\s,;]+/)) {
    if (token === "") continue;
    if (/^[0-9a-fA-F]{64}$/.test(token)) {
      if (sha !== null) flush();
      sha = token.toLowerCase();
    } else {
      if (url !== null) flush();
      url = token;
    }
    if (url !== null && sha !== null) flush();
  }
  flush();
  return parts;
}
