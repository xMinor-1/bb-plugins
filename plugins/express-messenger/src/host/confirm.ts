// The last word before a message leaves: a window drawn by the operating system on this machine,
// not by bb. bb cannot tell whether a send came from an agent the person asked or from one that
// read a message and followed it, so the person checks the chat and the text in a window outside
// bb. It raises the bar; it is not a wall: a program of the same user can press buttons too.
//
//   macOS    /usr/bin/osascript (JavaScript for Automation) `display dialog`
//   Windows  a WinForms window from Windows PowerShell in System32
//   Linux    /usr/bin/zenity, when a desktop session is present
//
// Tools are called by absolute paths, and the window's text (a chat name and a message) never
// goes into process arguments, which endpoint security tools log: scripts read it from stdin.
import { spawn } from "node:child_process";
import { join } from "node:path";
import type { ChatKind, Lang } from "../../contract.js";

export interface SendSummary {
  readonly chat: string;
  readonly kind: ChatKind;
  readonly members: number;
  readonly text: string;
}

export type ConfirmOutcome = { readonly ok: true } | { readonly ok: false; readonly reason: "cancelled" | "timeout" | "unavailable" | "busy"; readonly message: string };

export interface SendConfirmer {
  confirm(summary: SendSummary, signal?: AbortSignal, lang?: Lang): Promise<ConfirmOutcome>;
}

export const CONFIRM_TIMEOUT_S = 180;
export const TEXT_PREVIEW = 1500;
const ZENITY = "/usr/bin/zenity";

const WORDS = {
  en: {
    title: "Express Messenger: send this message?",
    send: "Send",
    cancel: "Cancel",
    kind: { personal: "Personal chat", group: "Group chat", channel: "Channel", bot: "Bot", notes: "Notes", other: "Chat" } satisfies Record<ChatKind, string>,
    members: (n: number) => `${n} members`,
    to: "To",
    text: (n: number) => `Text (${n} characters)`,
    onlyStart: (shown: number, n: number) => `[Only the start is shown: ${shown} of ${n} characters.]`,
    warning: "An agent wants to send this from your name. Check the chat and the text. Send?",
  },
  ru: {
    title: "Express Messenger: отправить сообщение?",
    send: "Отправить",
    cancel: "Отмена",
    kind: { personal: "Личный чат", group: "Групповой чат", channel: "Канал", bot: "Бот", notes: "Заметки", other: "Чат" } satisfies Record<ChatKind, string>,
    members: (n: number) => `участников: ${n}`,
    to: "Кому",
    text: (n: number) => `Текст (символов: ${n})`,
    onlyStart: (shown: number, n: number) => `[Здесь только начало: ${shown} из ${n} символов.]`,
    warning: "Агент хочет отправить это от вашего имени. Проверьте чат и текст. Отправить?",
  },
};

/** The window's text and buttons. Exported for tests: the person must see where it goes and what. */
export function confirmationText(summary: SendSummary, lang: Lang = "en"): { title: string; message: string; send: string; cancel: string } {
  const w = WORDS[lang];
  const text = summary.text.trim();
  const cut = text.length > TEXT_PREVIEW;
  const start = cut ? text.slice(0, TEXT_PREVIEW).trimEnd() : text;
  const where = [w.kind[summary.kind], summary.kind === "group" || summary.kind === "channel" ? w.members(summary.members) : null].filter(Boolean).join(", ");
  const lines = [`${w.to}: ${summary.chat} (${where})`, "", `${w.text(text.length)}:`, cut ? `${start}…` : start, cut ? w.onlyStart(start.length, text.length) : null, "", w.warning];
  return { title: w.title, message: lines.filter((line): line is string => line !== null).join("\n"), send: w.send, cancel: w.cancel };
}

type WindowText = ReturnType<typeof confirmationText>;

