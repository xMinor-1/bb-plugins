// Obfuscation Proxy — server entry.
//
// Claude Code sessions get ANTHROPIC_BASE_URL pointed at this plugin's own
// route. Each request carries its thread id; the plugin sends it through a
// local masking proxy when masking is on for that thread, and straight to
// the original upstream when it is off. The proxy masks secrets, internal
// hosts and personal data before anything leaves the machine and restores
// them in the streamed answer. Masking state per thread is visible above the
// message box (app.tsx); the switch takes effect on the next request.

import { randomBytes } from "node:crypto";
import { dirname, join } from "node:path";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { ensureBinary } from "./src/binary";
import { rpcContract } from "./src/contract";
import { MaskMatcher, ThreadFeeds } from "./src/feed";
import { forwardRequest, type ProxyTarget } from "./src/forward";
import { validateUpstream } from "./src/proxy-config";
import { refusedMessage, setupAnswer, waitReason } from "./src/server-texts";
import {
  KEY_HEADER,
  type Lang,
  PROXY_CHANGED,
  ROUTED_PROVIDERS,
  THREAD_CHANGED,
  THREAD_HEADER,
  type ProxyStatus,
  type ThreadStatus,
} from "./src/shared";
import { ProxySupervisor } from "./src/supervisor";

export type { RpcContract } from "./src/contract";

const DEFAULT_UPSTREAM = "https://api.anthropic.com";
const ROUTES = ["/v1/messages", "/v1/messages/count_tokens"];
/** A request waits this long for a proxy that is installing or starting. */
const PROXY_WAIT_MS = 15_000;
/** Core's per-thread pause between re-attempts is 1 s; the second recheck comes after it. */
const RECHECK_AGAIN_MS = 1_500;

