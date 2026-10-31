// The last word before a draft leaves: a window drawn by the operating system
// on this machine, not by bb. bb cannot tell whether a call to send came from
// the panel, the CLI or an agent with a shell, so the panel's own dialog is not
// proof that a person decided. A system window is: an agent can call the RPC,
// but it cannot press the button in a window on the person's screen.
//
//   macOS    osascript (JavaScript for Automation) `display dialog`
//   Windows  a WinForms window from Windows PowerShell
//   Linux    zenity, when a desktop session is present
//
// The window's text is mail — recipients, subject, the start of the message —
// so it never travels in process arguments (endpoint security tools log command
// lines): every script reads it from stdin, as ASCII-only source.
import { spawn } from "node:child_process";
import { join } from "node:path";
import type { BodyFormat, DraftKind, MailAddress } from "../../contract.js";

export interface SendSummary {
  readonly kind: DraftKind;
  /** Whose mailbox it goes from: the login, or null for Windows / Kerberos sign-in. */
  readonly mailbox: string | null;
  readonly subject: string;
  readonly to: readonly MailAddress[];
  readonly cc: readonly MailAddress[];
  readonly bcc: readonly MailAddress[];
  readonly attachments: readonly { name: string; size: number | null }[];
  readonly bodyFormat: BodyFormat;
  /** The text written for the message: what the person reads first. */
  readonly text: string;
  /** Characters of quoted original sent below the text, 0 for none. */
  readonly quotedChars: number;
}

export type ConfirmOutcome =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: "cancelled" | "timeout" | "unavailable"; readonly message: string };

export interface SendConfirmer {
  confirm(summary: SendSummary, signal?: AbortSignal): Promise<ConfirmOutcome>;
}

/** How long the window waits for the person before it counts as Cancel. */
export const CONFIRM_TIMEOUT_S = 240;
const TEXT_PREVIEW = 700;
const MAX_LISTED = 25;
const TITLE = "Exchange Mail: send this message?";

const address = (a: MailAddress) => (a.name && a.name !== a.email ? `${a.name} <${a.email}>` : a.email);

function recipients(label: string, list: readonly MailAddress[]): string | null {
  if (list.length === 0) return null;
  const shown = list.slice(0, MAX_LISTED).map(address).join(", ");
  const more = list.length > MAX_LISTED ? `, and ${list.length - MAX_LISTED} more` : "";
  return `${label} (${list.length}): ${shown}${more}`;
}

const FORMAT_NOTE: Record<BodyFormat, string> = {
  text: "plain text",
  html: "HTML: it goes out with formatting, and anything hidden in the HTML, as Outlook shows it",
  rtf: "rich text (RTF): it goes out with formatting, as Outlook shows it",
  unknown: "unknown: Exchange did not say; it may go out as HTML",
};

/** The window's text. Exported for tests: what the person is asked must name everything that goes. */
export function confirmationText(summary: SendSummary): { title: string; message: string } {
  const kind = summary.kind === "new" ? "New message" : summary.kind === "replyAll" ? "Reply to all" : "Reply";
  const text = summary.text.trim();
  const preview = text.length > TEXT_PREVIEW ? `${text.slice(0, TEXT_PREVIEW).trimEnd()}…` : text;
  const lines = [
    `${kind}${summary.mailbox ? ` from ${summary.mailbox}` : ""}. It cannot be called back.`,
    "",
    recipients("To", summary.to) ?? "To: nobody",
    recipients("Cc", summary.cc),
    recipients("Bcc", summary.bcc),
    `Subject: ${summary.subject || "(no subject)"}`,
    summary.attachments.length
      ? `Attachments (${summary.attachments.length}): ${summary.attachments
          .slice(0, MAX_LISTED)
          .map((a) => a.name)
          .join(", ")}${summary.attachments.length > MAX_LISTED ? ", …" : ""}`
      : "Attachments: none",
    `Format: ${FORMAT_NOTE[summary.bodyFormat]}`,
    "",
    "Text:",
    preview || "(empty)",
    summary.quotedChars > 0 ? `\n…followed by the quoted message (${summary.quotedChars} characters).` : null,
    "",
    "Send it only if you asked for this message. An agent cannot press this button.",
  ];
  return { title: TITLE, message: lines.filter((line): line is string => line !== null).join("\n") };
}

