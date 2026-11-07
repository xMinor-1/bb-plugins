import { experimental_saveFile } from "@get-bb/plugin-sdk/app";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { LanguageSwitch } from "@/lib/i18n";
import type { KeyStatus } from "../../contract";
import type { Person } from "../shared/model";
import { exportSchema, toExport, type Prefs } from "../shared/prefs";
import type { Template } from "../shared/templates";
import type { ConfigView } from "../server/rpc-contract";
import { PeoplePicker } from "./Bulk";
import type { Messages } from "./messages";
import { Avatar, Icons } from "./parts";
import { BoardsSection, needsInterest } from "./Boards";
import { configStore, errorText, failureText, prefsStore, reloadBoard, savePrefs, settingsOpenStore, type Rpc } from "./store";
import { Popover, Spinner } from "./ui";

function Connection({ t, rpc, config }: { t: Messages; rpc: Rpc; config: ConfigView }) {
  const [status, setStatus] = useState<(KeyStatus & { hostId: string | null }) | null>(null);
  const [machines, setMachines] = useState<{ machines: { id: string; name: string; connected: boolean }[]; current: string | null } | null>(null);
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [check, setCheck] = useState<{ ok: boolean; code: string | null; me: Person | null } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = () => {
    rpc.call("machines").then(setMachines, () => undefined);
    rpc.call("keyStatus").then(
      (next) => {
        setStatus(next);
        setError(null);
      },
      (cause) => setError(errorText(t, cause)),
    );
  };
  useEffect(load, [rpc]);
  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (cause) {
      setError(errorText(t, cause));
    } finally {
      setBusy(false);
      load();
    }
  };
  const store = status?.keyStore ? (t as unknown as Record<string, string>)[`keyStore_${status.keyStore}`] : null;
  return (
    <section>
      <h3>{t.settingsConnection}</h3>
      <p className="tb-h">{t.settingsConnectionHint}</p>
      <div className="tb-frow">
        <label>{t.tracker}</label>
        <input className="tb-inp" readOnly value={config.address ?? ""} aria-label={t.tracker} />
      </div>
      {machines && machines.machines.length > 1 ? (
        <div className="tb-frow">
          <label htmlFor="tb-machine">{t.machine}</label>
          <select
            id="tb-machine"
            className="tb-inp"
            value={machines.current ?? ""}
            onChange={(event) =>
              void run(async () => {
                await rpc.call("setMachine", { hostId: event.target.value });
                setCheck(null);
              })
            }
          >
            {machines.machines.map((machine) => (
              <option key={machine.id} value={machine.id}>
                {machine.name}
                {machine.connected ? "" : ` (${t.offline})`}
              </option>
            ))}
          </select>
        </div>
      ) : null}
      <div className="tb-frow">
        <label htmlFor="tb-key">{t.apiKey}</label>
        <div className="tb-key-row">
          <input
            id="tb-key"
            className="tb-inp"
            type="password"
            autoComplete="off"
            spellCheck={false}
            value={key}
            placeholder={status?.hasKey ? "••••••••••••••••" : t.apiKeyPlaceholder}
            onChange={(event) => setKey(event.target.value)}
          />
          <button
            className="tb-btn tb-pri"
            type="button"
            disabled={busy || key.trim() === "" || Boolean(config.problem)}
            onClick={() =>
              void run(async () => {
                const result = await rpc.call("saveKey", { key: key.trim() });
                setKey("");
                setCheck(result);
                if (!result.ok) return;
                // The first key: next comes "What are you interested in".
                const prefs = prefsStore.get();
                if (prefs && needsInterest(config, prefs)) settingsOpenStore.set(false);
                else void reloadBoard(rpc);
              })
            }
          >
            {t.saveAndCheck}
          </button>
        </div>
      </div>
      {config.keyHelp ? (
        <div className="tb-frow">
          <span />
          <span className="tb-hint">{config.keyHelp}</span>
        </div>
      ) : null}
      <div className="tb-frow">
        <span />
        <span className="tb-key-state">
          {busy ? <Spinner /> : null}
          {check?.ok && check.me ? (
            <span className="tb-okl">
              <Icons.check /> {t.keyWorks(check.me.name)}
            </span>
          ) : check && !check.ok ? (
            <span className="tb-error">{failureText(t, check.code, null)}</span>
          ) : status?.hasKey ? (
            <span className="tb-hint">
              {t.keySaved}
              {store ? ` ${store}` : ""}
              {status.addressChanged ? `. ${t.error_addressChanged}` : ""}
            </span>
          ) : status ? (
            <span className="tb-hint">{t.noKey}</span>
          ) : null}
          {status?.hasKey ? (
            <>
              <button className="tb-btn" type="button" disabled={busy} onClick={() => void run(async () => setCheck(await rpc.call("checkKey")))}>
                {t.check}
              </button>
              <button
                className="tb-btn tb-ghost"
                type="button"
                disabled={busy}
                onClick={() =>
                  void run(async () => {
                    await rpc.call("forgetKey");
                    setCheck(null);
                  })
                }
              >
                {t.forget}
              </button>
            </>
          ) : null}
        </span>
      </div>
      {error ? <p className="tb-error">{error}</p> : null}
    </section>
  );
}

