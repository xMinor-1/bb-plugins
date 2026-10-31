// The host's guards without Exchange: the password stays with its address and
// login, sign-in after a refusal is rate-limited and single-flight, and the
// system window that confirms a send names everything that goes.
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { answerOf, confirmationText, macScript, oneAtATime, systemConfirmer, windowsScript, ZENITY, type SendConfirmer, type SendSummary } from "../src/host/confirm";
import type { HttpRequest, HttpResponse, Transport } from "../src/host/curl";
import { normalizeEwsUrl } from "../src/host/ews/client";
import { openFileSecretStore, type SecretStore } from "../src/host/secret-store";
import { MailService } from "../src/host/service";
import { accountName, RETRY_AFTER_MS } from "../src/host/signin";

const URL_A = "https://mail-a.example.test/EWS/Exchange.asmx";
const URL_B = "https://mail-b.example.test/EWS/Exchange.asmx";
const GOOD = "right horse battery";

const soap = (body: string) =>
  `<?xml version="1.0" encoding="utf-8"?><s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body xmlns:m="http://schemas.microsoft.com/exchange/services/2006/messages" xmlns:t="http://schemas.microsoft.com/exchange/services/2006/types">${body}</s:Body></s:Envelope>`;
const ok = (op: string, inner: string) =>
  soap(`<m:${op}Response><m:ResponseMessages><m:${op}ResponseMessage ResponseClass="Success"><m:ResponseCode>NoError</m:ResponseCode>${inner}</m:${op}ResponseMessage></m:ResponseMessages></m:${op}Response>`);

/** Exchange that accepts one password for any login, counts sign-ins and can hold answers back. */
function fakeExchange() {
  const state = { attempts: 0, refused: 0, inFlight: 0, maxInFlight: 0 };
  let accepted = GOOD;
  let hold: Promise<void> | null = null;
  let release: () => void = () => undefined;
  const transport: Transport = {
    info: async () => ({ path: "curl", version: "8.0", features: ["NTLM", "SPNEGO"] }),
    async send(request: HttpRequest): Promise<HttpResponse> {
      state.attempts++;
      state.inFlight++;
      state.maxInFlight = Math.max(state.maxInFlight, state.inFlight);
      try {
        if (hold) await hold;
        if (request.auth.kind !== "ntlm" || request.auth.password !== accepted) {
          state.refused++;
          return { status: 401, body: "" };
        }
        if (request.body.includes("<m:GetFolder")) return { status: 200, body: ok("GetFolder", "<m:Folders><t:Folder><t:TotalCount>3</t:TotalCount><t:UnreadCount>1</t:UnreadCount></t:Folder></m:Folders>") };
        if (request.body.includes("<m:FindItem")) return { status: 200, body: ok("FindItem", '<m:RootFolder TotalItemsInView="0" IncludesLastItemInRange="true"><t:Items/></m:RootFolder>') };
        return { status: 500, body: soap("<s:Fault><faultstring>not in this fake</faultstring></s:Fault>") };
      } finally {
        state.inFlight--;
      }
    },
  };
  return {
    state,
    transport,
    hold() {
      hold = new Promise((resolve) => (release = resolve));
    },
    release() {
      hold = null;
      release();
    },
    reset() {
      Object.assign(state, { attempts: 0, refused: 0, inFlight: 0, maxInFlight: 0 });
    },
    /** The domain stops taking the password bb has: it expired, or someone changed it elsewhere. */
    changePassword(next: string) {
      accepted = next;
    },
  };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 60));

