// One chat next to the board: a real bb thread. Until the first message it is bb's
// new-thread composer; after it, the thread itself. "+" starts over.
import { experimental_NewThreadComposer as NewThreadComposer, ThreadChat, useBbNavigate, useComposers, type PluginComposerApi } from "@get-bb/plugin-sdk/app";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import type { ChatView } from "../server/rpc-contract";
import type { Messages } from "./messages";
import { Icons } from "./parts";
import { chatOpenStore, errorText, pendingPillsStore, useStore, type Rpc } from "./store";
import { Spinner } from "./ui";

export const MENTION_PROVIDER = "issues";
const DRAFT_KEY = "tracker-board-chat";

function chatComposer(composers: readonly PluginComposerApi[], threadId: string | null): PluginComposerApi | null {
  if (threadId) return composers.find((composer) => composer.scope.kind === "thread" && composer.scope.threadId === threadId) ?? null;
  const fresh = composers.filter((composer) => composer.scope.kind === "new-thread");
  return fresh.find((composer) => composer.key.includes(DRAFT_KEY)) ?? fresh[fresh.length - 1] ?? null;
}

/**
 * Puts task pills from "To chat" into whichever composer the column shows. It
 * lives apart from the composer: `useComposers` re-renders on every composer
 * update, and re-rendering the composer from here would feed that back.
 */
function PillInserter({ threadId, onInserted }: { threadId: string | null; onInserted: () => void }) {
  const composers = useComposers();
  const pending = useStore(pendingPillsStore);
  const composer = chatComposer(composers, threadId);
  useEffect(() => {
    if (!composer || pending.length === 0) return;
    try {
      composer.insert(
        pending.flatMap((key) => [{ provider: MENTION_PROVIDER, id: key, label: key }, " "]),
        { at: "end" },
      );
      composer.focus();
    } catch {
      // The composer went away between renders; the next one gets the pills.
      return;
    }
    pendingPillsStore.set([]);
    onInserted();
  }, [composer, pending, onInserted]);
  return null;
}

type ComposerProps = {
  projectId: string;
  hostId: string | null;
  placeholder: string;
  focus: number;
  onSubmit: (request: unknown) => Promise<void>;
};

/** bb's new-thread composer with props that keep their identity between renders. */
const ChatComposer = memo(function ChatComposer({ projectId, hostId, placeholder, focus, onSubmit }: ComposerProps) {
  const environment = useMemo(() => (hostId ? { type: "host" as const, hostId, workspace: { type: "personal" as const } } : null), [hostId]);
  return (
    <NewThreadComposer
      defaultProjectId={projectId}
      {...(environment ? { defaultEnvironment: environment } : {})}
      draftKey={DRAFT_KEY}
      placeholder={placeholder}
      focusRequest={focus}
      onSubmit={onSubmit}
    />
  );
});

const HEIGHT_STEP = 5;

/** The line between the board and the chat below it: drag it, or use the arrow keys. */
export function ChatSplitter({ t, height, onResize }: { t: Messages; height: number; onResize: (height: number) => void }) {
  const clamp = (value: number) => Math.round(Math.min(80, Math.max(20, value)));
  return (
    <div
      className="tb-split"
      role="separator"
      aria-orientation="horizontal"
      aria-label={t.resizeChat}
      aria-valuemin={20}
      aria-valuemax={80}
      aria-valuenow={height}
      tabIndex={0}
      title={t.resizeChat}
      onKeyDown={(event) => {
        if (event.key === "ArrowUp") onResize(clamp(height + HEIGHT_STEP));
        if (event.key === "ArrowDown") onResize(clamp(height - HEIGHT_STEP));
      }}
      onPointerDown={(event) => {
        const area = event.currentTarget.parentElement;
        if (!area) return;
        event.preventDefault();
        const bar = event.currentTarget;
        bar.classList.add("tb-on");
        let next = height;
        // While dragging only the CSS variable moves; the height is saved once, on release.
        const move = (moved: PointerEvent) => {
          const box = area.getBoundingClientRect();
          next = clamp(((box.bottom - moved.clientY) / box.height) * 100);
          area.style.setProperty("--tb-chat-h", `${next}%`);
        };
        const up = () => {
          bar.classList.remove("tb-on");
          window.removeEventListener("pointermove", move);
          window.removeEventListener("pointerup", up);
          if (next !== height) onResize(next);
        };
        window.addEventListener("pointermove", move);
        window.addEventListener("pointerup", up);
      }}
    />
  );
}

