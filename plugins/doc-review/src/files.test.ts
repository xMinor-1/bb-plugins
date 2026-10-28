import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { describe, expect, it, vi } from "vitest";
import { DocFiles } from "./files";
import type { DocRow } from "./store";

const doc = {
  hostId: "host-windows",
  absPath: "D:/Documents/Projects/peptides/.tmp/reports/audit.html",
} as DocRow;

function fixture(call = vi.fn().mockResolvedValue("version")) {
  const listeners = new Map<string, (event?: any) => void>();
  const read = vi.fn();
  const get = vi.fn(async () => ({ status: "connected" }));
  const bb = {
    hosts: { experimental_client: () => ({ call,
      experimental_onSignal: (_name: string, fn: (event: any) => void) => { listeners.set("changed", fn); return vi.fn(); },
      experimental_onWorkerExit: (fn: () => void) => { listeners.set("exit", fn); return vi.fn(); },
    }) },
    sdk: { files: { read }, hosts: { get }, subscribe: ({ event, callback }: any) => { listeners.set(event, callback); return vi.fn(); } },
    onDispose: vi.fn(),
  } as unknown as BbPluginApi;
  return { files: new DocFiles(bb, ".tmp"), call, read, get, listeners };
}

describe("watched remote versions", () => {
  it("reuses subscribed metadata and invalidates when the file changes", async () => {
    const f = fixture();
    expect(await f.files.version(doc)).toBe("version");
    expect(await f.files.version(doc)).toBe("version");
    expect(f.call).toHaveBeenCalledTimes(1);
    expect(f.read).not.toHaveBeenCalled();
    f.listeners.get("changed")!({ hostId: doc.hostId, payload: { path: doc.absPath } });
    f.call.mockResolvedValue("changed");
    expect(await f.files.version(doc)).toBe("changed");
    expect(f.call).toHaveBeenCalledTimes(2);
  });

  it("clears subscribed versions after reconnect, worker exit and offline state", async () => {
    const f = fixture();
    for (const event of ["host:changed", "realtime:connection", "exit"]) {
      await f.files.version(doc);
      f.listeners.get(event)!();
    }
    expect(f.call).toHaveBeenCalledTimes(3);
    f.get.mockResolvedValue({ status: "disconnected" });
    await expect(f.files.version(doc)).rejects.toThrow("not connected");
  });

  it("deduplicates concurrent metadata reads and preserves failures", async () => {
    const f = fixture();
    await Promise.all([f.files.version(doc), f.files.version(doc)]);
    expect(f.call).toHaveBeenCalledTimes(1);
    f.listeners.get("exit")!();
    const error = new Error("Disconnected");
    f.call.mockRejectedValue(error);
    await expect(f.files.version(doc)).rejects.toBe(error);
    f.call.mockResolvedValue("reconnected");
    expect(await f.files.version(doc)).toBe("reconnected");
  });
});

it("resolves a Windows host file on a Mac/Linux server", async () => {
  const bb = { sdk: { system: { config: async () => ({ primaryHostId: "host-mac" }) } } } as unknown as BbPluginApi;
  expect(await new DocFiles(bb, ".tmp").resolve("D:/Documents/Projects/peptides/.tmp/reports/../audit.html", {
    kind: "host", experimental_hostId: "host-windows", threadId: null, environmentId: null, projectId: null,
  })).toEqual({ absPath: "D:/Documents/Projects/peptides/.tmp/audit.html", hostId: "host-windows" });
});
