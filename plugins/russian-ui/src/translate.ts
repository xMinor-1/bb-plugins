// Puts Russian text over bb's English in the hard-to-read screens only: settings, first run and dialogs.
// It works in the page: bb's files stay as they are, and the undo brings the English text back.

export type Dictionary = {
  exact: Record<string, string>;
  /** Tried in order when there is no exact match. The replacement may use $1, $2… */
  patterns: ReadonlyArray<readonly [RegExp, string]>;
};

/** Screens that are translated as a whole while the route is a settings page. */
const SETTINGS_ROOTS = '[data-testid="settings-sidebar-body"], [data-testid="app-layout-content-shell"]';
/** Screens that are translated on any route: first run, dialogs and the agent's permission requests. */
const GLOBAL_ROOTS =
  '[data-testid="onboarding"], [role="dialog"], [role="alertdialog"], [data-testid="tool-use-ask"], [data-testid="plan-review-request"]';
/** Menus and lists opened from settings. */
const POPOVERS = "[data-radix-popper-content-wrapper]";
/** Never touched: what the user or an agent wrote, code, and the command palette with thread titles. */
const EXCLUDED =
  'pre, code, kbd, [contenteditable=""], [contenteditable="true"], .monaco-editor, .cm-editor, .xterm, [cmdk-root], ' +
  '[data-testid="command-palette"], [data-testid="command-preview"], [class*="prose"], [class*="markdown"], [data-bb-no-translate]';
/** A text box's text is its value; its placeholder and title are still translated. */
const VALUE_HOLDERS = "textarea";
const ATTRIBUTES = ["placeholder", "title"] as const;

export function lookupKey(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** The Russian text for an English one, keeping its surrounding spaces, or null when there is none. */
export function translateText(text: string, dict: Dictionary): string | null {
  const key = lookupKey(text);
  if (!key) return null;
  let target: string | undefined = dict.exact[key];
  if (target === undefined) {
    for (const [pattern, replacement] of dict.patterns) {
      if (pattern.test(key)) {
        target = key.replace(pattern, replacement);
        break;
      }
    }
  }
  if (target === undefined || target === key) return null;
  const lead = /^\s*/.exec(text)?.[0] ?? "";
  const trail = /\s*$/.exec(text)?.[0] ?? "";
  return lead + target + trail;
}

export function isSettingsPath(pathname: string): boolean {
  return pathname === "/settings" || pathname.startsWith("/settings/");
}

/** Whether a node lies in a translated screen and outside the excluded parts. */
export function inScope(node: Node, settingsRoute: boolean): boolean {
  const el = node instanceof Element ? node : node.parentElement;
  if (!el || el.closest(EXCLUDED)) return false;
  if (!(node instanceof Element) && el.closest(VALUE_HOLDERS)) return false;
  if (el.closest(GLOBAL_ROOTS)) return true;
  return settingsRoute && el.closest(`${SETTINGS_ROOTS}, ${POPOVERS}`) !== null;
}

/** Translates the page and keeps it translated while bb renders. Returns the undo. */
export function startTranslator(doc: Document, dict: Dictionary): () => void {
  const view = doc.defaultView;
  const texts = new Map<Text, { original: string; shown: string }>();
  const attrs = new Map<Element, Map<string, { original: string; shown: string }>>();
  const settingsRoute = () => isSettingsPath(view?.location.pathname ?? "");

  const translateTextNode = (node: Text) => {
    const value = node.nodeValue ?? "";
    const known = texts.get(node);
    if (known && value === known.shown) return;
    const shown = translateText(value, dict);
    if (shown === null) {
      // bb wrote new text that has no translation: forget the old original so the undo does not bring it back.
      if (known) texts.delete(node);
      return;
    }
    texts.set(node, { original: value, shown });
    node.nodeValue = shown;
  };

  const translateAttributes = (el: Element) => {
    for (const name of ATTRIBUTES) {
      const value = el.getAttribute(name);
      if (value === null) continue;
      const known = attrs.get(el)?.get(name);
      if (known && value === known.shown) continue;
      const shown = translateText(value, dict);
      if (shown === null) {
        attrs.get(el)?.delete(name);
        continue;
      }
      let byName = attrs.get(el);
      if (!byName) attrs.set(el, (byName = new Map()));
      byName.set(name, { original: value, shown });
      el.setAttribute(name, shown);
    }
  };

  const visit = (root: Node, settings: boolean) => {
    if (root instanceof Text) {
      if (inScope(root, settings)) translateTextNode(root);
      return;
    }
    if (!(root instanceof Element)) return;
    // Most of what bb adds (chat messages, the thread list) is outside every screen: one check and out.
    const starts = inScope(root, settings)
      ? [root]
      : [...root.querySelectorAll(settings ? `${GLOBAL_ROOTS}, ${SETTINGS_ROOTS}, ${POPOVERS}` : GLOBAL_ROOTS)];
    for (const start of starts) walk(start, settings);
  };

  const walk = (start: Element, settings: boolean) => {
    const walker = doc.createTreeWalker(start, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        if (node instanceof Element && node.matches(EXCLUDED)) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      },
    });
    for (let node: Node | null = walker.currentNode; node; node = walker.nextNode()) {
      if (node instanceof Text) {
        if (inScope(node, settings)) translateTextNode(node);
      } else if (node instanceof Element && (node.hasAttribute("placeholder") || node.hasAttribute("title"))) {
        if (inScope(node, settings)) translateAttributes(node);
      }
    }
  };

  const prune = () => {
    for (const node of texts.keys()) if (!node.isConnected) texts.delete(node);
    for (const el of attrs.keys()) if (!el.isConnected) attrs.delete(el);
  };

  let batches = 0;
  const observer = new MutationObserver((records) => {
    const settings = settingsRoute();
    for (const record of records) {
      if (record.type === "characterData") {
        if (record.target instanceof Text && inScope(record.target, settings)) translateTextNode(record.target);
      } else if (record.type === "attributes") {
        if (record.target instanceof Element && inScope(record.target, settings)) translateAttributes(record.target);
      } else {
        for (const node of record.addedNodes) visit(node, settings);
      }
    }
    // Writes above only happen when the text is English, so the observer cannot feed itself.
    if (++batches % 200 === 0) prune();
  });

  visit(doc.body, settingsRoute());
  observer.observe(doc.body, {
    subtree: true,
    childList: true,
    characterData: true,
    attributes: true,
    attributeFilter: [...ATTRIBUTES],
  });

  return () => {
    observer.disconnect();
    for (const [node, { original, shown }] of texts) if (node.nodeValue === shown) node.nodeValue = original;
    for (const [el, byName] of attrs) {
      for (const [name, { original, shown }] of byName) if (el.getAttribute(name) === shown) el.setAttribute(name, original);
    }
    texts.clear();
    attrs.clear();
  };
}
