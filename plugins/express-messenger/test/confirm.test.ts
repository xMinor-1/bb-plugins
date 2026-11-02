// What the system window says: the whole text or a refusal, and who the message goes to.
import { describe, expect, it } from "vitest";
import { confirmationText, oneAtATime, ruleConfirmationText, windowRefusal, type SendConfirmer } from "../src/host/confirm";

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

  it("keeps a chat's name from changing how the window reads", () => {
    const rlo = String.fromCodePoint(0x202e);
    const { message } = confirmationText({ ...recipient, chat: `Team${rlo}\nAccountant`, person: null, text: "Hello" });
    expect(message).toContain("To: Team Accountant (Personal chat)");
    expect(message).not.toContain(rlo);
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
  ])("refuses a %s", (_name, code) => {
    expect(windowRefusal(`Pay ${String.fromCodePoint(code)}now`)).toContain("invisible or direction-changing");
  });

  it("refuses a text too long or too tall to show", () => {
    expect(windowRefusal("x".repeat(1501))).toContain("at most 1500");
    expect(windowRefusal(Array.from({ length: 31 }, () => "line").join("\n"))).toContain("at most 30");
    expect(windowRefusal(Array.from({ length: 16 }, () => "y".repeat(90)).join("\n"))).toContain("at most 30");
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
