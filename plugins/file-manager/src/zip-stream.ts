// src/zip-stream.ts — several selected entries as one streamed zip (§5.3).
//
// Why a zip at all: a browser — and every phone — treats a burst of
// `<a download>` clicks as one download plus a list of things to block, so
// "download 5 files" quietly delivered one. A single response is the only
// multi-file download that works on every client.
//
// Why stored, not deflated: the exact byte length is known before the first
// byte is sent, so `Content-Length` survives and the browser can show real
// progress on a multi-GB archive. Photos, video and archives — what people
// actually pull off a server — do not shrink anyway.
//
// The layout is the streaming one: each local header carries zeros and bit 3,
// the CRC and sizes follow the data in a descriptor, and the central directory
// at the end holds the truth. ZIP64 fields appear only where a size, an offset
// or the entry count needs them.
import { createReadStream } from "node:fs";
import { readdir, realpath, stat } from "node:fs/promises";
import path from "node:path";
import zlib from "node:zlib";

import { fmError } from "./errors";
import { isInside, resolveExisting, resolveExistingDir } from "./root";

/** Files plus folders in one archive; a walk that finds more is refused. */
export const MAX_ZIP_ENTRIES = 20_000;

export interface ZipItem {
  /** Path inside the archive, `/`-separated, no trailing slash. */
  name: string;
  /** Absolute path to read; `null` for a folder entry. */
  source: string | null;
  size: number;
  mtime: Date;
  /** Unix mode bits, kept so executables stay executable after unzip. */
  mode: number;
}

/* ------------------------------------------------------------------ */
/* Collecting                                                          */
/* ------------------------------------------------------------------ */

/** `a/b.txt` → `["a", "b.txt"]`; anything that could climb out is refused. */
function splitRelative(name: string): string[] {
  const parts = name.split("/");
  for (const part of parts) {
    // eslint-disable-next-line no-control-regex -- deliberate: reject control chars
    if (part === "" || part === "." || part === ".." || /[\x00-\x1f]/u.test(part)) {
      throw fmError("invalid_name", name);
    }
  }
  return parts;
}

/**
 * Everything the archive will hold, in order. `names` are relative to `dir`
 * (what the panel sends); a folder brings its whole subtree.
 *
 * Inside a folder, a symlink to a file inside the root is packed as that
 * file, and any other link is left out: following directory links is how a
 * walk ends up in a loop or outside the root.
 */
export async function collectZipItems(dir: string, names: readonly string[]): Promise<ZipItem[]> {
  const base = await resolveExistingDir(dir);
  const items: ZipItem[] = [];
  const seen = new Set<string>();

  const push = (item: ZipItem): void => {
    if (seen.has(item.name)) return;
    if (items.length >= MAX_ZIP_ENTRIES) {
      throw fmError("unsupported", `more than ${String(MAX_ZIP_ENTRIES)} files and folders`);
    }
    seen.add(item.name);
    items.push(item);
  };

  const walk = async (absolute: string, prefix: string): Promise<void> => {
    let children;
    try {
      children = await readdir(absolute, { withFileTypes: true });
    } catch {
      // An unreadable subfolder stays in the archive, empty.
      return;
    }
    children.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
    for (const child of children) {
      const childPath = path.join(absolute, child.name);
      const childName = `${prefix}/${child.name}`;
      if (child.isSymbolicLink()) {
        try {
          const target = await realpath(childPath);
          if (!isInside(target)) continue;
          const st = await stat(target);
          if (st.isFile()) push({ name: childName, source: target, size: st.size, mtime: st.mtime, mode: st.mode });
        } catch {
          // Dangling link: nothing to pack.
        }
        continue;
      }
      if (!child.isFile() && !child.isDirectory()) continue;
      let st;
      try {
        st = await stat(childPath);
      } catch {
        continue;
      }
      if (child.isDirectory()) {
        push({ name: childName, source: null, size: 0, mtime: st.mtime, mode: st.mode });
        await walk(childPath, childName);
      } else {
        push({ name: childName, source: childPath, size: st.size, mtime: st.mtime, mode: st.mode });
      }
    }
  };

  for (const name of names) {
    const parts = splitRelative(name);
    const absolute = await resolveExisting(path.join(base, ...parts));
    const st = await stat(absolute);
    const archiveName = parts.join("/");
    if (st.isDirectory()) {
      push({ name: archiveName, source: null, size: 0, mtime: st.mtime, mode: st.mode });
      await walk(absolute, archiveName);
    } else if (st.isFile()) {
      push({ name: archiveName, source: absolute, size: st.size, mtime: st.mtime, mode: st.mode });
    }
    // Sockets, fifos, devices: there are no bytes to hand over.
  }
  return items;
}

/* ------------------------------------------------------------------ */
/* Layout                                                              */
/* ------------------------------------------------------------------ */

