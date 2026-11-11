// What the system window says: the whole text or a refusal, and who the message goes to.
import { describe, expect, it } from "vitest";
import { confirmationText, linuxWindowHeight, MAX_WINDOW_LINES, oneAtATime, ruleConfirmationText, windowLines, windowRefusal, windowsScript, type SendConfirmer } from "../src/host/confirm";

const recipient = { chat: "Alexander Volkov", kind: "personal" as const, members: 2, person: { position: "Analyst", department: "Logistics", email: "a.volkov@example.com" } };

describe("confirmationText", () => {
  it("shows the whole text, with nothing cut", () => {
    const text = "x".repeat(1500);
    const { message } = confirmationText({ ...recipient, text });
    expect(message).toContain(text);
    expect(message).not.toContain("…");
  });

  it("tells two people with one name apart: position, department and address", () => {
    const { message } = confirmationText({ ...recipient, text: "Hello" });
    expect(message).toContain("To: Alexander Volkov (Personal chat)");
    expect(message).toContain("Analyst, Logistics");
    expect(message).toContain("a.volkov@example.com");
    const ru = confirmationText({ ...recipient, text: "Привет" }, "ru");
    expect(ru.message).toContain("Кому: Alexander Volkov (Личный чат)");
    expect(ru.send).toBe("Отправить");
  });

  it("names the message of the thread and the person mentioned, in one line each", () => {
    const rlo = String.fromCodePoint(0x202e);
    const group = { chat: "Release team", kind: "group" as const, members: 12, person: null };
    const thread = { from: "Dmitry Ivanov", at: null, preview: `When the release${rlo}\nreaches dev, tag me` };
    const mention = { name: "Alexander Volkov", position: "Analyst", department: "Logistics", email: "a.volkov@example.com" };
    const { title, message } = confirmationText({ ...group, text: "Done", thread, mention });
    expect(title).toBe("Express Messenger: answer in this thread?");
    expect(message).toContain("In the thread under the message (Dmitry Ivanov):");
    expect(message).toContain("«When the release reaches dev, tag me»");
    expect(message).not.toContain(rlo);
    expect(message).toContain("Mentions (they get a notification): Alexander Volkov, Analyst, Logistics");
    expect(message).toContain("a.volkov@example.com");
    const ru = confirmationText({ ...group, text: "Готово", thread, mention }, "ru");
    expect(ru.title).toBe("Express Messenger: ответить в этом треде?");
    expect(ru.message).toContain("Упоминание (человеку придёт уведомление): Alexander Volkov");
  });

  it("keeps a chat's name from changing how the window reads", () => {
    const rlo = String.fromCodePoint(0x202e);
    const { message } = confirmationText({ ...recipient, chat: `Team${rlo}\nAccountant`, person: null, text: "Hello" });
    expect(message).toContain("To: Team Accountant (Personal chat)");
    expect(message).not.toContain(rlo);
  });

  it("does not leave the name empty when it holds only characters nobody can see", () => {
    const { message } = confirmationText({ ...recipient, chat: String.fromCodePoint(0x3164, 0x2800), person: null, text: "Hello" });
    expect(message).toContain("To: ? (Personal chat)");
  });

  it("counts members for a group", () => {
    expect(confirmationText({ chat: "Team", kind: "group", members: 12, person: null, text: "Hi" }).message).toContain("Group chat, 12 members");
  });
});

describe("ruleConfirmationText", () => {
  it("says what the rule does, with the note in full", () => {
    const note = "Questions to me ".repeat(50).trim();
    const { title, message, send } = ruleConfirmationText({ ...recipient, last: 5, cooldownMinutes: 20, note });
    expect(title).toContain("watch rule");
    expect(send).toBe("Add rule");
    expect(message).toContain("Watch: Alexander Volkov");
    expect(message).toContain("a.volkov@example.com");
    expect(message).toContain("last 5 messages");
    expect(message).toContain("20 min");
    expect(message).toContain(note);
  });
});

