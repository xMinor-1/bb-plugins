// components/UsagePage.tsx — the Usage page: what the limits went on.
//
// Two halves, and they are not the same kind of truth.
//
// The top half is the same summary the Claude Code extension for VS Code
// shows: the same sliding windows (last 24h, last 7d), the same weighted-cost
// formula, the same five behaviours, the same thresholds and the same
// sentences. If the two disagree by a percentage point it is because the
// windows slid, not because the arithmetic differs.
//
// The bottom half is ours and has no counterpart there: workflow runs and
// background /go runs with their real figures, skills with how often they ran
// and how heavy their instructions are, projects and bb threads. Those numbers
// are token counts, not weighted cost, and the headings say so — mixing the two
// units silently would be the one thing that makes the whole page untrustworthy.
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { useBbNavigate, useRpc, type PluginNavPanelProps } from "@get-bb/plugin-sdk/app";

import type { rpcContract, UsageState } from "../server";
// Types only, and it has to stay that way: usage-scan.ts reads the file system
// and imports node: modules, so one runtime binding taken from it would drag the
// whole scanner into the browser bundle.
import type {
  AttributionRow,
  BehaviorKey,
  GoRunBucket,
  SkillBucket,
  UNRESOLVED_THREAD_KEY,
  UsageBucket,
  UsageSummary,
  WorkflowBucket,
} from "../usage-scan";
import {
  PANEL_PATH,
  SHORT_LABEL,
  hasFigures,
  labelKey,
  percentOf,
  resetText,
  staleLine,
  statusLine,
} from "../lib/limits";
import {
  clock,
  compactNumber,
  dateTime,
  duration,
  exactNumber,
  kilobytes,
  projectLabel,
  sharePercent,
  splitTail,
} from "../lib/format";
import {
  ATTRIBUTION_EMPTY_HINT,
  ATTRIBUTION_EMPTY_TITLE,
  ATTRIBUTION_MAX_ROWS,
  ATTRIBUTION_TEXT,
  ATTRIBUTION_VALUE_HEADER,
  BEHAVIOR_TEXT,
  LOADING_TEXT,
  SCOPE_DISCLAIMER,
  SECTION_TITLE,
  moreText,
  nothingOverText,
  windowDisclaimer,
  type AttributionGroup,
} from "../lib/insight-text";
import { Caption, Card, Cell, Empty, Meter, Percent, Stat, Table, toneOf } from "./ui";
import { UsageChart } from "./UsageChart";

/**
 * The scanner's key for the sessions no bb thread was found for. Spelled out
 * rather than imported, because importing the constant itself would be a runtime
 * import of the scanner; the annotation is the link — the scanner's own literal
 * type, so renaming the key there stops this file from compiling.
 */
const UNRESOLVED_THREAD: typeof UNRESOLVED_THREAD_KEY = "unresolved";

/** How often the page refreshes itself once the figures are complete. */
const POLL_MS = 60_000;
/** While the first pass over the transcripts runs, the numbers still grow. */
const COLD_POLL_MS = 2_000;
/** After a failed call — often enough to recover, rare enough to stay quiet. */
const RETRY_MS = 15_000;

type Period = "day" | "week";

/** The period lives in the URL, so a link to a window survives a reload. */
function periodOf(subPath: string): Period {
  return subPath.split("/")[0] === "week" ? "week" : "day";
}

