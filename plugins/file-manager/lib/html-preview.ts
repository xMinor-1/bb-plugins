const CONTENT_POLICY = [
  "default-src 'none'",
  "style-src 'unsafe-inline'",
  "img-src data:",
  "font-src data:",
  "media-src data:",
  "base-uri 'none'",
  "form-action 'none'",
].join("; ");

/** Build a static document for an iframe with an empty sandbox attribute. */
export function htmlPreviewDocument(markup: string): string {
  // Parse in the template's inert document so resources cannot start loading
  // in the app. Only the serialized, separately sandboxed preview is displayed.
  const inertDocument = document.createElement("template").content.ownerDocument;
  const page = inertDocument.createElement("html");
  page.innerHTML = markup;

  // Resource hints and navigations are independent of the CSP fetch policy.
  page.querySelectorAll(
    "base, link, meta[http-equiv], script, iframe, frame, object, embed, portal, fencedframe, template, area",
  ).forEach((element) => element.remove());
  page.querySelectorAll("a").forEach((link) => {
    // Drop the navigation element itself, including SVG anchors whose target
    // could change after parsing. Keep its text and other visible children.
    const replacement = link.namespaceURI === "http://www.w3.org/2000/svg"
      ? inertDocument.createElementNS(link.namespaceURI, "g")
      : inertDocument.createElement("span");
    while (link.firstChild !== null) replacement.append(link.firstChild);
    link.replaceWith(replacement);
  });
  page.querySelectorAll("math[*|href], math [*|href]").forEach((element) => {
    element.removeAttribute("href");
    element.removeAttributeNS("http://www.w3.org/1999/xlink", "href");
  });

  let head = page.querySelector("head");
  if (head === null) {
    head = inertDocument.createElement("head");
    page.prepend(head);
  }
  const policy = inertDocument.createElement("meta");
  policy.httpEquiv = "Content-Security-Policy";
  policy.content = CONTENT_POLICY;
  head.prepend(policy);
  return `<!doctype html>${page.outerHTML}`;
}