/** JSON with everything outside printable ASCII escaped: safe inside any script source. */
function asciiJson(value: unknown): string {
  return JSON.stringify(value).replace(/[^\x20-\x7e]/g, (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`);
}

interface RunOutput {
  code: number | null;
  stdout: string;
  error: NodeJS.ErrnoException | null;
}

function run(command: string, args: string[], input: string, timeoutMs: number, signal?: AbortSignal): Promise<RunOutput> {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"], windowsHide: false, shell: false });
    } catch (error) {
      resolve({ code: null, stdout: "", error: error as NodeJS.ErrnoException });
      return;
    }
    const out: Buffer[] = [];
    let size = 0;
    let settled = false;
    const finish = (result: RunOutput) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      resolve(result);
    };
    const abort = () => child.kill("SIGKILL");
    const timer = setTimeout(abort, timeoutMs);
    signal?.addEventListener("abort", abort, { once: true });
    child.stdout.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size <= 16 * 1024) out.push(chunk);
    });
    child.stderr.resume();
    child.on("error", (error) => finish({ code: null, stdout: "", error }));
    child.on("close", (code) => finish({ code, stdout: Buffer.concat(out).toString("utf8").trim(), error: null }));
    child.stdin.on("error", () => undefined);
    child.stdin.end(input);
  });
}

/** The scripts print `bb-express:<answer>`; anything without the marker counts as no answer. */
const ANSWER = /bb-express:(send|cancel|timeout|nogui|error)\b/;
export function answerOf(stdout: string): "send" | "cancel" | "timeout" | null {
  const found = ANSWER.exec(stdout)?.[1];
  return found === "send" || found === "cancel" || found === "timeout" ? found : null;
}

const unavailable = (message: string): ConfirmOutcome => ({ ok: false, reason: "unavailable", message });
const cancelled: ConfirmOutcome = { ok: false, reason: "cancelled", message: "The user did not confirm sending in the system window. Nothing was sent." };
const timedOut: ConfirmOutcome = { ok: false, reason: "timeout", message: "Nobody answered the system window in time. Nothing was sent." };
const RUN_LIMIT_MS = (CONFIRM_TIMEOUT_S + 30) * 1000;

/** JXA `display dialog`: Cancel is the default and the Escape button. */
export function macScript(text: WindowText): string {
  return [
    "var app = Application.currentApplication();",
    "app.includeStandardAdditions = true;",
    `var data = ${asciiJson(text)};`,
    "var answer;",
    "try { app.activate(); } catch (e) {}",
    "try {",
    `  var r = app.displayDialog(data.message, { withTitle: data.title, buttons: [data.cancel, data.send], defaultButton: data.cancel, cancelButton: data.cancel, withIcon: "caution", givingUpAfter: ${CONFIRM_TIMEOUT_S} });`,
    '  answer = r.gaveUp ? "timeout" : r.buttonReturned === data.send ? "send" : "cancel";',
    "} catch (e) {",
    '  answer = e.errorNumber === -128 ? "cancel" : "error";',
    "}",
    '"bb-express:" + answer;',
    "",
  ].join("\n");
}

function macConfirmer(): SendConfirmer {
  return {
    async confirm(summary, signal, lang) {
      const result = await run("/usr/bin/osascript", ["-l", "JavaScript", "-"], macScript(confirmationText(summary, lang)), RUN_LIMIT_MS, signal);
      const answer = answerOf(result.stdout);
      if (answer === "send" && result.code === 0) return { ok: true };
      if (answer === "cancel") return cancelled;
      if (answer === "timeout") return timedOut;
      return unavailable("bb could not show the confirmation window on this Mac (no desktop session, or the window was blocked), so nothing was sent.");
    },
  };
}

/** The WinForms window. Enter means Cancel: sending takes a click on Send. */
export function windowsScript(text: WindowText): string {
  const data = Buffer.from(JSON.stringify(text), "utf8").toString("base64");
  const script = String.raw`
$ErrorActionPreference = 'Stop'
try {
  if (-not [Environment]::UserInteractive -or [System.Diagnostics.Process]::GetCurrentProcess().SessionId -eq 0) { [Console]::Out.Write('bb-express:nogui'); return }
  Add-Type -AssemblyName System.Windows.Forms
  Add-Type -AssemblyName System.Drawing
  [System.Windows.Forms.Application]::EnableVisualStyles()
  $d = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${data}')) | ConvertFrom-Json
  $form = New-Object System.Windows.Forms.Form
  $form.Text = $d.title
  $form.TopMost = $true
  $form.StartPosition = 'CenterScreen'
  $form.FormBorderStyle = 'FixedDialog'
  $form.MinimizeBox = $false
  $form.MaximizeBox = $false
  $form.ClientSize = New-Object System.Drawing.Size(560, 380)
  $box = New-Object System.Windows.Forms.TextBox
  $box.Multiline = $true
  $box.ReadOnly = $true
  $box.ScrollBars = 'Vertical'
  $box.WordWrap = $true
  $box.Text = ($d.message -split "\r?\n") -join [Environment]::NewLine
  $box.SetBounds(12, 12, 536, 310)
  $send = New-Object System.Windows.Forms.Button
  $send.Text = $d.send
  $send.SetBounds(372, 334, 85, 32)
  $send.DialogResult = [System.Windows.Forms.DialogResult]::Yes
  $cancel = New-Object System.Windows.Forms.Button
  $cancel.Text = $d.cancel
  $cancel.SetBounds(463, 334, 85, 32)
  $cancel.DialogResult = [System.Windows.Forms.DialogResult]::Cancel
  $form.Controls.AddRange(@($box, $send, $cancel))
  $form.AcceptButton = $cancel
  $form.CancelButton = $cancel
  $form.add_Shown({ $form.Activate(); [void]$cancel.Focus() })
  $timer = New-Object System.Windows.Forms.Timer
  $timer.Interval = ${CONFIRM_TIMEOUT_S * 1000}
  $timer.add_Tick({ $timer.Stop(); $form.Tag = 'timeout'; $form.Close() })
  $timer.Start()
  $result = $form.ShowDialog()
  $timer.Stop()
  if ($form.Tag -eq 'timeout') { [Console]::Out.Write('bb-express:timeout') }
  elseif ($result -eq [System.Windows.Forms.DialogResult]::Yes) { [Console]::Out.Write('bb-express:send') }
  else { [Console]::Out.Write('bb-express:cancel') }
} catch {
  [Console]::Out.Write('bb-express:error')
}
`;
  const encoded = Buffer.from(script, "utf8").toString("base64");
  return `& ([ScriptBlock]::Create([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encoded}'))))\n`;
}

function windowsConfirmer(): SendConfirmer {
  const powershell = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  return {
    async confirm(summary, signal, lang) {
      const result = await run(powershell, ["-NoProfile", "-NonInteractive", "-STA", "-Command", "-"], windowsScript(confirmationText(summary, lang)), RUN_LIMIT_MS, signal);
      const answer = answerOf(result.stdout);
      if (answer === "send") return { ok: true };
      if (answer === "cancel") return cancelled;
      if (answer === "timeout") return timedOut;
      return unavailable("bb could not show the confirmation window on this computer (no desktop session, or PowerShell is blocked by a policy), so nothing was sent.");
    },
  };
}

function linuxConfirmer(env: NodeJS.ProcessEnv): SendConfirmer {
  return {
    async confirm(summary, signal, lang) {
      if (!env.DISPLAY && !env.WAYLAND_DISPLAY) return unavailable("This machine has no desktop session to show the confirmation window, so nothing was sent.");
      const text = confirmationText(summary, lang);
      const result = await run(
        ZENITY,
        ["--text-info", `--title=${text.title}`, `--ok-label=${text.send}`, `--cancel-label=${text.cancel}`, "--width=560", "--height=400", `--timeout=${CONFIRM_TIMEOUT_S}`],
        `${text.message}\n`,
        RUN_LIMIT_MS,
        signal,
      );
      if (result.error) return unavailable(`${ZENITY} is not installed, so bb cannot ask in a system window and nothing was sent.`);
      if (result.code === 0) return { ok: true };
      if (result.code === 1) return cancelled;
      if (result.code === 5) return timedOut;
      return unavailable("The confirmation window did not open, so nothing was sent.");
    },
  };
}

export function systemConfirmer(platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env): SendConfirmer {
  if (platform === "darwin") return macConfirmer();
  if (platform === "win32") return windowsConfirmer();
  return linuxConfirmer(env);
}

/** One window at a time: a burst of sends cannot stack windows for the person to click through. */
export function oneAtATime(inner: SendConfirmer): SendConfirmer {
  let open = false;
  return {
    async confirm(summary, signal, lang) {
      if (open) return { ok: false, reason: "busy", message: "Another send is waiting for confirmation in a system window. Answer it first." };
      open = true;
      try {
        return await inner.confirm(summary, signal, lang);
      } finally {
        open = false;
      }
    },
  };
}