export function UsagePage({ subPath }: PluginNavPanelProps): ReactNode {
  const rpc = useRpc<typeof rpcContract>();
  const navigate = useBbNavigate();
  const period = periodOf(subPath);

  const [summary, setSummary] = useState<UsageSummary | null>(null);
  const [limits, setLimits] = useState<UsageState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);

  // useRpc hands back a fresh object every render; keeping it in a ref stops
  // the effect below from restarting on every one of them.
  const rpcRef = useRef(rpc);
  rpcRef.current = rpc;

  useEffect(() => {
    let alive = true;
    let timer = 0;
    const tick = async (): Promise<void> => {
      try {
        const [next, state] = await Promise.all([
          rpcRef.current.call("usage", { window: period }),
          rpcRef.current.call("state", null),
        ]);
        if (!alive) return;
        setSummary(next);
        setLimits(state);
        setError(null);
        // A cold scan is still finding calls, so the figures below keep moving:
        // come back in a couple of seconds instead of a minute.
        timer = window.setTimeout(() => void tick(), next.scan.cold ? COLD_POLL_MS : POLL_MS);
      } catch (failure) {
        if (!alive) return;
        setError(failure instanceof Error ? failure.message : String(failure));
        timer = window.setTimeout(() => void tick(), RETRY_MS);
      }
    };
    void tick();
    return () => {
      alive = false;
      window.clearTimeout(timer);
    };
  }, [period, nonce]);

  const toPeriod = useCallback(
    (next: Period) => navigate.toPluginPanel(PANEL_PATH, { subPath: next }),
    [navigate],
  );

  return (
    <div className="h-full overflow-y-auto p-4 md:p-5">
      {/*
        The page is a panel, not a window: bb gives it whatever width is left
        after the sidebar and the right panel, and that is nothing like the
        viewport. Every breakpoint below is therefore a container query — a
        `md:` here would lay five figures out in a row inside a 450-pixel panel
        just because the screen behind it happens to be 1440 wide.
      */}
      <div className="@container mx-auto w-full max-w-3xl space-y-4">
        <div className="flex flex-wrap items-center gap-2">
          <div
            role="group"
            aria-label="Usage window"
            className="inline-flex gap-0.5 rounded-md border border-border p-0.5"
          >
            <PeriodButton current={period} value="day" label="Day" onPick={toPeriod} />
            <PeriodButton current={period} value="week" label="Week" onPick={toPeriod} />
          </div>
          <button
            type="button"
            onClick={() => setNonce((value) => value + 1)}
            className="rounded-md border border-border px-2.5 py-1 text-sm text-muted-foreground hover:text-foreground"
          >
            Refresh
          </button>
          {summary === null ? null : (
            <span className="ml-auto text-xs text-muted-foreground">
              Updated {clock(new Date(summary.generatedAt))}
            </span>
          )}
        </div>

        {error === null ? null : (
          <Card title="Could not load the usage figures">
            <Caption>{error}</Caption>
          </Card>
        )}

        <LimitsCard state={limits} />

        {summary === null ? (
          <Card>
            <Empty>{LOADING_TEXT}</Empty>
          </Card>
        ) : (
          <>
            <ScanCard summary={summary} />
            <OverviewCard summary={summary} />
            <BehaviorsCard summary={summary} period={period} />
            <AttributionCard summary={summary} />
            <SkillsCard skills={summary.bySkill} total={summary.bucketCounts.skill} />
            <ProcessesCard summary={summary} />
            <ProjectsCard summary={summary} />
            <Caption>
              Read from {summary.scan.files} local transcript files ·{" "}
              {exactNumber(summary.scan.calls)} deduplicated calls in the cache · a call answered in
              several parts is counted once.
            </Caption>
          </>
        )}
      </div>
    </div>
  );
}

function PeriodButton({
  current,
  value,
  label,
  onPick,
}: {
  current: Period;
  value: Period;
  label: string;
  onPick: (value: Period) => void;
}): ReactNode {
  const active = current === value;
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={() => onPick(value)}
      className={`rounded-[5px] px-2.5 py-1 text-sm ${
        active ? "bg-muted text-foreground" : "text-muted-foreground hover:text-foreground"
      }`}
    >
      {label}
    </button>
  );
}

