// Claude Code activity: Usage Meter's page, section for section. The top half
// is the summary the Claude Code extension for VS Code shows (same windows,
// same weighted-cost formula, same five behaviours and sentences); the bottom
// half — skills, workflow and background runs, projects and bb threads — is
// counted in plain tokens, and the headings say so.
import type { ReactNode } from "react";
import type {
  AttributionRow,
  BehaviorKey,
  GoRunBucket,
  SkillBucket,
  UNRESOLVED_THREAD_KEY,
  UsageBucket,
  UsageSummary,
  WorkflowBucket,
} from "../src/claude/usage-scan";
import type { TokenWindow } from "../src/shared/types";
import { compactNumber, dateTime, duration, exactNumber, kilobytes, projectLabel, sharePercent, splitTail } from "../lib/format";
import { useLang, useMessages, type Lang } from "../lib/i18n";
import { messages, type Messages } from "../lib/messages";
import { Caption, Card, Cell, Empty, Meter, Stat, Table } from "./kit";
import { UsageChart } from "./UsageChart";

/** Spelled out: importing the scanner's constant would pull the scanner into the browser. */
const UNRESOLVED_THREAD: typeof UNRESOLVED_THREAD_KEY = "unresolved";
const ATTRIBUTION_MAX_ROWS = 8;
type Group = "skills" | "agents" | "plugins" | "mcp_servers";

export function ActivitySections({ summary, window }: { summary: UsageSummary; window: TokenWindow }): ReactNode {
  const t = useMessages(messages);
  const lang = useLang();
  return (
    <>
      <ScanCard summary={summary} />
      <OverviewCard summary={summary} />
      <BehaviorsCard summary={summary} window={window} />
      <AttributionCard summary={summary} />
      <SkillsCard skills={summary.bySkill} total={summary.bucketCounts.skill} />
      <ProcessesCard summary={summary} />
      <ProjectsCard summary={summary} />
      <Caption>{t.readFrom(summary.scan.files, exactNumber(summary.scan.calls, lang))}</Caption>
    </>
  );
}

function ScanCard({ summary }: { summary: UsageSummary }): ReactNode {
  const t = useMessages(messages);
  const scan = summary.scan;
  if (scan.error !== null) {
    return (
      <Card title={t.scanFailed}>
        <Caption>{scan.error}</Caption>
      </Card>
    );
  }
  if (!scan.cold) return null;
  return (
    <Card title={t.scanning} hint={t.scanningHint(scan.filesDone, scan.filesTotal)}>
      <Meter value={scan.percent} />
    </Card>
  );
}

function OverviewCard({ summary }: { summary: UsageSummary }): ReactNode {
  const t = useMessages(messages);
  const lang = useLang();
  const s = summary.sessions;
  return (
    <Card title={t.overviewTitle} hint={`${dateTime(summary.window.from, lang)} — ${dateTime(summary.window.to, lang)}`}>
      <div className="mb-3 grid grid-cols-[repeat(auto-fill,minmax(max(7.5rem,calc((100%-4*0.75rem)/5)),1fr))] gap-3">
        <Stat label={t.statTokens} value={compactNumber(summary.totals.total, lang)} title={exactNumber(summary.totals.total, lang)} hint={t.statOut(compactNumber(summary.totals.output, lang))} />
        <Stat label={t.statCalls} value={exactNumber(summary.totals.calls, lang)} hint={t.statTools(exactNumber(summary.totals.toolCalls, lang))} />
        <Stat label={t.statSessions} value={exactNumber(s.count, lang)} hint={t.statPeak(s.concurrencyPeak)} />
        <Stat label={t.statContext} value={compactNumber(s.contextMedian, lang)} hint={`p90 ${compactNumber(s.contextP90, lang)}`} title={t.statContextTitle} />
        <Stat
          label={t.statCache}
          value={sharePercent(summary.totals.total > 0 ? summary.totals.cacheRead / summary.totals.total : 0)}
          hint={t.statWritten(compactNumber(summary.totals.cacheCreation, lang))}
        />
      </div>
      <UsageChart timeline={summary.timeline} />
    </Card>
  );
}

