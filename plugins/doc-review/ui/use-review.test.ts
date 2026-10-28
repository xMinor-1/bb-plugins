import { afterEach, expect, it, vi } from "vitest";
import type { ReviewDoc } from "../src/types";

const state = vi.hoisted(() => ({
  call: vi.fn(),
  inFlight: { current: false },
  dispose: undefined as undefined | (() => void),
}));
vi.mock("react", () => ({
  useCallback: (fn: unknown) => fn,
  useState: vi.fn(),
  useRef: () => state.inFlight,
  useEffect: (fn: () => undefined | (() => void)) => { state.dispose = fn(); },
}));
vi.mock("@get-bb/plugin-sdk/app", () => ({
  useRpc: () => ({ call: state.call }),
  useRealtime: vi.fn(),
  useRealtimeConnectionState: vi.fn(),
}));
import { useDocVersion } from "./use-review";

afterEach(() => {
  state.dispose?.();
  state.call.mockReset();
  state.inFlight.current = false;
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it("does not overlap slow version requests or apply their result after unmount", async () => {
  vi.useFakeTimers();
  vi.stubGlobal("window", globalThis);
  vi.stubGlobal("document", { visibilityState: "visible" });
  let resolve!: (value: { version: string }) => void;
  state.call.mockReturnValue(new Promise((done) => { resolve = done; }));
  const update = vi.fn();
  useDocVersion({ id: "report", version: "old" } as ReviewDoc, update);
  await vi.advanceTimersByTimeAsync(12000);
  expect(state.call).toHaveBeenCalledTimes(1);
  resolve({ version: "new" });
  await vi.advanceTimersByTimeAsync(4000);
  expect(state.call).toHaveBeenCalledTimes(2);
  expect(update).toHaveBeenCalledTimes(2);
  state.dispose?.();
  await vi.advanceTimersByTimeAsync(8000);
  expect(state.call).toHaveBeenCalledTimes(2);
});

it("ignores a response from a document that has been closed", async () => {
  vi.useFakeTimers();
  vi.stubGlobal("window", globalThis);
  vi.stubGlobal("document", { visibilityState: "visible" });
  let resolve!: (value: { version: string }) => void;
  state.call.mockReturnValue(new Promise((done) => { resolve = done; }));
  const update = vi.fn();
  useDocVersion({ id: "report", version: "old" } as ReviewDoc, update);
  await vi.advanceTimersByTimeAsync(4000);
  state.dispose?.();
  resolve({ version: "new" });
  await vi.advanceTimersByTimeAsync(0);
  expect(update).not.toHaveBeenCalled();
});

it("resumes polling after a failed request and skips hidden documents", async () => {
  vi.useFakeTimers();
  vi.stubGlobal("window", globalThis);
  const page = { visibilityState: "hidden" };
  vi.stubGlobal("document", page);
  state.call.mockRejectedValueOnce(new Error("Disconnected"))
    .mockResolvedValue({ version: "old" });
  const update = vi.fn();
  useDocVersion({ id: "report", version: "old" } as ReviewDoc, update);
  await vi.advanceTimersByTimeAsync(4000);
  expect(state.call).not.toHaveBeenCalled();
  page.visibilityState = "visible";
  await vi.advanceTimersByTimeAsync(8000);
  expect(state.call).toHaveBeenCalledTimes(2);
  expect(update).not.toHaveBeenCalled();
});

it("advances the HTML URL together with the file version", async () => {
  vi.useFakeTimers();
  vi.stubGlobal("window", globalThis);
  vi.stubGlobal("document", { visibilityState: "visible" });
  state.call.mockResolvedValue({ version: "new version" });
  const doc = { id: "report", version: "old", htmlUrl: "/html?doc=report&v=old" } as ReviewDoc;
  const update = vi.fn();
  useDocVersion(doc, update);
  await vi.advanceTimersByTimeAsync(4000);
  const changed = update.mock.calls[0][0](doc);
  expect(changed.version).toBe("new version");
  expect(changed.htmlUrl).toBe("/html?doc=report&v=new%20version");
});