/** The live limits — the same figures the sidebar rings show. */
function LimitsCard({ state }: { state: UsageState | null }): ReactNode {
  const figures = hasFigures(state);
  const status = statusLine(state);
  return (
    <Card
      title="Plan limits"
      hint={
        state?.planLabel || state?.accountEmail ? (
          <span>
            {state?.planLabel ?? ""}
            {state?.planLabel && state?.accountEmail ? " · " : ""}
            {state?.accountEmail ?? ""}
          </span>
        ) : undefined
      }
    >
      {!state || (state.status !== "ok" && !figures) ? (
        <Empty>
          <span title={status.title ?? undefined}>{status.text}</span>
        </Empty>
      ) : (
        <>
          <div className="space-y-2">
            {state.windows.map((limit) => {
              const percent = percentOf(limit);
              const tone = toneOf(percent);
              return (
                <div key={limit.label} className="flex items-center gap-3">
                  <span
                    className="w-24 flex-none truncate text-sm text-foreground"
                    title={limit.label}
                  >
                    {SHORT_LABEL[labelKey(limit.label)] ?? limit.label}
                  </span>
                  <Meter value={percent ?? 0} tone={tone} className="min-w-0 flex-1" />
                  <span className="w-10 flex-none text-right text-sm">
                    <Percent value={`${Math.round(limit.usedPercent)}%`} tone={tone} />
                  </span>
                  <span className="w-28 flex-none truncate text-right text-xs text-muted-foreground">
                    {resetText(limit.resetsAt)}
                  </span>
                </div>
              );
            })}
          </div>
          {state.status === "ok" ? null : (
            <Caption>
              <span title={staleLine(state).title ?? undefined}>{staleLine(state).text}</span>
            </Caption>
          )}
        </>
      )}
    </Card>
  );
}

/** Shown only while the first pass over the transcripts is still running. */
function ScanCard({ summary }: { summary: UsageSummary }): ReactNode {
  const scan = summary.scan;
  if (scan.error !== null) {
    return (
      <Card title="The transcript scan failed">
        <Caption>{scan.error}</Caption>
      </Card>
    );
  }
  if (!scan.cold) return null;
  return (
    <Card
      title="Reading local transcripts…"
      hint={`${scan.filesDone} of ${scan.filesTotal} files · the figures below cover what has been read so far`}
    >
      <Meter value={scan.percent} />
    </Card>
  );
}

/** The window at a glance, plus the chart. */
function OverviewCard({ summary }: { summary: UsageSummary }): ReactNode {
  const sessions = summary.sessions;
  return (
    <Card
      title="Usage over the window"
      hint={`${dateTime(summary.window.from)} — ${dateTime(summary.window.to)}`}
    >
      <div className="mb-3 grid grid-cols-2 gap-3 @sm:grid-cols-3 @2xl:grid-cols-5">
        <Stat
          label="Tokens"
          value={compactNumber(summary.totals.total)}
          title={exactNumber(summary.totals.total)}
          hint={`${compactNumber(summary.totals.output)} out`}
        />
        <Stat
          label="Calls"
          value={exactNumber(summary.totals.calls)}
          hint={`${exactNumber(summary.totals.toolCalls)} tool uses`}
        />
        <Stat label="Sessions" value={exactNumber(sessions.count)} hint={`peak ${sessions.concurrencyPeak} at once`} />
        <Stat
          label="Context"
          value={compactNumber(sessions.contextMedian)}
          hint={`p90 ${compactNumber(sessions.contextP90)}`}
          title="Median input context per call: cache reads, cache writes and uncached input — the same sum the “>150k context” statement is measured against"
        />
        <Stat
          label="Cache reads"
          value={sharePercent(summary.totals.total > 0 ? summary.totals.cacheRead / summary.totals.total : 0)}
          hint={`${compactNumber(summary.totals.cacheCreation)} written`}
        />
      </div>
      <UsageChart timeline={summary.timeline} />
    </Card>
  );
}

/** What the count of a behaviour actually counts. */
function countText(key: BehaviorKey, count: number): string {
  const sessions = key === "subagent_heavy" || key === "cron";
  const noun = sessions ? "session" : "request";
  return `${exactNumber(count)} ${noun}${count === 1 ? "" : "s"}`;
}