const BLANK: Template = { id: "", title: "", prefix: "", type: "", under: "story", labels: [], components: [], assignee: "", priority: "", description: "" };

function nextId(templates: readonly Template[]): string {
  for (let n = 1; n < 100; n += 1) if (!templates.some((template) => template.id === `MY${n}`)) return `MY${n}`;
  return `MY${Date.now() % 1000}`;
}

function TemplatesSection({ t, rpc, config, prefs }: { t: Messages; rpc: Rpc; config: ConfigView; prefs: Prefs }) {
  const build = config.templates.filter((template) => !template.own);
  const [own, setOwn] = useState<Template[]>(prefs.templates);
  const dirty = JSON.stringify(own) !== JSON.stringify(prefs.templates);
  const typeName = (key: string) => config.types.find((type) => type.key === key)?.name ?? (key || "—");
  const update = (index: number, patch: Partial<Template>) => setOwn((current) => current.map((template, i) => (i === index ? { ...template, ...patch } : template)));
  const save = async () => {
    const clean = own
      .map((template) => ({ ...template, id: template.id.trim().replace(/[^A-Za-z0-9_-]/g, "").slice(0, 16) || nextId(own), title: template.title.trim() || template.id }))
      .filter((template) => !build.some((item) => item.id === template.id));
    try {
      await savePrefs(rpc, { templates: clean });
      setOwn(clean);
      configStore.set(await rpc.call("config"));
      toast.success(t.saved);
    } catch (cause) {
      toast.error(errorText(t, cause));
    }
  };
  return (
    <section>
      <h3>{t.settingsTemplates}</h3>
      <p className="tb-h">{t.settingsTemplatesHint}</p>
      <div className="tb-tplt-wrap">
        <table className="tb-tplt">
          <thead>
            <tr>
              <th>{t.template}</th>
              <th>{t.prefix}</th>
              <th>{t.type}</th>
              <th>{t.under}</th>
              <th>{t.labels}</th>
              <th>{t.component}</th>
              <th>{t.assignee}</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {build.map((template) => (
              <tr key={template.id}>
                <td>
                  <b>{template.title}</b>
                </td>
                <td>{template.prefix}</td>
                <td>{typeName(template.type)}</td>
                <td>{t[`under_${template.under}`]}</td>
                <td className="tb-hint">{template.labels.join(", ") || t.none}</td>
                <td className="tb-hint">{template.components.join(", ") || t.none}</td>
                <td className="tb-hint">{template.assignee || t.none}</td>
                <td>
                  <span className="tb-badge">
                    <Icons.lock /> {t.fromBuild}
                  </span>
                </td>
              </tr>
            ))}
            {own.map((template, index) => (
              <tr key={index}>
                <td>
                  <input value={template.title} onChange={(event) => update(index, { title: event.target.value })} aria-label={t.title} />
                </td>
                <td>
                  <input value={template.prefix} onChange={(event) => update(index, { prefix: event.target.value, id: event.target.value.replace(/[^A-Za-z0-9]/g, "") || template.id })} aria-label={t.prefix} style={{ width: 70 }} />
                </td>
                <td>
                  <select value={template.type} onChange={(event) => update(index, { type: event.target.value })} aria-label={t.type}>
                    <option value="">—</option>
                    {config.types.map((type) => (
                      <option key={type.key} value={type.key}>
                        {type.name}
                      </option>
                    ))}
                  </select>
                </td>
                <td>
                  <select value={template.under} onChange={(event) => update(index, { under: event.target.value as Template["under"] })} aria-label={t.under}>
                    <option value="story">{t.under_story}</option>
                    <option value="epic">{t.under_epic}</option>
                    <option value="any">{t.under_any}</option>
                  </select>
                </td>
                <td>
                  <input
                    value={template.labels.join(", ")}
                    title={t.labelsHint}
                    placeholder={t.labelsComma}
                    onChange={(event) => update(index, { labels: event.target.value.split(",").map((label) => label.trim()).filter(Boolean) })}
                    aria-label={t.labels}
                  />
                </td>
                <td>
                  <input value={template.components.join(", ")} onChange={(event) => update(index, { components: event.target.value.split(",").map((item) => item.trim()).filter(Boolean) })} aria-label={t.component} />
                </td>
                <td>
                  <select value={template.assignee} onChange={(event) => update(index, { assignee: event.target.value })} aria-label={t.assignee}>
                    <option value="">{t.nobody}</option>
                    <option value="@me">@me</option>
                    <option value="@parent">@parent</option>
                    {prefs.people.map((person) => (
                      <option key={person.id} value={person.id}>
                        {person.name}
                      </option>
                    ))}
                  </select>
                </td>
                <td className="tb-nowrap">
                  <span className="tb-badge">{t.mineBadge}</span>
                  <button className="tb-ib tb-ib-s" type="button" onClick={() => setOwn((current) => current.filter((_, i) => i !== index))} title={t.delete} aria-label={t.delete}>
                    <Icons.x />
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="tb-row-actions">
        <button className="tb-btn" type="button" onClick={() => setOwn((current) => [...current, { ...BLANK, id: nextId([...build, ...current]), title: t.ownTemplate, prefix: "[MY]" }])}>
          <Icons.plus />
          {t.ownTemplate}
        </button>
        {dirty ? (
          <button className="tb-btn tb-pri" type="button" onClick={() => void save()}>
            {t.save}
          </button>
        ) : null}
        <span className="tb-hint">{t.buildTemplatesHint}</span>
      </div>
      <p className="tb-h tb-mt">{t.labelsHint}</p>
    </section>
  );
}

function PeopleSection({ t, rpc, prefs }: { t: Messages; rpc: Rpc; prefs: Prefs }) {
  const [open, setOpen] = useState(false);
  const set = (people: Person[]) => void savePrefs(rpc, { people }).catch((cause) => toast.error(errorText(t, cause)));
  return (
    <section>
      <h3>{t.settingsPeople}</h3>
      <p className="tb-h">{t.settingsPeopleHint}</p>
      <div className="tb-people">
        {prefs.people.map((person) => (
          <span key={person.id} className="tb-person">
            <Avatar id={person.id} name={person.name} size={20} t={t} />
            {person.name}
            <button className="tb-lbl-x" type="button" aria-label={`${t.delete} ${person.name}`} onClick={() => set(prefs.people.filter((item) => item.id !== person.id))}>
              ×
            </button>
          </span>
        ))}
        <Popover
          open={open}
          onClose={() => setOpen(false)}
          className="tb-menu"
          trigger={
            <button className="tb-addl" type="button" onClick={() => setOpen(!open)}>
              {t.addPerson}
            </button>
          }
        >
          <PeoplePicker
            t={t}
            rpc={rpc}
            people={[]}
            onPick={(person) => {
              setOpen(false);
              if (person && !prefs.people.some((item) => item.id === person.id)) set([...prefs.people, person]);
            }}
          />
        </Popover>
      </div>
    </section>
  );
}

function TransferSection({ t, rpc, prefs }: { t: Messages; rpc: Rpc; prefs: Prefs }) {
  const file = useRef<HTMLInputElement | null>(null);
  return (
    <section>
      <h3>{t.settingsTransfer}</h3>
      <p className="tb-h">{t.settingsTransferHint}</p>
      <div className="tb-row-actions">
        <button
          className="tb-btn"
          type="button"
          onClick={() => {
            const blob = new Blob([JSON.stringify(toExport(prefs), null, 2)], { type: "application/json" });
            void experimental_saveFile({ fileName: "tracker-board-settings.json", blob }).then((outcome) => (outcome === "started" ? toast.success(t.fileSaved) : toast.error(t.failed)));
          }}
        >
          {t.saveToFile}
        </button>
        <button className="tb-btn" type="button" onClick={() => file.current?.click()}>
          {t.loadFromFile}
        </button>
        <input
          ref={file}
          type="file"
          accept="application/json,.json"
          hidden
          onChange={async (event) => {
            const picked = event.target.files?.[0];
            event.target.value = "";
            if (!picked || picked.size > 1_000_000) {
              if (picked) toast.error(t.fileBad);
              return;
            }
            try {
              const parsed = exportSchema.safeParse(JSON.parse(await picked.text()));
              if (!parsed.success) throw new Error("bad file");
              prefsStore.set(await rpc.call("importPrefs", { file: parsed.data }));
              configStore.set(await rpc.call("config"));
              toast.success(t.fileLoaded);
            } catch {
              toast.error(t.fileBad);
            }
          }}
        />
      </div>
    </section>
  );
}

export function SettingsView({ t, rpc, config, prefs }: { t: Messages; rpc: Rpc; config: ConfigView; prefs: Prefs }) {
  return (
    <div className="tb-settings">
      {config.problem ? <p className="tb-error">{t.notConfigured(config.problem)}</p> : null}
      <Connection t={t} rpc={rpc} config={config} />
      <BoardsSection t={t} rpc={rpc} config={config} prefs={prefs} />
      <TemplatesSection t={t} rpc={rpc} config={config} prefs={prefs} />
      <PeopleSection t={t} rpc={rpc} prefs={prefs} />
      <TransferSection t={t} rpc={rpc} prefs={prefs} />
      <section>
        <h3>{t.language}</h3>
        <LanguageSwitch />
      </section>
    </div>
  );
}