let dir: string;
let secrets: SecretStore;
let exchange: ReturnType<typeof fakeExchange>;
let clock: number;
const open = (options: { allowLocalHttp?: boolean } = {}) =>
  new MailService({ dataDir: join(dir, "data"), transport: exchange.transport, secrets, now: () => clock, platform: "linux", ...options });

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "exchange-mail-unit-"));
  secrets = openFileSecretStore(join(dir, "secrets"));
  exchange = fakeExchange();
  clock = Date.UTC(2026, 9, 31, 9, 0);
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("the password belongs to its address and login", () => {
  it("is deleted and asked for again when the address changes", async () => {
    const service = open();
    expect((await service.saveConnection({ url: URL_A, auth: "password", user: "STUB\\alice", password: GOOD })).hasPassword).toBe(true);
    await expect(service.saveConnection({ url: URL_B, auth: "password", user: "STUB\\alice" })).rejects.toThrow(/previous address or login/);
    expect(await secrets.has("password")).toBe(false);
    expect((await service.status()).hasPassword).toBe(false);
    expect(exchange.state.attempts).toBe(0);
  });

  it("is deleted and asked for again when the login changes", async () => {
    const service = open();
    await service.saveConnection({ url: URL_A, auth: "password", user: "STUB\\alice", password: GOOD });
    await expect(service.saveConnection({ url: URL_A, auth: "password", user: "STUB\\bob" })).rejects.toThrow(/previous address or login/);
    expect(await secrets.has("password")).toBe(false);
  });

  it("stays when the same address and login are saved again", async () => {
    const service = open();
    await service.saveConnection({ url: URL_A, auth: "password", user: "STUB\\alice", password: GOOD });
    expect((await service.saveConnection({ url: URL_A, auth: "password", user: "STUB\\alice" })).hasPassword).toBe(true);
    expect((await service.check()).ok).toBe(true);
  });

  it("is never taken over from an earlier connection on this machine", async () => {
    await secrets.set("password", Buffer.from(GOOD).toString("base64"));
    await expect(open().saveConnection({ url: URL_A, auth: "password", user: "STUB\\alice" })).rejects.toThrow(/Enter the password/);
    expect(await secrets.has("password")).toBe(false);
  });

  it("is not sent when the saved connection points elsewhere than where it was typed", async () => {
    const service = open();
    await service.saveConnection({ url: URL_A, auth: "password", user: "STUB\\alice", password: GOOD });
    const file = join(dir, "data", "connection.json");
    const saved = JSON.parse(await readFile(file, "utf8"));
    await writeFile(file, JSON.stringify({ ...saved, url: URL_B }));
    expect((await service.check()).message).toMatch(/password is missing/);
    expect(exchange.state.attempts).toBe(0);
    expect(await secrets.has("password")).toBe(false);
  });

  it("only goes over plain http to this machine under the dev flag", async () => {
    await expect(open().saveConnection({ url: "http://localhost:8080/EWS/Exchange.asmx", auth: "negotiate" })).rejects.toThrow(/https/);
    expect(() => normalizeEwsUrl("http://127.0.0.1:8080")).toThrow(/https/);
    expect(normalizeEwsUrl("http://127.0.0.1:8080", { allowLocalHttp: true })).toBe("http://127.0.0.1:8080/EWS/Exchange.asmx");
    expect(() => normalizeEwsUrl("http://mail.example.test", { allowLocalHttp: true })).toThrow(/https/);
    expect((await open({ allowLocalHttp: true }).saveConnection({ url: "http://localhost:8080", auth: "negotiate" })).url).toBe("http://localhost:8080/EWS/Exchange.asmx");
  });
});

