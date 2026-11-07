// A yes-or-no window drawn by the operating system on the machine that runs
// this bb, not by bb. bb cannot tell whether an RPC came from the panel, the
// CLI or an agent with a shell, so the panel's own button is not proof that a
// person decided. Turning "Own agents" on takes a press in this window too.
// That raises the bar; it is not a wall: on Windows and under X11 any program
// of the same user can press buttons in other windows, and on macOS one with
// the Accessibility permission can.
//
//   macOS    /usr/bin/osascript (JavaScript for Automation) `display dialog`
//   Windows  a WinForms window from Windows PowerShell in System32
//   Linux    /usr/bin/zenity, when a desktop session is present
//
// Every tool is called by its absolute path, never looked up in PATH. On macOS
// and Windows the text travels on stdin as ASCII-only source; zenity takes it
// as an argument (see zenityArgs). In every window the default button is No:
// Enter never turns own agents on.
// The same approach as Exchange Mail's send window (plugins/exchange-mail).
import { spawn } from "node:child_process";
import { join } from "node:path";

export interface WindowText {
  title: string;
  message: string;
  yes: string;
  no: string;
}

export type WindowOutcome =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: "cancelled" | "timeout" | "unavailable" | "busy" };

export interface ConfirmWindow {
  confirm(text: WindowText, signal?: AbortSignal): Promise<WindowOutcome>;
}

/** How long the window waits for the person before it counts as No. */
export const CONFIRM_TIMEOUT_S = 240;
export const ZENITY = "/usr/bin/zenity";
const RUN_LIMIT_MS = (CONFIRM_TIMEOUT_S + 30) * 1000;

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

/** The scripts print `bb-fleet-kit:<answer>`; anything without the marker counts as no answer. */
const ANSWER = /bb-fleet-kit:(yes|no|timeout|nogui|error)\b/;
export function answerOf(stdout: string): "yes" | "no" | "timeout" | null {
  const found = ANSWER.exec(stdout)?.[1];
  return found === "yes" || found === "no" || found === "timeout" ? found : null;
}

const outcomeOf = (answer: ReturnType<typeof answerOf>): WindowOutcome =>
  answer === "yes" ? { ok: true } : answer === "no" ? { ok: false, reason: "cancelled" } : answer === "timeout" ? { ok: false, reason: "timeout" } : { ok: false, reason: "unavailable" };

/** JXA: Standard Additions `display dialog`; No is the default and the Escape button. */
export function macScript(text: WindowText): string {
  return [
    "var app = Application.currentApplication();",
    "app.includeStandardAdditions = true;",
    `var data = ${asciiJson(text)};`,
    "var answer;",
    "try { app.activate(); } catch (e) {}",
    "try {",
    `  var r = app.displayDialog(data.message, { withTitle: data.title, buttons: [data.no, data.yes], defaultButton: data.no, cancelButton: data.no, withIcon: "caution", givingUpAfter: ${CONFIRM_TIMEOUT_S} });`,
    '  answer = r.gaveUp ? "timeout" : r.buttonReturned === data.yes ? "yes" : "no";',
    "} catch (e) {",
    '  answer = e.errorNumber === -128 ? "no" : "error";',
    "}",
    '"bb-fleet-kit:" + answer;',
    "",
  ].join("\n");
}

