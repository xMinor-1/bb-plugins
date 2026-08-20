// @vitest-environment jsdom
import { describe, expect, it } from "vitest";

import {
  UNKNOWN,
  etaFromRate,
  formatBytes,
  formatCount,
  formatDuration,
  formatEta,
  formatExactBytes,
  formatModified,
  formatPercent,
  formatRelativeTime,
  formatSpeed,
  progressRatio,
} from "../../lib/format";

const KIB = 1024;
const MIB = 1024 * KIB;
const GIB = 1024 * MIB;

describe("formatBytes", () => {
  it("keeps whole bytes below 1 KB", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(1)).toBe("1 B");
    expect(formatBytes(1023)).toBe("1023 B");
  });

  it("switches unit at every 1024 boundary and trims a trailing .0", () => {
    expect(formatBytes(KIB)).toBe("1 KB");
    expect(formatBytes(1536)).toBe("1.5 KB");
    expect(formatBytes(MIB)).toBe("1 MB");
    expect(formatBytes(5 * GIB)).toBe("5 GB");
    expect(formatBytes(1024 * GIB)).toBe("1 TB");
  });

  it("drops the decimal past 100 of a unit", () => {
    expect(formatBytes(234 * MIB)).toBe("234 MB");
    expect(formatBytes(12.34 * MIB)).toBe("12.3 MB");
  });

  it("renders nonsense as the unknown placeholder", () => {
    expect(formatBytes(Number.NaN)).toBe(UNKNOWN);
    expect(formatBytes(-1)).toBe(UNKNOWN);
    expect(formatBytes(Number.POSITIVE_INFINITY)).toBe(UNKNOWN);
  });

  it("formats an exact count for tooltips", () => {
    expect(formatExactBytes(1048576)).toContain("bytes");
    expect(formatExactBytes(Number.NaN)).toBe(UNKNOWN);
  });
});

describe("formatSpeed", () => {
  it("suffixes the byte size", () => {
    expect(formatSpeed(12 * MIB)).toBe("12 MB/s");
  });

  it("treats a zero or unknown rate as unknown", () => {
    expect(formatSpeed(0)).toBe(UNKNOWN);
    expect(formatSpeed(Number.NaN)).toBe(UNKNOWN);
  });
});

describe("formatPercent / progressRatio", () => {
  it("rounds and clamps", () => {
    expect(formatPercent(0)).toBe("0%");
    expect(formatPercent(0.424)).toBe("42%");
    expect(formatPercent(1.5)).toBe("100%");
    expect(formatPercent(-1)).toBe("0%");
  });

  it("never divides by a zero total", () => {
    expect(progressRatio(0, 0)).toBe(0);
    expect(progressRatio(50, 100)).toBe(0.5);
    expect(progressRatio(500, 100)).toBe(1);
  });
});

describe("formatDuration / formatEta", () => {
  it("scales from seconds to days", () => {
    expect(formatDuration(0)).toBe("0s");
    expect(formatDuration(45_000)).toBe("45s");
    expect(formatDuration(125_000)).toBe("2m 5s");
    expect(formatDuration(120_000)).toBe("2m");
    expect(formatDuration(3 * 3600_000 + 10 * 60_000)).toBe("3h 10m");
    expect(formatDuration(2 * 86_400_000 + 4 * 3600_000)).toBe("2d 4h");
  });

  it("carries a rounded-up remainder instead of printing 60", () => {
    expect(formatDuration(59_700)).toBe("1m");
    expect(formatDuration(3_599_900)).toBe("1h");
  });

  it("renders an unknown eta as an empty string so the tray can skip it", () => {
    expect(formatEta(null)).toBe("");
    expect(formatEta(125_000)).toBe("2m 5s left");
    expect(formatDuration(null)).toBe(UNKNOWN);
  });

  it("derives an eta from a rate, and null when the rate is unknown", () => {
    expect(etaFromRate(10 * MIB, MIB)).toBe(10_000);
    expect(etaFromRate(10 * MIB, 0)).toBeNull();
    expect(etaFromRate(0, 0)).toBe(0);
  });
});

describe("dates", () => {
  const now = Date.parse("2026-03-12T15:00:00Z");

  it("describes recent timestamps relatively", () => {
    expect(formatRelativeTime(now - 5_000, now)).toBe("just now");
    expect(formatRelativeTime(now - 5 * 60_000, now)).toBe("5m ago");
    expect(formatRelativeTime(now - 3 * 3600_000, now)).toBe("3h ago");
    expect(formatRelativeTime(now - 3 * 86_400_000, now)).toBe("3d ago");
  });

  it("falls back to a date past a week", () => {
    const old = formatRelativeTime(now - 40 * 86_400_000, now);
    expect(old).not.toContain("ago");
    expect(old).not.toBe(UNKNOWN);
  });

  it("shows a time for today and a date otherwise", () => {
    const today = new Date(now);
    today.setHours(9, 30, 0, 0);
    expect(formatModified(today.getTime(), now)).toMatch(/\d/u);
    expect(formatModified(now - 400 * 86_400_000, now)).toMatch(/\d{4}/u);
    expect(formatModified(Number.NaN, now)).toBe(UNKNOWN);
  });
});

describe("formatCount", () => {
  it("pluralizes", () => {
    expect(formatCount(1, "item")).toBe("1 item");
    expect(formatCount(3, "item")).toBe("3 items");
    expect(formatCount(0, "entry", "entries")).toBe("0 entries");
  });
});