describe("signing in after Exchange refused the password", () => {
  it("is paused for everyone for 15 minutes — Try again and a new password included", async () => {
    const service = open();
    await service.saveConnection({ url: URL_A, auth: "password", user: "STUB\\alice", password: "wrong" });
    expect((await service.check()).ok).toBe(false);
    expect(exchange.state.refused).toBe(1);
    const status = await service.status();
    expect(status.blocked).toMatch(/did not accept/);
    expect(status.retryAt).toBe(clock + RETRY_AFTER_MS);

    expect(await service.tool({ tool: "list" })).toMatchObject({ isError: true, text: expect.stringMatching(/paused.*no earlier than/s) });
    expect((await service.check(true)).message).toMatch(/no earlier than/);
    await service.saveConnection({ url: URL_A, auth: "password", user: "STUB\\alice", password: GOOD });
    expect((await service.check()).message).toMatch(/no earlier than/);
    clock += RETRY_AFTER_MS - 1000;
    expect((await service.check(true)).ok).toBe(false);
    expect(exchange.state.attempts).toBe(1);

    clock += 1000;
    // The password changed since the refusal: the first call after the pause tries it, once.
    expect((await service.check()).ok).toBe(true);
    expect(exchange.state.attempts).toBe(2);
    expect((await service.status()).blocked).toBeNull();
  });

  it("never retries the refused password by itself, only when someone asks — and then at most once per pause", async () => {
    const service = open();
    await service.saveConnection({ url: URL_A, auth: "password", user: "STUB\\alice", password: "wrong" });
    await service.check();
    clock += RETRY_AFTER_MS;
    expect((await service.tool({ tool: "list" })).text).toMatch(/Enter the password again/);
    expect(exchange.state.attempts).toBe(1);
    expect((await service.check(true)).ok).toBe(false);
    expect(exchange.state.attempts).toBe(2);
    expect((await service.status()).retryAt).toBe(clock + RETRY_AFTER_MS);
    expect((await service.check(true)).message).toMatch(/no earlier than/);
    expect(exchange.state.attempts).toBe(2);
  });

  it("outlasts a restart, Disconnect and another way of typing the same login", async () => {
    const first = open();
    await first.saveConnection({ url: URL_A, auth: "password", user: "STUB\\alice", password: "wrong" });
    await first.check();
    const restarted = open();
    expect((await restarted.check(true)).message).toMatch(/no earlier than/);
    await restarted.forget();
    await restarted.saveConnection({ url: URL_B, auth: "password", user: "Alice@stub.example.test", password: GOOD });
    expect((await restarted.check()).message).toMatch(/no earlier than/);
    expect(exchange.state.attempts).toBe(1);
    expect(accountName("STUB\\Alice")).toBe(accountName("alice@stub.example.test"));
  });

  it("does not hold back another login, which is another account", async () => {
    const service = open();
    await service.saveConnection({ url: URL_A, auth: "password", user: "STUB\\alice", password: "wrong" });
    await service.check();
    await service.saveConnection({ url: URL_A, auth: "password", user: "STUB\\bob", password: GOOD });
    expect((await service.check()).ok).toBe(true);
  });
});

describe("one sign-in at a time", () => {
  it("sends a wrong password once, however many calls arrive together", async () => {
    const service = open();
    await service.saveConnection({ url: URL_A, auth: "password", user: "STUB\\alice", password: "wrong" });
    exchange.hold();
    const calls = Promise.all([
      service.list({ folder: "inbox" }).catch((error: Error) => error.message),
      service.list({ folder: "sent" }).catch((error: Error) => error.message),
      service.tool({ tool: "search", query: "budget" }),
      service.check(),
    ]);
    await settle();
    expect(exchange.state.inFlight).toBe(1);
    exchange.release();
    const [inbox, sent, search, check] = await calls;
    expect(exchange.state.attempts).toBe(1);
    expect(exchange.state.refused).toBe(1);
    for (const message of [inbox, sent, search.text, check.message]) expect(message).toMatch(/did not accept|paused/);
  });

  it("keeps going one at a time after a sign-in worked", async () => {
    const service = open();
    await service.saveConnection({ url: URL_A, auth: "password", user: "STUB\\alice", password: GOOD });
    expect((await service.check()).ok).toBe(true);
    exchange.reset();
    exchange.hold();
    const calls = Promise.all([service.list({ folder: "inbox" }), service.list({ folder: "sent" }), service.tool({ tool: "search", query: "budget" })]);
    await settle();
    expect(exchange.state.inFlight).toBe(1);
    exchange.release();
    await calls;
    expect(exchange.state.attempts).toBeGreaterThan(3);
    expect(exchange.state.maxInFlight).toBe(1);
  });

  it("stops everyone else at the first refusal, even a second after a sign-in worked", async () => {
    const service = open();
    await service.saveConnection({ url: URL_A, auth: "password", user: "STUB\\alice", password: GOOD });
    expect((await service.check()).ok).toBe(true);
    clock += 1000;
    exchange.changePassword("changed elsewhere");
    exchange.reset();
    exchange.hold();
    const calls = Promise.all([
      service.list({ folder: "inbox" }).catch((error: Error) => error.message),
      service.list({ folder: "sent" }).catch((error: Error) => error.message),
      service.tool({ tool: "search", query: "budget" }),
      service.check(),
    ]);
    await settle();
    expect(exchange.state.inFlight).toBe(1);
    exchange.release();
    const [inbox, sent, search, check] = await calls;
    expect(exchange.state.refused).toBe(1);
    expect(exchange.state.attempts).toBe(1);
    for (const message of [inbox, sent, search.text, check.message]) expect(message).toMatch(/did not accept|paused/);
    expect((await service.status()).retryAt).toBe(clock + RETRY_AFTER_MS);
  });
});