function countText(key: BehaviorKey, count: number, t: Messages, lang: Lang): string {
  const n = exactNumber(count, lang);
  return key === "subagent_heavy" || key === "cron" ? t.countSessions(n, count === 1) : t.countRequests(n, count === 1);
}

function Statement({ claim, advice, count }: { claim: string; advice: string; count?: string }): ReactNode {
  return (
    <li className="flex items-start justify-between gap-3">
      <div className="min-w-0">
        <p className="text-sm text-foreground">{claim}</p>
        <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">{advice}</p>
      </div>
      {count === undefined ? null : <span className="flex-none whitespace-nowrap pt-0.5 text-xs tabular-nums text-muted-foreground">{count}</span>}
    </li>
  );
}

function attributionGroups(summary: UsageSummary): Array<[Group, AttributionRow[]]> {
  const i = summary.insights;
  return [
    ["skills", i.skills],
    ["agents", i.agents],
    ["plugins", i.plugins],
    ["mcp_servers", i.mcpServers],
  ];
}

function BehaviorsCard({ summary, window }: { summary: UsageSummary; window: TokenWindow }): ReactNode {
  const t = useMessages(messages);
  const lang = useLang();
  const gate = summary.insights.minBehaviorPct;
  const behaviors = summary.insights.behaviors.filter((b) => b.rawPct >= gate);
  const claims = attributionGroups(summary)
    .map(([group, rows]) => ({ group, top: rows[0] }))
    .filter((e): e is { group: Group; top: AttributionRow } => e.top !== undefined && e.top.pct >= gate);
  return (
    <Card
      title={t.sectionTitle}
      hint={
        <>
          <span className="block">{t.scopeDisclaimer}</span>
          <span className="block">{t.windowDisclaimer(t.windows[window])}</span>
        </>
      }
    >
      {behaviors.length === 0 && claims.length === 0 ? (
        <Empty>{t.nothingOver(gate)}</Empty>
      ) : (
        <ul className="space-y-3">
          {behaviors.map((b) => (
            <Statement key={b.key} claim={t.behavior[b.key].claim(b.pct)} advice={t.behavior[b.key].advice} count={countText(b.key, b.count, t, lang)} />
          ))}
          {claims.map(({ group, top }) => (
            <Statement key={group} claim={t.attribution[group].claim(top.pct, top.name)} advice={t.attribution[group].advice} />
          ))}
        </ul>
      )}
    </Card>
  );
}

/** A long name that keeps its last segment: three sibling folders stay told apart. */
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

/** A table that says when the backend cut it short. */
function TrimmedTable({ head, widths, shown, total, children }: { head: ReactNode[]; widths?: Array<string | undefined>; shown: number; total: number; children: ReactNode }): ReactNode {
  const t = useMessages(messages);
  const rest = Math.max(0, total - shown);
  return (
    <div>
      <Table head={head} widths={widths}>
        {children}
      </Table>
      {rest > 0 ? <Caption>{t.more(rest)}</Caption> : null}
    </div>
  );
}

function AttributionCard({ summary }: { summary: UsageSummary }): ReactNode {
  const t = useMessages(messages);
  const filled = attributionGroups(summary).filter(([, rows]) => rows.length > 0);
  if (filled.length === 0) {
    return (
      <Card title={t.attributionTitle}>
        <Empty>{t.attributionEmpty}</Empty>
      </Card>
    );
  }
  return (
    <Card title={t.attributionTitle} hint={t.attributionHint}>
      <div className="grid grid-cols-[repeat(auto-fill,minmax(max(14rem,calc((100%-1.5rem)/2)),1fr))] gap-x-6 gap-y-3">
        {filled.map(([group, rows]) => {
          const shown = rows.slice(0, ATTRIBUTION_MAX_ROWS);
          return (
            <TrimmedTable key={group} head={[t.attribution[group].title, t.attributionValue]} widths={[undefined, "28%"]} shown={shown.length} total={rows.length}>
              {shown.map((row) => (
                <tr key={row.name}>
                  <Cell first title={row.name}>
                    <Name value={group === "skills" ? `/${row.name}` : row.name} />
                  </Cell>
                  <Cell>{row.pct}%</Cell>
                </tr>
              ))}
            </TrimmedTable>
          );
        })}
      </div>
    </Card>
  );
}

