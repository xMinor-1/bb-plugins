// @vitest-environment jsdom
//
// The sign-in page with its buttons pressed: what a person types, what reaches the
// server, and the sentence they read for each outcome.
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import type { PluginRpcTestHandlers } from "@get-bb/plugin-sdk/testing/app";
import type { ConnectionStatus } from "../contract";
import type { rpcContract } from "../server";

await loadPluginApp(() => import("../app"));
const { DataServicePage } = await import("../src/app/DataServicePage");

afterEach(cleanup);
beforeEach(() => localStorage.clear());

const EMPTY: ConnectionStatus = { platform: "darwin", user: null, hasPassword: false, passwordStore: null, blocked: false, addressChanged: false, lastCheck: null };
const SIGNED: ConnectionStatus = { ...EMPTY, user: "person", hasPassword: true, passwordStore: "keychain", lastCheck: { ok: true, at: 1, code: null, status: null } };
const CONFIG = { name: "Sales data", summary: "About sales.", notice: "Covers all clients.", iconText: null as string | null, address: "https://svc.example.com/api/", problem: null, canCheck: true, rules: [{ provider: "acp-opencode", model: "corp/*" }], rulesText: null as string | null };

function open(options: { status?: ConnectionStatus; check?: { ok: boolean; code: never | null; status: number | null }; config?: Partial<Omit<typeof CONFIG, "problem">> & { problem?: string | null } } = {}) {
  let current = options.status ?? EMPTY;
  const calls: { saved: unknown[]; checks: unknown[]; forgot: number } = { saved: [], checks: [], forgot: 0 };
  const handlers: PluginRpcTestHandlers<typeof rpcContract> = {
    machines: () => ({ machines: [{ id: "host_mac", name: "mac", connected: true }], lastUsed: null }),
    config: () => ({ ...CONFIG, ...options.config }),
    status: () => current,
    saveConnection: (input) => {
      calls.saved.push(input);
      current = { ...current, user: input.user, hasPassword: true, passwordStore: "keychain", lastCheck: null };
      return current;
    },
    checkSignIn: (input) => {
      calls.checks.push(input);
      const outcome = (options.check ?? { ok: true, code: null, status: null }) as { ok: boolean; code: null; status: null };
      current = { ...current, blocked: (outcome.code as string | null) === "unauthorized", lastCheck: { ...outcome, at: 2 } };
      return outcome;
    },
    forget: () => {
      calls.forgot += 1;
      current = EMPTY;
      return current;
    },
  };
  renderSlot({ component: DataServicePage }, {}, { rpc: handlers });
  return calls;
}

describe("the panel's name", () => {
  const load = async () => (await loadPluginApp(() => import("../app"))).navPanels[0]!;

  it("is generic until the service name is known, then comes from the remembered name", async () => {
    expect((await load()).title).toBe("Data Service");
    const { useServiceName } = await import("../src/app/service-name");
    function Name() {
      return <p>{useServiceName() ?? "none"}</p>;
    }
    renderSlot({ component: Name }, {}, { rpc: { config: () => CONFIG } as unknown as PluginRpcTestHandlers<typeof rpcContract> });
    await screen.findByText("Sales data");
    expect((await load()).title).toBe("Sales data");
  });

  it("keeps the generic title when storage does not work", async () => {
    const { rememberedTitle } = await import("../src/app/service-name");
    const read = localStorage.getItem;
    Storage.prototype.getItem = () => {
      throw new Error("blocked");
    };
    try {
      expect(rememberedTitle()).toBe("Data Service");
    } finally {
      Storage.prototype.getItem = read;
    }
  });
});

describe("the sidebar icon", () => {
  it("is the database mark until the server sends a text, then the text, remembered for the next load", async () => {
    const { ServiceIcon } = await import("../src/app/icon");
    const { useServiceName } = await import("../src/app/service-name");
    const { container } = renderSlot({ component: () => <ServiceIcon className="icon" /> }, {});
    expect(container.querySelector("ellipse")).not.toBeNull();
    function Name() {
      return <p>{useServiceName() ?? "none"}</p>;
    }
    renderSlot({ component: Name }, {}, { rpc: { config: () => ({ ...CONFIG, iconText: "AB" }) } as unknown as PluginRpcTestHandlers<typeof rpcContract> });
    await screen.findByText("Sales data");
    await waitFor(() => expect(container.querySelector("text")?.textContent).toBe("AB"));
    expect(container.querySelector("ellipse")).toBeNull();
    expect(localStorage.getItem("http-data-service:icon-text")).toBe("AB");
  });

  it("goes back to the database mark when the text is removed", async () => {
    const { ServiceIcon, setIconText } = await import("../src/app/icon");
    setIconText("AB");
    const { container } = renderSlot({ component: () => <ServiceIcon /> }, {});
    expect(container.querySelector("text")?.textContent).toBe("AB");
    setIconText(null);
    await waitFor(() => expect(container.querySelector("ellipse")).not.toBeNull());
    expect(localStorage.getItem("http-data-service:icon-text")).toBeNull();
  });
});

async function signIn() {
  fireEvent.change(await screen.findByLabelText(/^Login/), { target: { value: "person" } });
  fireEvent.change(screen.getByLabelText(/^Password/), { target: { value: "secret-value" } });
  fireEvent.click(screen.getByRole("button", { name: "Save and check" }));
}

