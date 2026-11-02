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
import { MAX_SEND_CHARS, type ChatKind, type Lang } from "../../contract.js";
import { hasHiddenCharacters, oneLine } from "../shared/untrusted.js";

/** Who the window names: the directory's words, so two people with one name differ. */
export interface Recipient {
  readonly chat: string;
  readonly kind: ChatKind;
  readonly members: number;
  readonly person: { readonly position: string | null; readonly department: string | null; readonly email: string | null } | null;
}

export interface SendSummary extends Recipient {
  readonly text: string;
}

export interface RuleSummary extends Recipient {
  readonly last: number;
  readonly cooldownMinutes: number;
  readonly note: string | null;
}

export type ConfirmOutcome = { readonly ok: true } | { readonly ok: false; readonly reason: "cancelled" | "timeout" | "unavailable" | "busy"; readonly message: string };

export interface SendConfirmer {
  confirm(summary: SendSummary, signal?: AbortSignal, lang?: Lang): Promise<ConfirmOutcome>;
  confirmRule(summary: RuleSummary, signal?: AbortSignal, lang?: Lang): Promise<ConfirmOutcome>;
}

export const CONFIRM_TIMEOUT_S = 180;
/** What fits a window on a small laptop screen: lines as they wrap at about this many characters. */
export const WINDOW_LINE_CHARS = 60;
export const MAX_WINDOW_LINES = 30;
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
    warning: "An agent wants to send this from your name. Check the chat and the text. Send?",
    scroll: "Scroll to the end of the text to turn the button on.",
    ruleTitle: "Express Messenger: add this watch rule?",
    ruleAdd: "Add rule",
    ruleWatch: "Watch",
    ruleEffect: (last: number, minutes: number) => `When this chat gets unread messages, bb starts a thread that reads the last ${last} messages and tells you what is going on, at most once in ${minutes} min.`,
    ruleNote: "Note for the digest",
    ruleWarning: "Check the chat and the note. Add the rule?",
  },
  ru: {
    title: "Express Messenger: отправить сообщение?",
    send: "Отправить",
    cancel: "Отмена",
    kind: { personal: "Личный чат", group: "Групповой чат", channel: "Канал", bot: "Бот", notes: "Заметки", other: "Чат" } satisfies Record<ChatKind, string>,
    members: (n: number) => `участников: ${n}`,
    to: "Кому",
    text: (n: number) => `Текст (символов: ${n})`,
    warning: "Агент хочет отправить это от вашего имени. Проверьте чат и текст. Отправить?",
    scroll: "Дочитайте текст до конца, и кнопка включится.",
    ruleTitle: "Express Messenger: добавить правило сторожа?",
    ruleAdd: "Добавить",
    ruleWatch: "Следить",
    ruleEffect: (last: number, minutes: number) => `Когда в этом чате появится непрочитанное, bb заведёт тред: он прочитает последние сообщения (${last}) и расскажет, что там происходит, не чаще раза в ${minutes} мин.`,
    ruleNote: "Заметка к пересказу",
    ruleWarning: "Проверьте чат и заметку. Добавить правило?",
  },
};

/**
 * Why a text cannot go through the window, or null: the window shows every character or nothing
 * goes. Invisible and direction-changing characters are refused, because a person could not check
 * them; an overlong text is refused, because a window that cuts it would ask about less than is sent.
 */
/** Lines as a window wraps them. A blank line takes a line too. */
export function windowLines(text: string): number {
  return text.split("\n").reduce((sum, line) => sum + Math.max(1, Math.ceil(line.length / WINDOW_LINE_CHARS)), 0);
}

export function windowRefusal(text: string): string | null {
  if (hasHiddenCharacters(text)) return "The text has invisible or direction-changing characters, and the confirmation window could not show it as it is. Rewrite it without them.";
  if (text.length > MAX_SEND_CHARS) return `The text is ${text.length} characters, and the confirmation window shows at most ${MAX_SEND_CHARS}. Shorten it, or split it in parts the user asks for one by one.`;
  const lines = windowLines(text);
  if (lines > MAX_WINDOW_LINES) return `The text takes ${lines} lines, and the confirmation window shows at most ${MAX_WINDOW_LINES}. Shorten it, or split it in parts the user asks for one by one.`;
  return null;
}

