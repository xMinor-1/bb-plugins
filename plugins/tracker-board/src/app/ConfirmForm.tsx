// The confirmation form above the chat's composer: what the agent wants to change,
// one checkbox per change. Only what stays checked is applied.
import type { PluginPendingInteractionProps } from "@get-bb/plugin-sdk/app";
import { useEffect, useMemo, useState } from "react";
import { useMessages } from "@/lib/i18n";
import type { PlannedChange } from "../shared/changes";
import { messages, type Messages } from "./messages";
import { Icons } from "./parts";

interface Payload {
  tracker: string;
  summary: string;
  items: (PlannedChange & { line: string })[];
}

function readPayload(value: unknown): Payload | null {
  if (!value || typeof value !== "object") return null;
  const payload = value as Partial<Payload>;
  if (!Array.isArray(payload.items)) return null;
  return { tracker: String(payload.tracker ?? ""), summary: String(payload.summary ?? ""), items: payload.items.filter((item) => item && typeof item.id === "string") };
}

export function changeText(t: Messages, item: PlannedChange): string {
  const c = item.change;
  const arrow = (from: string | null, to: string | null) => (from ? `${from} → ${to ?? ""}` : to ?? "");
  switch (c.kind) {
    case "status":
      return `${t.status}: ${arrow(item.from, item.to)}`;
    case "assignee":
      return `${t.assignee}: ${arrow(item.from, item.to === "nobody" ? t.nobody : item.to)}`;
    case "priority":
      return `${t.priority}: ${arrow(item.from, item.to)}`;
    case "labels":
      return `${t.labels}: ${item.to ?? ""}`;
    case "parent":
      return `${t.parent}: ${arrow(item.from === "none" ? t.none : item.from, item.to === "none" ? t.none : item.to)}`;
    case "summary":
      return `${t.title}: ${arrow(item.from, item.to)}`;
    case "description":
      return `${t.description}: ${item.to ?? ""}`;
    case "comment":
      return `${t.addComment}: ${item.to ?? ""}`;
    case "create":
      return `${t.newIssue}${c.parentKey ? `, ${t.parent.toLowerCase()} ${c.parentKey}` : ""}${c.labels.length ? `, ${c.labels.join(", ")}` : ""}`;
  }
}

export function ConfirmForm({ interaction, submit, cancel }: PluginPendingInteractionProps) {
  const t = useMessages(messages);
  const payload = useMemo(() => readPayload(interaction.payload), [interaction.payload]);
  const okItems = payload?.items.filter((item) => item.ok) ?? [];
  const [checked, setChecked] = useState<ReadonlySet<string>>(() => new Set(okItems.map((item) => item.id)));
  const [sending, setSending] = useState(false);
  const approve = async () => {
    setSending(true);
    try {
      await submit({ approve: okItems.filter((item) => checked.has(item.id)).map((item) => item.id) });
    } finally {
      setSending(false);
    }
  };
  const reject = async () => {
    setSending(true);
    try {
      await cancel();
    } finally {
      setSending(false);
    }
  };
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (event.key === "Enter" && (event.metaKey || event.ctrlKey) && checked.size > 0 && !sending) {
        event.preventDefault();
        void approve();
      }
    };
    document.addEventListener("keydown", key);
    return () => document.removeEventListener("keydown", key);
  });
  if (!payload) return null;
  const skipped = payload.items.filter((item) => !item.ok);
  const n = okItems.filter((item) => checked.has(item.id)).length;
  return (
    <div className="tb-root tb-ask" role="group" aria-label={t.confirmTitle(okItems.length)}>
      <div className="tb-ask-h">{t.confirmTitle(okItems.length)}</div>
      {payload.summary ? <div className="tb-ask-sum">{payload.summary}</div> : null}
      <div className="tb-hint tb-ask-hint">{t.confirmHint}</div>
      <div className="tb-ask-list">
        {okItems.map((item) => {
          const on = checked.has(item.id);
          return (
            <label key={item.id} className={`tb-ask-it${on ? "" : " tb-no"}`}>
              <input
                className="tb-cb"
                type="checkbox"
                checked={on}
                disabled={sending}
                onChange={() =>
                  setChecked((current) => {
                    const next = new Set(current);
                    if (next.has(item.id)) next.delete(item.id);
                    else next.add(item.id);
                    return next;
                  })
                }
              />
              <span className="tb-t">
                {item.key ? `${item.key} ` : ""}
                {item.title}
              </span>
              <span className="tb-d">{changeText(t, item)}</span>
            </label>
          );
        })}
        {skipped.length > 0 ? (
          <div className="tb-ask-skipped">
            {t.skipped}:{" "}
            {skipped.map((item) => `${item.key ?? item.title} (${t[`skip_${item.skip ?? "same"}`]})`).join("; ")}
          </div>
        ) : null}
      </div>
      <div className="tb-ask-f">
        <span className="tb-grow" />
        <button className="tb-btn" type="button" onClick={reject} disabled={sending}>
          {t.reject}
        </button>
        <button className="tb-btn tb-pri" type="button" onClick={approve} disabled={sending || n === 0}>
          <Icons.check />
          {t.applyN(n)}
          <span className="tb-kbd">⌘↵</span>
        </button>
      </div>
    </div>
  );
}
