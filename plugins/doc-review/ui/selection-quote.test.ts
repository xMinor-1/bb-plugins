import { afterEach, expect, it, vi } from "vitest";
import { selectedUserMessage } from "./selection-quote";

vi.mock("@get-bb/plugin-sdk/app", () => ({ useComposer: vi.fn() }));
afterEach(() => vi.unstubAllGlobals());

function fixture() {
  vi.stubGlobal("window", { innerWidth: 1000 });
  const pane = {} as Element;
  const bubble = { closest: () => pane, contains: () => true };
  const element = { closest: vi.fn(() => bubble) };
  const selection = { isCollapsed: false, rangeCount: 1, anchorNode: { nodeType: 3, parentElement: element }, focusNode: {},
    toString: () => "  Комментарий №14\nТекст  ", getRangeAt: () => ({ getBoundingClientRect: () => ({ left: 950, top: 100, bottom: 120 }) }),
  };
  return { pane, bubble, element, selection: selection as unknown as Selection };
}

it("offers a quote for user text in the matching thread pane", () => {
  const f = fixture();
  expect(selectedUserMessage(f.selection, f.pane)).toEqual({ text: "Комментарий №14\nТекст", left: 840, top: 58 });
});

it("ignores assistant messages, other panes and selections spanning messages", () => {
  const f = fixture();
  f.element.closest.mockReturnValueOnce(null as any);
  expect(selectedUserMessage(f.selection, f.pane)).toBeNull();
  expect(selectedUserMessage(f.selection, {} as Element)).toBeNull();
  f.bubble.contains = () => false;
  expect(selectedUserMessage(f.selection, f.pane)).toBeNull();
});

it("ignores empty or collapsed selections", () => {
  const f = fixture();
  expect(selectedUserMessage(null, f.pane)).toBeNull();
  expect(selectedUserMessage({ ...f.selection, isCollapsed: true }, f.pane)).toBeNull();
  expect(selectedUserMessage({ ...f.selection, toString: () => " " }, f.pane)).toBeNull();
});
