// No tracker key on this machine: the page asks for it before anything else.
import { useBbNavigate } from "@get-bb/plugin-sdk/app";
import { useState, type ReactNode } from "react";
import type { ConfigView } from "../server/rpc-contract";
import { openInOwnBrowser } from "./links";
import type { Messages } from "./messages";
import { Icons } from "./parts";
import { errorText, failureText, hasKeyStore, type Rpc } from "./store";
import { Spinner } from "./ui";

/** The first-run steps: the key, what you are interested in, the board. */
export function Steps({ t, keyDone }: { t: Messages; keyDone: boolean }) {
  return (
    <div className="tb-steps">
      <span className={keyDone ? "tb-step-ok" : "tb-step-now"}>
        <span className="tb-step-n">{keyDone ? <Icons.check /> : 1}</span>
        {t.stepKey}
      </span>
      <span className={keyDone ? "tb-step-now" : ""}>
        <span className="tb-step-n">2</span>
        {t.stepInterest}
      </span>
      <span>
        <span className="tb-step-n">3</span>
        {t.stepBoard}
      </span>
    </div>
  );
}

/** Splits a build's hint into text and http(s) links; a link drops the punctuation that ends a sentence. */
export function helpParts(text: string): { text: string; url?: string }[] {
  const parts: { text: string; url?: string }[] = [];
  for (const [index, piece] of text.split(/(https?:\/\/[^\s<>"]+)/).entries()) {
    if (piece === "") continue;
    if (index % 2 === 0) {
      parts.push({ text: piece });
      continue;
    }
    let end = piece.length;
    while (end > 0 && ".,;:!?)»".includes(piece[end - 1]!)) end -= 1;
    parts.push({ text: piece.slice(0, end), url: piece.slice(0, end) });
    if (end < piece.length) parts.push({ text: piece.slice(end) });
  }
  return parts;
}

/** The build's hint on where to get a key, its links opening in the person's own browser. */
export function HelpText({ text, className }: { text: string; className?: string }) {
  const navigate = useBbNavigate();
  const content: ReactNode[] = helpParts(text).map((part, index) =>
    part.url ? (
      <a
        key={index}
        href={part.url}
        onClick={(event) => {
          event.preventDefault();
          openInOwnBrowser(part.url!, navigate.openUrl);
        }}
      >
        {part.text}
      </a>
    ) : (
      <span key={index}>{part.text}</span>
    ),
  );
  return <span className={className}>{content}</span>;
}

/**
 * Sign in with an API key: shown instead of the board while this machine has no key, whatever
 * boards the person picked before. The hint on where to get a key comes from the build.
 */
export function KeyStep({ t, rpc, config, steps, onSaved }: { t: Messages; rpc: Rpc; config: ConfigView; steps: boolean; onSaved: () => void }) {
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const blocked = busy || key.trim() === "" || Boolean(config.problem);
  const save = async () => {
    setBusy(true);
    setFailure(null);
    try {
      const result = await rpc.call("saveKey", { key: key.trim() });
      if (!result.ok) {
        setFailure(failureText(t, result.code, null));
        return;
      }
      setKey("");
      hasKeyStore.set(true);
      onSaved();
    } catch (cause) {
      setFailure(errorText(t, cause));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="tb-onb">
      <div className="tb-onb-in tb-onb-one">
        {steps ? <Steps t={t} keyDone={false} /> : null}
        <form
          className="tb-keystep"
          onSubmit={(event) => {
            event.preventDefault();
            if (!blocked) void save();
          }}
        >
          <h1>{t.keyTitle}</h1>
          <p className="tb-lead">{t.keyLead}</p>
          {config.keyHelp ? (
            <div className="tb-key-help">
              <b>{t.whereKey}</b>
              <HelpText text={config.keyHelp} />
            </div>
          ) : null}
          <div className="tb-key-row">
            <input
              id="tb-key-first"
              className="tb-inp"
              type="password"
              autoComplete="off"
              spellCheck={false}
              autoFocus
              value={key}
              placeholder={t.apiKeyPlaceholder}
              aria-label={t.apiKey}
              onChange={(event) => setKey(event.target.value)}
            />
            <button className="tb-btn tb-pri" type="submit" disabled={blocked}>
              {busy ? <Spinner /> : null}
              {t.saveAndCheck}
            </button>
          </div>
          {failure ? <p className="tb-error">{failure}</p> : null}
        </form>
      </div>
    </div>
  );
}