const MAX32 = 0xffffffff;
const MAX16 = 0xffff;
const FLAGS = 0x0808; // bit 3: sizes in the descriptor; bit 11: UTF-8 names
const MADE_BY = (3 << 8) | 45; // Unix, spec 4.5

const LOCAL_HEADER = 30;
const CENTRAL_HEADER = 46;
const ZIP64_EXTRA = 28; // tag + size + uncompressed + compressed + offset
const EOCD = 22;
const ZIP64_EOCD = 56;
const ZIP64_LOCATOR = 20;

interface Placed {
  item: ZipItem;
  nameBytes: Buffer;
  offset: number;
  /** The size needs 64 bits: descriptor and header versions follow. */
  bigSize: boolean;
  /** Anything in the central record needs the ZIP64 extra field. */
  bigRecord: boolean;
}

interface Layout {
  placed: Placed[];
  centralOffset: number;
  centralSize: number;
  zip64End: boolean;
  totalBytes: number;
}

function archiveName(item: ZipItem): Buffer {
  return Buffer.from(item.source === null ? `${item.name}/` : item.name, "utf8");
}

function layout(items: readonly ZipItem[]): Layout {
  const placed: Placed[] = [];
  let offset = 0;
  for (const item of items) {
    const nameBytes = archiveName(item);
    const bigSize = item.size >= MAX32;
    placed.push({ item, nameBytes, offset, bigSize, bigRecord: bigSize || offset >= MAX32 });
    offset += LOCAL_HEADER + nameBytes.length + item.size + (bigSize ? 24 : 16);
  }
  const centralOffset = offset;
  let centralSize = 0;
  for (const entry of placed) {
    centralSize += CENTRAL_HEADER + entry.nameBytes.length + (entry.bigRecord ? ZIP64_EXTRA : 0);
  }
  const zip64End = placed.length >= MAX16 || centralOffset >= MAX32 || centralSize >= MAX32;
  const totalBytes =
    centralOffset + centralSize + (zip64End ? ZIP64_EOCD + ZIP64_LOCATOR : 0) + EOCD;
  return { placed, centralOffset, centralSize, zip64End, totalBytes };
}

/** The exact length `zipStream` will produce for these items. */
export function zipLength(items: readonly ZipItem[]): number {
  return layout(items).totalBytes;
}

/* ------------------------------------------------------------------ */
/* Records                                                             */
/* ------------------------------------------------------------------ */

/** MS-DOS time and date, local time, 2-second resolution, floor at 1980. */
function dosDateTime(date: Date): { time: number; date: number } {
  const year = date.getFullYear();
  if (year < 1980) return { time: 0, date: (1 << 5) | 1 };
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2),
    date: ((Math.min(year, 2107) - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  };
}

function localHeader(entry: Placed): Buffer {
  const { time, date } = dosDateTime(entry.item.mtime);
  const header = Buffer.alloc(LOCAL_HEADER);
  header.writeUInt32LE(0x04034b50, 0);
  header.writeUInt16LE(entry.bigSize ? 45 : 20, 4);
  header.writeUInt16LE(FLAGS, 6);
  header.writeUInt16LE(0, 8); // stored
  header.writeUInt16LE(time, 10);
  header.writeUInt16LE(date, 12);
  // CRC and both sizes stay zero: they follow in the descriptor.
  header.writeUInt16LE(entry.nameBytes.length, 26);
  return Buffer.concat([header, entry.nameBytes]);
}

function descriptor(entry: Placed, crc: number): Buffer {
  const size = entry.item.size;
  if (entry.bigSize) {
    const record = Buffer.alloc(24);
    record.writeUInt32LE(0x08074b50, 0);
    record.writeUInt32LE(crc, 4);
    record.writeBigUInt64LE(BigInt(size), 8);
    record.writeBigUInt64LE(BigInt(size), 16);
    return record;
  }
  const record = Buffer.alloc(16);
  record.writeUInt32LE(0x08074b50, 0);
  record.writeUInt32LE(crc, 4);
  record.writeUInt32LE(size, 8);
  record.writeUInt32LE(size, 12);
  return record;
}

