import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useComposer } from "@get-bb/plugin-sdk/app";
import { Button } from "@/components/ui/button";
import { usePortalScopeProps } from "../lib/portal-scope";

export function selectedUserMessage(selection: Selection | null, pane: Element | null) {
  if (!selection || selection.isCollapsed || selection.rangeCount !== 1 || !pane) return null;
  const element = selection.anchorNode?.nodeType === 1 ? selection.anchorNode as Element : selection.anchorNode?.parentElement;
  // BB gives user bubbles this alignment; assistant prose owns its own menu.
  const bubble = element?.closest('[data-message-column] > .ml-auto');
  if (!bubble || bubble.closest("main") !== pane || !selection.focusNode || !bubble.contains(selection.focusNode)) return null;
  const text = selection.toString().trim();
  if (!text) return null;
  const rect = selection.getRangeAt(0).getBoundingClientRect();
  return { text, left: Math.max(8, Math.min(rect.left, window.innerWidth - 160)), top: rect.top > 48 ? rect.top - 42 : rect.bottom + 8 };
}

export function SelectionQuote({ threadId }: { threadId: string }) {
  const marker = useRef<HTMLSpanElement>(null);
  const composer = useComposer();
  const scopeProps = usePortalScopeProps();
  const [selected, setSelected] = useState<ReturnType<typeof selectedUserMessage>>(null);
  useEffect(() => {
    const update = () => setSelected(selectedUserMessage(window.getSelection(), marker.current?.closest("main") ?? null));
    const hide = () => setSelected(null);
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") hide(); };
    document.addEventListener("selectionchange", update);
    document.addEventListener("scroll", hide, true);
    document.addEventListener("keydown", onKey);
    window.addEventListener("resize", hide);
    return () => {
      document.removeEventListener("selectionchange", update);
      document.removeEventListener("scroll", hide, true);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("resize", hide);
    };
  }, [threadId]);
  const available = composer.scope.kind === "thread" && composer.scope.threadId === threadId;
  return <>
    <span ref={marker} hidden />
    {selected && available ? createPortal(
      <div {...scopeProps} style={{ position: "fixed", left: selected.left, top: selected.top, zIndex: 2147483646 }}>
        <Button size="sm" variant="outline" className="shadow-md" onPointerDown={(event) => event.preventDefault()} onClick={() => {
          composer.insert(selected.text.split(/\r?\n/).map((line) => `> ${line}`).join("\n") + "\n\n", { at: "end", block: true });
          window.getSelection()?.removeAllRanges();
          setSelected(null);
          composer.focus();
        }}>Цитировать</Button>
      </div>, document.body,
    ) : null}
  </>;
}