/** One statement: the claim, the advice under it, the count on the right. */
function Statement({
  claim,
  advice,
  count,
}: {
  claim: string;
  advice: string;
  count?: string;
}): ReactNode {
  return (
    <li className="flex items-start justify-between gap-3">
      <div className="min-w-0">
        <p className="text-sm text-foreground">{claim}</p>
        <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">{advice}</p>
      </div>
      {count === undefined ? null : (
        <span className="flex-none whitespace-nowrap pt-0.5 text-xs tabular-nums text-muted-foreground">
          {count}
        </span>
      )}
    </li>
  );
}

/**
 * The behaviours and the top attribution claims — the part of the page that is
 * the extension's summary, word for word.
 */
function BehaviorsCard({
  summary,
  period,
}: {
  summary: UsageSummary;
  period: Period;
}): ReactNode {
  const insights = summary.insights;
  const gate = insights.minBehaviorPct;
  const behaviors = insights.behaviors.filter((behavior) => behavior.rawPct >= gate);
  const groups: Array<[AttributionGroup, AttributionRow[]]> = [
    ["skills", insights.skills],
    ["agents", insights.agents],
    ["plugins", insights.plugins],
    ["mcp_servers", insights.mcpServers],
  ];
  const claims = groups
    .map(([group, rows]) => ({ group, top: rows[0] }))
    .filter((entry): entry is { group: AttributionGroup; top: AttributionRow } => {
      return entry.top !== undefined && entry.top.pct >= gate;
    });

  return (
    <Card
      title={SECTION_TITLE}
      hint={
        <>
          <span className="block">{SCOPE_DISCLAIMER}</span>
          <span className="block">{windowDisclaimer(period)}</span>
        </>
      }
    >
      {behaviors.length === 0 && claims.length === 0 ? (
        <Empty>{nothingOverText(gate)}</Empty>
      ) : (
        <ul className="space-y-3">
          {behaviors.map((behavior) => (
            <Statement
              key={behavior.key}
              claim={BEHAVIOR_TEXT[behavior.key].claim(behavior.pct)}
              advice={BEHAVIOR_TEXT[behavior.key].advice}
              count={countText(behavior.key, behavior.count)}
            />
          ))}
          {claims.map(({ group, top }) => (
            <Statement
              key={group}
              claim={ATTRIBUTION_TEXT[group].claim(top.pct, top.name)}
              advice={ATTRIBUTION_TEXT[group].advice}
            />
          ))}
        </ul>
      )}
    </Card>
  );
}

/**
 * A long name that keeps its tail. The cell clips from the right, so a plain
 * ellipsis eats exactly the segment that tells three sibling folders apart:
 * three different env_* directories all come out as "…/personal-worksp…". The
 * head is dimmed and allowed to shrink, the last segment never does.
 */
function Name({ value }: { value: string }): ReactNode {
  const { head, tail } = splitTail(value);
  if (!head) return <span className="block truncate">{value}</span>;
  return (
    <span className="flex min-w-0 items-baseline">
      <span className="truncate text-muted-foreground">{head}</span>
      <span className="max-w-full flex-none truncate">{tail}</span>
    </span>
  );
}

/**
 * A table that owns up to its own tail. Every breakdown on this page is cut to
 * a row limit by the backend, and a table that stops at twelve rows without
 * saying so reads as the complete list — which is how a thirteenth project
 * carrying two per cent of the week goes unnoticed.
 */
function TrimmedTable({
  head,
  widths,
  shown,
  total,
  children,
}: {
  head: ReactNode[];
  widths?: Array<string | undefined>;
  /** Rows actually drawn. */
  shown: number;
  /** Rows the breakdown had before the cut. */
  total: number;
  children: ReactNode;
}): ReactNode {
  const rest = Math.max(0, total - shown);
  return (
    <div>
      <Table head={head} widths={widths}>
        {children}
      </Table>
      {rest > 0 ? <Caption>{moreText(rest)}</Caption> : null}
    </div>
  );
}

