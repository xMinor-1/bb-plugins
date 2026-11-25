// @vitest-environment jsdom
import { act, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { renderSlot } from "@get-bb/plugin-sdk/testing/app";
import type { PluginRpcTestHandlers } from "@get-bb/plugin-sdk/testing/app";
import { afterEach, describe, expect, it, vi } from "vitest";

import { RemoteFiles } from "../../components/RemoteFiles";
import type { FileManagerContract, RemoteDirectory } from "../../contract";

const HOST = "host_remote";
const HOME = "/home/viewer";
const TARGET = "/etc/folder with spaces";
const originalFile = { name: "original.txt", path: `${HOME}/original.txt`, kind: "file" } as const;

function listing(path: string, entries: RemoteDirectory["entries"] = []): RemoteDirectory {
  return { path, parentPath: path.slice(0, path.lastIndexOf("/")) || "/", rootPath: "/", entries, truncated: false };
}

function mount(remoteDirectory: PluginRpcTestHandlers<FileManagerContract>["remoteDirectory"]) {
  const onVisit = vi.fn();
  const slot = renderSlot({ component: RemoteFiles }, { hostId: HOST, onVisit }, {
    rpc: { remoteDirectory } as PluginRpcTestHandlers<FileManagerContract>,
  });
  return { slot, onVisit };
}

afterEach(cleanup);

describe("remote path bar", () => {
  it("uses one row for parent navigation, breadcrumbs, and inline path entry", async () => {
    const remoteDirectory = vi.fn(({ path = HOME }: { hostId: string; path?: string }) => listing(path));
    const { slot, onVisit } = mount(remoteDirectory);
    const ancestor = await slot.findByRole("button", { name: "home" });
    const edit = slot.getByRole("button", { name: "Edit folder path" });
    const strip = slot.getByRole("navigation", { name: "Folder path" });
    expect(strip.contains(edit)).toBe(true);
    expect(strip.contains(ancestor)).toBe(true);
    expect(strip.parentElement?.parentElement?.contains(slot.getByRole("button", { name: "Parent folder" }))).toBe(true);
    expect(slot.queryByText(HOME)).toBeNull();

    fireEvent.click(ancestor);
    await waitFor(() => expect(onVisit).toHaveBeenLastCalledWith(HOST, "/home"));
    expect(slot.queryByRole("textbox")).toBeNull();
    fireEvent.click(slot.getByRole("button", { name: "Edit folder path" }));
    const input = slot.getByRole("textbox", { name: "Folder path" }) as HTMLInputElement;
    expect(input.value).toBe("/home");
    expect(document.activeElement).toBe(input);
    expect(slot.queryByRole("navigation", { name: "Folder path" })).toBeNull();

    fireEvent.change(input, { target: { value: TARGET } });
    fireEvent.keyDown(input, { key: "Enter" });
    await slot.findByRole("button", { name: "folder with spaces" });
    expect(remoteDirectory).toHaveBeenLastCalledWith({ hostId: HOST, path: TARGET });
    expect(onVisit).toHaveBeenLastCalledWith(HOST, TARGET);
    expect(slot.queryByRole("textbox")).toBeNull();
  });

  it("keeps the listing and saved path when typed navigation fails or is cancelled", async () => {
    const remoteDirectory = vi.fn(async ({ path = HOME }: { hostId: string; path?: string }) => {
      if (path !== HOME) throw new Error("path_escape: Outside the machine's browsing root");
      return listing(HOME, [originalFile]);
    });
    const { slot, onVisit } = mount(remoteDirectory);
    await slot.findByRole("button", { name: originalFile.name });
    fireEvent.click(slot.getByRole("button", { name: "Edit folder path" }));
    const input = slot.getByRole("textbox", { name: "Folder path" }) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "relative" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(slot.getByRole("alert").textContent).toBe("Enter an absolute folder path on this machine.");
    expect(remoteDirectory).toHaveBeenCalledTimes(1);

    fireEvent.change(input, { target: { value: TARGET } });
    fireEvent.keyDown(input, { key: "Enter" });
    const alert = await slot.findByRole("alert");
    expect(alert.textContent).toBe("This folder is outside the machine’s browsing root.");
    expect(input.getAttribute("aria-errormessage")).toBe(alert.id);
    expect(input.value).toBe(TARGET);
    expect(slot.getByRole("button", { name: originalFile.name })).toBeDefined();
    expect(onVisit.mock.calls).toEqual([[HOST, HOME]]);

    fireEvent.keyDown(input, { key: "Escape" });
    expect(slot.getByRole("button", { name: "viewer" }).getAttribute("aria-current")).toBe("page");
    expect(document.activeElement).toBe(slot.getByRole("button", { name: "Edit folder path" }));
    expect(slot.queryByRole("alert")).toBeNull();
    expect(remoteDirectory).toHaveBeenCalledTimes(2);
  });

  it("drops a pending typed path result when the editor is cancelled", async () => {
    let finish: (directory: RemoteDirectory) => void = () => undefined;
    const pending = new Promise<RemoteDirectory>((resolve) => { finish = resolve; });
    const { slot, onVisit } = mount(({ path = HOME }) => path === HOME ? listing(HOME, [originalFile]) : pending);
    await slot.findByRole("button", { name: originalFile.name });
    fireEvent.click(slot.getByRole("button", { name: "Edit folder path" }));
    const input = slot.getByRole("textbox", { name: "Folder path" }) as HTMLInputElement;
    fireEvent.change(input, { target: { value: TARGET } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(slot.getByRole("group", { name: "Folder path" }).getAttribute("aria-busy")).toBe("true");
    fireEvent.keyDown(input, { key: "Escape" });
    await act(async () => finish(listing(TARGET)));

    expect(slot.getByRole("button", { name: originalFile.name })).toBeDefined();
    expect(slot.getByRole("button", { name: "viewer" }).getAttribute("aria-current")).toBe("page");
    expect(onVisit.mock.calls).toEqual([[HOST, HOME]]);
  });
});
