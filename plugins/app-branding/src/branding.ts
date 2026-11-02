// Puts a configured name and logo over bb's own, in the page only: bb's files stay as they are.
export const MAX_LOGO_LENGTH = 64 * 1024;
const BB_TITLE = "bb";
const LOGO_IMAGES = 'img[src*="/assets/bb-logo-"]';
const ICON_LINKS = 'link[rel~="icon"], link[rel="apple-touch-icon"]';

export type Branding = { appName: string; logoSvg: string };

export function isUsableLogo(value: string): boolean {
  return value.length <= MAX_LOGO_LENGTH && /^\s*(<\?xml[^>]*>\s*)?<svg[\s>]/.test(value);
}

export function readBranding(values: Record<string, unknown>): Branding {
  const text = (value: unknown) => (typeof value === "string" ? value.trim() : "");
  const logoSvg = text(values.logoSvg);
  return { appName: text(values.appName), logoSvg: isUsableLogo(logoSvg) ? logoSvg : "" };
}

export function svgDataUrl(svg: string): string {
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

/** bb's stylesheet inverts its logo in the dark theme, which would turn a colored logo into its negative. */
export function logoCss(url: string): string {
  return `${LOGO_IMAGES}{content:url("${url}");filter:none!important}`;
}

/** Applies the branding and keeps it applied while bb rewrites the title and icons. Returns the undo. */
export function applyBranding(doc: Document, { appName, logoSvg }: Branding): () => void {
  if (!appName && !logoSvg) return () => {};
  const url = logoSvg ? svgDataUrl(logoSvg) : "";
  const originals = new Map<HTMLLinkElement, string>();
  const style = doc.createElement("style");

  const sync = () => {
    if (appName && doc.title === BB_TITLE) doc.title = appName;
    if (!url) return;
    for (const link of doc.querySelectorAll<HTMLLinkElement>(ICON_LINKS)) {
      const href = link.getAttribute("href") ?? "";
      if (href === url) continue;
      originals.set(link, href);
      link.setAttribute("href", url);
    }
  };

  if (url) {
    style.textContent = logoCss(url);
    doc.head.append(style);
  }
  sync();
  // Every write above is conditional on the value being wrong, so the observer cannot feed itself.
  const observer = new MutationObserver(sync);
  observer.observe(doc.head, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ["href"] });

  return () => {
    observer.disconnect();
    style.remove();
    for (const [link, href] of originals) link.setAttribute("href", href);
    if (appName && doc.title === appName) doc.title = BB_TITLE;
  };
}