function recipientLines(recipient: Recipient, w: (typeof WORDS)[Lang], head: string): string[] {
  const where = [w.kind[recipient.kind], recipient.kind === "group" || recipient.kind === "channel" ? w.members(recipient.members) : null].filter(Boolean).join(", ");
  const person = recipient.person;
  const job = person ? [person.position, person.department].filter((part): part is string => !!part).map((part) => oneLine(part)).join(", ") : "";
  // A name of invisible characters only would leave the person nothing to check.
  return [`${head}: ${oneLine(recipient.chat) || "?"} (${where})`, ...(job ? [job] : []), ...(person?.email ? [oneLine(person.email)] : [])];
}

/** The window's text and buttons. Exported for tests: the person must see where it goes and all of what goes. */
export function confirmationText(summary: SendSummary, lang: Lang = "en"): { title: string; message: string; send: string; cancel: string; scroll: string } {
  const w = WORDS[lang];
  const text = summary.text.trim();
  const lines = [...recipientLines(summary, w, w.to), "", `${w.text(text.length)}:`, text, "", w.warning];
  return { title: w.title, message: lines.join("\n"), send: w.send, cancel: w.cancel, scroll: w.scroll };
}

export function ruleConfirmationText(summary: RuleSummary, lang: Lang = "en"): WindowText {
  const w = WORDS[lang];
  const lines = [...recipientLines(summary, w, w.ruleWatch), "", w.ruleEffect(summary.last, summary.cooldownMinutes), ...(summary.note ? ["", `${w.ruleNote}:`, summary.note] : []), "", w.ruleWarning];
  return { title: w.ruleTitle, message: lines.join("\n"), send: w.ruleAdd, cancel: w.cancel, scroll: w.scroll };
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

/** What a window answered. `unavailable` says why it did not open. */
type Asked = "send" | "cancel" | "timeout" | { readonly unavailable: string };
type Asker = (text: WindowText, signal?: AbortSignal) => Promise<Asked>;
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

function macAsker(): Asker {
  return async (text, signal) => {
    const result = await run("/usr/bin/osascript", ["-l", "JavaScript", "-"], macScript(text), RUN_LIMIT_MS, signal);
    const answer = answerOf(result.stdout);
    if (answer === "send" && result.code !== 0) return { unavailable: "bb could not show the confirmation window on this Mac." };
    return answer ?? { unavailable: "bb could not show the confirmation window on this Mac (no desktop session, or the window was blocked)." };
  };
}

/**
 * The WinForms window. Enter means Cancel: sending takes a click on Send. The window grows to hold
 * the whole text as it really wraps in this font, up to the height of the screen. Send stays off
 * until the last line has been on screen, so what does not fit cannot be confirmed unread; if
 * anything here fails, Send stays off and only Cancel works.
 */
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
  $box.Anchor = 'Top, Bottom, Left, Right'
  $hint = New-Object System.Windows.Forms.Label
  $hint.Text = $d.scroll
  $hint.SetBounds(12, 334, 350, 32)
  $hint.Anchor = 'Bottom, Left'
  $send = New-Object System.Windows.Forms.Button
  $send.Text = $d.send
  $send.SetBounds(372, 334, 85, 32)
  $send.Anchor = 'Bottom, Right'
  $send.Enabled = $false
  $send.DialogResult = [System.Windows.Forms.DialogResult]::Yes
  $cancel = New-Object System.Windows.Forms.Button
  $cancel.Text = $d.cancel
  $cancel.SetBounds(463, 334, 85, 32)
  $cancel.Anchor = 'Bottom, Right'
  $cancel.DialogResult = [System.Windows.Forms.DialogResult]::Cancel
  $form.Controls.AddRange(@($box, $hint, $send, $cancel))
  $form.AcceptButton = $cancel
  $form.CancelButton = $cancel
  $form.add_Load({
    try {
      $area = [System.Windows.Forms.Screen]::FromControl($form).WorkingArea
      $frame = $form.Height - $form.ClientSize.Height
      $want = ($box.GetLineFromCharIndex($box.TextLength - 1) + 1) * $box.Font.Height + 8
      $height = [Math]::Max(310, [Math]::Min($want, $area.Height - $frame - 70))
      $form.ClientSize = New-Object System.Drawing.Size(560, ($height + 70))
      $form.Top = [int]($area.Top + [Math]::Max(0, ($area.Height - $form.Height) / 2))
    } catch { }
  })
  $reached = New-Object System.Windows.Forms.Timer
  $reached.Interval = 200
  $reached.add_Tick({
    try {
      $end = $box.GetPositionFromCharIndex($box.TextLength - 1)
      if ($end.Y -ge 0 -and $end.Y -le ($box.ClientSize.Height - $box.Font.Height + 3)) {
        $reached.Stop()
        $hint.Visible = $false
        $send.Enabled = $true
      }
    } catch { $reached.Stop() }
  })
  $form.add_Shown({ $form.Activate(); [void]$cancel.Focus(); $reached.Start() })
  $timer = New-Object System.Windows.Forms.Timer
  $timer.Interval = ${CONFIRM_TIMEOUT_S * 1000}
  $timer.add_Tick({ $timer.Stop(); $form.Tag = 'timeout'; $form.Close() })
  $timer.Start()
  $result = $form.ShowDialog()
  $timer.Stop()
  $reached.Stop()
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

function windowsAsker(): Asker {
  const powershell = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  return async (text, signal) => {
    const result = await run(powershell, ["-NoProfile", "-NonInteractive", "-STA", "-Command", "-"], windowsScript(text), RUN_LIMIT_MS, signal);
    return answerOf(result.stdout) ?? { unavailable: "bb could not show the confirmation window on this computer (no desktop session, or PowerShell is blocked by a policy)." };
  };
}

/** Tall enough for the whole text on a usual screen. zenity scrolls past that, and cannot hold its button back. */
export function linuxWindowHeight(message: string): number {
  return Math.min(900, Math.max(400, 110 + windowLines(message) * 20));
}

function linuxAsker(env: NodeJS.ProcessEnv): Asker {
  return async (text, signal) => {
    if (!env.DISPLAY && !env.WAYLAND_DISPLAY) return { unavailable: "This machine has no desktop session to show the confirmation window." };
    const result = await run(
      ZENITY,
      ["--text-info", `--title=${text.title}`, `--ok-label=${text.send}`, `--cancel-label=${text.cancel}`, "--width=560", `--height=${linuxWindowHeight(text.message)}`, `--timeout=${CONFIRM_TIMEOUT_S}`],
      `${text.message}\n`,
      RUN_LIMIT_MS,
      signal,
    );
    if (result.error) return { unavailable: `${ZENITY} is not installed, so bb cannot ask in a system window.` };
    if (result.code === 0) return "send";
    if (result.code === 1) return "cancel";
    if (result.code === 5) return "timeout";
    return { unavailable: "The confirmation window did not open." };
  };
}

function outcomeOf(asked: Asked, notConfirmed: string, nothing: string): ConfirmOutcome {
  if (asked === "send") return { ok: true };
  if (asked === "cancel") return { ok: false, reason: "cancelled", message: `${notConfirmed} ${nothing}` };
  if (asked === "timeout") return { ok: false, reason: "timeout", message: `Nobody answered the system window in time. ${nothing}` };
  return { ok: false, reason: "unavailable", message: `${asked.unavailable} ${nothing}` };
}

export function systemConfirmer(platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env): SendConfirmer {
  const ask = platform === "darwin" ? macAsker() : platform === "win32" ? windowsAsker() : linuxAsker(env);
  return {
    confirm: async (summary, signal, lang) => outcomeOf(await ask(confirmationText(summary, lang), signal), "The user did not confirm sending in the system window.", "Nothing was sent."),
    confirmRule: async (summary, signal, lang) => outcomeOf(await ask(ruleConfirmationText(summary, lang), signal), "The user did not confirm the watch rule in the system window.", "No rule was added."),
  };
}

/** One window at a time: a burst of requests cannot stack windows for the person to click through. */
export function oneAtATime(inner: SendConfirmer): SendConfirmer {
  let open = false;
  const guarded = async (work: () => Promise<ConfirmOutcome>): Promise<ConfirmOutcome> => {
    if (open) return { ok: false, reason: "busy", message: "Another request is waiting for confirmation in a system window. Answer it first." };
    open = true;
    try {
      return await work();
    } finally {
      open = false;
    }
  };
  return {
    confirm: (summary, signal, lang) => guarded(() => inner.confirm(summary, signal, lang)),
    confirmRule: (summary, signal, lang) => guarded(() => inner.confirmRule(summary, signal, lang)),
  };
}
