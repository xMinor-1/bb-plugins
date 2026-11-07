// The tracker opens in the person's own browser, not in bb's built-in one.
import { describe, expect, it, vi } from "vitest";
import { openInOwnBrowser } from "../src/app/links";

const URL_ = "https://tracker.example.com/PAY-101";

describe("opening a task in the tracker", () => {
  it("uses the desktop app's external browser when there is one", () => {
    const openExternalUrl = vi.fn();
    const openUrl = vi.fn(() => true);
    expect(openInOwnBrowser(URL_, openUrl, { bbDesktop: { openExternalUrl } })).toBe(true);
    expect(openExternalUrl).toHaveBeenCalledWith(URL_);
    expect(openUrl).not.toHaveBeenCalled();
  });

  it("falls back to bb's openUrl in the web app and when the bridge fails", () => {
    const openUrl = vi.fn(() => true);
    expect(openInOwnBrowser(URL_, openUrl, {})).toBe(true);
    const broken = { openExternalUrl: () => { throw new Error("gone"); } };
    expect(openInOwnBrowser(URL_, openUrl, { bbDesktop: broken })).toBe(true);
    expect(openUrl).toHaveBeenCalledTimes(2);
  });

  it("opens nothing but http and https", () => {
    const openExternalUrl = vi.fn();
    const openUrl = vi.fn(() => true);
    expect(openInOwnBrowser("javascript:alert(1)", openUrl, { bbDesktop: { openExternalUrl } })).toBe(false);
    expect(openExternalUrl).not.toHaveBeenCalled();
    expect(openUrl).not.toHaveBeenCalled();
  });
});