export function ChatColumn({
  t,
  rpc,
  agentsAllowed,
  confirm,
  place,
  onPlace,
}: {
  t: Messages;
  rpc: Rpc;
  agentsAllowed: boolean;
  /** Whether the agent's changes wait for the person's confirmation. */
  confirm: boolean;
  place: "right" | "bottom";
  onPlace: (place: "right" | "bottom") => void;
}) {
  const [chat, setChat] = useState<ChatView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [focus, setFocus] = useState(0);
  const navigate = useBbNavigate();

  const load = useCallback(() => {
    rpc.call("chat").then(setChat, (cause) => setError(errorText(t, cause)));
  }, [rpc, t]);
  useEffect(load, [load]);

  const bumpFocus = useCallback(() => setFocus((value) => value + 1), []);
  const latest = useRef({ rpc, t });
  latest.current = { rpc, t };
  const submit = useCallback(async (request: unknown) => {
    const { rpc: client, t: text } = latest.current;
    try {
      const { threadId } = await client.call("startChat", { request: request as Record<string, unknown> });
      setChat((current) => (current ? { ...current, threadId } : current));
    } catch (cause) {
      toast.error(text.chatStartFailed(errorText(text, cause)));
      throw cause;
    }
  }, []);

  const reset = async () => {
    await rpc.call("setChat", { threadId: null });
    setChat((current) => (current ? { ...current, threadId: null } : current));
  };

  return (
    <aside className="tb-chat" aria-label={t.chat}>
      {chat ? <PillInserter threadId={chat.threadId} onInserted={bumpFocus} /> : null}
      <div className="tb-chat-h">
        <span className="tb-chat-t">{t.chat}</span>
        <button className="tb-ib" type="button" onClick={() => onPlace(place === "right" ? "bottom" : "right")} title={place === "right" ? t.chatToBottom : t.chatToRight} aria-label={place === "right" ? t.chatToBottom : t.chatToRight}>
          {place === "right" ? <Icons.layBottom /> : <Icons.layRight />}
        </button>
        <button className="tb-ib" type="button" onClick={reset} title={t.newChat} aria-label={t.newChat} disabled={!chat?.threadId}>
          <Icons.plus />
        </button>
        <button className="tb-ib" type="button" onClick={() => chat?.threadId && navigate.toThread(chat.threadId)} title={t.openAsThread} aria-label={t.openAsThread} disabled={!chat?.threadId}>
          <Icons.expand />
        </button>
        <button className="tb-ib" type="button" onClick={() => chatOpenStore.set(false)} title={t.hideChat} aria-label={t.hideChat}>
          <Icons.x />
        </button>
      </div>
      {error ? <p className="tb-error tb-pad">{error}</p> : null}
      {!chat && !error ? (
        <div className="tb-pad">
          <Spinner label={t.loading} />
        </div>
      ) : null}
      {chat?.threadId ? (
        <div className="tb-chat-thread">
          <ThreadChat key={chat.threadId} threadId={chat.threadId} variant="compact" focusRequest={focus} />
        </div>
      ) : chat ? (
        <div className="tb-chat-new">
          <div className="tb-chat-empty">
            <p>{t.chatIntro1}</p>
            <p>{confirm ? t.chatIntro2 : t.chatIntro2Direct}</p>
            {agentsAllowed ? null : <p className="tb-warn">{t.chatNoAgents}</p>}
          </div>
          {chat.projectId ? (
            <div className="tb-chat-composer">
              <ChatComposer projectId={chat.projectId} hostId={chat.hostId} placeholder={t.chatPlaceholder} focus={focus} onSubmit={submit} />
            </div>
          ) : (
            <p className="tb-error tb-pad">{t.chatNoProject}</p>
          )}
        </div>
      ) : null}
    </aside>
  );
}