function SkillsCard({ skills, total }: { skills: SkillBucket[]; total: number }): ReactNode {
  const t = useMessages(messages);
  const lang = useLang();
  return (
    <Card title={t.skillsTitle} hint={t.skillsHint}>
      {skills.length === 0 ? (
        <Empty>{t.skillsEmpty}</Empty>
      ) : (
        <TrimmedTable head={t.skillsHead} widths={[undefined, "10%", "18%", "15%", "17%"]} shown={skills.length} total={total}>
          {skills.map((row) => (
            <tr key={row.skill}>
              <Cell first title={row.skill}>
                <Name value={`/${row.skill}`} />
              </Cell>
              <Cell muted>{exactNumber(row.invocations, lang)}</Cell>
              <Cell muted title={row.injections > 0 ? t.skillInjections(row.injections) : t.skillNoInjection}>
                {kilobytes(row.injectedBytes, lang)}
              </Cell>
              <Cell title={row.reported.total > 0 ? exactNumber(row.reported.total, lang) : t.skillNoCall}>
                {row.reported.total > 0 ? compactNumber(row.reported.total, lang) : "—"}
              </Cell>
              <Cell muted>{row.reported.total > 0 ? sharePercent(row.reportedShare) : "—"}</Cell>
            </tr>
          ))}
        </TrimmedTable>
      )}
    </Card>
  );
}

function runLength(run: GoRunBucket): number | null {
  if (!run.startedAt || !run.finishedAt) return null;
  const from = Date.parse(run.startedAt);
  const to = Date.parse(run.finishedAt);
  if (Number.isNaN(from) || Number.isNaN(to) || to < from) return null;
  return to - from;
}

function ProcessesCard({ summary }: { summary: UsageSummary }): ReactNode {
  const t = useMessages(messages);
  const lang = useLang();
  const workflows: WorkflowBucket[] = summary.byWorkflow;
  const runs: GoRunBucket[] = summary.byGoRun;
  if (workflows.length === 0 && runs.length === 0) {
    return (
      <Card title={t.processesTitle}>
        <Empty>{t.processesEmpty}</Empty>
      </Card>
    );
  }
  return (
    <Card title={t.processesTitle} hint={t.processesHint}>
      <div className="space-y-4">
        {workflows.length === 0 ? null : (
          <TrimmedTable head={t.workflowHead} widths={[undefined, "11%", "15%", "13%", "17%"]} shown={workflows.length} total={summary.bucketCounts.workflow}>
            {workflows.map((run) => (
              <tr key={run.key}>
                <Cell first title={`${run.workflowName ?? run.runId}, ${dateTime(run.startedAt, lang)}`}>
                  <span className="flex min-w-0 items-baseline">
                    <span className="truncate text-foreground">{run.workflowName ?? run.runId}</span>
                    <span className="flex-none text-muted-foreground">&nbsp;{dateTime(run.startedAt, lang)}</span>
                  </span>
                </Cell>
                <Cell muted>{run.agentCount === null ? "—" : run.agentCount}</Cell>
                <Cell title={exactNumber(run.totals.total, lang)}>{compactNumber(run.totals.total, lang)}</Cell>
                <Cell muted>{duration(run.durationMs, lang)}</Cell>
                <Cell muted title={run.status ?? undefined}>{run.status ?? "—"}</Cell>
              </tr>
            ))}
          </TrimmedTable>
        )}
        {runs.length === 0 ? null : (
          <TrimmedTable head={t.goHead} widths={[undefined, "16%", "15%", "13%", "10%"]} shown={runs.length} total={summary.bucketCounts.goRun}>
            {runs.map((run) => (
              <tr key={run.key}>
                <Cell first title={`${run.name}, ${run.dir ?? ""}`}>
                  <span className="flex min-w-0 items-baseline">
                    <span className="truncate text-foreground">{run.name}</span>
                    <span className="flex-none text-muted-foreground">&nbsp;{dateTime(run.startedAt, lang)}</span>
                  </span>
                </Cell>
                <Cell muted title={run.model ?? undefined}>{(run.model ?? "—").replace(/^claude-/, "")}</Cell>
                <Cell title={exactNumber(run.totals.total, lang)}>{compactNumber(run.totals.total, lang)}</Cell>
                <Cell muted>{duration(runLength(run), lang)}</Cell>
                <Cell muted>{run.exitCode === null ? t.running : run.exitCode}</Cell>
              </tr>
            ))}
          </TrimmedTable>
        )}
      </div>
    </Card>
  );
}