/** One attribution table: top rows by share, the rest as a single line. */
function AttributionTable({
  group,
  rows,
}: {
  group: AttributionGroup;
  rows: AttributionRow[];
}): ReactNode {
  const text = ATTRIBUTION_TEXT[group];
  const shown = rows.slice(0, ATTRIBUTION_MAX_ROWS);
  return (
    <TrimmedTable
      head={[text.title, ATTRIBUTION_VALUE_HEADER]}
      widths={[undefined, "28%"]}
      shown={shown.length}
      total={rows.length}
    >
      {shown.map((row) => (
        <tr key={row.name}>
          <Cell first title={row.name}>
            <Name value={text.label(row.name)} />
          </Cell>
          <Cell>{row.pct}%</Cell>
        </tr>
      ))}
    </TrimmedTable>
  );
}

function AttributionCard({ summary }: { summary: UsageSummary }): ReactNode {
  const insights = summary.insights;
  const groups: Array<[AttributionGroup, AttributionRow[]]> = [
    ["skills", insights.skills],
    ["agents", insights.agents],
    ["plugins", insights.plugins],
    ["mcp_servers", insights.mcpServers],
  ];
  const filled = groups.filter(([, rows]) => rows.length > 0);
  if (filled.length === 0) {
    return (
      <Card title={ATTRIBUTION_EMPTY_TITLE}>
        <Empty>{ATTRIBUTION_EMPTY_HINT}</Empty>
      </Card>
    );
  }
  return (
    <Card
      title={ATTRIBUTION_EMPTY_TITLE}
      hint="Claude Code's own attribution. Shares are of the same weighted cost as the statements above, so one call can appear in several tables."
    >
      <div className="grid gap-x-6 gap-y-3 @xl:grid-cols-2">
        {filled.map(([group, rows]) => (
          <AttributionTable key={group} group={group} rows={rows} />
        ))}
      </div>
    </Card>
  );
}

/** Our own skill figures: how often each ran, and what it drags into context. */
function SkillsCard({ skills, total }: { skills: SkillBucket[]; total: number }): ReactNode {
  return (
    <Card
      title="Skills"
      hint="Runs are counted from the transcripts; tokens are the calls Claude Code attributes to the skill itself. The instruction body it injects keeps costing after that, so the real footprint is larger."
    >
      {skills.length === 0 ? (
        <Empty>No skills ran in this window.</Empty>
      ) : (
        // The order is the backend's, by the same tokens this table prints, and
        // it is left alone: re-sorting here would leave the "… N more" line
        // below counting a tail that was cut by a different rule than the one
        // the rows are shown in.
        <TrimmedTable
          head={["Skill", "Runs", "Instructions", "Tokens", "% of tokens"]}
          widths={[undefined, "10%", "18%", "15%", "17%"]}
          shown={skills.length}
          total={total}
        >
          {skills.map((row) => (
            <tr key={row.skill}>
              <Cell first title={row.skill}>
                <Name value={`/${row.skill}`} />
              </Cell>
              <Cell muted>{exactNumber(row.invocations)}</Cell>
              <Cell
                muted
                title={
                  row.injections > 0
                    ? `${row.injections} injections of the instruction body`
                    : "The instruction body was not injected in this window"
                }
              >
                {kilobytes(row.injectedBytes)}
              </Cell>
              {/*
                A skill Claude Code attributed no call to gets a dash, not a
                zero: "0" claims a measurement, while what happened is that the
                run left no attributed call in this window at all.
              */}
              <Cell
                title={
                  row.reported.total > 0
                    ? exactNumber(row.reported.total)
                    : "No call in this window carries this skill's name"
                }
              >
                {row.reported.total > 0 ? compactNumber(row.reported.total) : "—"}
              </Cell>
              <Cell muted>{row.reported.total > 0 ? sharePercent(row.reportedShare) : "—"}</Cell>
            </tr>
          ))}
        </TrimmedTable>
      )}
    </Card>
  );
}

