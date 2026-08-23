// PATHBAR-SPEC §4 / §9.1 — everything the path bar makes of what you paste,
// with no DOM and no panel. `lib/fm-pathbar.ts` is the whole of the bar's
// judgement, so the table below is the specification of that judgement:
// cleanup (quotes, escapes, `file://`, multi-line), resolution (`~` is
// root-relative, everything else relative resolves against the folder *on
// screen*), and the root check that happens here rather than over the wire.
//
// Two invariants are asserted throughout rather than in one place:
//   * a refusal message never contains a literal home path — it is built from
//     `rootPhrase(root)` of the root the caller passed in (SPEC trap: the hard
//     root is homedir(), not "/home/coder");
//   * `parsePathInput` never needs the module-level `clientRoot`: this file
//     never calls `setClientRoot`, so any accidental dependency on it would
//     resolve against "/" and fail here.
import { describe, expect, it } from "vitest";

import {
  outsideRootMessage,
  parsePathInput,
  splitForCompletion,
  windowsPathMessage,
  PATH_INVALID_MESSAGE,
  PATH_REMOTE_MESSAGE,
  PATH_SCHEME_MESSAGE,
  type PathInputContext,
} from "../../lib/fm-pathbar";
import { rootPhrase } from "../../lib/fm-paths";

const ROOT = "/home/coder";
const CURRENT = `${ROOT}/projects`;
const CONTEXT: PathInputContext = { root: ROOT, currentPath: CURRENT };

/** A second host with a different home: the trap this plugin keeps re-breaking. */
const OTHER_ROOT = "/Users/ada";
const OTHER_CONTEXT: PathInputContext = { root: OTHER_ROOT, currentPath: `${OTHER_ROOT}/work` };

function absoluteOf(raw: string, context: PathInputContext = CONTEXT): string {
  const result = parsePathInput(raw, context);
  expect(result.kind).toBe("path");
  return result.kind === "path" ? result.absolute : "";
}

function refusalOf(raw: string, context: PathInputContext = CONTEXT): string {
  const result = parsePathInput(raw, context);
  expect(result.kind).toBe("refused");
  return result.kind === "refused" ? result.message : "";
}

describe("parsePathInput — absolute and `~` (§4.2)", () => {
  it("keeps an absolute path inside the root", () => {
    expect(absoluteOf(`${ROOT}/docs/notes`)).toBe(`${ROOT}/docs/notes`);
  });

  it("treats `~`, `~/` and `~/x` as root-relative", () => {
    expect(absoluteOf("~")).toBe(ROOT);
    expect(absoluteOf("~/")).toBe(ROOT);
    expect(absoluteOf("~/docs")).toBe(`${ROOT}/docs`);
    expect(absoluteOf("~/docs/notes")).toBe(`${ROOT}/docs/notes`);
  });

  it("resolves `~` against the root the caller passed, not a module default", () => {
    expect(absoluteOf("~/work", OTHER_CONTEXT)).toBe(`${OTHER_ROOT}/work`);
  });
});

describe("parsePathInput — relative resolves against the folder on screen (§4.2)", () => {
  it("joins a bare name, `./` and a nested path to currentPath", () => {
    expect(absoluteOf("docs")).toBe(`${CURRENT}/docs`);
    expect(absoluteOf("./docs")).toBe(`${CURRENT}/docs`);
    expect(absoluteOf("sub/deep")).toBe(`${CURRENT}/sub/deep`);
  });

  it("walks up with `..` while it stays inside the root", () => {
    expect(absoluteOf("../pics")).toBe(`${ROOT}/pics`);
    expect(absoluteOf("..")).toBe(ROOT);
  });

  it("refuses `..` that would leave the root", () => {
    expect(refusalOf("..", { root: ROOT, currentPath: ROOT })).toBe(outsideRootMessage(ROOT));
    expect(refusalOf("../..")).toBe(outsideRootMessage(ROOT));
  });

  it("is not the same answer as the `~` form — the whole point of §4.2", () => {
    expect(absoluteOf("docs")).toBe(`${CURRENT}/docs`);
    expect(absoluteOf("~/docs")).toBe(`${ROOT}/docs`);
    expect(absoluteOf("docs")).not.toBe(absoluteOf("~/docs"));
  });

  it("collapses separators, `.` and `..` inside the value", () => {
    expect(absoluteOf("docs/")).toBe(`${CURRENT}/docs`);
    expect(absoluteOf("docs//x")).toBe(`${CURRENT}/docs/x`);
    expect(absoluteOf("docs/./x")).toBe(`${CURRENT}/docs/x`);
    expect(absoluteOf("docs/../pics")).toBe(`${CURRENT}/pics`);
    expect(absoluteOf(`${ROOT}/docs/`)).toBe(`${ROOT}/docs`);
    expect(absoluteOf(`${ROOT}//docs///x/`)).toBe(`${ROOT}/docs/x`);
  });
});