function ShareRow({ label, title, bucket }: { label: ReactNode; title: string; bucket: UsageBucket }): ReactNode {
  const lang = useLang();
  return (
    <tr>
      <Cell first title={title}>{label}</Cell>
      <Cell title={exactNumber(bucket.totals.total, lang)}>{compactNumber(bucket.totals.total, lang)}</Cell>
      <Cell>
        <span className="ml-auto flex max-w-[7rem] items-center gap-2">
          <Meter value={bucket.share * 100} className="min-w-0 flex-1" />
          <span className="w-9 flex-none text-right text-xs text-muted-foreground">{sharePercent(bucket.share)}</span>
        </span>
      </Cell>
    </tr>
  );
}

function ProjectsCard({ summary }: { summary: UsageSummary }): ReactNode {
  const t = useMessages(messages);
  const unresolved = summary.unresolvedThreadShare;
  const unresolvedShown = summary.byThread.some((b) => b.key === UNRESOLVED_THREAD);
  if (summary.byProject.length === 0 && summary.byThread.length === 0) {
    return (
      <Card title={t.projectsTitle}>
        <Empty>{t.projectsEmpty}</Empty>
      </Card>
    );
  }
  return (
    <Card title={t.projectsTitle} hint={t.projectsHint}>
      <div className="space-y-4">
        <div className="grid grid-cols-[repeat(auto-fill,minmax(max(15rem,calc((100%-1.5rem)/2)),1fr))] gap-x-6 gap-y-3">
          <TrimmedTable head={t.projectHead} widths={[undefined, "22%", "30%"]} shown={summary.byProject.length} total={summary.bucketCounts.project}>
            {summary.byProject.map((b) => (
              <ShareRow key={b.key} label={<Name value={projectLabel(b.key, b.label)} />} title={projectLabel(b.key, b.label)} bucket={b} />
            ))}
          </TrimmedTable>
          <TrimmedTable head={t.modelHead} widths={[undefined, "22%", "30%"]} shown={summary.byModel.length} total={summary.bucketCounts.model}>
            {summary.byModel.map((b) => (
              <ShareRow key={b.key} label={b.label.replace(/^claude-/, "")} title={b.label} bucket={b} />
            ))}
          </TrimmedTable>
        </div>
        {summary.byThread.length === 0 ? (
          <Empty>{t.noThreads}</Empty>
        ) : (
          <TrimmedTable head={t.threadHead} widths={[undefined, "22%", "30%"]} shown={summary.byThread.length} total={summary.bucketCounts.thread}>
            {summary.byThread.map((b) => (
              <ShareRow key={b.key} label={b.label} title={b.label} bucket={b} />
            ))}
          </TrimmedTable>
        )}
        {unresolved > 0 && !unresolvedShown ? <Caption>{t.unresolved(sharePercent(unresolved))}</Caption> : null}
      </div>
    </Card>
  );
}
