import { describe, expect, it } from "vitest";
import { verifyEffectiveProviderPolicy as verify } from "../src/shared/provider-policy.js";

const statement = (effect: "allow" | "deny", resource: string) => ({ action: "provider.use", effect, resource });
const denyAll = statement("deny", "*");
const allowCompany = statement("allow", "company");

describe("effective provider restriction", () => {
  it("requires an explicit warning when the fleet restriction is off", () => {
    expect(verify("", undefined).state).toBe("unrestricted");
  });
  it("proves a deny-all with explicit approved exceptions", () => {
    expect(verify("company", [denyAll, allowCompany]).state).toBe("verified");
  });
  it("rejects a default model setting or provider declarations as proof", () => {
    expect(verify("company", { model: "company/model", providers: { company: {} } }).state).toBe("blocked");
    expect(verify("company", [allowCompany]).state).toBe("blocked");
  });
  it("rejects later external allows, including auto-discovered and wildcard providers", () => {
    for (const resource of ["external", "opencode", "*", "company-*", "company?"]) {
      expect(verify("company", [denyAll, allowCompany, statement("allow", resource)]).state).toBe("blocked");
    }
  });
  it("honors policy order instead of treating any deny as sufficient", () => {
    expect(verify("company", [statement("allow", "external"), denyAll, allowCompany]).state).toBe("verified");
    expect(verify("company", [denyAll, allowCompany, statement("allow", "external")]).state).toBe("blocked");
  });
  it("fails closed on malformed snapshots, malformed statements and invalid settings", () => {
    for (const policies of [undefined, null, {}, [null], [denyAll, { ...allowCompany, effect: "ALLOW" }]]) {
      expect(verify("company", policies).state).toBe("blocked");
    }
    expect(verify("*", [denyAll, allowCompany]).state).toBe("blocked");
  });
  it("does not confuse MCP permissions with provider restrictions", () => {
    expect(verify("company", [{ action: "mcp.use", effect: "deny", resource: "*" }]).state).toBe("blocked");
  });
});