export default async function plugin(bb: BbPluginApi) {
  const settings = bb.settings.define({
    autoEnable: {
      type: "boolean",
      label: "Mask new threads by default",
      description:
        "Masking starts on in every thread with an external model. People can still switch it per thread above the message box.",
      default: true,
    },
    binaryPath: {
      type: "string",
      label: "Proxy binary path",
      description: "Absolute path to the masking proxy binary on the bb server machine. Leave empty to download it.",
      default: "",
    },
    downloadUrl: {
      type: "string",
      label: "Proxy download URL",
      description:
        "Used when the path is empty. {os}, {arch} and {ext} are filled in (darwin/linux/windows, amd64/arm64, .exe); " +
        "a .sha256 file must sit next to the binary.",
      default: "",
    },
    corporateModels: {
      type: "string",
      label: "In-network models",
      description:
        "Comma-separated model id prefixes that never leave your network. For them the masking bar stays visible " +
        "but inactive: a grey light and a tooltip saying masking is not needed. Every other model counts as external.",
      default: "",
    },
    hideSegment: {
      type: "boolean",
      label: "Hide the masking bar",
      description:
        "Hides the masking bar above the message box in every thread. Masking itself keeps working. " +
        "For builds that do not need the bar.",
      default: false,
    },
    extraConfig: {
      type: "string",
      label: "Extra proxy configuration (YAML)",
      description: "Appended to the generated config: masking rules, egress proxy. The plugin sets server, upstream and log itself.",
      default: "",
      experimental_multiline: true,
    },
  });
  let values = await settings.get();

  const kv = bb.storage.kv;
  let key = await kv.get<string>("routing-key");
  if (typeof key !== "string" || key.length < 32) {
    key = randomBytes(24).toString("hex");
    await kv.set("routing-key", key);
  }

  const upstream = process.env.ANTHROPIC_BASE_URL?.trim() || DEFAULT_UPSTREAM;
  const upstreamProblem = validateUpstream(upstream);
  if (upstreamProblem !== null) bb.log.warn(upstreamProblem);

  const workDir = join(dirname(bb.storage.database().name), "proxy");
  const feeds = new ThreadFeeds(kv);
  const masks = new MaskMatcher();

  const changed = (threadId: string) => bb.realtime.publish(THREAD_CHANGED, { threadId });

  // The language people last used in bb, for the texts the server writes.
  let lang: Lang = (await kv.get<Lang>("ui-lang")) === "ru" ? "ru" : "en";
  function rememberLang(next: Lang | undefined): void {
    if (next === undefined || next === lang) return;
    lang = next;
    void kv.set("ui-lang", next).catch(() => {});
  }

  /**
   * Messages queued behind the proxy are asked about again: core re-runs the
   * dispatch hook. Core skips a re-attempt that comes within a second of the
   * previous one on the same thread (bb 0.49: a settings change re-asks while
   * the proxy is starting, "running" follows 0.6 s later), so ask once more
   * after that pause.
   */
  let recheckAgain: ReturnType<typeof setTimeout> | null = null;
  function releaseWaiting(): void {
    const recheck = () =>
      void bb.experimental_hooks.recheck("message.dispatch").then(
        () => bb.log.debug("asked bb to re-attempt queued messages"),
        (error: unknown) => bb.log.warn(`re-attempt of queued messages failed: ${String(error)}`),
      );
    recheck();
    if (recheckAgain !== null) clearTimeout(recheckAgain);
    recheckAgain = setTimeout(() => {
      recheckAgain = null;
      recheck();
    }, RECHECK_AGAIN_MS);
    recheckAgain.unref?.();
  }

  // ---------- Masking state per thread ----------

  async function maskingOf(threadId: string): Promise<{ masking: boolean; explicit: boolean }> {
    const stored = await kv.get<boolean>(`mask:${threadId}`);
    if (typeof stored === "boolean") return { masking: stored, explicit: true };
    return { masking: values.autoEnable, explicit: false };
  }

  // ---------- The proxy process ----------

  let supervisor: ProxySupervisor | null = null;
  let proxyStatus: ProxyStatus = { state: "stopped", message: null, problem: null, since: Date.now() };
  let restartRun: AbortController | null = null;
  const readyWaiters: (() => void)[] = [];

  function newSupervisor(): ProxySupervisor {
    const source = { binaryPath: values.binaryPath, downloadUrl: values.downloadUrl };
    return new ProxySupervisor({
      dir: workDir,
      upstream,
      extraConfig: values.extraConfig,
      resolveBinary: (signal) => ensureBinary({ source, dir: join(workDir, "bin"), signal }),
      onEvent: (event) => {
        if (event.kind === "masks") masks.report(event.inBytes, event.byCategory);
        if (event.kind === "error") bb.log.warn(`proxy: ${event.message}`);
      },
      onStatus: (status) => {
        proxyStatus = status;
        bb.log.info(`proxy ${status.state}${status.message ? `: ${status.message}` : ""}`);
        bb.realtime.publish(PROXY_CHANGED, { state: status.state });
        for (const resolve of readyWaiters.splice(0)) resolve();
        if (status.state === "running") releaseWaiting();
      },
    });
  }

  bb.background.service("masking-proxy", {
    async start(signal) {
      while (!signal.aborted) {
        const run = new AbortController();
        restartRun = run;
        const stop = () => run.abort();
        signal.addEventListener("abort", stop, { once: true });
        try {
          supervisor = newSupervisor();
          await supervisor.run(run.signal);
        } finally {
          signal.removeEventListener("abort", stop);
        }
      }
    },
  });

  settings.onChange((next) => {
    values = next;
    // A new run picks up the binary, the extra config and the default.
    restartRun?.abort();
    releaseWaiting();
  });

  function proxyNow(): ProxyTarget | null {
    const url = supervisor?.url ?? null;
    if (url !== null) return { url };
    if (proxyStatus.state === "installing" || proxyStatus.state === "starting") return null;
    return { error: proxyStatus.message ?? `it is ${proxyStatus.state}` };
  }

  /** The running proxy; a request in flight waits a little for one that is installing or starting. */
  async function proxyTarget(): Promise<ProxyTarget> {
    const deadline = Date.now() + PROXY_WAIT_MS;
    for (;;) {
      const now = proxyNow();
      if (now !== null) return now;
      const left = deadline - Date.now();
      if (left <= 0) return { error: proxyStatus.state === "installing" ? "it is still downloading" : "it is still starting" };
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, left);
        readyWaiters.push(() => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
  }

  // ---------- Messages to an external agent wait for the proxy ----------

  // With masking on and no proxy yet, a new message is queued with a reason
  // card instead of failing in the agent; it goes out once the proxy runs or
  // masking is turned off (both call recheck). "Send now" bypasses the hook,
  // and the route then refuses with the same explanation.
  //
  // No `sendAt` on the wait: bb 0.49 stored it but did not re-attempt the row
  // when it came due, and a timed row shows as scheduled rather than waiting.
  bb.experimental_hooks.on("message.dispatch", async (ctx) => {
    if (!ROUTED_PROVIDERS.includes(ctx.requestedExecution.providerId)) return { action: "proceed" };
    if (!(await maskingOf(ctx.thread.id)).masking) return { action: "proceed" };
    if (supervisor?.url) return { action: "proceed" };
    return { action: "wait", reason: waitReason(proxyStatus, lang) };
  });

  // ---------- Route Claude Code through this plugin ----------

  const baseHeaders = process.env.ANTHROPIC_CUSTOM_HEADERS?.trim() ?? "";
  bb.providers.experimental_contributeEnv("claude-code", (ctx) => {
    const ours = `${THREAD_HEADER}: ${ctx.threadId ?? "none"}\n${KEY_HEADER}: ${key}`;
    return [
      {
        name: "ANTHROPIC_BASE_URL",
        value: { serverPath: `/api/v1/plugins/${bb.pluginId}/http` },
        reason: "Model requests go through the Obfuscation Proxy plugin, which masks them when masking is on",
      },
      {
        name: "ANTHROPIC_CUSTOM_HEADERS",
        value: baseHeaders === "" ? ours : `${baseHeaders}\n${ours}`,
        reason: "Tells the Obfuscation Proxy plugin which thread a request belongs to",
      },
      {
        name: "ENABLE_TOOL_SEARCH",
        value: "true",
        reason: "Claude Code turns tool search off behind a custom base URL; requests still reach Anthropic",
      },
    ];
  });
  bb.providers.experimental_contributeEnvHealth("claude-code", () => ({
    label: "Masking",
    statusMessage:
      proxyStatus.state === "running"
        ? "Requests go through the Obfuscation Proxy plugin; masking is switched per thread."
        : `Requests go through the Obfuscation Proxy plugin; the masking proxy is ${proxyStatus.state}.`,
  }));

  // Claude Code checks that its base URL answers before it starts.
  bb.http.route("HEAD", "/api/hello", () => new Response(null, { status: 200 }), { auth: "none" });

  for (const path of ROUTES) {
    bb.http.route(
      "POST",
      path,
      (c) =>
        forwardRequest(c.req.raw, path, {
          key,
          upstream,
          isMasking: async (threadId) => (await maskingOf(threadId)).masking,
          proxy: proxyTarget,
          refusedMessage: () => refusedMessage(proxyStatus, lang),
          feeds,
          masks,
          changed,
        }),
      // The agent cannot send bb's plugin token; the routing key header guards the route instead.
      { auth: "none" },
    );
  }

  // ---------- RPC for the thread segment ----------

  async function status(threadId: string): Promise<ThreadStatus> {
    const state = await maskingOf(threadId);
    return { threadId, ...state, proxy: proxyStatus, totals: await feeds.totals(threadId) };
  }

  bb.rpc.register(rpcContract, {
    thread_status: ({ threadId, lang: next }) => {
      rememberLang(next);
      return status(threadId);
    },
    thread_feed: async ({ threadId, limit, lang: next }) => {
      rememberLang(next);
      return { entries: await feeds.entries(threadId, limit) };
    },
    thread_set_masking: async ({ threadId, masking, lang: next }) => {
      rememberLang(next);
      await kv.set(`mask:${threadId}`, masking);
      changed(threadId);
      // A message queued behind the proxy goes out once masking is off.
      if (!masking) releaseWaiting();
      return status(threadId);
    },
    setupStatus: (input) => {
      rememberLang(input?.lang);
      return setupAnswer(proxyStatus, input?.lang ?? lang);
    },
  });
}