describe("signing in", () => {
  it("shows the name, the notice and the address the person does not type", async () => {
    open();
    expect(await screen.findByText("Sales data")).toBeTruthy();
    expect(screen.getByText("Covers all clients.")).toBeTruthy();
    const address = (await screen.findByLabelText(/^Service address/)) as HTMLInputElement;
    expect(address.value).toBe("https://svc.example.com/api/");
    expect(address.disabled).toBe(true);
    expect((screen.getByLabelText(/^Password/) as HTMLInputElement).type).toBe("password");
  });

  it("saves the login and password, checks, and clears the field", async () => {
    const calls = open();
    await signIn();
    expect(await screen.findByText("Signed in. Agents can read the service.")).toBeTruthy();
    expect(calls.saved).toEqual([{ hostId: "host_mac", user: "person", password: "secret-value" }]);
    expect(calls.checks).toEqual([{ hostId: "host_mac", retry: false }]);
    expect((screen.getByLabelText(/^Password/) as HTMLInputElement).value).toBe("");
    expect(document.body.textContent).not.toContain("secret-value");
  });

  it("explains a refused password and offers one more try", async () => {
    const calls = open({ check: { ok: false, code: "unauthorized" as never, status: 401 } });
    await signIn();
    expect(await screen.findByText(/did not accept the login or password/)).toBeTruthy();
    fireEvent.click(await screen.findByRole("button", { name: "Try once more" }));
    await waitFor(() => expect(calls.checks).toHaveLength(2));
    expect(calls.checks[1]).toEqual({ hostId: "host_mac", retry: true });
  });

  it.each([
    ["unreachable", /Check that the corporate network or VPN is on/],
    ["notFound", /Your login is not the problem/],
    ["forbidden", /no access to the service/],
    ["tls", /does not trust the service's certificate/],
    ["notConfigured", /has not set up the service yet/],
  ])("explains %s without technical words", async (code, pattern) => {
    open({ check: { ok: false, code: code as never, status: null } });
    await signIn();
    expect(await screen.findByText(pattern)).toBeTruthy();
  });

  it("speaks Russian when asked", async () => {
    localStorage.setItem("xminor-plugins.lang", "ru");
    open({ check: { ok: false, code: "unauthorized" as never, status: 401 } });
    fireEvent.change(await screen.findByLabelText(/^Логин/), { target: { value: "person" } });
    fireEvent.change(screen.getByLabelText(/^Пароль/), { target: { value: "pw" } });
    fireEvent.click(screen.getByRole("button", { name: "Сохранить и проверить" }));
    expect(await screen.findByText(/Сервис не принял логин или пароль/)).toBeTruthy();
  });

  it("does not send a login with a colon", async () => {
    const calls = open();
    fireEvent.change(await screen.findByLabelText(/^Login/), { target: { value: "a:b" } });
    fireEvent.change(screen.getByLabelText(/^Password/), { target: { value: "pw" } });
    fireEvent.click(screen.getByRole("button", { name: "Save and check" }));
    expect(await screen.findByText("A login cannot contain a colon.")).toBeTruthy();
    expect(calls.saved).toHaveLength(0);
  });
});

describe("after signing in", () => {
  it("checks again, and signs out on request", async () => {
    const calls = open({ status: SIGNED });
    fireEvent.click(await screen.findByRole("button", { name: "Check again" }));
    await waitFor(() => expect(calls.checks).toHaveLength(1));
    await screen.findByText("Signed in. Agents can read the service.");
    fireEvent.click(await screen.findByRole("button", { name: "Sign out and delete the password" }));
    await waitFor(() => expect(calls.forgot).toBe(1));
  });

  it("asks for the password again when the address moved", async () => {
    open({ status: { ...SIGNED, addressChanged: true } });
    expect(await screen.findByText(/The service address has changed/)).toBeTruthy();
    expect((screen.getByLabelText(/^Password/) as HTMLInputElement).required).toBe(true);
    expect(screen.queryByRole("button", { name: "Check again" })).toBeNull();
  });

  it("says when the password is in a file rather than an OS store", async () => {
    open({ status: { ...SIGNED, passwordStore: "file" } });
    expect(await screen.findByText(/no password store bb can use/)).toBeTruthy();
  });

  it("lists who may read, and says when nobody may", async () => {
    open();
    expect(await screen.findByText("acp-opencode corp/*")).toBeTruthy();
    cleanup();
    open({ config: { rules: [] } });
    expect(await screen.findByText(/No model is allowed yet/)).toBeTruthy();
  });

  it("says who may read in the build's words, without the rules", async () => {
    open({ config: { rulesText: "Only agents on the company's models" } });
    expect(await screen.findByText("Only agents on the company's models")).toBeTruthy();
    expect(screen.queryByText("acp-opencode corp/*")).toBeNull();
    cleanup();
    open({ config: { rulesText: "Only agents on the company's models", rules: [] } });
    expect(await screen.findByText(/No model is allowed yet/)).toBeTruthy();
  });

  it("shows a configuration that cannot work", async () => {
    open({ config: { problem: "No methods are configured" } });
    expect(await screen.findByText(/has not set up the service correctly/)).toBeTruthy();
  });
});
