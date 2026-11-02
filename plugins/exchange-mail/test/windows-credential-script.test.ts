// The Windows store script goes to `powershell -Command -` on stdin, which reads line by
// line and runs a multi-line statement only after a blank line. Without the empty last
// line the script does not run, so nothing is saved or read.
import { describe, expect, it } from "vitest";
import { WINDOWS_CREDENTIAL_SCRIPT } from "../src/host/secret-store";

describe("the Windows credential script", () => {
  // Readers decode stdout as UTF-8, but Console.Out encodes with the OEM code page: a password with
  // non-Latin letters came back as question marks on real Windows PowerShell 5.1.
  it("writes the value as UTF-8 bytes, not through the console encoding", () => {
    expect(WINDOWS_CREDENTIAL_SCRIPT).toContain("[Text.Encoding]::UTF8.GetBytes($v)");
    expect(WINDOWS_CREDENTIAL_SCRIPT).not.toContain("[Console]::Out.Write($v)");
  });

  it("ends with an empty line", () => {
    expect(WINDOWS_CREDENTIAL_SCRIPT.endsWith("}\n\n")).toBe(true);
  });

  it("has the switch that does the work as its last statement", () => {
    expect(WINDOWS_CREDENTIAL_SCRIPT.trimEnd().endsWith("default { exit 2 }\n}")).toBe(true);
  });
});