/** Workflow runs and background /go runs — the figures the extension has not got. */
function ProcessesCard({ summary }: { summary: UsageSummary }): ReactNode {
  const workflows: WorkflowBucket[] = summary.byWorkflow;
  const runs: GoRunBucket[] = summary.byGoRun;
  if (workflows.length === 0 && runs.length === 0) {
    return (
      <Card title="Processes">
        <Empty>No workflow runs and no background runs in this window.</Empty>
      </Card>
    );
  }
  return (
    <Card
      title="Processes"
      hint="Workflow runs and background /go runs, by tokens. Agents, duration and status come from the run's own metadata."
    >
      <div className="space-y-4">
        {workflows.length === 0 ? null : (
          <TrimmedTable
            head={["Workflow run", "Agents", "Tokens", "Took", "Status"]}
            widths={[undefined, "11%", "15%", "13%", "17%"]}
            shown={workflows.length}
            total={summary.bucketCounts.workflow}
          >
            {workflows.map((run) => (
              <tr key={run.key}>
                <Cell first title={`${run.workflowName ?? run.runId} · ${dateTime(run.startedAt)}`}>
                  <span className="flex min-w-0 items-baseline">
                    <span className="truncate text-foreground">
                      {run.workflowName ?? run.runId}
                    </span>
                    <span className="flex-none text-muted-foreground">
                      &nbsp;· {dateTime(run.startedAt)}
                    </span>
                  </span>
                </Cell>
                <Cell muted>{run.agentCount === null ? "—" : run.agentCount}</Cell>
                <Cell title={exactNumber(run.totals.total)}>
                  {compactNumber(run.totals.total)}
                </Cell>
                <Cell muted>{duration(run.durationMs)}</Cell>
                <Cell muted title={run.status ?? undefined}>
                  {run.status ?? "—"}
                </Cell>
              </tr>
            ))}
          </TrimmedTable>
        )}
        {runs.length === 0 ? null : (
          <TrimmedTable
            head={["Background run", "Model", "Tokens", "Took", "Exit"]}
            widths={[undefined, "16%", "15%", "13%", "10%"]}
            shown={runs.length}
            total={summary.bucketCounts.goRun}
          >
            {runs.map((run) => (
              <tr key={run.key}>
                <Cell first title={`${run.name} · ${run.dir ?? ""}`}>
                  <span className="flex min-w-0 items-baseline">
                    <span className="truncate text-foreground">{run.name}</span>
                    <span className="flex-none text-muted-foreground">
                      &nbsp;· {dateTime(run.startedAt)}
                    </span>
                  </span>
                </Cell>
                <Cell muted title={run.model ?? undefined}>
                  {(run.model ?? "—").replace(/^claude-/, "")}
                </Cell>
                <Cell title={exactNumber(run.totals.total)}>
                  {compactNumber(run.totals.total)}
                </Cell>
                <Cell muted>{duration(runLength(run))}</Cell>
                <Cell muted>{run.exitCode === null ? "running" : run.exitCode}</Cell>
              </tr>
            ))}
          </TrimmedTable>
        )}
      </div>
    </Card>
  );
}

/** How long a background run took; null while it is still running. */
function runLength(run: GoRunBucket): number | null {
  if (!run.startedAt || !run.finishedAt) return null;
  const from = Date.parse(run.startedAt);
  const to = Date.parse(run.finishedAt);
  if (Number.isNaN(from) || Number.isNaN(to) || to < from) return null;
  return to - from;
}

