// HTML pages open in a sandboxed frame whose origin is opaque, so the review
// panel cannot reach into the page and the page's scripts cannot reach bb.
// The server serves the file with this bridge script appended: inside the
// frame it reports text selections and picked elements to the panel, and
// paints the comments the panel sends back (highlights, numbered pins,
// element outlines). Messages carry `docReview: 1`; everything the panel
// receives is treated as untrusted input.
//
// The bridge is plain ES2019 kept as a string, so it runs in any page as is.

export { HTML_SANDBOX } from "./types.js";

export const BRIDGE_SCRIPT = String.raw`(function () {
  "use strict";
  if (window.__docReviewBridge || window.parent === window) return;
  window.__docReviewBridge = true;
  var ACCENT = "79,107,237";
  var parentWindow = window.parent;
  var mode = "text";
  var items = [];
  var resolved = [];
  var pendingAnchor = null;
  var pendingTarget = null;
  var ui = null;
  var cachedIndex = null;
  var frame = 0;
  var selectionTimer = 0;
  var selectionShown = false;

  function post(message) {
    message.docReview = 1;
    try { parentWindow.postMessage(message, "*"); } catch (error) { /* the panel went away */ }
  }
  function collapse(text) { return String(text || "").replace(/\s+/g, " ").trim(); }
  function isUi(node) {
    var element = node && (node.nodeType === 1 ? node : node.parentElement);
    return !!(element && element.closest && element.closest("[data-doc-review-ui]"));
  }
  function toRect(box) { return { x: box.left, y: box.top, w: box.width, h: box.height }; }

  // --- Text index: the page's visible text, whitespace collapsed ----------
  var SKIP = { SCRIPT: true, STYLE: true, NOSCRIPT: true, TEMPLATE: true };
  function buildIndex() {
    var index = { text: "", nodes: [], offsets: [] };
    if (!document.body) return index;
    var walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
      acceptNode: function (node) {
        var parent = node.parentElement;
        if (!parent || SKIP[parent.tagName] || isUi(parent)) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      }
    });
    var lastSpace = true;
    var node;
    while ((node = walker.nextNode())) {
      var value = node.data;
      for (var i = 0; i < value.length; i += 1) {
        var ch = value.charAt(i);
        var space = /\s/.test(ch);
        if (space && lastSpace) continue;
        index.text += space ? " " : ch;
        index.nodes.push(node);
        index.offsets.push(i);
        lastSpace = space;
      }
    }
    return index;
  }
  function getIndex() {
    if (!cachedIndex) cachedIndex = buildIndex();
    return cachedIndex;
  }
  function occurrences(index, quote) {
    var hay = index.text.toLowerCase();
    var needle = collapse(quote).toLowerCase();
    var list = [];
    if (!needle) return list;
    var at = hay.indexOf(needle);
    while (at >= 0 && list.length < 500) {
      list.push(at);
      at = hay.indexOf(needle, at + 1);
    }
    return list;
  }
  function rangeAt(index, at, length) {
    var end = at + length - 1;
    if (at < 0 || end >= index.nodes.length) return null;
    var range = document.createRange();
    try {
      range.setStart(index.nodes[at], index.offsets[at]);
      var endNode = index.nodes[end];
      range.setEnd(endNode, Math.min(index.offsets[end] + 1, endNode.data.length));
    } catch (error) {
      return null;
    }
    return range;
  }
  function findQuote(anchor) {
    var index = getIndex();
    var needle = collapse(anchor.quote);
    var list = occurrences(index, needle);
    if (!list.length) return null;
    var prefix = collapse(anchor.prefix).toLowerCase().slice(-24);
    var suffix = collapse(anchor.suffix).toLowerCase().slice(0, 24);
    var best = list[0];
    var bestScore = -1;
    for (var i = 0; i < list.length; i += 1) {
      var at = list[i];
      var before = index.text.slice(Math.max(0, at - prefix.length - 2), at).toLowerCase().trim();
      var after = index.text.slice(at + needle.length, at + needle.length + suffix.length + 2).toLowerCase().trim();
      var score = (prefix && before.slice(-prefix.length) === prefix ? 2 : 0) + (suffix && after.slice(0, suffix.length) === suffix ? 1 : 0);
      if (score > bestScore) { bestScore = score; best = at; }
    }
    return rangeAt(index, best, needle.length);
  }

  // --- Selectors ------------------------------------------------------------
  function cssPath(element) {
    var parts = [];
    while (element && element.nodeType === 1 && element !== document.documentElement) {
      if (element.id && /^[A-Za-z][\w-]*$/.test(element.id) && document.querySelectorAll("#" + element.id).length === 1) {
        parts.unshift("#" + element.id);
        break;
      }
      var tag = element.tagName.toLowerCase();
      var parent = element.parentElement;
      if (!parent) { parts.unshift(tag); break; }
      var same = [];
      for (var i = 0; i < parent.children.length; i += 1) {
        if (parent.children[i].tagName === element.tagName) same.push(parent.children[i]);
      }
      parts.unshift(same.length > 1 ? tag + ":nth-of-type(" + (same.indexOf(element) + 1) + ")" : tag);
      element = parent;
    }
    return parts.join(" > ");
  }
  function visibleText(element) { return collapse(element.innerText !== undefined ? element.innerText : element.textContent); }
  function elementAnchor(element) {
    return {
      kind: "html-element",
      selector: (cssPath(element) || element.tagName.toLowerCase()).slice(0, 1000),
      tag: element.tagName.toLowerCase().slice(0, 40),
      text: visibleText(element).slice(0, 4000),
      html: String(element.outerHTML || "").slice(0, 1200)
    };
  }
  function findElement(anchor) {
    var element = null;
    try { element = document.querySelector(anchor.selector); } catch (error) { element = null; }
    var text = collapse(anchor.text).toLowerCase().slice(0, 80);
    var matches = function (candidate) {
      return candidate && candidate.tagName.toLowerCase() === anchor.tag &&
        (!text || visibleText(candidate).toLowerCase().indexOf(text) === 0);
    };
    if (matches(element)) return element;
    if (text) {
      // The page changed since the comment: the same tag with the same text.
      var candidates = document.getElementsByTagName(anchor.tag);
      for (var i = 0; i < candidates.length; i += 1) {
        if (matches(candidates[i]) && !isUi(candidates[i])) return candidates[i];
      }
    }
    return element && element.tagName.toLowerCase() === anchor.tag ? element : null;
  }
  function resolveAnchor(anchor) {
    if (!anchor) return null;
    if (anchor.kind === "html-text") { var range = findQuote(anchor); return range ? { range: range } : null; }
    if (anchor.kind === "html-element") { var element = findElement(anchor); return element ? { element: element } : null; }
    return null;
  }
  function resolveAll() {
    resolved = [];
    var missing = [];
    for (var i = 0; i < items.length; i += 1) {
      var item = items[i];
      var target = resolveAnchor(item.anchor);
      if (target) resolved.push({ id: item.id, seq: item.seq, active: !!item.active, range: target.range || null, element: target.element || null });
      else missing.push(item.id);
    }
    pendingTarget = resolveAnchor(pendingAnchor);
    schedulePaint();
    post({ type: "resolved", missing: missing });
  }

  // --- Painting ---------------------------------------------------------------
  function ensureUi() {
    if (ui && ui.root.isConnected) return ui;
    var style = document.createElement("style");
    style.setAttribute("data-doc-review-ui", "");
    style.textContent =
      "::highlight(doc-review-comment){background-color:rgba(" + ACCENT + ",0.22)}" +
      "::highlight(doc-review-active){background-color:rgba(" + ACCENT + ",0.42)}" +
      "::highlight(doc-review-pending){background-color:rgba(" + ACCENT + ",0.32)}" +
      "html[data-doc-review-mode=element],html[data-doc-review-mode=element] *{cursor:crosshair!important}";
    (document.head || document.documentElement).appendChild(style);
    var root = document.createElement("div");
    root.setAttribute("data-doc-review-ui", "");
    root.style.cssText = "position:fixed;top:0;left:0;right:0;bottom:0;z-index:2147483647;pointer-events:none;margin:0;padding:0;border:0;background:none;";
    var hover = document.createElement("div");
    hover.style.cssText = "position:fixed;display:none;box-sizing:border-box;border:2px solid rgb(" + ACCENT + ");background:rgba(" + ACCENT + ",0.08);border-radius:3px;pointer-events:none;";
    var layer = document.createElement("div");
    root.appendChild(layer);
    root.appendChild(hover);
    document.documentElement.appendChild(root);
    ui = { root: root, hover: hover, layer: layer, style: style };
    return ui;
  }
  function setHighlights(layers) {
    var registry = window.CSS && window.CSS.highlights;
    var Highlight = window.Highlight;
    if (!registry || !Highlight) return;
    ["comment", "active", "pending"].forEach(function (name) {
      var ranges = layers[name];
      if (ranges.length) registry.set("doc-review-" + name, new (Function.prototype.bind.apply(Highlight, [null].concat(ranges)))());
      else registry.delete("doc-review-" + name);
    });
  }
  function box(left, top, width, height, css) {
    var element = document.createElement("div");
    element.style.cssText = "position:fixed;box-sizing:border-box;left:" + left + "px;top:" + top + "px;width:" + width + "px;height:" + height + "px;" + css;
    return element;
  }
  function paint() {
    frame = 0;
    var parts = ensureUi();
    parts.layer.textContent = "";
    var layers = { comment: [], active: [], pending: [] };
    var width = window.innerWidth;
    var height = window.innerHeight;
    for (var i = 0; i < resolved.length; i += 1) {
      var item = resolved[i];
      var rect = null;
      if (item.range) {
        (item.active ? layers.active : layers.comment).push(item.range);
        var rects = item.range.getClientRects();
        rect = rects.length ? rects[0] : item.range.getBoundingClientRect();
      } else if (item.element) {
        rect = item.element.getBoundingClientRect();
        parts.layer.appendChild(box(rect.left, rect.top, rect.width, rect.height,
          "border:2px solid rgba(" + ACCENT + "," + (item.active ? "1" : "0.7") + ");background:rgba(" + ACCENT + "," + (item.active ? "0.14" : "0.05") + ");border-radius:3px;"));
      }
      if (!rect || rect.bottom < 0 || rect.top > height || rect.right < 0 || rect.left > width) continue;
      var pin = document.createElement("button");
      pin.type = "button";
      pin.textContent = String(item.seq);
      pin.setAttribute("data-comment-id", item.id);
      pin.setAttribute("aria-label", "Comment " + item.seq);
      pin.style.cssText = "all:initial;position:fixed;box-sizing:border-box;left:" + Math.max(2, rect.left - 10) + "px;top:" + Math.max(2, rect.top - 10) + "px;" +
        "min-width:20px;height:20px;padding:0 5px;border-radius:10px;background:rgb(" + ACCENT + ");color:#fff;" +
        "font:600 11px/20px -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;text-align:center;cursor:pointer;pointer-events:auto;" +
        "box-shadow:0 1px 3px rgba(0,0,0,0.3)" + (item.active ? ",0 0 0 3px rgba(" + ACCENT + ",0.35);" : ";");
      pin.addEventListener("click", onPinClick, true);
      parts.layer.appendChild(pin);
    }
    if (pendingTarget) {
      if (pendingTarget.range) layers.pending.push(pendingTarget.range);
      else if (pendingTarget.element) {
        var r = pendingTarget.element.getBoundingClientRect();
        parts.layer.appendChild(box(r.left, r.top, r.width, r.height, "border:2px dashed rgb(" + ACCENT + ");background:rgba(" + ACCENT + ",0.1);border-radius:3px;"));
      }
    }
    setHighlights(layers);
  }
  function schedulePaint() {
    if (!frame) frame = requestAnimationFrame(paint);
  }
  function onPinClick(event) {
    event.preventDefault();
    event.stopPropagation();
    post({ type: "select", id: event.currentTarget.getAttribute("data-comment-id") });
  }

  // --- Selections and picking ---------------------------------------------------
  function selectionAnchor() {
    var selection = window.getSelection();
    if (!selection || selection.rangeCount === 0 || selection.isCollapsed) return null;
    var range = selection.getRangeAt(0);
    if (isUi(range.commonAncestorContainer)) return null;
    var quote = collapse(range.toString());
    if (!quote) return null;
    var index = getIndex();
    var list = occurrences(index, quote);
    var at = -1;
    for (var i = 0; i < list.length && at < 0; i += 1) {
      try { if (range.comparePoint(index.nodes[list[i]], index.offsets[list[i]]) === 0) at = list[i]; } catch (error) { /* detached */ }
    }
    if (at < 0 && list.length) at = list[0];
    var container = range.commonAncestorContainer;
    var element = container.nodeType === 1 ? container : container.parentElement;
    var rects = range.getClientRects();
    var last = rects.length ? rects[rects.length - 1] : range.getBoundingClientRect();
    return {
      anchor: {
        kind: "html-text",
        quote: quote.slice(0, 4000),
        prefix: at >= 0 ? index.text.slice(Math.max(0, at - 60), at).trim().slice(-200) : "",
        suffix: at >= 0 ? index.text.slice(at + quote.length, at + quote.length + 60).trim().slice(0, 200) : "",
        selector: element ? cssPath(element).slice(0, 1000) : ""
      },
      rect: toRect(last)
    };
  }
  function reportSelection() {
    if (mode !== "text") return;
    var found = selectionAnchor();
    if (found) {
      post({ type: "selection", anchor: found.anchor, rect: found.rect });
      selectionShown = true;
    } else if (selectionShown) {
      post({ type: "selection", anchor: null });
      selectionShown = false;
    }
  }
  function pickable(x, y) {
    var element = document.elementFromPoint(x, y);
    if (!element || isUi(element) || element === document.documentElement || element === document.body) return null;
    return element;
  }
  function showHover(element) {
    var parts = ensureUi();
    if (!element) { parts.hover.style.display = "none"; return; }
    var rect = element.getBoundingClientRect();
    parts.hover.style.display = "block";
    parts.hover.style.left = rect.left + "px";
    parts.hover.style.top = rect.top + "px";
    parts.hover.style.width = rect.width + "px";
    parts.hover.style.height = rect.height + "px";
  }
  function caretAt(x, y) {
    if (document.caretRangeFromPoint) {
      var range = document.caretRangeFromPoint(x, y);
      return range ? { node: range.startContainer, offset: range.startOffset } : null;
    }
    if (document.caretPositionFromPoint) {
      var position = document.caretPositionFromPoint(x, y);
      return position ? { node: position.offsetNode, offset: position.offset } : null;
    }
    return null;
  }

  document.addEventListener("selectionchange", function () {
    clearTimeout(selectionTimer);
    selectionTimer = setTimeout(reportSelection, 150);
  });
  window.addEventListener("mousemove", function (event) {
    if (mode === "element") showHover(pickable(event.clientX, event.clientY));
  }, true);
  ["mousedown", "mouseup", "pointerdown", "pointerup", "dblclick", "auxclick", "submit"].forEach(function (type) {
    window.addEventListener(type, function (event) {
      if (mode !== "element" || isUi(event.target)) return;
      event.preventDefault();
      event.stopPropagation();
    }, true);
  });
  window.addEventListener("click", function (event) {
    if (isUi(event.target)) return;
    if (mode === "element") {
      event.preventDefault();
      event.stopPropagation();
      if (event.stopImmediatePropagation) event.stopImmediatePropagation();
      var element = pickable(event.clientX, event.clientY);
      if (!element) return;
      pendingTarget = { element: element };
      schedulePaint();
      post({ type: "element", anchor: elementAnchor(element), rect: toRect(element.getBoundingClientRect()) });
      return;
    }
    // A click on highlighted text opens its comment.
    var selection = window.getSelection();
    if (selection && !selection.isCollapsed) return;
    var caret = caretAt(event.clientX, event.clientY);
    if (!caret) return;
    for (var i = 0; i < resolved.length; i += 1) {
      var item = resolved[i];
      try {
        if (item.range && item.range.isPointInRange(caret.node, caret.offset)) { post({ type: "select", id: item.id }); return; }
      } catch (error) { /* detached */ }
      if (item.element && item.element.contains(caret.node)) { post({ type: "select", id: item.id }); return; }
    }
  }, true);
  document.addEventListener("contextmenu", function (event) {
    if (mode !== "text") return;
    var found = selectionAnchor();
    if (!found) return;
    event.preventDefault();
    post({ type: "contextmenu", anchor: found.anchor, x: event.clientX, y: event.clientY });
  }, true);
  document.addEventListener("keydown", function (event) {
    if ((event.metaKey || event.ctrlKey) && event.altKey && event.code === "KeyM") {
      var found = selectionAnchor();
      if (found) {
        event.preventDefault();
        post({ type: "shortcut", anchor: found.anchor, rect: found.rect });
      }
    } else if (event.key === "Escape") {
      post({ type: "escape" });
    }
  }, true);
  window.addEventListener("scroll", function () {
    schedulePaint();
    if (selectionShown) { clearTimeout(selectionTimer); selectionTimer = setTimeout(reportSelection, 100); }
  }, true);
  window.addEventListener("resize", schedulePaint);
  window.addEventListener("load", function () { cachedIndex = null; resolveAll(); });

  if (window.MutationObserver && document.body) {
    // Throttled, not debounced: a page that never stops changing still repaints.
    var mutationTimer = 0;
    new MutationObserver(function () {
      if (mutationTimer) return;
      mutationTimer = setTimeout(function () { mutationTimer = 0; cachedIndex = null; resolveAll(); }, 300);
    }).observe(document.body, { childList: true, subtree: true, characterData: true });
  }

  window.addEventListener("message", function (event) {
    if (event.source !== parentWindow) return;
    var data = event.data;
    if (!data || data.docReview !== 1) return;
    if (data.type === "mode") {
      mode = data.mode === "element" ? "element" : "text";
      document.documentElement.setAttribute("data-doc-review-mode", mode);
      if (mode !== "element") showHover(null);
      else { var selection = window.getSelection(); if (selection) selection.removeAllRanges(); }
    } else if (data.type === "comments") {
      items = Array.isArray(data.items) ? data.items : [];
      resolveAll();
    } else if (data.type === "pending") {
      pendingAnchor = data.anchor || null;
      pendingTarget = resolveAnchor(pendingAnchor);
      if (!pendingAnchor) showHover(null);
      schedulePaint();
    } else if (data.type === "reveal") {
      for (var i = 0; i < resolved.length; i += 1) {
        if (resolved[i].id !== data.id) continue;
        var item = resolved[i];
        var target = item.element || (item.range && (item.range.startContainer.nodeType === 1 ? item.range.startContainer : item.range.startContainer.parentElement));
        if (target && target.scrollIntoView) target.scrollIntoView({ block: "center", behavior: "smooth" });
        break;
      }
    } else if (data.type === "clear-selection") {
      var current = window.getSelection();
      if (current) current.removeAllRanges();
      selectionShown = false;
    }
  });

  ensureUi();
  post({ type: "ready", title: document.title || "" });
})();`;