describe("the system window that confirms a send", () => {
  const summary: SendSummary = {
    kind: "replyAll",
    mailbox: "STUB\\alice",
    subject: "RE: Квартальный отчёт",
    to: [{ name: "Bob Builder", email: "bob@example.test" }],
    cc: [{ name: null, email: "carol@example.test" }],
    bcc: [{ name: "Hidden Watcher", email: "watcher@example.test" }],
    attachments: [{ name: "numbers.xlsx", size: 2048 }],
    bodyFormat: "html",
    text: "Привет, Боб! Цифры проверю к пятнице.",
    quotedChars: 120,
  };

  it("names every recipient, Bcc included, the attachments, the format and the start of the text", () => {
    const { title, message } = confirmationText(summary);
    expect(title).toMatch(/send this message/);
    expect(message).toContain("Reply to all from STUB\\alice");
    expect(message).toContain("To (1): Bob Builder <bob@example.test>");
    expect(message).toContain("Cc (1): carol@example.test");
    expect(message).toContain("Bcc (1): Hidden Watcher <watcher@example.test>");
    expect(message).toContain("Attachments (1): numbers.xlsx");
    expect(message).toMatch(/Format: HTML/);
    expect(message).toContain("Text (37 characters):\nПривет, Боб! Цифры проверю к пятнице.");
    expect(message).not.toContain("Only the start");
    expect(message).toContain("quoted message (120 characters)");
  });

  it("asks the person to check, and promises nothing about who can press the button", () => {
    for (const lang of ["en", "ru"] as const) {
      const { message } = confirmationText(summary, lang);
      expect(message).not.toMatch(/agent|агент/i);
      expect(message.split("\n").at(-1)).toBe(lang === "en" ? "Check the recipients and the text. Send this message?" : "Проверьте получателей и текст. Отправить письмо?");
    }
  });

  it("speaks the panel's language, buttons included", () => {
    const ru = confirmationText(summary, "ru");
    expect(ru).toMatchObject({ title: "Exchange Mail: отправить письмо?", send: "Отправить", cancel: "Отмена" });
    expect(ru.message).toContain("Скрытая копия (1): Hidden Watcher <watcher@example.test>");
    expect(ru.message).toContain("Вложения (1): numbers.xlsx");
    expect(confirmationText(summary).send).toBe("Send");
    const mac = macScript(ru);
    expect(/^[\x09\x0a\x20-\x7e]*$/.test(mac)).toBe(true);
    expect(mac).toContain("buttons: [data.cancel, data.send]");
  });

  it("counts long lists and cuts long text instead of hiding them", () => {
    const many = Array.from({ length: 40 }, (_, n) => ({ name: null, email: `p${n}@example.test` }));
    const { message } = confirmationText({ ...summary, bcc: many, text: "x".repeat(5000), attachments: [], bodyFormat: "text" });
    expect(message).toContain("Bcc (40): p0@example.test");
    expect(message).toContain("and 15 more");
    expect(message).toContain("Attachments: none");
    expect(message).toContain("Text (5000 characters):\nxxx");
    expect(message).toMatch(/x…\n\[Only the start is shown here: 700 of 5000 characters\. The whole text is in the draft card in bb\.\]/);
    expect(message.length).toBeLessThan(3000);
    const ru = confirmationText({ ...summary, text: "ж".repeat(1234) }, "ru").message;
    expect(ru).toContain("Текст (символов: 1234):");
    expect(ru).toContain("[Здесь только начало: 700 из 1234 символов. Весь текст — в карточке черновика в bb.]");
  });

  it("keeps mail out of process arguments: scripts carry it as ASCII on stdin", () => {
    const text = confirmationText(summary);
    const mac = macScript(text);
    expect(/^[\x09\x0a\x20-\x7e]*$/.test(mac)).toBe(true);
    expect(() => new Function(mac)).not.toThrow();
    expect(JSON.parse(/var data = (.*);\n/.exec(mac)![1]!)).toEqual(text);
    expect(mac).toContain("defaultButton: data.cancel");

    const windows = windowsScript(text);
    expect(windows.split("\n").filter(Boolean)).toHaveLength(1);
    expect(/^[\x20-\x7e]*\n$/.test(windows)).toBe(true);
    const inner = Buffer.from(/FromBase64String\('([^']+)'\)/.exec(windows)![1]!, "base64").toString("utf8");
    const data = Buffer.from(/FromBase64String\('([^']+)'\)/.exec(inner)![1]!, "base64").toString("utf8");
    expect(JSON.parse(data)).toEqual(text);
    expect(inner).toContain("$form.AcceptButton = $cancel");
  });

  it("reads only its own answer from the script output", () => {
    expect(answerOf("\u001b[?1hbb-exchange-mail:send\u001b[?1h")).toBe("send");
    expect(answerOf("bb-exchange-mail:cancel")).toBe("cancel");
    expect(answerOf("send")).toBeNull();
    expect(answerOf("bb-exchange-mail:error")).toBeNull();
    expect(answerOf("")).toBeNull();
  });

  it("refuses when there is no desktop to show it on", async () => {
    expect(await systemConfirmer("linux", {}).confirm(summary)).toMatchObject({ ok: false, reason: "unavailable" });
  });

  it("calls zenity by its absolute path, never the one PATH points to", async () => {
    expect(ZENITY).toBe("/usr/bin/zenity");
    // A "zenity" that answers Send, first in PATH: what an agent's shell could set up.
    const bin = join(dir, "bin");
    const marker = join(dir, "fake-zenity-ran");
    await mkdir(bin);
    await writeFile(join(bin, "zenity"), `#!/bin/sh\ntouch '${marker}'\nexit 0\n`, { mode: 0o755 });
    const outcome = await systemConfirmer("linux", { DISPLAY: ":99", PATH: bin }).confirm(summary);
    await expect(stat(marker)).rejects.toThrow();
    // Here there is no /usr/bin/zenity, or no display at :99: either way, nothing confirms the send.
    expect(outcome.ok).toBe(false);
  });

  it("opens one window at a time", async () => {
    let finish!: () => void;
    let shown = 0;
    const slow: SendConfirmer = {
      confirm: () => {
        shown++;
        return new Promise((resolve) => (finish = () => resolve({ ok: true })));
      },
    };
    const confirmer = oneAtATime(slow);
    const first = confirmer.confirm(summary);
    expect(await confirmer.confirm(summary)).toMatchObject({ ok: false, reason: "busy" });
    finish();
    expect(await first).toEqual({ ok: true });
    expect(shown).toBe(1);
  });
});
