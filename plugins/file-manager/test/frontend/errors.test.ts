// @vitest-environment jsdom
import { describe, expect, it } from "vitest";

import {
  FileManagerRpcError,
  batchFailureText,
  describeErrorCode,
  errorToastText,
  isFileManagerErrorCode,
  parseRpcError,
  toFileManagerError,
  toastText,
} from "../../lib/errors";

describe("parseRpcError", () => {
  it("splits '<code>: <message>' on the first separator only", () => {
    const parsed = parseRpcError(new Error("not_found: /home/coder/gone: really"));
    expect(parsed.code).toBe("not_found");
    expect(parsed.message).toBe("/home/coder/gone: really");
    expect(parsed.rawMessage).toBe("not_found: /home/coder/gone: really");
  });

  it("recognizes every code in the frozen enum", () => {
    for (const code of ["path_escape", "exists", "not_empty", "no_space", "unsupported"] as const) {
      expect(parseRpcError(new Error(`${code}: x`)).code).toBe(code);
    }
  });

  it("leaves an unknown prefix alone", () => {
    const parsed = parseRpcError(new Error("something bad: happened"));
    expect(parsed.code).toBeNull();
    expect(parsed.message).toBe("something bad: happened");
  });

  it("accepts a bare code, a string, and a plain object", () => {
    expect(parseRpcError("permission_denied").code).toBe("permission_denied");
    expect(parseRpcError({ message: "exists: /home/coder/a" }).code).toBe("exists");
    expect(parseRpcError({ code: "handler_error", message: "io_error: disk" }).wireCode).toBe(
      "handler_error",
    );
  });

  it("survives null, undefined and non-error throws", () => {
    expect(parseRpcError(null)).toEqual({
      code: null,
      message: "",
      rawMessage: "",
      wireCode: null,
    });
    expect(parseRpcError(undefined).code).toBeNull();
    expect(parseRpcError(42).message).toBe("42");
  });

  it("keeps the host's transport code out of the domain code", () => {
    const parsed = parseRpcError({ code: "invalid_input", message: "Invalid input" });
    expect(parsed.code).toBeNull();
    expect(parsed.wireCode).toBe("invalid_input");
  });
});

describe("toFileManagerError", () => {
  it("carries the code onto the Error instance", () => {
    const error = toFileManagerError(new Error("exists: /home/coder/a.txt"));
    expect(error).toBeInstanceOf(FileManagerRpcError);
    expect(error.code).toBe("exists");
    expect(error.message).toBe("/home/coder/a.txt");
    expect(error.rawMessage).toBe("exists: /home/coder/a.txt");
  });

  it("is idempotent and re-parses to the same shape", () => {
    const once = toFileManagerError(new Error("not_a_directory: /home/coder/a.txt"));
    expect(toFileManagerError(once)).toBe(once);
    expect(parseRpcError(once).code).toBe("not_a_directory");
  });
});

describe("toast text", () => {
  it("prefers the friendly sentence for a known code", () => {
    expect(errorToastText(new Error("path_escape: /etc"))).toBe(
      "That path is outside the file manager root.",
    );
    expect(toastText).toBe(errorToastText);
  });

  it("falls back to the server message, then to the fallback", () => {
    expect(errorToastText(new Error("the socket died"))).toBe("the socket died");
    expect(errorToastText(new Error(""), "Upload failed.")).toBe("Upload failed.");
  });

  it("has a sentence for every code", () => {
    expect(describeErrorCode("upload_busy")).toMatch(/in flight/u);
    expect(isFileManagerErrorCode("offset_mismatch")).toBe(true);
    expect(isFileManagerErrorCode("handler_error")).toBe(false);
  });
});

describe("batchFailureText", () => {
  it("is null when nothing failed", () => {
    expect(batchFailureText([])).toBeNull();
  });

  it("names the first failure and counts the rest", () => {
    expect(
      batchFailureText([{ path: "/home/coder/a.txt", code: "exists", message: "x" }]),
    ).toBe("a.txt: An item with that name already exists.");
    expect(
      batchFailureText(
        [
          { path: "/home/coder/a.txt", code: "permission_denied", message: "x" },
          { path: "/home/coder/b.txt", code: "not_found", message: "y" },
        ],
        "move",
      ),
    ).toBe("2 items failed to move. a.txt: Permission denied.");
  });
});
