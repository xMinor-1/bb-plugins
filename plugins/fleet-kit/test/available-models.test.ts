// Copied from plugins/qlik-sense/test/available-models.test.ts (commit c0399a0). Keep in sync with qlik-sense.
import { describe, expect, it } from "vitest";
import { verifyAvailableModels as verify } from "../src/shared/available-models.js";

describe("available model guard", () => {
  it("accepts only a nonempty successful list of approved provider models", () => {
    expect(verify("company", 0, "company/fast\ncompany/family/large\n").state).toBe("verified");
    expect(verify("company,local", 0, "company/fast\r\nlocal/large\r\n").state).toBe("verified");
  });
  it("blocks external and built-in free providers even alongside approved models", () => {
    expect(verify("company", 0, "company/fast\nopencode/free\n").state).toBe("blocked");
    expect(verify("company", 0, "company/fast\nexternal/large\n").state).toBe("blocked");
  });
  it.each(["", "   ", "company", "Available models:\ncompany/fast", "company/fast\n\ncompany/large", "\x1b[32mcompany/fast\x1b[0m", '{"company":["fast"]}'])("blocks empty or ambiguous CLI output", (output) => {
    expect(verify("company", 0, output).state).toBe("blocked");
  });
  it("does not accept stdout from a failed or terminated command", () => {
    expect(verify("company", 1, "company/fast").state).toBe("blocked");
    expect(verify("company", null, "company/fast").state).toBe("blocked");
  });
  it("keeps personal unrestricted mode explicit", () => {
    expect(verify("", null, undefined)).toMatchObject({ state: "unrestricted", warning: expect.any(String) });
    expect(verify("*", 0, "company/fast").state).toBe("blocked");
  });
});
