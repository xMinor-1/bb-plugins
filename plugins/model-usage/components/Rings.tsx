// The footer button's icon: Claude Code's session (outer ring) and week
// (inner ring), as Usage Meter drew them; a dot when a per-model weekly limit
// passes the warning mark. Without Claude Code figures — a plain chart glyph.
import type { ReactNode } from "react";
import { claudeRings, useStore } from "../lib/store";
import { DANGER, WARN } from "./kit";

const colour = (p: number) => (p > DANGER ? "var(--color-destructive, #dc2626)" : p >= WARN ? "#f59e0b" : "currentColor");

function Ring({ r, value, width }: { r: number; value: number; width: number }): ReactNode {
  const length = 2 * Math.PI * r;
  const filled = (Math.max(0, Math.min(100, value)) / 100) * length;
  return (
    <>
      <circle cx="12" cy="12" r={r} fill="none" stroke="currentColor" strokeOpacity={0.18} strokeWidth={width} />
      {filled > 0 ? (
        <circle
          cx="12"
          cy="12"
          r={r}
          fill="none"
          stroke={colour(value)}
          strokeWidth={width}
          strokeLinecap="round"
          strokeDasharray={`${filled} ${length}`}
          transform="rotate(-90 12 12)"
        />
      ) : null}
    </>
  );
}

export function RingsIcon({ className }: { className?: string }): ReactNode {
  const { limits } = useStore();
  const rings = claudeRings(limits);
  if (!rings) {
    return (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" className={className} aria-hidden>
        <path d="M4 20V4M4 20h16M8 16v-5M12 16V8M16 16v-3" />
      </svg>
    );
  }
  return (
    <svg viewBox="0 0 24 24" className={className} aria-hidden>
      <Ring r={10} value={rings.session} width={2.6} />
      <Ring r={5.6} value={rings.week} width={2.6} />
      {rings.extra >= WARN ? <circle cx="20.5" cy="3.5" r="2.6" fill={colour(rings.extra)} /> : null}
    </svg>
  );
}
