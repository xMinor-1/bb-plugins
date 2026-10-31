// Copied from plugins/qlik-sense/test/check-models.test.ts (commit c0399a0). Keep in sync with qlik-sense.
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { checkOpenCodeConfiguration, type ModelCheckOptions } from "../src/host/check-models.js";

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });

async function fixture(extraEnv: NodeJS.ProcessEnv = {}): Promise<ModelCheckOptions> {
  const dir = await mkdtemp(join(tmpdir(), "qlik-model-check-"));
  directories.push(dir);
  const script = join(dir, "fake-opencode.mjs");
  await writeFile(script, `
import { writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
const args = process.argv.slice(2);
if (args.includes('--version')) { console.log(process.env.TEST_VERSION || '2.2.5'); }
else {
  writeFileSync('observed.json', JSON.stringify({pid:process.pid, args, cwd:process.cwd(), configDir:process.env.OPENCODE_CONFIG_DIR, marker:process.env.OPENCODE_TEST_MARKER, xdg:process.env.XDG_CONFIG_HOME, leaked:process.env.QLIK_TEST_PARENT_ONLY}));
  if (!args.includes('--standalone') || !args.includes('models')) process.exit(3);
  if (process.env.TEST_MODE === 'hang' || process.env.TEST_MODE === 'orphan') {
    if (process.env.TEST_MODE === 'hang') process.on('SIGTERM', () => {});
    const code = process.env.TEST_MODE === 'orphan' ? "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)" : 'setInterval(()=>{},1000)';
    const server = spawn(process.execPath, ['-e', code], {stdio:'ignore'});
    writeFileSync('server.pid', String(server.pid));
    setInterval(()=>{},1000);
  } else if (process.env.TEST_MODE === 'fail') {
    console.error('sensitive-fixture-stderr'); process.exitCode = 1;
  } else if (process.env.TEST_MODE === 'oversize') {
    process.stdout.write('x'.repeat(5*1024*1024));
  } else console.log(process.env.TEST_MODE === 'external' ? 'external/model' : 'company/model');
}
`);
  return {
    allowedProviders: "company",
    projectDirectory: dir,
    environment: { OPENCODE_TEST_MARKER: "acp-env", XDG_CONFIG_HOME: join(dir, "config"), ...extraEnv },
    command: [process.execPath, script],
    timeoutMs: 2000,
  };
}

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

/** The process has exited (an unreaped zombie counts: containers leave orphans to PID 1), within `ms`. */
async function gone(pid: number, ms = 3_000): Promise<boolean> {
  const zombie = () =>
    process.platform === "linux" && readFile(`/proc/${pid}/stat`, "utf8").then((value) => /^\d+ \(.*\) Z /.test(value)).catch(() => false);
  for (const until = Date.now() + ms; ; ) {
    if (!alive(pid) || (await zombie())) return true;
    if (Date.now() > until) return false;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

describe("OpenCode configuration runner", () => {
  it("passes the ACP environment and absolute project cwd and waits for process exit", async () => {
    const options = await fixture();
    process.env.QLIK_TEST_PARENT_ONLY = "must-not-inherit";
    try {
      expect((await checkOpenCodeConfiguration(options)).state).toBe("verified");
      const observed = JSON.parse(await readFile(join(options.projectDirectory, "observed.json"), "utf8"));
      expect(observed).toMatchObject({ args: ["models", "--standalone"], cwd: options.projectDirectory, marker: "acp-env", xdg: options.environment.XDG_CONFIG_HOME });
      expect(observed.leaked).toBeUndefined();
      expect(alive(observed.pid)).toBe(false);
    } finally { delete process.env.QLIK_TEST_PARENT_ONLY; }
  });

  it("blocks v1 without launching the model probe or touching legacy configuration", async () => {
    const options = await fixture({ TEST_VERSION: "1.18.3" });
    const result = await checkOpenCodeConfiguration(options);
    expect(result).toMatchObject({ state: "blocked", reason: expect.stringContaining("Update OpenCode to 2.x") });
    await expect(readFile(join(options.projectDirectory, "observed.json"))).rejects.toThrow();
  });

  it("passes the explicit config directory to the child instead of the prior ACP override", async () => {
    const options = await fixture({ OPENCODE_CONFIG_DIR: join(tmpdir(), "prior-acp-config") });
    options.opencodeConfigDir = join(options.projectDirectory, "isolated-config");
    expect((await checkOpenCodeConfiguration(options)).state).toBe("verified");
    const observed = JSON.parse(await readFile(join(options.projectDirectory, "observed.json"), "utf8"));
    expect(observed.configDir).toBe(options.opencodeConfigDir);
    expect(options.environment.OPENCODE_CONFIG_DIR).toBe(join(tmpdir(), "prior-acp-config"));
  });

  it.each(["external", "fail", "oversize"])("fails closed for %s without exposing stderr", async (mode) => {
    const options = await fixture({ TEST_MODE: mode });
    const result = await checkOpenCodeConfiguration(options);
    expect(result.state).toBe("blocked");
    expect(JSON.stringify(result)).not.toContain("sensitive-fixture-stderr");
  });

  it.each(["hang", "orphan"])("terminates the standalone process tree on timeout (%s)", async (mode) => {
    const options = await fixture({ TEST_MODE: mode });
    options.timeoutMs = 800;
    expect((await checkOpenCodeConfiguration(options)).state).toBe("blocked");
    const observed = JSON.parse(await readFile(join(options.projectDirectory, "observed.json"), "utf8"));
    const serverPid = Number(await readFile(join(options.projectDirectory, "server.pid"), "utf8"));
    // Killed processes leave a moment later on a loaded machine: wait up to 3 s.
    expect(await gone(observed.pid)).toBe(true);
    expect(await gone(serverPid)).toBe(true);
  });

  it("blocks missing executables and cancellation; personal mode does not spawn", async () => {
    const options = await fixture();
    expect((await checkOpenCodeConfiguration({ ...options, command: [join(options.projectDirectory, "missing")] })).state).toBe("blocked");
    expect((await checkOpenCodeConfiguration({ ...options, signal: AbortSignal.abort() })).state).toBe("blocked");
    expect((await checkOpenCodeConfiguration({ ...options, allowedProviders: "", command: ["missing"] })).state).toBe("unrestricted");
  });
});
