import { describe, expect, it } from "vitest";
import { disallowedModels, LadderError, nextModel, parseLadders } from "../src/shared/ladder";
import { createPolicy, parseRules } from "../src/shared/policy";

const policy = createPolicy(parseRules("acp-opencode corp/*"));

describe("parseLadders", () => {
  it("reads one ladder per line and skips comments", () => {
    const ladders = parseLadders("# coder first\nacp-opencode corp/coder > corp/daily > corp/fast\n\n");
    expect(ladders).toEqual([{ provider: "acp-opencode", models: ["corp/coder", "corp/daily", "corp/fast"] }]);
  });

  it("refuses a ladder of one model, a repeated model and junk", () => {
    expect(() => parseLadders("acp-opencode corp/coder")).toThrow(LadderError);
    expect(() => parseLadders("acp-opencode corp/a > corp/a")).toThrow(LadderError);
    expect(() => parseLadders("acp-opencode corp/a > ")).toThrow(LadderError);
    expect(() => parseLadders("acp-opencode corp/a > corp/b;rm")).toThrow(LadderError);
    expect(() => parseLadders("acp-opencode corp/* > corp/b")).toThrow(LadderError);
  });
});

describe("nextModel", () => {
  const ladders = parseLadders("acp-opencode corp/coder > corp/daily > corp/fast\nacp-opencode corp/vision > corp/vision-thinking");

  it("goes one step down the ladder that names the model", () => {
    expect(nextModel(ladders, policy, "acp-opencode", "corp/coder")).toBe("corp/daily");
    expect(nextModel(ladders, policy, "acp-opencode", "corp/daily")).toBe("corp/fast");
    expect(nextModel(ladders, policy, "acp-opencode", "corp/vision")).toBe("corp/vision-thinking");
  });

  it("has nothing after the last model, for other providers or unknown models", () => {
    expect(nextModel(ladders, policy, "acp-opencode", "corp/fast")).toBeNull();
    expect(nextModel(ladders, policy, "codex", "corp/coder")).toBeNull();
    expect(nextModel(ladders, policy, "acp-opencode", "corp/other")).toBeNull();
  });

  it("never returns a model outside the allowed list", () => {
    const mixed = parseLadders("acp-opencode corp/coder > public/big > corp/fast");
    expect(disallowedModels(mixed, policy)).toEqual(["acp-opencode public/big"]);
    expect(nextModel(mixed, policy, "acp-opencode", "corp/coder")).toBe("corp/fast");
    expect(nextModel(mixed, createPolicy([]), "acp-opencode", "corp/coder")).toBeNull();
  });
});
