// lib/preview.ts — which entries the gallery tries to paint, and how a file
// name becomes a URL. Both are pure, and both are the kind of rule that only a
// table of awkward names can prove right.
import { describe, expect, it } from "vitest";

import type { FileEntry } from "../../contract";
import { isImageEntry, isImageName, previewUrl } from "../../lib/preview";
import { isTextViewerKind, isViewableEntry, isUrlViewerKind, viewerKindFor, viewerKindForEntry } from "../../lib/viewer";

function entry(partial: Partial<FileEntry> & { name: string }): FileEntry {
  return {
    name: partial.name,
    path: partial.path ?? `/home/coder/${partial.name}`,
    kind: partial.kind ?? "file",
    targetKind: partial.targetKind ?? null,
    sizeBytes: 10,
    modifiedAtMs: 0,
    isHidden: partial.name.startsWith("."),
    isSymlink: partial.isSymlink ?? false,
    escapesRoot: partial.escapesRoot ?? false,
    archiveFormat: partial.archiveFormat ?? null,
  };
}

describe("isImageName", () => {
  it.each([
    "a.png", "a.APNG", "a.JPG", "a.jpeg", "a.jpe", "a.jfif",
    "a.gif", "a.webp", "a.avif", "a.bmp", "a.ICO", "a.svg",
  ])("accepts %s", (name) => {
    expect(isImageName(name)).toBe(true);
  });

  it.each([
    // Images a browser will not decode: fetching them would cost the bytes and
    // fall back to the icon anyway.
    "a.tiff",
    "a.heic",
    "a.psd",
    "a.txt",
    "archive.zip",
    // No extension at all, and a dotfile whose "extension" is the whole name.
    "Makefile",
    ".png",
  ])("rejects %s", (name) => {
    expect(isImageName(name)).toBe(false);
  });

  it("reads the last extension of a double-barrelled name", () => {
    expect(isImageName("logo.svg.png")).toBe(true);
    expect(isImageName("logo.png.txt")).toBe(false);
  });
});

describe("isImageEntry", () => {
  it("takes a plain image file", () => {
    expect(isImageEntry(entry({ name: "shot.png" }))).toBe(true);
  });

  it("takes a symlink that points at a file, like every other view does", () => {
    expect(
      isImageEntry(entry({ name: "shot.png", kind: "symlink", isSymlink: true, targetKind: "file" })),
    ).toBe(true);
  });

  it("refuses a directory named like an image", () => {
    expect(isImageEntry(entry({ name: "sprites.png", kind: "directory" }))).toBe(false);
  });

  it("refuses a link that leaves the root — nothing reads through those", () => {
    expect(
      isImageEntry(
        entry({
          name: "shot.png",
          kind: "symlink",
          isSymlink: true,
          targetKind: "file",
          escapesRoot: true,
        }),
      ),
    ).toBe(false);
  });
});

describe("previewUrl", () => {
  it("appends one segment", () => {
    expect(previewUrl("https://bb.test/p/tok", "shot.png")).toBe("https://bb.test/p/tok/shot.png");
  });

  it("does not double the separator when the base already ends in one", () => {
    expect(previewUrl("https://bb.test/p/tok/", "shot.png")).toBe("https://bb.test/p/tok/shot.png");
  });

  it("encodes each segment but keeps the separators", () => {
    expect(previewUrl("https://bb.test/p/tok", "my photos/a b.png")).toBe(
      "https://bb.test/p/tok/my%20photos/a%20b.png",
    );
  });

  it("encodes the characters that would otherwise end the path", () => {
    // `#`, `?` and `%` are legal in a POSIX file name and fatal in a raw URL.
    expect(previewUrl("https://bb.test/p/tok", "a#b?c%d.png")).toBe(
      "https://bb.test/p/tok/a%23b%3Fc%25d.png",
    );
  });

  it("answers the base itself for an empty relative path", () => {
    expect(previewUrl("https://bb.test/p/tok", "")).toBe("https://bb.test/p/tok");
  });
});

// ---------------------------------------------------------------------------
// lib/viewer.ts — which renderer the built-in viewer reaches for (§8.12).
// ---------------------------------------------------------------------------

describe("viewerKindFor", () => {
  it.each(["page.HTML", "page.htm", "page.xhtml"])("reads %s as an HTML document", (name) => {
    const kind = viewerKindFor(name);
    expect(kind).toBe("html");
    expect(isTextViewerKind(kind)).toBe(true);
    expect(isUrlViewerKind(kind)).toBe(false);
  });

  it.each([
    ["shot.PNG", "image"], ["spinner.apng", "image"], ["app.ico", "image"],
    ["photo.jpe", "image"], ["photo.JFIF", "image"], ["scan.svg", "image"],
    ["manual.PDF", "pdf"], ["clip.MP4", "video"], ["clip.webm", "video"],
    ["song.mp3", "audio"], ["song.flac", "audio"], ["song.ogg", "audio"],
  ])("uses the browser URL renderer for %s", (name, expected) => {
    const kind = viewerKindFor(name);
    expect(kind).toBe(expected);
    expect(isUrlViewerKind(kind)).toBe(true);
  });

  it("keeps markdown apart, so it can be rendered as a document", () => {
    expect(viewerKindFor("README.md")).toBe("markdown");
    expect(viewerKindFor("notes.markdown")).toBe("markdown");
    expect(viewerKindFor("page.mdx")).toBe("markdown");
  });

  it("sends everything else to the text branch, extension or not", () => {
    // `text` is a question for the server, not a claim about the file — which
    // is the only way these four ever open.
    for (const name of ["Makefile", "LICENSE", ".gitignore", "server.ts", "data.csv", "data.json"]) {
      expect(viewerKindFor(name)).toBe("text");
    }
    // Including the ones that will come back "not text": guessing from the
    // name would only move the same answer earlier and get it wrong more often.
    expect(viewerKindFor("tool.bin")).toBe("text");
    expect(viewerKindFor("bundle.zip")).toBe("text");
  });

  it("leaves the containers a browser cannot play to the text branch", () => {
    // A `<video>` that paints a black rectangle is worse than the download
    // offer the text branch ends in.
    expect(viewerKindFor("film.mkv")).toBe("text");
    expect(viewerKindFor("old.avi")).toBe("text");
  });
});

describe("viewerKindForEntry", () => {
  it("opens a recognized local archive as its table of contents", () => {
    expect(viewerKindForEntry(entry({ name: "logs.tar.gz", archiveFormat: "tar.gz" }))).toBe("archive");
  });
});

describe("isViewableEntry", () => {
  it("takes files and symlinks to files, and nothing else", () => {
    expect(isViewableEntry(entry({ name: "a.txt" }))).toBe(true);
    expect(
      isViewableEntry(entry({ name: "link", isSymlink: true, kind: "symlink", targetKind: "file" })),
    ).toBe(true);
    expect(isViewableEntry(entry({ name: "docs", kind: "directory" }))).toBe(false);
    expect(isViewableEntry(entry({ name: "pipe", kind: "other" }))).toBe(false);
    expect(isViewableEntry(entry({ name: "out.txt", escapesRoot: true }))).toBe(false);
  });
});
