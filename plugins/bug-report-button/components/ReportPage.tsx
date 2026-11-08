// The report page: subject, description and pictures from a drop, a paste or a file picker; sends through the server.
import { useCallback, useEffect, useRef, useState, type DragEvent } from "react";
import { useRpc } from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "../server";
import { combineImages } from "../src/combine";
import { DEFAULT_LABEL } from "../src/config";
import {
  IMAGE_TYPES,
  MAX_DESCRIPTION_LENGTH,
  MAX_IMAGE_BYTES,
  MAX_IMAGES,
  MAX_SUBJECT_LENGTH,
  MAX_TOTAL_BYTES,
  checkImage,
  formatBytes,
  imageName,
  isImageType,
  type ImageType,
} from "../src/report";

type KeyStatus = { hasKey: boolean; source: "own" | "shared" | null; keyStore: "keychain" | "credential-manager" | "file" | null };
type PageConfig = {
  label: string;
  formUrl: string;
  canSend: boolean;
  canAttach: boolean;
  combine: boolean;
  picturesStay: boolean;
  problem: string | null;
  mode: "form" | "rest";
  key: KeyStatus | null;
  keyHelp: string;
  keyProblem: string | null;
};
type Attached = { id: string; name: string; type: ImageType; size: number; blob: Blob; preview: string };
type Sent = { key: string | null; url: string | null; warning: string | null; picturesLeft: number };

let nextId = 0;

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).slice(String(reader.result).indexOf(",") + 1));
    reader.onerror = () => reject(reader.error ?? new Error("A picture could not be read."));
    reader.readAsDataURL(blob);
  });
}

/** Files from a drop, a paste or the picker. A drop of a web page picture carries no file and is skipped. */
function filesOf(list: DataTransfer | FileList | null): File[] {
  if (!list) return [];
  if ("items" in list) {
    const files: File[] = [];
    for (const item of Array.from(list.items)) {
      if (item.kind === "file") {
        const file = item.getAsFile();
        if (file) files.push(file);
      }
    }
    return files.length ? files : Array.from(list.files);
  }
  return Array.from(list);
}

function hasFiles(event: DragEvent) {
  return Array.from(event.dataTransfer?.types ?? []).includes("Files");
}

function clientLine() {
  return `${navigator.userAgent}; window ${window.innerWidth}x${window.innerHeight}`;
}

const STORE_NAMES = { keychain: "Keychain", "credential-manager": "Credential Manager", file: "a file only you can read" } as const;