describe("windowRefusal", () => {
  it("passes what the window shows in full", () => {
    expect(windowRefusal("Hello")).toBeNull();
    expect(windowRefusal("Two\nlines and a family emoji " + String.fromCodePoint(0x1f468, 0x200d, 0x1f469))).toBeNull();
    expect(windowRefusal("x".repeat(1500))).toBeNull();
  });

  it.each([
    ["direction override", 0x202e],
    ["zero-width space", 0x200b],
    ["byte order mark", 0xfeff],
    ["line separator", 0x2028],
    ["soft hyphen", 0xad],
    ["bell", 0x07],
    ["return", 0x0d],
    ["Hangul filler", 0x3164],
    ["blank braille pattern", 0x2800],
    ["tag letter", 0xe0061],
  ])("refuses a %s", (_name, code) => {
    expect(windowRefusal(`Pay ${String.fromCodePoint(code)}now`)).toContain("invisible or direction-changing");
  });

  it("refuses a text too long or too tall to show", () => {
    expect(windowRefusal("x".repeat(1501))).toContain("at most 1500");
    expect(windowRefusal(Array.from({ length: 31 }, () => "line").join("\n"))).toContain("at most 30");
    expect(windowRefusal(Array.from({ length: 16 }, () => "y".repeat(90)).join("\n"))).toContain("at most 30");
  });
});

describe("how tall the window is", () => {
  it("counts blank lines", () => {
    expect(windowLines("a\n\n\nb")).toBe(4);
    expect(windowRefusal(`a${"\n".repeat(MAX_WINDOW_LINES - 1)}b`)).toBeNull();
    expect(windowRefusal(`a${"\n".repeat(MAX_WINDOW_LINES)}b`)).toContain(`at most ${MAX_WINDOW_LINES}`);
  });

  it("zenity grows with the text, within a usual screen", () => {
    expect(linuxWindowHeight("short")).toBe(400);
    const { message } = confirmationText({ ...recipient, text: Array.from({ length: 30 }, () => "line").join("\n") });
    expect(linuxWindowHeight(message)).toBeGreaterThan(110 + 30 * 20);
    expect(linuxWindowHeight("\n".repeat(500))).toBe(900);
  });
});

describe("the Windows window", () => {
  const script = (text = "Hello") => {
    const outer = windowsScript(confirmationText({ ...recipient, text }, "ru"));
    return Buffer.from(/FromBase64String\('([^']+)'\)/.exec(outer)![1]!, "base64").toString("utf8");
  };

  it("carries the whole window text in UTF-8, with the hint in the person's language", () => {
    const data = JSON.parse(Buffer.from(/FromBase64String\('([^']+)'\)/.exec(script("Привет"))![1]!, "base64").toString("utf8"));
    expect(data.message).toContain("Привет");
    expect(data.scroll).toContain("Дочитайте");
  });

  it("holds Send back until the last line has been on screen, and never turns it on elsewhere", () => {
    const body = script();
    expect(body).toContain("$send.Enabled = $false");
    expect(body.match(/\$send\.Enabled = \$true/g)).toHaveLength(1);
    const gate = body.indexOf("GetPositionFromCharIndex($box.TextLength - 1)");
    expect(gate).toBeGreaterThan(-1);
    expect(body.indexOf("$send.Enabled = $true")).toBeGreaterThan(gate);
    // Enter and Escape stay on Cancel.
    expect(body).toContain("$form.AcceptButton = $cancel");
    expect(body).toContain("$form.CancelButton = $cancel");
  });

  it("sizes itself by the lines as they really wrap, blank ones included, within the screen", () => {
    const body = script();
    expect(body).toContain("$box.GetLineFromCharIndex($box.TextLength - 1) + 1");
    expect(body).toContain("WorkingArea");
    expect(body).not.toContain("SetBounds(12, 12, 536, 310)\n  $send");
  });
});

describe("oneAtATime", () => {
  it("does not stack a rule's window on a send's", async () => {
    let release = () => {};
    const inner: SendConfirmer = {
      confirm: () => new Promise((resolve) => (release = () => resolve({ ok: true }))),
      confirmRule: async () => ({ ok: true }),
    };
    const guarded = oneAtATime(inner);
    const first = guarded.confirm({ ...recipient, text: "Hello" });
    expect(await guarded.confirmRule({ ...recipient, last: 1, cooldownMinutes: 1, note: null })).toMatchObject({ ok: false, reason: "busy" });
    release();
    expect(await first).toEqual({ ok: true });
    expect(await guarded.confirmRule({ ...recipient, last: 1, cooldownMinutes: 1, note: null })).toEqual({ ok: true });
  });
});
