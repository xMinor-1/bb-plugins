import { createHash } from "node:crypto";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { DownloadError, ensureBinary, expandDownloadUrl, NotConfiguredError, parseSha256File } from "../src/binary";
import { ProxySupervisor } from "../src/supervisor";
import type { ProxyStatus } from "../src/shared";

let dir: string;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "masking-proxy-test-"));
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("download URL and checksum file", () => {
  it("fills the platform into the template", () => {
    const template = "https://releases.example/v1/proxy-{os}-{arch}{ext}";
    expect(expandDownloadUrl(template, { platform: "darwin", arch: "arm64" })).toBe(
      "https://releases.example/v1/proxy-darwin-arm64",
    );
    expect(expandDownloadUrl(template, { platform: "win32", arch: "x64" })).toBe(
      "https://releases.example/v1/proxy-windows-amd64.exe",
    );
    expect(() => expandDownloadUrl(template, { platform: "aix", arch: "ppc64" })).toThrow();
  });
  it("reads both checksum file layouts", () => {
    const hex = "a".repeat(64);
    expect(parseSha256File(`${hex}\n`)).toBe(hex);
    expect(parseSha256File(`${hex.toUpperCase()}  proxy-linux-amd64\n`)).toBe(hex);
    expect(parseSha256File("not a digest")).toBeNull();
  });
});

describe("ensureBinary", () => {
  let server: Server;
  let base: string;
  let payload = Buffer.from("#!/bin/sh\necho proxy\n");
  let digest = createHash("sha256").update(payload).digest("hex");
  let up = true;

  beforeAll(async () => {
    server = createServer((req, res) => {
      if (!up) {
        res.writeHead(503).end();
        return;
      }
      if (req.url?.endsWith(".sha256")) res.end(`${digest}  proxy\n`);
      else res.end(payload);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    base = `http://127.0.0.1:${typeof address === "object" && address !== null ? address.port : 0}`;
  });
  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

  it("needs a path or a URL", async () => {
    await expect(ensureBinary({ source: { binaryPath: "", downloadUrl: "" }, dir })).rejects.toMatchObject({
      problem: "no-source",
    });
    await expect(
      ensureBinary({ source: { binaryPath: join(dir, "missing"), downloadUrl: "" }, dir }),
    ).rejects.toMatchObject({ problem: "no-file", message: join(dir, "missing") });
    await expect(ensureBinary({ source: { binaryPath: "", downloadUrl: "" }, dir })).rejects.toBeInstanceOf(
      NotConfiguredError,
    );
  });

  it("calls a host that refuses or cannot be reached a download failure", async () => {
    up = false;
    const source = { binaryPath: "", downloadUrl: `${base}/refused-{os}-{arch}` };
    await expect(
      ensureBinary({ source, dir: join(dir, "bin3"), platform: { platform: "linux", arch: "x64" } }),
    ).rejects.toThrow(DownloadError);
    up = true;
    const unreachable = { binaryPath: "", downloadUrl: "http://127.0.0.1:1/proxy-{os}-{arch}" };
    await expect(
      ensureBinary({ source: unreachable, dir: join(dir, "bin4"), platform: { platform: "linux", arch: "x64" } }),
    ).rejects.toThrow(DownloadError);
  });

  it("downloads, verifies and reuses the verified copy when the host is down", async () => {
    const binDir = join(dir, "bin");
    const source = { binaryPath: "", downloadUrl: `${base}/proxy-{os}-{arch}{ext}` };
    const path = await ensureBinary({ source, dir: binDir, platform: { platform: "linux", arch: "x64" } });
    expect(path).toBe(join(binDir, "proxy-linux-amd64"));
    expect(await readFile(path)).toEqual(payload);
    up = false;
    expect(await ensureBinary({ source, dir: binDir, platform: { platform: "linux", arch: "x64" } })).toBe(path);
    up = true;
  });

  it("rejects a binary that does not match its checksum", async () => {
    payload = Buffer.from("tampered");
    const source = { binaryPath: "", downloadUrl: `${base}/other-{os}-{arch}` };
    await expect(
      ensureBinary({ source, dir: join(dir, "bin2"), platform: { platform: "linux", arch: "arm64" } }),
    ).rejects.toSatisfy((error) => error instanceof DownloadError && error.message.startsWith("Checksum mismatch"));
    payload = Buffer.from("#!/bin/sh\necho proxy\n");
    digest = createHash("sha256").update(payload).digest("hex");
  });
});

describe("ProxySupervisor", () => {
  const controllers: AbortController[] = [];
  afterEach(() => {
    // A failed assertion must not leave a child process running.
    for (const controller of controllers.splice(0)) controller.abort();
  });

  async function fakeProxy(name: string, script: string): Promise<string> {
    const path = join(dir, name);
    await writeFile(path, `#!/bin/sh\n${script}\n`);
    await chmod(path, 0o755);
    return path;
  }

  function supervise(binary: string, statuses: ProxyStatus[], extra = "") {
    const controller = new AbortController();
    controllers.push(controller);
    const supervisor = new ProxySupervisor({
      dir: join(dir, "work"),
      upstream: "https://api.example",
      extraConfig: extra,
      resolveBinary: async () => binary,
      onEvent: () => {},
      onStatus: (status) => statuses.push(status),
      startTimeoutMs: 3_000,
    });
    return { supervisor, controller, run: supervisor.run(controller.signal) };
  }

  it("reports running once the proxy listens and stopped after abort", async () => {
    const binary = await fakeProxy(
      "listens.sh",
      `echo '{"level":"INFO","msg":"listening","addr":"127.0.0.1:1"}'\nexec sleep 30`,
    );
    const statuses: ProxyStatus[] = [];
    const { supervisor, controller, run } = supervise(binary, statuses);
    await expect.poll(() => supervisor.status.state).toBe("running");
    expect(supervisor.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/u);
    const config = await readFile(join(dir, "work", "config.yaml"), "utf8");
    expect(config).toContain('base_url: "https://api.example"');
    controller.abort();
    await run;
    expect(supervisor.status.state).toBe("stopped");
    expect(supervisor.url).toBeNull();
    expect(statuses.map((status) => status.state)).toEqual(["installing", "starting", "running", "stopped"]);
  });

  it("fails with the proxy's last error when it exits", async () => {
    const binary = await fakeProxy("crashes.sh", 'echo "Error: read config: bad key" >&2\nexit 1');
    const { supervisor, run } = supervise(binary, []);
    await expect(run).rejects.toThrow("Error: read config: bad key");
    expect(supervisor.status).toMatchObject({ state: "failed", message: "Error: read config: bad key", problem: "start" });
  });

  it("waits without crashing while nothing is configured", async () => {
    const statuses: ProxyStatus[] = [];
    const controller = new AbortController();
    controllers.push(controller);
    const supervisor = new ProxySupervisor({
      dir: join(dir, "work2"),
      upstream: "https://api.example",
      extraConfig: "",
      resolveBinary: async () => {
        throw new NotConfiguredError("Set the proxy binary path or download URL in the plugin settings.", "no-source");
      },
      onEvent: () => {},
      onStatus: (status) => statuses.push(status),
    });
    const run = supervisor.run(controller.signal);
    await expect.poll(() => supervisor.status.state).toBe("not-configured");
    controller.abort();
    await run;
    expect(supervisor.status.state).toBe("stopped");
  });

  it("fails before starting when the extra config redefines the upstream", async () => {
    const binary = await fakeProxy("never.sh", "exec sleep 30");
    const { run } = supervise(binary, [], "upstream:\n  default: other");
    await expect(run).rejects.toThrow(/must not set "upstream"/u);
  });
});