/** The WinForms window. Enter means No: turning on takes a deliberate click. */
export function windowsScript(text: WindowText): string {
  const data = Buffer.from(JSON.stringify(text), "utf8").toString("base64");
  const script = String.raw`
$ErrorActionPreference = 'Stop'
try {
  if (-not [Environment]::UserInteractive -or [System.Diagnostics.Process]::GetCurrentProcess().SessionId -eq 0) { [Console]::Out.Write('bb-fleet-kit:nogui'); return }
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
  $form.ClientSize = New-Object System.Drawing.Size(560, 340)
  $box = New-Object System.Windows.Forms.TextBox
  $box.Multiline = $true
  $box.ReadOnly = $true
  $box.ScrollBars = 'Vertical'
  $box.WordWrap = $true
  $box.Text = ($d.message -split "\r?\n") -join [Environment]::NewLine
  $box.SetBounds(12, 12, 536, 270)
  $yes = New-Object System.Windows.Forms.Button
  $yes.Text = $d.yes
  $yes.SetBounds(332, 294, 120, 32)
  $yes.DialogResult = [System.Windows.Forms.DialogResult]::Yes
  $no = New-Object System.Windows.Forms.Button
  $no.Text = $d.no
  $no.SetBounds(458, 294, 90, 32)
  $no.DialogResult = [System.Windows.Forms.DialogResult]::Cancel
  $form.Controls.AddRange(@($box, $yes, $no))
  $form.AcceptButton = $no
  $form.CancelButton = $no
  $form.add_Shown({ $form.Activate(); [void]$no.Focus() })
  $timer = New-Object System.Windows.Forms.Timer
  $timer.Interval = ${CONFIRM_TIMEOUT_S * 1000}
  $timer.add_Tick({ $timer.Stop(); $form.Tag = 'timeout'; $form.Close() })
  $timer.Start()
  $result = $form.ShowDialog()
  $timer.Stop()
  if ($form.Tag -eq 'timeout') { [Console]::Out.Write('bb-fleet-kit:timeout') }
  elseif ($result -eq [System.Windows.Forms.DialogResult]::Yes) { [Console]::Out.Write('bb-fleet-kit:yes') }
  else { [Console]::Out.Write('bb-fleet-kit:no') }
} catch {
  [Console]::Out.Write('bb-fleet-kit:error')
}
`;
  // One line on stdin: PowerShell reads `-Command -` line by line, so the script travels encoded and is parsed whole.
  const encoded = Buffer.from(script, "utf8").toString("base64");
  return `& ([ScriptBlock]::Create([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encoded}'))))\n`;
}

/** zenity's arguments: a question with No as the default button. */
export function zenityArgs(text: WindowText): string[] {
  return [
    "--question",
    "--default-cancel",
    "--no-markup",
    `--title=${text.title}`,
    `--text=${text.message}`,
    `--ok-label=${text.yes}`,
    `--cancel-label=${text.no}`,
    "--width=560",
    `--timeout=${CONFIRM_TIMEOUT_S}`,
  ];
}

export function systemConfirmWindow(platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env): ConfirmWindow {
  if (platform === "darwin") {
    return {
      async confirm(text, signal) {
        const result = await run("/usr/bin/osascript", ["-l", "JavaScript", "-"], macScript(text), RUN_LIMIT_MS, signal);
        const answer = answerOf(result.stdout);
        return outcomeOf(answer === "yes" && result.code !== 0 ? null : answer);
      },
    };
  }
  if (platform === "win32") {
    const powershell = join(env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
    return {
      async confirm(text, signal) {
        const result = await run(powershell, ["-NoProfile", "-NonInteractive", "-STA", "-Command", "-"], windowsScript(text), RUN_LIMIT_MS, signal);
        return outcomeOf(answerOf(result.stdout));
      },
    };
  }
  return {
    async confirm(text, signal) {
      if (!env.DISPLAY && !env.WAYLAND_DISPLAY) return { ok: false, reason: "unavailable" };
      // --question with --default-cancel: Enter and Space answer No, turning on takes a click on Yes.
      // (--text-info, which reads stdin, makes Enter answer Yes.) The text is an argument here: it is the
      // build's warning, shown to the person anyway, not a secret. --no-markup keeps "<" and "&" as text.
      const result = await run(
        ZENITY,
        zenityArgs(text),
        "",
        RUN_LIMIT_MS,
        signal,
        env,
      );
      if (result.error) return { ok: false, reason: "unavailable" };
      if (result.code === 0) return { ok: true };
      if (result.code === 1) return { ok: false, reason: "cancelled" };
      if (result.code === 5) return { ok: false, reason: "timeout" };
      return { ok: false, reason: "unavailable" };
    },
  };
}

/** One window at a time: a burst of calls cannot stack windows for the person to click through. */
export function oneAtATime(inner: ConfirmWindow): ConfirmWindow {
  let open = false;
  return {
    async confirm(text, signal) {
      if (open) return { ok: false, reason: "busy" };
      open = true;
      try {
        return await inner.confirm(text, signal);
      } finally {
        open = false;
      }
    },
  };
}
