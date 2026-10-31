// The Qlik Sense mark: a pie chart with one slice pulled out. bb's own icon set
// has no pie chart, and its column chart is taken by another plugin.
export const ICON = "QlikChartPie";

export function ChartPie({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M11 4a9 9 0 1 0 9 9h-9z" />
      <path d="M14 1.5a8.5 8.5 0 0 1 8.5 8.5H14z" />
    </svg>
  );
}
