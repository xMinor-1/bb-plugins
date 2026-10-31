// Known host failures reach the panel with a code and are shown in the panel's
// language; agents get the English text without any tag.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { explain, hostErrors } from "../src/app/errors";
import { TransportError, type Transport } from "../src/host/curl";
import { codeOf, forPanel, PANEL_CODES, UserError } from "../src/host/errors";
import { AuthError, normalizeEwsUrl } from "../src/host/ews/client";
import { EwsError } from "../src/host/ews/parse";
import { openFileSecretStore } from "../src/host/secret-store";
import { MailService } from "../src/host/service";
import { SignInPaused } from "../src/host/signin";

const thrown = (run: () => unknown): unknown => {
  try {
    run();
  } catch (error) {
    return error;
  }
  throw new Error("nothing was thrown");
};

describe("the host's failures, as the panel gets them", () => {
  it("puts the code, and the param if any, in front of the English text", () => {
    expect(forPanel(new UserError("Mail is not connected yet.", "not-connected"))).toBe("[mail:not-connected] Mail is not connected yet.");
    expect(forPanel(new SignInPaused("Mail sign-in is paused…", "signin-paused", 1_793_440_800_000))).toBe("[mail:signin-paused:1793440800000] Mail sign-in is paused…");
    expect(forPanel(new TransportError("unreachable", "Exchange is not reachable…", "Could not resolve host: mail.example.test"))).toBe(
      "[mail:unreachable:Could%20not%20resolve%20host%3A%20mail.example.test] Exchange is not reachable…",
    );
    expect(codeOf(new AuthError("Exchange did not accept the login and password.", "auth-refused"))).toEqual({ code: "auth-refused", param: null });
    expect(codeOf(new EwsError("Forbidden", "…"))).toEqual({ code: "ews-forbidden", param: null });
    expect(codeOf(thrown(() => normalizeEwsUrl("http://mail.example.test")))).toEqual({ code: "https-required", param: null });
    expect(codeOf(thrown(() => normalizeEwsUrl("https://bob:pw@mail.example.test")))).toEqual({ code: "login-in-address", param: null });
  });

  it("leaves failures without a code as they are", () => {
    expect(forPanel(new UserError('"x" is not an email address'))).toBe('"x" is not an email address');
    expect(forPanel(new EwsError("ErrorQuotaExceeded", "The mailbox is full"))).toBe("The mailbox is full");
    expect(forPanel(new TransportError("failed", "curl failed: exit 3"))).toBe("curl failed: exit 3");
    expect(forPanel("plain")).toBe("plain");
  });
});

describe("the panel's translations", () => {
  it("has every code the host sends, in both languages", () => {
    for (const code of PANEL_CODES) {
      for (const lang of ["en", "ru"] as const) {
        const shown = explain(hostErrors[lang], `[mail:${code}:1793440800000] English text`);
        expect(shown, `${lang} ${code}`).not.toContain("[mail:");
        expect(shown, `${lang} ${code}`).not.toBe("English text");
      }
    }
    expect(Object.keys(hostErrors.en).sort()).toEqual([...PANEL_CODES].sort());
  });

  it("says a known failure in the panel's language, with curl's words kept for IT", () => {
    const raw = forPanel(new TransportError("unreachable", "Exchange is not reachable from this machine (Could not resolve host). Check the corporate network or VPN.", "Could not resolve host"));
    expect(explain(hostErrors.ru, raw)).toBe("С этой машины Exchange недоступен. Проверьте корпоративную сеть или VPN. (curl: Could not resolve host)");
    expect(explain(hostErrors.en, raw)).toBe("Exchange is not reachable from this machine. Check the corporate network or VPN. (curl: Could not resolve host)");
    const paused = forPanel(new SignInPaused("Mail sign-in is paused…", "signin-paused", new Date(2026, 9, 31, 14, 5).getTime()));
    expect(explain(hostErrors.ru, paused)).toContain("не раньше 14:05");
  });

  it("finds the tag inside a message bb wrapped, and keeps English for what it does not know", () => {
    expect(explain(hostErrors.ru, "Host call failed: [mail:timeout] Exchange did not answer in time.")).toBe("Exchange не ответил вовремя. Проверьте корпоративную сеть или VPN.");
    expect(explain(hostErrors.ru, "[mail:from-a-newer-host] Something new happened.")).toBe("Something new happened.");
    expect(explain(hostErrors.ru, "[mail:constructor] Not a translation.")).toBe("Not a translation.");
    expect(explain(hostErrors.ru, "Exchange said something.")).toBe("Exchange said something.");
    expect(explain(hostErrors.ru, "[mail:tls:%E0%A4%A] The secure connection to Exchange failed")).toBe("Не удалось установить защищённое соединение с Exchange. Если повторится, покажите это сообщение IT.");
  });
});

describe("what the service hands out", () => {
  let dir: string;
  const unreachable: Transport = {
    info: async () => ({ path: "curl", version: "8.0", features: ["NTLM"] }),
    send: async () => {
      throw new TransportError("timeout", "Exchange did not answer in time. Check the corporate network or VPN.");
    },
  };
  const open = (transport: Transport = unreachable) =>
    new MailService({ dataDir: join(dir, "data"), transport, secrets: openFileSecretStore(join(dir, "secrets")), platform: "linux", allowLocalHttp: false });

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "exchange-mail-errors-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("tags the check and its saved result for the panel", async () => {
    const service = open();
    expect((await service.check()).message).toBe("[mail:not-connected] Mail is not connected yet.");
    await service.saveConnection({ url: "https://mail.example.test", auth: "negotiate" });
    const check = await service.check();
    expect(check.message).toMatch(/^\[mail:timeout\] Exchange did not answer in time/);
    expect((await service.status()).lastCheck?.message).toBe(check.message);
  });

  it("tags a missing curl in the status", async () => {
    const service = open({ info: async () => Promise.reject(new TransportError("curl-missing", "curl is not installed at /usr/bin/curl", "/usr/bin/curl")), send: unreachable.send });
    expect((await service.status()).curlError).toBe("[mail:curl-missing:%2Fusr%2Fbin%2Fcurl] curl is not installed at /usr/bin/curl");
  });

  it("gives agents the English text, no tags", async () => {
    const service = open();
    expect((await service.tool({ tool: "list" })).text).not.toContain("[mail:");
    await service.saveConnection({ url: "https://mail.example.test", auth: "negotiate" });
    const answer = await service.tool({ tool: "list" });
    expect(answer).toMatchObject({ isError: true });
    expect(answer.text).toContain("Exchange did not answer in time");
    expect(answer.text).not.toContain("[mail:");
  });
});
