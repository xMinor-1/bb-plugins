// The Windows store script goes to `powershell -Command -` on stdin, which reads line by
// line and runs a multi-line statement only after a blank line. Without the empty last
// line the script does not run, so nothing is saved or read.
import { describe, expect, it } from "vitest";
import { WINDOWS_CREDENTIAL_SCRIPT } from "../src/host/secret-store";

describe("the Windows credential script", () => {
  it("ends with an empty line", () => {
    expect(WINDOWS_CREDENTIAL_SCRIPT.endsWith("}\n\n")).toBe(true);
  });
});