/** A row with a share bar behind the numbers. */
function ShareRow({
  label,
  title,
  bucket,
}: {
  /**
   * Plain text truncates from the right, which is what a thread title wants —
   * a title identifies itself by how it starts. A path is passed as `<Name>`
   * instead, so it keeps its last segment.
   */
  label: ReactNode;
  title: string;
  bucket: UsageBucket;
}): ReactNode {
  return (
    <tr>
      <Cell first title={title}>
        {label}
      </Cell>
      <Cell title={exactNumber(bucket.totals.total)}>
        {compactNumber(bucket.totals.total)}
      </Cell>
      <Cell>
        {/* The bar keeps its own width on a wide table: a 200-pixel meter next
            to a two-digit percentage reads as decoration, not as a figure. */}
        <span className="ml-auto flex max-w-[7rem] items-center gap-2">
          <Meter value={bucket.share * 100} className="min-w-0 flex-1" />
          <span className="w-9 flex-none text-right text-xs text-muted-foreground">
            {sharePercent(bucket.share)}
          </span>
        </span>
      </Cell>
    </tr>
  );
}

/** Where the tokens went: folders, models, and bb threads where they are known. */
function ProjectsCard({ summary }: { summary: UsageSummary }): ReactNode {
  const unresolved = summary.unresolvedThreadShare;
  const unresolvedShown = summary.byThread.some(
    (bucket) => bucket.key === UNRESOLVED_THREAD,
  );
  if (summary.byProject.length === 0 && summary.byThread.length === 0) {
    return (
      <Card title="Projects and threads">
        <Empty>No usage recorded in this window.</Empty>
      </Card>
    );
  }
  return (
    <Card
      title="Projects and threads"
      hint="Tokens by working folder and by bb thread. A session is tied to a thread through bb's own events, which do not live long — older sessions stay unattributed."
    >
      <div className="space-y-4">
        {/* The folder column carries long paths; the model column carries "opus-5". */}
        <div className="grid gap-x-6 gap-y-3 @xl:grid-cols-[3fr_2fr]">
          <TrimmedTable
            head={["Project", "Tokens", "Share"]}
            widths={[undefined, "22%", "30%"]}
            shown={summary.byProject.length}
            total={summary.bucketCounts.project}
          >
            {summary.byProject.map((bucket) => (
              <ShareRow
                key={bucket.key}
                label={<Name value={projectLabel(bucket.key, bucket.label)} />}
                title={projectLabel(bucket.key, bucket.label)}
                bucket={bucket}
              />
            ))}
          </TrimmedTable>
          <TrimmedTable
            head={["Model", "Tokens", "Share"]}
            widths={[undefined, "22%", "30%"]}
            shown={summary.byModel.length}
            total={summary.bucketCounts.model}
          >
            {summary.byModel.map((bucket) => (
              <ShareRow
                key={bucket.key}
                label={bucket.label.replace(/^claude-/, "")}
                title={bucket.label}
                bucket={bucket}
              />
            ))}
          </TrimmedTable>
        </div>
        {summary.byThread.length === 0 ? (
          <Empty>No bb threads could be tied to these sessions.</Empty>
        ) : (
          <TrimmedTable
            head={["bb thread", "Tokens", "Share"]}
            widths={[undefined, "22%", "30%"]}
            shown={summary.byThread.length}
            total={summary.bucketCounts.thread}
          >
            {summary.byThread.map((bucket) => (
              <ShareRow key={bucket.key} label={bucket.label} title={bucket.label} bucket={bucket} />
            ))}
          </TrimmedTable>
        )}
        {/*
          Unattributed sessions are a bucket of their own ("Without a bb
          thread"), so the figure is normally a row in the table above. It needs
          a sentence only when that row did not survive the cut — otherwise the
          shares on screen quietly leave out the largest slice of all.
        */}
        {unresolved > 0 && !unresolvedShown ? (
          <Caption>{sharePercent(unresolved)} of the tokens could not be tied to a bb thread.</Caption>
        ) : null}
      </div>
    </Card>
  );
}
