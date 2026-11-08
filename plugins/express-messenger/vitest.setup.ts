import { configure } from "@testing-library/react";

// Slow runners: the default 1 s wait of Testing Library flakes there; vitest's testTimeout still bounds real hangs.
configure({ asyncUtilTimeout: 8_000 });

// The page scrolls its note into view; jsdom has no scrollIntoView.
if (typeof Element !== "undefined" && !Element.prototype.scrollIntoView) {
  Object.defineProperty(Element.prototype, "scrollIntoView", { configurable: true, value: () => {} });
}
