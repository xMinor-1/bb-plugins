import { describe, expect, it } from "vitest";
import { WEB_UI_SCRIPT, WEB_UI_TEXT } from "./web-ui";

describe("review controls in a live page", () => {
  it("is a script that parses, with the English texts built in", () => {
    expect(() => new Function("bb", WEB_UI_SCRIPT)).not.toThrow();
    expect(WEB_UI_SCRIPT).toContain(JSON.stringify(WEB_UI_TEXT));
  });
});