/** The person's own API key for the REST mode: it is saved in this computer's key store and sent only to the tracker. */
function ApiKey({ status, help, problem, disabled, onChange }: { status: KeyStatus | null; help: string; problem: string | null; disabled: boolean; onChange: (status: KeyStatus) => void }) {
  const rpc = useRpc<typeof rpcContract>();
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const run = async (action: () => Promise<KeyStatus>) => {
    setBusy(true);
    setFailure(null);
    try {
      onChange(await action());
      setValue("");
      setEditing(false);
    } catch (reason) {
      setFailure(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };
  if (problem) return <p className="brb-error" role="alert">{problem}</p>;
  if (!status) return null;
  const where = status.keyStore ? STORE_NAMES[status.keyStore] : "";
  if (status.hasKey && !editing) {
    return (
      <div className="brb-key" data-testid="brb-key">
        <span className="brb-muted">
          {status.source === "shared" ? `Sending with the API key you saved for the tracker board (${where}).` : `Sending with your API key, saved in ${where} on this computer.`}
        </span>
        <button type="button" className="brb-link" onClick={() => setEditing(true)} disabled={disabled || busy}>Change key</button>
        {status.source === "own" ? (
          <button type="button" className="brb-link" onClick={() => void run(() => rpc.call("key_forget", null))} disabled={disabled || busy}>Forget key</button>
        ) : null}
        {failure ? <p className="brb-error" role="alert">{failure}</p> : null}
      </div>
    );
  }
  return (
    <div className="brb-field" data-testid="brb-key">
      <span>Your API key</span>
      <div className="brb-key">
        <input
          type="password"
          name="api-key"
          autoComplete="off"
          value={value}
          placeholder="Paste the key"
          onChange={(event) => setValue(event.target.value)}
          onKeyDown={(event) => {
            // Enter saves the key, not the report around it.
            if (event.key !== "Enter") return;
            event.preventDefault();
            if (value.trim()) void run(() => rpc.call("key_save", { key: value.trim() }));
          }}
          disabled={disabled || busy}
        />
        <button
          type="button"
          className="brb-button"
          onClick={() => void run(() => rpc.call("key_save", { key: value.trim() }))}
          disabled={disabled || busy || !value.trim()}
        >
          {busy ? "Saving…" : "Save key"}
        </button>
        {status.hasKey ? <button type="button" className="brb-link" onClick={() => setEditing(false)}>Cancel</button> : null}
      </div>
      <span className="brb-muted">{help ? `${help} ` : ""}The key stays in this computer's key store and goes only to the tracker.</span>
      {failure ? <p className="brb-error" role="alert">{failure}</p> : null}
    </div>
  );
}

/** The host draws the panel title; a caption of the build's own is the page heading. */
function Heading({ label }: { label: string }) {
  return label === DEFAULT_LABEL ? null : <h2 className="brb-title">{label}</h2>;
}

export function ReportPage() {
  const rpc = useRpc<typeof rpcContract>();
  const [config, setConfig] = useState<PageConfig | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [subject, setSubject] = useState("");
  const [description, setDescription] = useState("");
  const [images, setImages] = useState<Attached[]>([]);
  const [notices, setNotices] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState<Sent | null>(null);
  const [dragging, setDragging] = useState(false);
  const dragDepth = useRef(0);
  const picker = useRef<HTMLInputElement>(null);
  const imagesRef = useRef(images);
  imagesRef.current = images;

  useEffect(() => {
    let live = true;
    rpc.call("config", null).then(
      (value) => live && setConfig(value),
      (reason: unknown) => live && setLoadError(reason instanceof Error ? reason.message : String(reason)),
    );
    return () => {
      live = false;
    };
  }, [rpc]);

  useEffect(() => () => imagesRef.current.forEach((image) => URL.revokeObjectURL(image.preview)), []);

  const attach = useCallback((files: File[]) => {
    if (!files.length) return;
    const refused: string[] = [];
    const added: Attached[] = [];
    const current = imagesRef.current;
    for (const file of files) {
      const check = checkImage(file, [...current, ...added]);
      if (!check.ok) {
        refused.push(check.reason);
        continue;
      }
      const type = file.type as ImageType;
      const name = imageName(file.name, type, [...current, ...added].map((image) => image.name));
      added.push({ id: `img-${++nextId}`, name, type, size: file.size, blob: file, preview: URL.createObjectURL(file) });
    }
    if (added.length) {
      setImages([...current, ...added]);
      setSent(null);
    }
    setNotices(refused);
  }, []);

  const remove = (id: string) => {
    const image = images.find((item) => item.id === id);
    if (image) URL.revokeObjectURL(image.preview);
    setImages(images.filter((item) => item.id !== id));
    setNotices([]);
  };

  // A paste anywhere on the page: a screenshot from the clipboard. Text still goes into the field as usual.
  const canAttach = !!config?.canAttach;
  useEffect(() => {
    if (!canAttach) return;
    const onPaste = (event: ClipboardEvent) => {
      const files = filesOf(event.clipboardData).filter((file) => file.type.startsWith("image/"));
      if (!files.length) return;
      event.preventDefault();
      attach(files);
    };
    document.addEventListener("paste", onPaste);
    return () => document.removeEventListener("paste", onPaste);
  }, [canAttach, attach]);

  const dragProps = canAttach
    ? {
        onDragEnter: (event: DragEvent) => {
          if (!hasFiles(event)) return;
          event.preventDefault();
          dragDepth.current += 1;
          setDragging(true);
        },
        onDragOver: (event: DragEvent) => {
          if (!hasFiles(event)) return;
          event.preventDefault();
          event.dataTransfer.dropEffect = "copy";
        },
        onDragLeave: () => {
          dragDepth.current = Math.max(0, dragDepth.current - 1);
          if (dragDepth.current === 0) setDragging(false);
        },
        onDrop: (event: DragEvent) => {
          event.preventDefault();
          dragDepth.current = 0;
          setDragging(false);
          attach(filesOf(event.dataTransfer));
        },
      }
    : {};

  const send = async () => {
    if (!config?.canSend || sending) return;
    if (config.mode === "rest" && !config.key?.hasKey) {
      setError("Save your API key first.");
      return;
    }
    if (!subject.trim()) {
      setError("Write a subject: a few words about what went wrong.");
      return;
    }
    setSending(true);
    setError(null);
    setSent(null);
    try {
      let parts: Array<{ name: string; type: ImageType; blob: Blob }> = images.map(({ name, type, blob }) => ({ name, type, blob }));
      if (config.combine && parts.length > 1) {
        const blob = await combineImages(parts.map((part) => part.blob));
        const type = isImageType(blob.type) ? blob.type : "image/png";
        parts = [{ name: imageName(`screenshots.${type === "image/jpeg" ? "jpg" : "png"}`, type, []), type, blob }];
      }
      const payload = await Promise.all(parts.map(async (part) => ({ name: part.name, type: part.type, base64: await blobToBase64(part.blob) })));
      const result = await rpc.call("send", { subject: subject.trim(), description, client: clientLine(), images: config.picturesStay ? [] : payload });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      // Pictures the form does not take stay on the page, so the person can attach them in the form.
      const kept = config.picturesStay ? images.length : 0;
      if (!kept) {
        images.forEach((image) => URL.revokeObjectURL(image.preview));
        setImages([]);
      }
      setSubject("");
      setDescription("");
      setNotices([]);
      setSent({ key: result.key, url: result.url, warning: result.warning, picturesLeft: kept });
    } catch (reason) {
      setError(`The report was not sent: ${reason instanceof Error ? reason.message : String(reason)}. What you wrote is kept; send again.`);
    } finally {
      setSending(false);
    }
  };

  if (loadError) return <div className="brb-root"><div className="brb-page"><p className="brb-error" role="alert">The page could not load its settings: {loadError}</p></div></div>;
  if (!config) return <div className="brb-root"><div className="brb-page"><p className="brb-muted">Loading…</p></div></div>;

  if (!config.canSend) {
    return (
      <div className="brb-root">
        <div className="brb-page">
          <Heading label={config.label} />
          {config.problem ? <p className="brb-error" role="alert">{config.problem}</p> : null}
          {config.formUrl ? (
            <>
              <p>Sending from here is not set up yet. Open the form and report the problem there.</p>
              <a className="brb-button brb-primary" href={config.formUrl} target="_blank" rel="noopener noreferrer">Open the form</a>
            </>
          ) : (
            <p className="brb-muted">There is no form yet: the plugin settings have no address.</p>
          )}
        </div>
      </div>
    );
  }

  const total = images.reduce((sum, image) => sum + image.size, 0);
  return (
    <div className={`brb-root${dragging ? " brb-dragging" : ""}`} {...dragProps} data-testid="brb-page">
      <form
        className="brb-page"
        onSubmit={(event) => {
          event.preventDefault();
          void send();
        }}
      >
        <Heading label={config.label} />
        {sent ? (
          <p className="brb-success" role="status">
            Sent.{" "}
            {sent.url ? (
              <a href={sent.url} target="_blank" rel="noopener noreferrer">{sent.key ?? "Open the record"}</a>
            ) : sent.key ? (
              <strong>{sent.key}</strong>
            ) : (
              "The form took the report."
            )}
          </p>
        ) : null}
        <label className="brb-field">
          <span>Subject</span>
          <input
            name="subject"
            value={subject}
            maxLength={MAX_SUBJECT_LENGTH}
            placeholder="What went wrong, in a few words"
            onChange={(event) => setSubject(event.target.value)}
            disabled={sending}
            required
          />
        </label>
        <label className="brb-field">
          <span>Description</span>
          <textarea
            name="description"
            value={description}
            maxLength={MAX_DESCRIPTION_LENGTH}
            rows={7}
            placeholder="What you did, what you expected, and what happened instead"
            onChange={(event) => setDescription(event.target.value)}
            disabled={sending}
          />
        </label>
        {config.canAttach ? (
          <div className="brb-field">
            <span>Pictures</span>
            <div
              className="brb-drop"
              role="button"
              tabIndex={0}
              onClick={() => picker.current?.click()}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  picker.current?.click();
                }
              }}
            >
              <strong>Drop pictures here, paste a screenshot, or choose files</strong>
              <span className="brb-muted">
                PNG, JPEG, GIF or WebP; up to {MAX_IMAGES} pictures, {formatBytes(MAX_IMAGE_BYTES)} each and {formatBytes(MAX_TOTAL_BYTES)} together.
                {config.combine ? " Several pictures are joined into one before sending." : ""}
                {config.picturesStay ? " The form does not take pictures from here yet: after sending you get a link to attach them in the tracker." : ""}
              </span>
            </div>
            <input
              ref={picker}
              type="file"
              accept={IMAGE_TYPES.join(",")}
              multiple
              hidden
              data-testid="brb-picker"
              onChange={(event) => {
                attach(filesOf(event.target.files));
                event.target.value = "";
              }}
            />
            {notices.map((notice) => (
              <p key={notice} className="brb-error" role="alert">{notice}</p>
            ))}
            {images.length ? (
              <ul className="brb-thumbs" aria-label="Attached pictures">
                {images.map((image) => (
                  <li key={image.id} className="brb-thumb">
                    <img src={image.preview} alt={image.name} />
                    <span title={image.name}>{image.name}</span>
                    <span className="brb-muted">{formatBytes(image.size)}</span>
                    <button type="button" aria-label={`Remove ${image.name}`} onClick={() => remove(image.id)} disabled={sending}>×</button>
                  </li>
                ))}
              </ul>
            ) : null}
            {images.length ? <span className="brb-muted">{images.length} of {MAX_IMAGES}, {formatBytes(total)}</span> : null}
          </div>
        ) : null}
        {sent?.warning ? <p className="brb-error" role="alert">{sent.warning}</p> : null}
        {sent?.picturesLeft ? (
          <p className="brb-error" role="alert" data-testid="brb-pictures-left">
            The form did not take the {sent.picturesLeft === 1 ? "picture" : `${sent.picturesLeft} pictures`}: they are still here.{" "}
            {config.formUrl ? (
              <>
                Attach {sent.picturesLeft === 1 ? "it" : "them"} in the tracker:{" "}
                <a href={config.formUrl} target="_blank" rel="noopener noreferrer">open the form</a>.
              </>
            ) : (
              <>Attach {sent.picturesLeft === 1 ? "it" : "them"} in the tracker.</>
            )}
          </p>
        ) : null}
        {config.mode === "rest" ? (
          <ApiKey
            status={config.key}
            help={config.keyHelp}
            problem={config.keyProblem}
            disabled={sending}
            onChange={(key) => setConfig({ ...config, key })}
          />
        ) : null}
        {error ? <p className="brb-error" role="alert">{error}</p> : null}
        <div className="brb-actions">
          <button type="submit" className="brb-button brb-primary" disabled={sending}>{sending ? "Sending…" : "Send"}</button>
          {config.formUrl ? <a href={config.formUrl} target="_blank" rel="noopener noreferrer" className="brb-muted">Open the form in a browser</a> : null}
        </div>
      </form>
      {dragging ? <div className="brb-overlay" aria-hidden="true">Drop to attach</div> : null}
    </div>
  );
}