describe("parsePathInput — cleanup (§4.1)", () => {
  it("trims surrounding whitespace and a trailing newline", () => {
    expect(absoluteOf(`  ${ROOT}/a  `)).toBe(`${ROOT}/a`);
    expect(absoluteOf(`${ROOT}/a\n`)).toBe(`${ROOT}/a`);
    expect(absoluteOf(`${ROOT}/a\r\n`)).toBe(`${ROOT}/a`);
  });

  it("takes the first non-empty line of a multi-line paste", () => {
    expect(absoluteOf(`\n\n  ${ROOT}/a  \n${ROOT}/b\n`)).toBe(`${ROOT}/a`);
  });

  it("strips one matched pair of wrapping quotes and keeps the spaces", () => {
    expect(absoluteOf(`"${ROOT}/My File.txt"`)).toBe(`${ROOT}/My File.txt`);
    expect(absoluteOf(`'${ROOT}/My File.txt'`)).toBe(`${ROOT}/My File.txt`);
  });

  it("un-escapes `\\ ` only in an unquoted value that really has one", () => {
    expect(absoluteOf(`${ROOT}/My\\ File.txt`)).toBe(`${ROOT}/My File.txt`);
    // Quoted: a backslash is a legal POSIX name character and stays put.
    expect(absoluteOf(`"${ROOT}/a\\b"`)).toBe(`${ROOT}/a\\b`);
    // Unquoted but with no escaped space anywhere: also left alone.
    expect(absoluteOf(`${ROOT}/a\\b/c`)).toBe(`${ROOT}/a\\b/c`);
  });

  it("decodes a `file://` URL, including percent escapes", () => {
    expect(absoluteOf(`file://${ROOT}/a%20b`)).toBe(`${ROOT}/a b`);
    expect(absoluteOf(`file://localhost${ROOT}/a`)).toBe(`${ROOT}/a`);
  });

  it("never percent-decodes a plain path — `%` is a legal file name character", () => {
    expect(absoluteOf(`${ROOT}/100%20done.txt`)).toBe(`${ROOT}/100%20done.txt`);
  });

  it("returns `empty` for nothing at all", () => {
    expect(parsePathInput("", CONTEXT)).toEqual({ kind: "empty" });
    expect(parsePathInput("   ", CONTEXT)).toEqual({ kind: "empty" });
    expect(parsePathInput("\n\n", CONTEXT)).toEqual({ kind: "empty" });
    expect(parsePathInput("file://", CONTEXT)).toEqual({ kind: "empty" });
  });
});

