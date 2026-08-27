// src/preview.ts — the gallery's byte transport (§8.9).
//
// The panel needs to *display* the files it lists, not just describe them. The
// download route is the wrong tool for that: it is `application/octet-stream`
// with `no-store` and `Content-Disposition`, deliberately, so an <img src> on
// it would fight the very headers that make a download a download.
//
// bb already has the right primitive — `bb.sdk.files.createPreview` mints a
// short-lived URL rooted at one folder — so this module is only two things:
// the §6 path clamp in front of it, and one stable error code behind it.
import type { BbPluginApi } from "@get-bb/plugin-sdk";

import { PREVIEW_TTL_MS } from "../contract";
import { fmError } from "./errors";
import { resolveExistingDir } from "./root";

export interface CreatePreviewUrlInput {
  path: string;
}

export interface CreatePreviewUrlOutput {
  baseUrl: string;
  path: string;
  expiresAtMs: number;
}

export async function createPreviewUrl(
  bb: BbPluginApi,
  input: CreatePreviewUrlInput,
): Promise<CreatePreviewUrlOutput> {
  // The clamp comes first and is the ordinary one: whatever the URL can reach
  // is decided here, by a realpath'ed folder inside the hard root, and never
  // by a string the panel sent.
  const dir = await resolveExistingDir(input.path);

  let preview: { baseUrl: string; expiresAtMs: number };
  try {
    // No `hostId`: the root of this plugin is the home folder of the user
    // running bb, so the files are on bb's own machine — which is what the
    // files area addresses when no host is named.
    preview = await bb.sdk.files.createPreview({ rootPath: dir, ttlMs: PREVIEW_TTL_MS });
  } catch (error) {
    // A server too old to mint preview URLs, or one that refused this folder,
    // must not read as a broken plugin: thumbnails are decoration, and the
    // panel falls back to type icons on any rejection. One stable code keeps
    // that branch from string-matching whatever the host happened to say.
    bb.log.warn(`could not create a preview URL for ${dir}: ${String(error)}`);
    throw fmError("unsupported", "previews are not available on this server");
  }

  return { baseUrl: preview.baseUrl, path: dir, expiresAtMs: preview.expiresAtMs };
}
