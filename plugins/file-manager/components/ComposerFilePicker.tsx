// components/ComposerFilePicker.tsx — the "+" menu's file browser (§8.8).
//
// bb's own "+" attaches files from the machine the *browser* runs on. This row
// attaches them from the machine bb itself runs on — the tree this plugin
// manages — as @-mentions that the backend re-reads at send time, so the agent
// always sees each file as it is when the message goes out, not as it was when
// it was picked. The dialog picks any number of them at once (§8.8).
//
// The component renders nothing until asked. It is registered as a composer
// banner with `chrome: "bare"` purely to have a place to mount from: the "+"
// row itself is host-rendered and its `run` callback has no React tree of its
// own (see lib/composer-bus.ts for why this is the mount point and not
// `actions`). An idle picker therefore contributes no DOM to the composer.
import { useCallback, useEffect, useState } from "react";
import { useComposer } from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";

import type { FileEntry } from "../contract";
import { composerScopeKey, subscribeFilePickRequests } from "../lib/composer-bus";
import { addFileMentions } from "../lib/composer-mentions";
import { errorToastText } from "../lib/errors";
import { useFmRpc } from "../lib/fm-rpc";
import { FilePickerDialog } from "./dialogs/FilePickerDialog";
import { defineMessages, messagesNow, pluralRu, useMessages } from "../lib/i18n";

const messages = defineMessages(
  {
    unreachable: "Could not reach the File Manager.",
    added: (name: string) => `${name} added to the chat`,
    filesAdded: (count: number) => `${String(count)} files added to the chat`,
    title: "Add a file from this machine",
    description: "Files on the machine bb runs on. The agent reads the file when you send the message.",
  },
  {
    unreachable: "Файловый менеджер не отвечает.",
    added: (name) => `${name} добавлен в чат`,
    filesAdded: (count) =>
      `${String(count)} ${pluralRu(count, ["файл добавлен", "файла добавлены", "файлов добавлено"])} в чат`,
    title: "Добавить файл с этой машины",
    description: "Файлы с машины, на которой работает bb. Агент прочитает файл, когда вы отправите сообщение.",
  },
);

/** Where the browser should open, once the backend has said where "home" is. */
interface PickerRoots {
  root: string;
  startFolder: string;
}

export function ComposerFilePicker() {
  const t = useMessages(messages);
  const rpc = useFmRpc();
  const composer = useComposer();
  const scopeKey = composerScopeKey(composer.scope);
  const [open, setOpen] = useState(false);
  const [roots, setRoots] = useState<PickerRoots | null>(null);

  // Every composer on screen mounts one of these, so a request has to name the
  // composer it came from — otherwise picking a file from a thread's "+" would
  // also open a dialog over the side chat next to it.
  useEffect(
    () =>
      subscribeFilePickRequests((requested) => {
        if (requested === scopeKey) setOpen(true);
      }),
    [scopeKey],
  );

  // The root is the home folder of whoever runs bb, so only the backend knows
  // it. Asked for on first open rather than on mount: this component is
  // mounted under every composer in the app and most of them never open it.
  useEffect(() => {
    if (!open || roots !== null) return;
    let cancelled = false;
    void (async () => {
      try {
        const state = await rpc.call("getState", null);
        if (!cancelled) setRoots({ root: state.root, startFolder: state.startFolder });
      } catch (failure) {
        if (cancelled) return;
        setOpen(false);
        toast.error(errorToastText(failure, messagesNow(messages).unreachable));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, roots, rpc]);

  const choose = useCallback(
    (entries: readonly FileEntry[]) => {
      // One mention per file, in the order they were picked: the draft reads
      // as the list the user built.
      addFileMentions(composer, entries);
      const first = entries[0];
      if (first === undefined) return;
      toast.success(
        entries.length === 1
          ? messagesNow(messages).added(first.name)
          : messagesNow(messages).filesAdded(entries.length),
      );
    },
    [composer],
  );

  // Nothing is rendered until the backend has answered: the dialog cannot show
  // a breadcrumb before it knows which folder is the root of it. Once it has,
  // the dialog stays mounted and closed — unmounting it mid-close would cut
  // its exit animation and its focus restoration short.
  if (roots === null) return null;

  return (
    <FilePickerDialog
      open={open}
      onOpenChange={setOpen}
      title={t.title}
      description={t.description}
      root={roots.root}
      initialPath={roots.startFolder}
      onChoose={choose}
    />
  );
}