describe("parsePathInput — refusals (§4.1, §4.3)", () => {
  it("refuses a Windows path with the Windows wording", () => {
    expect(refusalOf("C:\\Users\\me")).toBe(windowsPathMessage(ROOT));
    expect(refusalOf("c:/Users/me")).toBe(windowsPathMessage(ROOT));
    expect(refusalOf("\\\\server\\share")).toBe(windowsPathMessage(ROOT));
    expect(refusalOf("Users\\me\\Desktop")).toBe(windowsPathMessage(ROOT));
    expect(refusalOf(`file:///C:/Users/me`)).toBe(windowsPathMessage(ROOT));
  });

  it("refuses a `file://` URL that names another computer", () => {
    expect(refusalOf("file://server/share")).toBe(PATH_REMOTE_MESSAGE);
  });

  it("refuses any other scheme", () => {
    expect(refusalOf("https://example.com/x")).toBe(PATH_SCHEME_MESSAGE);
    expect(refusalOf("smb://nas/share")).toBe(PATH_SCHEME_MESSAGE);
    expect(refusalOf("data:text/plain,hi")).toBe(PATH_SCHEME_MESSAGE);
  });

  it("refuses control characters and NUL without a round trip", () => {
    expect(refusalOf(`${ROOT}/a\u0000b`)).toBe(PATH_INVALID_MESSAGE);
    expect(refusalOf(`${ROOT}/a\u0007b`)).toBe(PATH_INVALID_MESSAGE);
    expect(refusalOf(`${ROOT}/a\u007Fb`)).toBe(PATH_INVALID_MESSAGE);
  });

  it("refuses an absolute path outside the root", () => {
    expect(refusalOf("/")).toBe(outsideRootMessage(ROOT));
    expect(refusalOf("/etc/passwd")).toBe(outsideRootMessage(ROOT));
    expect(refusalOf("/home/coderx/notes")).toBe(outsideRootMessage(ROOT));
    expect(refusalOf(`${ROOT}/../coder2`)).toBe(outsideRootMessage(ROOT));
  });

  it("builds every refusal from the caller's root, never from a literal home", () => {
    const messages = [
      refusalOf("/etc/passwd", OTHER_CONTEXT),
      refusalOf("C:\\Users\\me", OTHER_CONTEXT),
      refusalOf("..", { root: OTHER_ROOT, currentPath: OTHER_ROOT }),
    ];
    for (const message of messages) {
      expect(message).toContain(rootPhrase(OTHER_ROOT));
      expect(message).not.toContain(ROOT);
      expect(message).not.toContain("/home/");
    }
    // And the message really is a function of the root, not a constant.
    expect(outsideRootMessage(OTHER_ROOT)).not.toBe(outsideRootMessage(ROOT));
    expect(windowsPathMessage(OTHER_ROOT)).not.toBe(windowsPathMessage(ROOT));
  });

  it("falls back to words while the root is still unknown", () => {
    // Before the bootstrap the client root is "/", and "outside /" is a lie in
    // every direction — `rootPhrase` says "the home folder" instead.
    expect(outsideRootMessage("/")).toContain("the home folder");
    expect(outsideRootMessage("/")).not.toContain(ROOT);
  });
});

describe("splitForCompletion — the §6 seam", () => {
  it("splits a `~` path into the directory to list and the typed prefix", () => {
    expect(splitForCompletion("~/pro", CONTEXT)).toEqual({ dir: ROOT, prefix: "pro" });
    expect(splitForCompletion("~/projects/", CONTEXT)).toEqual({
      dir: `${ROOT}/projects`,
      prefix: "",
    });
  });

  it("splits an absolute and a relative path", () => {
    expect(splitForCompletion(`${ROOT}/docs/no`, CONTEXT)).toEqual({
      dir: `${ROOT}/docs`,
      prefix: "no",
    });
    expect(splitForCompletion("doc", CONTEXT)).toEqual({ dir: CURRENT, prefix: "doc" });
    expect(splitForCompletion("sub/de", CONTEXT)).toEqual({
      dir: `${CURRENT}/sub`,
      prefix: "de",
    });
  });

  it("has nothing to complete for empty, refused or out-of-root input", () => {
    expect(splitForCompletion("", CONTEXT)).toBeNull();
    expect(splitForCompletion("   ", CONTEXT)).toBeNull();
    expect(splitForCompletion("C:\\Users\\me", CONTEXT)).toBeNull();
    expect(splitForCompletion("/etc/pas", CONTEXT)).toBeNull();
  });
});
