/** Only decorate Doc Review's numbered drawing attachments in BB's chat. */
export function mountDrawingCaptions() {
  const captions = new Set<HTMLSpanElement>();
  const refresh = (root: Element | Document) => {
    const images = [...root.querySelectorAll<HTMLImageElement>('button > img[alt^="comment-"]')];
    if (root instanceof HTMLImageElement && root.matches('button > img[alt^="comment-"]')) images.push(root);
    images.forEach((image) => {
      const match = /^comment-(\d+)-c_[a-z0-9]+(?:-|\.(?:png|jpe?g)$)/.exec(image.alt);
      if (!match) return;
      const button = image.parentElement!;
      let caption = button.querySelector<HTMLSpanElement>("[data-doc-review-caption]");
      if (!caption) {
        caption = document.createElement("span");
        caption.dataset.docReviewCaption = "";
        caption.style.cssText = "display:block;padding:2px 4px;font:500 11px/1.4 system-ui,sans-serif;text-align:center;color:inherit";
        button.appendChild(caption);
        captions.add(caption);
      }
      const label = `№${match[1]}`;
      if (caption.textContent !== label) caption.textContent = label;
    });
  };
  const observer = new MutationObserver((records) => {
    for (const record of records) {
      if (record.type === "attributes") refresh(record.target as Element);
      else record.addedNodes.forEach((node) => { if (node instanceof Element) refresh(node); });
    }
    if (records.some((record) => record.removedNodes.length)) {
      for (const caption of captions) if (!caption.isConnected) captions.delete(caption);
    }
  });
  observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["alt"] });
  refresh(document);
  return () => { observer.disconnect(); captions.forEach((caption) => caption.remove()); captions.clear(); };
}