/** JSON with everything outside printable ASCII escaped: safe inside any script source read from stdin. */
function asciiJson(value: unknown): string {
  return JSON.stringify(value).replace(/[^\x20-\x7e]/g, (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`);
}

interface RunOutput {
  code: number | null;
  stdout: string;
  error: NodeJS.ErrnoException | null;
}

function run(command: string, args: string[], input: string, timeoutMs: number, signal?: AbortSignal, env?: NodeJS.ProcessEnv): Promise<RunOutput> {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"], windowsHide: false, shell: false, env: env ?? process.env });
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

/**
 * The scripts print `bb-exchange-mail:<answer>`. Looking for the marker, not
 * comparing the whole output, keeps terminal noise a shell may add from
 * turning a Send into a refusal; anything without it counts as no answer.
 */
const ANSWER = /bb-exchange-mail:(send|cancel|timeout|nogui|error)\b/;
export function answerOf(stdout: string): "send" | "cancel" | "timeout" | null {
  const found = ANSWER.exec(stdout)?.[1];
  return found === "send" || found === "cancel" || found === "timeout" ? found : null;
}

const unavailable = (message: string): ConfirmOutcome => ({ ok: false, reason: "unavailable", message });
const cancelled: ConfirmOutcome = { ok: false, reason: "cancelled", message: "You did not confirm sending in the system window. Nothing was sent." };
const timedOut: ConfirmOutcome = { ok: false, reason: "timeout", message: "Nobody answered the system window in time. Nothing was sent." };
const RUN_LIMIT_MS = (CONFIRM_TIMEOUT_S + 30) * 1000;

// ---------------------------------------------------------------------- macOS

/** JXA: Standard Additions `display dialog`, Cancel is the default and the Escape button. */
export function macScript(text: { title: string; message: string }): string {
  return [
    "var app = Application.currentApplication();",
    "app.includeStandardAdditions = true;",
    `var data = ${asciiJson(text)};`,
    "var answer;",
    "try { app.activate(); } catch (e) {}",
    "try {",
    `  var r = app.displayDialog(data.message, { withTitle: data.title, buttons: ["Cancel", "Send"], defaultButton: "Cancel", cancelButton: "Cancel", withIcon: "caution", givingUpAfter: ${CONFIRM_TIMEOUT_S} });`,
    '  answer = r.gaveUp ? "timeout" : r.buttonReturned === "Send" ? "send" : "cancel";',
    "} catch (e) {",
    '  answer = e.errorNumber === -128 ? "cancel" : "error";',
    "}",
    '"bb-exchange-mail:" + answer;',
    "",
  ].join("\n");
}

function macConfirmer(): SendConfirmer {
  return {
    async confirm(summary, signal) {
      const result = await run("/usr/bin/osascript", ["-l", "JavaScript", "-"], macScript(confirmationText(summary)), RUN_LIMIT_MS, signal);
      const answer = answerOf(result.stdout);
      if (answer === "send" && result.code === 0) return { ok: true };
      if (answer === "cancel") return cancelled;
      if (answer === "timeout") return timedOut;
      return unavailable(
        "bb could not show the confirmation window on this Mac (no desktop session, or the window was blocked), so nothing was sent. Send it from Outlook, or sign in to this Mac's desktop and try again.",
      );
    },
  };
}

// -------------------------------------------------------------------- Windows

/** The WinForms window. Enter means Cancel: sending takes a deliberate click on Send. */
export function windowsScript(text: { title: string; message: string }): string {
  const data = Buffer.from(JSON.stringify(text), "utf8").toString("base64");
  const script = String.raw`
$ErrorActionPreference = 'Stop'
try {
  if (-not [Environment]::UserInteractive -or [System.Diagnostics.Process]::GetCurrentProcess().SessionId -eq 0) { [Console]::Out.Write('bb-exchange-mail:nogui'); return }
  Add-Type -AssemblyName System.Windows.Forms
  Add-Type -AssemblyName System.Drawing
  [System.Windows.Forms.Application]::EnableVisualStyles()
  $d = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${data}')) | ConvertFrom-Json
  $form = New-Object System.Windows.Forms.Form
  $form.Text = $d.title
  $form.TopMost = $true
  $form.ShowInTaskbar = $true
  $form.StartPosition = 'CenterScreen'
  $form.FormBorderStyle = 'FixedDialog'
  $form.MinimizeBox = $false
  $form.MaximizeBox = $false
  $form.ClientSize = New-Object System.Drawing.Size(600, 460)
  $box = New-Object System.Windows.Forms.TextBox
  $box.Multiline = $true
  $box.ReadOnly = $true
  $box.ScrollBars = 'Vertical'
  $box.WordWrap = $true
  $box.Text = ($d.message -split "\r?\n") -join [Environment]::NewLine
  $box.SetBounds(12, 12, 576, 390)
  $send = New-Object System.Windows.Forms.Button
  $send.Text = 'Send'
  $send.SetBounds(412, 414, 85, 32)
  $send.DialogResult = [System.Windows.Forms.DialogResult]::Yes
  $cancel = New-Object System.Windows.Forms.Button
  $cancel.Text = 'Cancel'
  $cancel.SetBounds(503, 414, 85, 32)
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
  if ($form.Tag -eq 'timeout') { [Console]::Out.Write('bb-exchange-mail:timeout') }
  elseif ($result -eq [System.Windows.Forms.DialogResult]::Yes) { [Console]::Out.Write('bb-exchange-mail:send') }
  else { [Console]::Out.Write('bb-exchange-mail:cancel') }
} catch {
  [Console]::Out.Write('bb-exchange-mail:error')
}
`;
  // One line on stdin: PowerShell reads `-Command -` line by line, so the
  // script travels encoded and is parsed whole.
  const encoded = Buffer.from(script, "utf8").toString("base64");
  return `& ([ScriptBlock]::Create([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encoded}'))))\n`;
}

function windowsConfirmer(): SendConfirmer {
  const powershell = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  return {
    async confirm(summary, signal) {
      const result = await run(powershell, ["-NoProfile", "-NonInteractive", "-STA", "-Command", "-"], windowsScript(confirmationText(summary)), RUN_LIMIT_MS, signal);
      const answer = answerOf(result.stdout);
      if (answer === "send") return { ok: true };
      if (answer === "cancel") return cancelled;
      if (answer === "timeout") return timedOut;
      return unavailable(
        "bb could not show the confirmation window on this computer (no desktop session, or PowerShell is blocked by a company policy), so nothing was sent. Send it from Outlook instead.",
      );
    },
  };
}

// ---------------------------------------------------------------------- Linux

function linuxConfirmer(env: NodeJS.ProcessEnv): SendConfirmer {
  return {
    async confirm(summary, signal) {
      if (!env.DISPLAY && !env.WAYLAND_DISPLAY) {
        return unavailable("This machine has no desktop session to show the confirmation window, so nothing was sent. Send it from Outlook instead.");
      }
      const text = confirmationText(summary);
      // --text-info reads the text from stdin; only the fixed title is an argument.
      const result = await run(
        "zenity",
        ["--text-info", `--title=${text.title}`, "--ok-label=Send", "--cancel-label=Cancel", "--width=600", "--height=480", `--timeout=${CONFIRM_TIMEOUT_S}`],
        `${text.message}\n`,
        RUN_LIMIT_MS,
        signal,
      );
      if (result.error) return unavailable("zenity is not installed, so bb cannot ask in a system window and nothing was sent. Send it from Outlook instead.");
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

/** One window at a time: a burst of send calls cannot stack windows for the person to click through. */
export function oneAtATime(inner: SendConfirmer): SendConfirmer {
  let open = false;
  return {
    async confirm(summary, signal) {
      if (open) return { ok: false, reason: "cancelled", message: "Another send is waiting for confirmation in a system window. Answer it first." };
      open = true;
      try {
        return await inner.confirm(summary, signal);
      } finally {
        open = false;
      }
    },
  };
}
