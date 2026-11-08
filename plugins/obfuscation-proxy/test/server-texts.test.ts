import { describe, expect, it } from "vitest";
import { proxyState, refusedMessage, setupAnswer, waitReason } from "../src/server-texts";
import type { ProxyProblem, ProxyState, ProxyStatus } from "../src/shared";

const status = (state: ProxyState, message: string | null = null, problem: ProxyProblem | null = null): ProxyStatus => ({
  state,
  message,
  problem,
  since: 0,
});

describe("server texts", () => {
  it("names each reason the proxy is not there in the person's language", () => {
    expect(proxyState(status("installing"), "ru")).toBe("Прокси обфускации ещё скачивается");
    expect(proxyState(status("failed", "HTTP 401 for https://host/x", "download"), "ru")).toBe(
      "Прокси обфускации не скачался (HTTP 401 for https://host/x)",
    );
    expect(proxyState(status("failed", "exit 1", "start"), "ru")).toBe("Прокси обфускации не запустился (exit 1)");
    expect(proxyState(status("not-configured", "Set it", "no-source"), "ru")).toBe(
      "Прокси обфускации не установлен: в настройках плагина нет адреса загрузки",
    );
    expect(proxyState(status("not-configured", "/opt/p", "no-file"), "en")).toBe(
      "The masking proxy is not installed: no file (/opt/p)",
    );
  });

  it("explains every waiting state and how to send without masking", () => {
    for (const state of ["installing", "starting", "not-configured", "failed", "stopped"] as const) {
      expect(waitReason(status(state, "x"), "ru")).toContain("выключите обфускацию над полем ввода");
      expect(waitReason(status(state, "x"), "en")).toContain("turn masking off above the message box");
    }
    expect(waitReason(status("installing"), "ru")).toBe(
      "Прокси обфускации ещё скачивается. Сообщение уйдёт само, когда прокси запустится. " +
        "Чтобы отправить без маскировки, выключите обфускацию над полем ввода.",
    );
    expect(waitReason(status("failed", "HTTP 503", "download"), "ru")).toMatch(
      /^Прокси обфускации не скачался \(HTTP 503\)\. Плагин пробует снова/u,
    );
    expect(waitReason(status("not-configured", null, "no-source"), "ru")).toContain("Сообщение ждёт.");
  });

  it("says nothing was sent when it refuses a request", () => {
    expect(refusedMessage(status("installing"), "ru")).toBe(
      "Обфускация в этом треде включена. Прокси обфускации ещё скачивается. Ничего не отправлено. " +
        "Подождите, пока он запустится, или выключите обфускацию над полем ввода.",
    );
    expect(refusedMessage(status("failed", "exit 1", "start"), "en")).toContain("Nothing was sent");
  });

  it("maps proxy states to Fleet Kit's step states within its 200 characters", () => {
    expect(setupAnswer(status("running"), "ru")).toEqual({ state: "done", summary: "Прокси обфускации работает" });
    expect(setupAnswer(status("installing"), "ru")).toEqual({
      state: "todo",
      summary: "Прокси обфускации ещё скачивается, сообщения своим агентам ждут",
    });
    expect(setupAnswer(status("starting"), "en").state).toBe("todo");
    expect(setupAnswer(status("not-configured", null, "no-source"), "ru").state).toBe("problem");
    expect(setupAnswer(status("failed", "HTTP 404", "download"), "ru")).toEqual({
      state: "problem",
      summary: "Прокси обфускации не скачался (HTTP 404)",
    });
    expect(setupAnswer(status("failed", "x".repeat(500), "start"), "ru").summary.length).toBeLessThanOrEqual(200);
  });
});
