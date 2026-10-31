// Step 2: the apps agents may read (ticked apps are the boundary) and the sheets
// to recommend, each with a note on what it answers.
import { useCallback, useEffect, useMemo, useState } from "react";
import { experimental_copyToClipboard, UrlLink } from "@get-bb/plugin-sdk/app";
import type { Catalog, CatalogApp, CheckLinkResult, QlikAppSummary, QlikSheetSummary } from "../../contract";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { useMessages } from "@/lib/i18n";
import { messages } from "./messages";
import { Notice, Section, errorText } from "./ui";
import type { Rpc } from "./rpc";

const SHOWN_APPS = 200;

type SheetsState = { kind: "loading" } | { kind: "ready"; sheets: QlikSheetSummary[] } | { kind: "error"; message: string };

export function ReportsSection({ rpc, hostId, signedIn }: { rpc: Rpc; hostId: string; signedIn: boolean }) {
  const [saved, setSaved] = useState<Catalog | null>(null);
  const [draft, setDraft] = useState<Catalog>({ apps: [] });
  const [apps, setApps] = useState<QlikAppSummary[] | null>(null);
  const [appsError, setAppsError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [sheets, setSheets] = useState<Record<string, SheetsState>>({});
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const t = useMessages(messages);

  useEffect(() => {
    let cancelled = false;
    rpc.call("getCatalog", { hostId }).then(
      (catalog) => {
        if (cancelled) return;
        setSaved(catalog);
        setDraft(catalog);
      },
      (cause) => !cancelled && setSaveError(errorText(cause)),
    );
    return () => {
      cancelled = true;
    };
  }, [rpc, hostId]);

  const loadApps = useCallback(() => {
    setAppsError(null);
    setApps(null);
    rpc.call("listApps", { hostId }).then(
      (result) => setApps(result.apps),
      (cause) => setAppsError(errorText(cause)),
    );
  }, [rpc, hostId]);

  useEffect(() => {
    if (signedIn) loadApps();
  }, [signedIn, loadApps]);

  const loadSheets = useCallback(
    (appId: string) => {
      setSheets((current) => ({ ...current, [appId]: { kind: "loading" } }));
      rpc.call("listSheets", { hostId, appId }).then(
        (result) => setSheets((current) => ({ ...current, [appId]: { kind: "ready", sheets: result.sheets } })),
        (cause) => setSheets((current) => ({ ...current, [appId]: { kind: "error", message: errorText(cause) } })),
      );
    },
    [rpc, hostId],
  );

  // Ticked apps show their sheets right away.
  useEffect(() => {
    if (!signedIn) return;
    for (const app of draft.apps) if (!sheets[app.id]) loadSheets(app.id);
  }, [signedIn, draft.apps, sheets, loadSheets]);

  const ticked = useMemo(() => new Map(draft.apps.map((app) => [app.id, app])), [draft]);
  const dirty = saved !== null && JSON.stringify(saved) !== JSON.stringify(draft);

  const updateApp = (appId: string, change: (app: CatalogApp) => CatalogApp) =>
    setDraft((current) => ({ apps: current.apps.map((app) => (app.id === appId ? change(app) : app)) }));

  const toggleApp = (app: { id: string; name: string; stream: string | null }, on: boolean) => {
    setDraft((current) =>
      on
        ? { apps: [...current.apps, { id: app.id, name: app.name, stream: app.stream, note: "", sheets: [] }] }
        : { apps: current.apps.filter((candidate) => candidate.id !== app.id) },
    );
    if (on && !sheets[app.id]) loadSheets(app.id);
  };

  const toggleSheet = (appId: string, sheet: { id: string; title: string }, on: boolean) =>
    updateApp(appId, (app) => ({
      ...app,
      sheets: on ? [...app.sheets, { id: sheet.id, title: sheet.title, note: "" }] : app.sheets.filter((candidate) => candidate.id !== sheet.id),
    }));

  const save = async (next: Catalog = draft) => {
    setSaving(true);
    setSaveError(null);
    try {
      const stored = await rpc.call("saveCatalog", { hostId, catalog: next });
      setSaved(stored);
      setDraft(stored);
    } catch (cause) {
      setSaveError(errorText(cause));
    } finally {
      setSaving(false);
    }
  };

  const wanted = search.trim().toLowerCase();
  const visible = (apps ?? []).filter((app) => !wanted || `${app.name} ${app.stream ?? ""}`.toLowerCase().includes(wanted));
  const missing = draft.apps.filter((app) => apps !== null && !apps.some((candidate) => candidate.id === app.id));

  if (!signedIn) {
    return (
      <Section step={2} title={t.reportsTitle} muted>
        <p className="text-sm text-muted-foreground">{t.signInFirst}</p>
      </Section>
    );
  }

  return (
    <Section step={2} title={t.reportsTitle}>
      <p className="text-sm text-muted-foreground">{t.reportsIntro}</p>

      <div className="flex items-center gap-2">
        <Input value={search} onChange={(event) => setSearch(event.target.value)} placeholder={t.findApp} aria-label={t.findAppLabel} />
        <Button variant="outline" onClick={loadApps} disabled={apps === null && appsError === null}>
          {t.reload}
        </Button>
      </div>

      {appsError ? <Notice tone="error">{appsError}</Notice> : null}
      {apps === null && !appsError ? <Notice tone="info">{t.loadingApps}</Notice> : null}
      {apps !== null && apps.length === 0 ? <Notice tone="info">{t.noApps}</Notice> : null}

      {missing.length ? (
        <Notice tone="warn">{t.lostApps(missing.map((app) => app.name).join(", "))}</Notice>
      ) : null}

      {apps !== null && visible.length ? (
        <ul className="divide-y divide-border rounded-md border border-border">
          {visible.slice(0, SHOWN_APPS).map((app) => {
            const entry = ticked.get(app.id);
            return (
              <li key={app.id} className="px-3 py-2">
                <label className="flex items-start gap-3 text-sm">
                  <Checkbox className="mt-0.5" checked={Boolean(entry)} onCheckedChange={(checked) => toggleApp(app, checked === true)} />
                  <span className="min-w-0 flex-1">
                    <span className="font-medium">{app.name}</span>
                    {app.stream ? <span className="text-muted-foreground"> — {app.stream}</span> : null}
                  </span>
                </label>
                {entry ? (
                  <AppDetails
                    app={entry}
                    sheets={sheets[app.id]}
                    onNote={(note) => updateApp(app.id, (current) => ({ ...current, note }))}
                    onToggleSheet={(sheet, on) => toggleSheet(app.id, sheet, on)}
                    onSheetNote={(sheetId, note) =>
                      updateApp(app.id, (current) => ({
                        ...current,
                        sheets: current.sheets.map((sheet) => (sheet.id === sheetId ? { ...sheet, note } : sheet)),
                      }))
                    }
                    onRetry={() => loadSheets(app.id)}
                  />
                ) : null}
              </li>
            );
          })}
        </ul>
      ) : null}
      {visible.length > SHOWN_APPS ? (
        <p className="text-xs text-muted-foreground">{t.showing(SHOWN_APPS, visible.length)}</p>
      ) : null}

      <div className="flex items-center gap-3">
        <Button onClick={() => void save()} disabled={!dirty || saving}>
          {saving ? t.saving : t.saveReports}
        </Button>
        <span className="text-xs text-muted-foreground">
          {t.enabledApps(draft.apps.length)}
          {dirty ? t.notSaved : ""}
        </span>
      </div>
      {saveError ? <Notice tone="error">{saveError}</Notice> : null}

      <LinkCheck
        rpc={rpc}
        hostId={hostId}
        onAdd={(result) => {
          const next: Catalog = { apps: draft.apps.map((app) => ({ ...app, sheets: [...app.sheets] })) };
          let app = next.apps.find((candidate) => candidate.id === result.app.id);
          if (!app) {
            app = { id: result.app.id, name: result.app.name, stream: result.app.stream, note: "", sheets: [] };
            next.apps.push(app);
          }
          if (result.sheet && !app.sheets.some((sheet) => sheet.id === result.sheet!.id)) {
            app.sheets.push({ id: result.sheet.id, title: result.sheet.title, note: "" });
          }
          void save(next);
          if (!sheets[result.app.id]) loadSheets(result.app.id);
        }}
      />
    </Section>
  );
}

function AppDetails({
  app,
  sheets,
  onNote,
  onToggleSheet,
  onSheetNote,
  onRetry,
}: {
  app: CatalogApp;
  sheets: SheetsState | undefined;
  onNote: (note: string) => void;
  onToggleSheet: (sheet: { id: string; title: string }, on: boolean) => void;
  onSheetNote: (sheetId: string, note: string) => void;
  onRetry: () => void;
}) {
  const recommended = new Map(app.sheets.map((sheet) => [sheet.id, sheet]));
  const t = useMessages(messages);
  return (
    <div className="ml-7 mt-2 space-y-2">
      <Input value={app.note} onChange={(event) => onNote(event.target.value)} placeholder={t.appNote} maxLength={500} />
      {sheets === undefined || sheets.kind === "loading" ? <p className="text-xs text-muted-foreground">{t.loadingSheets}</p> : null}
      {sheets?.kind === "error" ? (
        <Notice tone="error">
          {sheets.message}{" "}
          <Button size="sm" variant="link" onClick={onRetry}>
            {t.retry}
          </Button>
        </Notice>
      ) : null}
      {sheets?.kind === "ready" ? (
        sheets.sheets.length ? (
          <ul className="space-y-1.5">
            {sheets.sheets.map((sheet) => {
              const entry = recommended.get(sheet.id);
              return (
                <li key={sheet.id} className="text-sm">
                  <div className="flex items-center gap-3">
                    <Checkbox checked={Boolean(entry)} onCheckedChange={(checked) => onToggleSheet(sheet, checked === true)} aria-label={t.recommend(sheet.title)} />
                    <span className="min-w-0 flex-1 truncate">
                      {sheet.title}
                      {sheet.published === false ? <span className="text-muted-foreground">{t.privateSheet}</span> : null}
                    </span>
                    {sheet.link ? (
                      <UrlLink href={sheet.link} className="shrink-0 text-xs text-muted-foreground hover:text-foreground">
                        {t.openInQlik}
                      </UrlLink>
                    ) : null}
                  </div>
                  {entry ? (
                    <Input
                      className="ml-7 mt-1 h-8 w-[calc(100%-1.75rem)] text-xs"
                      value={entry.note}
                      onChange={(event) => onSheetNote(sheet.id, event.target.value)}
                      placeholder={t.sheetNote}
                      maxLength={500}
                    />
                  ) : null}
                </li>
              );
            })}
          </ul>
        ) : (
          <p className="text-xs text-muted-foreground">{t.noSheets}</p>
        )
      ) : null}
    </div>
  );
}

function LinkCheck({ rpc, hostId, onAdd }: { rpc: Rpc; hostId: string; onAdd: (result: Extract<CheckLinkResult, { status: "ok" }>) => void }) {
  const [link, setLink] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<CheckLinkResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [checkedLink, setCheckedLink] = useState("");
  const t = useMessages(messages);

  const check = async () => {
    setBusy(true);
    setError(null);
    setResult(null);
    setCopied(false);
    try {
      setCheckedLink(link.trim());
      setResult(await rpc.call("checkLink", { hostId, link }));
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setBusy(false);
    }
  };

  const request = result?.status === "no-access" ? t.request(checkedLink, result.appId, result.user) : "";

  return (
    <div className="space-y-2 border-t border-border pt-3">
      <p className="text-sm font-medium">{t.cantFind}</p>
      <p className="text-xs text-muted-foreground">{t.cantFindHint}</p>
      <div className="flex items-center gap-2">
        <Input value={link} onChange={(event) => setLink(event.target.value)} placeholder="https://…/sense/app/…/sheet/…" aria-label={t.reportLink} />
        <Button variant="outline" onClick={() => void check()} disabled={busy || link.trim() === ""}>
          {busy ? t.checking : t.check}
        </Button>
      </div>
      {error ? <Notice tone="error">{error}</Notice> : null}
      {result?.status === "invalid" ? (
        <Notice tone="error">
          {result.reason === "other-site"
            ? t.otherSite(result.linkOrigin ?? "", result.setupOrigin ?? "")
            : result.reason === "no-sheet"
              ? t.noSheet(result.sheetId ?? "")
              : t.notALink}
        </Notice>
      ) : null}
      {result?.status === "ok" ? (
        <Notice tone="ok">
          <p>
            {t.found} {result.app.name}
            {result.sheet ? ` → ${result.sheet.title}` : ""}.
          </p>
          <Button
            className="mt-2"
            size="sm"
            onClick={() => {
              onAdd(result);
              setResult(null);
              setLink("");
            }}
          >
            {t.addToReports}
          </Button>
        </Notice>
      ) : null}
      {result?.status === "no-access" ? (
        <Notice tone="warn">
          <p>{t.noAccess}</p>
          {result.detail ? <p className="mt-1 text-xs opacity-80">{result.detail}</p> : null}
          <p className="mt-2 text-xs text-muted-foreground">{t.sendToOwner}</p>
          <pre className="mt-1 whitespace-pre-wrap rounded border border-border bg-background p-2 text-xs">{request}</pre>
          <Button
            className="mt-2"
            size="sm"
            variant="outline"
            onClick={() => void experimental_copyToClipboard({ text: request }).then((ok) => setCopied(ok))}
          >
            {copied ? t.copied : t.copyRequest}
          </Button>
        </Notice>
      ) : null}
    </div>
  );
}
