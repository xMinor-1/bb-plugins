// components/UsageChart.tsx — usage over the window, as bars.
//
// Hand-drawn SVG on purpose: a chart library costs the best part of a megabyte
// in the bundle for one bar chart, and this one has to draw exactly three
// stacked series and nothing else. Colours are opacities of the current text
// colour, so the chart works in any theme without naming a single colour.
import { useEffect, useRef, useState, type ReactNode } from "react";

import type { TimelinePoint, UsageTimeline } from "../usage-scan";
import { clock, compactNumber, duration, exactNumber, weekday } from "../lib/format";

/** Bar height of the plot area, in pixels. */
const PLOT_HEIGHT = 96;
/** Room under the plot for the time labels. */
const AXIS_HEIGHT = 16;
/** Gap between bars, in pixels; bars thinner than this lose it. */
const BAR_GAP = 2;
/** Opacity of each series — main session darkest, the deeper the lighter. */
const SERIES: Array<{ key: "main" | "workflow" | "subagent"; label: string; opacity: number }> = [
  { key: "main", label: "Main session", opacity: 0.75 },
  { key: "workflow", label: "Workflow agents", opacity: 0.45 },
  { key: "subagent", label: "Subagents", opacity: 0.22 },
];

/** Width of the element, so the bars land on whole pixels instead of stretching. */
function useWidth(): [React.RefObject<HTMLDivElement | null>, number] {
  const ref = useRef<HTMLDivElement | null>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) setWidth(entry.contentRect.width);
    });
    observer.observe(node);
    setWidth(node.getBoundingClientRect().width);
    return () => observer.disconnect();
  }, []);
  return [ref, width];
}

/** Every label would collide; keep about one per this many pixels. */
function labelStep(count: number, width: number): number {
  if (count === 0 || width === 0) return 1;
  return Math.max(1, Math.round((count * 56) / width));
}

/** A window longer than this gets day labels instead of clock times. */
const DAY_LABEL_SPAN_MS = 36 * 3_600_000;

/** Whether this bar opens a local day — the buckets are aligned to local time. */
function opensDay(ts: number): boolean {
  const at = new Date(ts);
  return at.getHours() === 0 && at.getMinutes() === 0;
}

export function UsageChart({ timeline }: { timeline: UsageTimeline }): ReactNode {
  const [ref, width] = useWidth();
  const points = timeline.points;
  const peak = points.reduce((top, point) => Math.max(top, point.total), 0);

  const plotWidth = Math.max(width, 1);
  const slot = plotWidth / Math.max(points.length, 1);
  const barWidth = Math.max(1, slot - (slot > 6 ? BAR_GAP : 0));
  const step = labelStep(points.length, plotWidth);
  // Over a week the useful marks are the days, not every sixth hour.
  const byDay = points.length * timeline.stepMs > DAY_LABEL_SPAN_MS;
  const labelled = (point: TimelinePoint, index: number): boolean =>
    byDay ? opensDay(point.ts) : index % step === 0;

  return (
    <div ref={ref} className="w-full">
      {width === 0 ? null : (
        <svg
          width={plotWidth}
          height={PLOT_HEIGHT + AXIS_HEIGHT}
          viewBox={`0 0 ${plotWidth} ${PLOT_HEIGHT + AXIS_HEIGHT}`}
          role="img"
          aria-label="Usage over the window"
          className="text-foreground"
        >
          {/* Baseline: without it an empty stretch reads as a broken chart. */}
          <line
            x1={0}
            y1={PLOT_HEIGHT + 0.5}
            x2={plotWidth}
            y2={PLOT_HEIGHT + 0.5}
            stroke="currentColor"
            strokeOpacity={0.15}
          />
          {points.map((point, index) => {
            const x = index * slot;
            const height = peak > 0 ? (point.total / peak) * (PLOT_HEIGHT - 2) : 0;
            // The grid is aligned to the clock and the window to "now", so the
            // first and the last bucket are cut by the window's own edges. They
            // are drawn as narrow as the time they actually cover: at full width
            // the newest bar always reads as a collapse in usage and the oldest
            // as a lull, which is an artefact of the slicing, not the figures.
            const covered = point.spanMs > 0 ? Math.min(1, point.spanMs / timeline.stepMs) : 1;
            const width = Math.max(1, barWidth * covered);
            let top = PLOT_HEIGHT;
            const parts: ReactNode[] = [];
            for (const series of SERIES) {
              const value = point[series.key];
              const part = point.total > 0 ? (value / point.total) * height : 0;
              if (part <= 0) continue;
              top -= part;
              parts.push(
                <rect
                  key={series.key}
                  x={x}
                  y={top}
                  width={width}
                  height={part}
                  fill="currentColor"
                  fillOpacity={series.opacity}
                />,
              );
            }
            const when = byDay ? `${weekday(point.ts)} ${clock(point.ts)}` : clock(point.ts);
            const partial =
              covered < 0.995
                ? ` · partial interval, ${duration(point.spanMs)} of ${duration(timeline.stepMs)}`
                : "";
            return (
              <g key={point.ts}>
                {parts}
                {/* An invisible full-height target, so hovering a short bar still works. */}
                <rect x={x} y={0} width={barWidth} height={PLOT_HEIGHT} fill="transparent">
                  <title>{`${when} · ${exactNumber(point.total)} tokens · ${point.calls} calls${partial}`}</title>
                </rect>
              </g>
            );
          })}
          {points.map((point, index) =>
            labelled(point, index) ? (
              <text
                key={`label-${point.ts}`}
                x={index * slot}
                y={PLOT_HEIGHT + AXIS_HEIGHT - 4}
                fill="currentColor"
                fillOpacity={0.55}
                fontSize={10}
              >
                {byDay ? weekday(point.ts) : clock(point.ts)}
              </text>
            ) : null,
          )}
        </svg>
      )}
      <div className="mt-1.5 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
        {SERIES.map((series) => (
          <span key={series.key} className="flex items-center gap-1.5">
            <span
              className="inline-block h-2 w-2 rounded-[2px] bg-foreground"
              style={{ opacity: series.opacity }}
            />
            {series.label}
          </span>
        ))}
        <span className="ml-auto" title={`One bar is ${duration(timeline.stepMs)}; the first and the last cover only the part of it that falls inside the window, and are drawn that narrow`}>
          Peak {compactNumber(peak)} tokens per {duration(timeline.stepMs)} bar
        </span>
      </div>
    </div>
  );
}