const ABSOLUTE_URL = /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i;

function escapeAttribute(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}

/** The charset a page declares in a meta tag near its start, if any. */
export function declaredCharset(source: Buffer): string | null {
  const head = source.subarray(0, 4096).toString("latin1");
  const direct = /<meta[^>]+charset\s*=\s*["']?\s*([\w.:-]+)/i.exec(head);
  return direct ? direct[1]!.toLowerCase() : null;
}

function isUtf8(source: Buffer): boolean {
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(source);
    return true;
  } catch {
    return false;
  }
}

/**
 * The page as the frame gets it: relative URLs resolve next to the file (a
 * `<base>` pointing at bb's preview of its folder) and the bridge script runs
 * at the end of the body. Works on bytes, so any ASCII-compatible encoding
 * survives untouched; `contentType` names the charset when it is known.
 */
export function injectIntoHtml(
  source: Buffer,
  options: { baseHref: string | null; script: string },
): { body: Buffer; contentType: string } {
  let text = source.toString("latin1");
  const bom = text.startsWith("ï»¿") ? "ï»¿" : "";
  if (bom) text = text.slice(bom.length);

  if (options.baseHref) {
    const base = /<base\b[^>]*>/i.exec(text);
    const href = base ? /\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(base[0]) : null;
    const existing = href ? (href[1] ?? href[2] ?? href[3] ?? "") : null;
    if (base && existing !== null && ABSOLUTE_URL.test(existing)) {
      // The page names its own absolute base; leave it.
    } else {
      // A relative base is relative to the file's folder: keep it under ours.
      const combined = existing
        ? new URL(existing, new URL(options.baseHref, "http://preview.invalid")).pathname
        : options.baseHref;
      const tag = `<base href="${escapeAttribute(combined)}">`;
      if (base) {
        text = text.slice(0, base.index) + tag + text.slice(base.index + base[0].length);
      } else {
        const head = /<head\b[^>]*>/i.exec(text);
        const doctype = /^\s*<!doctype[^>]*>/i.exec(text);
        const at = head ? head.index + head[0].length : doctype ? doctype[0].length : 0;
        text = text.slice(0, at) + tag + text.slice(at);
      }
    }
  }

  const script = `<script data-doc-review-bridge>${options.script}</script>`;
  const lower = text.toLowerCase();
  const bodyEnd = lower.lastIndexOf("</body>");
  const htmlEnd = lower.lastIndexOf("</html>");
  const at = bodyEnd >= 0 ? bodyEnd : htmlEnd >= 0 ? htmlEnd : text.length;
  text = text.slice(0, at) + script + text.slice(at);

  const charset = declaredCharset(source) ?? (isUtf8(source) ? "utf-8" : null);
  return {
    body: Buffer.from(bom + text, "latin1"),
    contentType: charset ? `text/html; charset=${charset}` : "text/html",
  };
}
