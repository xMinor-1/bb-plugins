import { configure } from "@testing-library/react";

// Slow runners: the default 1 s wait of Testing Library flakes there; vitest's testTimeout still bounds real hangs.
configure({ asyncUtilTimeout: 8_000 });

// The dialog picks a layout through matchMedia and Radix scrolls focused items into view; jsdom has neither.
if (typeof window !== "undefined" && !window.matchMedia) {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    writable: true,
    value: (query: string): MediaQueryList =>
      ({
        matches: false,
        media: query,
        onchange: null,
        addListener: () => {},
        removeListener: () => {},
        addEventListener: () => {},
        removeEventListener: () => {},
        dispatchEvent: () => false,
      }) as unknown as MediaQueryList,
  });
}
if (typeof Element !== "undefined" && !Element.prototype.scrollIntoView) {
  Object.defineProperty(Element.prototype, "scrollIntoView", { configurable: true, value: () => {} });
}