function centralHeader(entry: Placed, crc: number): Buffer {
  const { item, nameBytes, offset, bigRecord } = entry;
  const { time, date } = dosDateTime(item.mtime);
  const folder = item.source === null;
  const record = Buffer.alloc(CENTRAL_HEADER + nameBytes.length + (bigRecord ? ZIP64_EXTRA : 0));
  record.writeUInt32LE(0x02014b50, 0);
  record.writeUInt16LE(MADE_BY, 4);
  record.writeUInt16LE(bigRecord ? 45 : 20, 6);
  record.writeUInt16LE(FLAGS, 8);
  record.writeUInt16LE(0, 10);
  record.writeUInt16LE(time, 12);
  record.writeUInt16LE(date, 14);
  record.writeUInt32LE(crc, 16);
  record.writeUInt32LE(bigRecord ? MAX32 : item.size, 20);
  record.writeUInt32LE(bigRecord ? MAX32 : item.size, 24);
  record.writeUInt16LE(nameBytes.length, 28);
  record.writeUInt16LE(bigRecord ? ZIP64_EXTRA : 0, 30);
  // Comment length, disk number, internal attributes: all zero.
  record.writeUInt32LE((((item.mode & 0xffff) << 16) | (folder ? 0x10 : 0)) >>> 0, 38);
  record.writeUInt32LE(bigRecord ? MAX32 : offset, 42);
  nameBytes.copy(record, CENTRAL_HEADER);
  if (bigRecord) {
    const extra = CENTRAL_HEADER + nameBytes.length;
    record.writeUInt16LE(0x0001, extra);
    record.writeUInt16LE(ZIP64_EXTRA - 4, extra + 2);
    record.writeBigUInt64LE(BigInt(item.size), extra + 4);
    record.writeBigUInt64LE(BigInt(item.size), extra + 12);
    record.writeBigUInt64LE(BigInt(offset), extra + 20);
  }
  return record;
}

function endRecords(plan: Layout): Buffer {
  const count = plan.placed.length;
  const parts: Buffer[] = [];
  if (plan.zip64End) {
    const zip64End = Buffer.alloc(ZIP64_EOCD);
    zip64End.writeUInt32LE(0x06064b50, 0);
    zip64End.writeBigUInt64LE(BigInt(ZIP64_EOCD - 12), 4);
    zip64End.writeUInt16LE(MADE_BY, 12);
    zip64End.writeUInt16LE(45, 14);
    // Disk numbers at 16 and 20 stay zero.
    zip64End.writeBigUInt64LE(BigInt(count), 24);
    zip64End.writeBigUInt64LE(BigInt(count), 32);
    zip64End.writeBigUInt64LE(BigInt(plan.centralSize), 40);
    zip64End.writeBigUInt64LE(BigInt(plan.centralOffset), 48);
    const locator = Buffer.alloc(ZIP64_LOCATOR);
    locator.writeUInt32LE(0x07064b50, 0);
    locator.writeBigUInt64LE(BigInt(plan.centralOffset + plan.centralSize), 8);
    locator.writeUInt32LE(1, 16);
    parts.push(zip64End, locator);
  }
  const end = Buffer.alloc(EOCD);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Math.min(count, MAX16), 8);
  end.writeUInt16LE(Math.min(count, MAX16), 10);
  end.writeUInt32LE(Math.min(plan.centralSize, MAX32), 12);
  end.writeUInt32LE(Math.min(plan.centralOffset, MAX32), 16);
  parts.push(end);
  return Buffer.concat(parts);
}

/* ------------------------------------------------------------------ */
/* Streaming                                                           */
/* ------------------------------------------------------------------ */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    table[index] = value >>> 0;
  }
  return table;
})();

/** Node ≥ 22.2 has a native one; the table is for anything older. */
const nativeCrc32 = (zlib as { crc32?: (data: Uint8Array, value?: number) => number }).crc32;

function crc32(data: Uint8Array, previous: number): number {
  if (nativeCrc32 !== undefined) return nativeCrc32(data, previous);
  let crc = ~previous >>> 0;
  for (const byte of data) crc = (CRC_TABLE[(crc ^ byte) & 0xff] ?? 0) ^ (crc >>> 8);
  return ~crc >>> 0;
}

/**
 * The archive, chunk by chunk. A file that changed size since
 * `collectZipItems` looked at it ends the stream with an error: the length
 * was promised in `Content-Length`, and a truncated zip that claims to be
 * whole is worse than a download the browser marks as failed.
 */
export async function* zipStream(items: readonly ZipItem[]): AsyncGenerator<Buffer> {
  const plan = layout(items);
  const crcs: number[] = [];
  for (const entry of plan.placed) {
    yield localHeader(entry);
    let crc = 0;
    let read = 0;
    const { source, size } = entry.item;
    if (source !== null && size > 0) {
      for await (const chunk of createReadStream(source, { start: 0, end: size - 1 })) {
        const bytes = chunk as Buffer;
        crc = crc32(bytes, crc);
        read += bytes.length;
        yield bytes;
      }
    }
    if (read !== size) {
      throw new Error(`${entry.item.name} changed while it was being zipped`);
    }
    crcs.push(crc);
    yield descriptor(entry, crc);
  }
  yield Buffer.concat(plan.placed.map((entry, index) => centralHeader(entry, crcs[index] ?? 0)));
  yield endRecords(plan);
}
