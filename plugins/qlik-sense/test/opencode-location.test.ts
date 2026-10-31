import { mkdtemp, mkdir, readFile, writeFile, rm, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveOpenCodeLocation as resolve } from "../src/host/opencode-location.js";
import { writeQlikMcpConfig } from "../src/host/opencode-config.js";
import { opencodeConfigDirSchema } from "../src/shared/settings.js";

const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });

describe("OpenCode location shared by check and writer", () => {
  it("prioritizes the explicit fleet setting, then ACP env, then XDG, then home", () => {
    const base = { userHome: "/users/example", platform: "posix" as const };
    const env = { OPENCODE_CONFIG_DIR: "/acp/config", XDG_CONFIG_HOME: "/xdg" };
    expect(resolve({ ...base, environment: env, opencodeConfigDir: "/fleet/isolated" }).directory).toBe("/fleet/isolated");
    expect(resolve({ ...base, environment: env, opencodeConfigDir: "" }).directory).toBe("/acp/config");
    expect(resolve({ ...base, environment: { XDG_CONFIG_HOME: "/xdg" } }).directory).toBe("/xdg/opencode");
    expect(resolve({ ...base, environment: { XDG_CONFIG_HOME: "" } }).directory).toBe("/users/example/.config/opencode");
  });
  it("uses the same XDG/home convention on Windows and preserves other ACP variables", () => {
    const environment = { OPENCODE_CONFIG_DIR: "C:\\Fleet\\Config", OPENCODE_TEST: "keep", XDG_DATA_HOME: "C:\\Fleet\\Data", APPDATA: "C:\\Unused" };
    const result = resolve({ environment, platform: "win32", userHome: "C:\\Users\\example", opencodeConfigDir: "D:\\Isolated Config" });
    expect(result.configFile).toBe("D:\\Isolated Config\\opencode.json");
    expect(result.environment).toEqual({ ...environment, OPENCODE_CONFIG_DIR: "D:\\Isolated Config" });
    expect(environment.OPENCODE_CONFIG_DIR).toBe("C:\\Fleet\\Config");
    expect(resolve({ environment: { APPDATA: "C:\\Unused" }, platform: "win32", userHome: "C:\\Users\\example" }).directory).toBe("C:\\Users\\example\\.config\\opencode");
  });
  it("rejects relative and control-character paths instead of resolving them against different cwd values", () => {
    for (const path of ["relative", "~/config", "%APPDATA%\\config", "/config\nother"]) {
      expect(opencodeConfigDirSchema.safeParse(path).success).toBe(false);
      expect(() => resolve({ environment: {}, opencodeConfigDir: path })).toThrow();
    }
    expect(() => resolve({ environment: { OPENCODE_CONFIG_DIR: "relative" } })).toThrow();
    expect(() => resolve({ environment: { XDG_CONFIG_HOME: "relative" } })).toThrow();
  });
  it("requires a drive or UNC share on Windows for setting, ACP override and XDG root", () => {
    for (const path of ["/config", "\\config", "C:config"]) {
      expect(() => resolve({ platform: "win32", environment: {}, opencodeConfigDir: path })).toThrow();
      expect(() => resolve({ platform: "win32", environment: { OPENCODE_CONFIG_DIR: path } })).toThrow();
      expect(() => resolve({ platform: "win32", environment: { XDG_CONFIG_HOME: path } })).toThrow();
    }
    expect(resolve({ platform: "win32", environment: {}, opencodeConfigDir: "\\\\server\\share\\config" }).configFile).toBe("\\\\server\\share\\config\\opencode.json");
  });
  it("writes only inside the chosen directory without touching fleet provider plugins", async () => {
    const dir = await mkdtemp(join(tmpdir(), "qlik-location-test-"));
    dirs.push(dir);
    const isolated = join(dir, "isolated");
    const other = join(dir, "other");
    await mkdir(join(isolated, "plugins"), { recursive: true });
    const secretPlugin = join(isolated, "plugins", "fleet-kit-secrets.js");
    await writeFile(secretPlugin, "// untouched provider fixture\n");
    await writeQlikMcpConfig({
      opencodeConfigDir: isolated, environment: { OPENCODE_CONFIG_DIR: other },
      major: 2, entry: { type: "local", command: ["node", "--use-system-ca", "/example/qlik.mjs"], enabled: false },
    });
    expect(JSON.parse(await readFile(join(isolated, "opencode.json"), "utf8")).mcp.servers["qlik-sense"].enabled).toBe(false);
    expect(await readFile(secretPlugin, "utf8")).toBe("// untouched provider fixture\n");
    expect(await readdir(join(isolated, "plugins"))).toEqual(["fleet-kit-secrets.js"]);
    await expect(readdir(other)).rejects.toThrow();
  });
});
