// HTML pages open in a sandboxed frame whose origin is opaque, so the review
// panel cannot reach into the page and the page's scripts cannot reach bb.
// The server serves the file with this bridge script first in its head:
// inside the frame it reports text selections and picked elements to the
// panel, and paints the comments the panel sends back (highlights, numbered
// pins, element outlines). Messages carry `docReview: 1`; everything the
// panel receives is treated as untrusted input.
//
// Pages the page shows in `<iframe srcdoc>` frames (a desktop and a phone
// preview side by side, say) get the bridge too. Each bridge relays for the
// frames inside its page: it adds the frame's CSS path to their anchors and
// maps their rectangles into its own viewport, so the panel talks to one
// bridge however deep the frames go.
//
// The bridge is plain ES2019 kept as a string, so it runs in any page as is.

import { DRAW_STEP, DRAWING_JS } from "./drawing.js";

export { HTML_SANDBOX } from "./types.js";

const MARK = "data-doc-review-bridge";

export const BRIDGE_SCRIPT = String.raw`(function () {
  "use strict";
  if (window.__docReviewBridge || window.parent === window) return;
  window.__docReviewBridge = true;
  var ACCENT = "79,107,237";
  var MARK = "data-doc-review-bridge";
  // A comment inside a frame names the frame by its CSS path, outermost first.
  var FRAME_JOIN = " >>> ";
  var parentWindow = window.parent;
  var own = document.currentScript;
  // The bridge's own text, for the pages this page shows in srcdoc frames.
  var SOURCE = own && own.hasAttribute(MARK) ? own.textContent || "" : "";
  var session = String(Math.random()).slice(2);
  // The bridge runs before the page's content arrives: selections work at
  // once, and comments resolve once the page is parsed.
  var loaded = document.readyState !== "loading";
  var mode = "text";
  var items = [];
  var resolved = [];
  var ownMissing = [];
  var children = [];
  var pendingAnchor = null;
  var pendingTarget = null;
  var revealLater = null;
  var revealNested = false;
  // How much the page holding this frame shrinks or grows it on screen.
  var viewScale = 1;
  var scaleTimer = 0;
  var ui = null;
  var cachedIndex = null;
  var paintRequest = 0;
  var selectionTimer = 0;
  var selectionShown = false;
  // Draw mode (the top page only; frames inside it wait as "idle"): the
  // strokes drawn so far, in CSS pixels of the page as it scrolls.
  var tool = "pen";
  var sketch = [];
  var stroke = null;
  var drawHold = null;
  var sketchShown = false;
  var DRAW_STEP = ${DRAW_STEP};
  ${DRAWING_JS}

  function sendTo(target, message) {
    message.docReview = 1;
    try { target.postMessage(message, "*"); } catch (error) { /* the frame went away */ }
  }
  function post(message) { sendTo(parentWindow, message); }
  function announce() { post({ type: "ready", session: session }); }
  function copyOf(object) {
    var copy = {};
    for (var key in object) if (Object.prototype.hasOwnProperty.call(object, key)) copy[key] = object[key];
    return copy;
  }
  function collapse(text) { return String(text || "").replace(/\s+/g, " ").trim(); }
  function isUi(node) {
    var element = node && (node.nodeType === 1 ? node : node.parentElement);
    return !!(element && element.closest && element.closest("[data-doc-review-ui]"));
  }
  function toRect(box) { return { x: box.left, y: box.top, w: box.width, h: box.height }; }
  /** A size for pins and outlines that looks the same in a scaled frame. */
  function px(size) { return size * Math.min(4, Math.max(0.25, 1 / viewScale)) + "px"; }

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
    if (cachedIndex) return cachedIndex;
    var index = buildIndex();
    // While the page is still arriving, the next selection needs a fresh one.
    if (loaded) cachedIndex = index;
    return index;
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
    var doc = element.ownerDocument || document;
    var parts = [];
    while (element && element.nodeType === 1 && element !== document.documentElement) {
      if (element.id && /^[A-Za-z][\w-]*$/.test(element.id) && doc.querySelectorAll("#" + element.id).length === 1) {
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
    if (!anchor || frameSplit(anchor)) return null;
    if (anchor.kind === "html-text") { var range = findQuote(anchor); return range ? { range: range } : null; }
    if (anchor.kind === "html-element") { var element = findElement(anchor); return element ? { element: element } : null; }
    if (anchor.kind === "html-drawing" && Array.isArray(anchor.strokes)) return { drawing: anchor.strokes };
    return null;
  }
  function resolveAll() {
    if (!loaded) return;
    resolved = [];
    ownMissing = [];
    for (var i = 0; i < items.length; i += 1) {
      var item = items[i];
      if (frameSplit(item.anchor)) continue;
      var target = resolveAnchor(item.anchor);
      if (target) resolved.push({ id: item.id, seq: item.seq, active: !!item.active, range: target.range || null, element: target.element || null, drawing: target.drawing || null });
      else ownMissing.push(item.id);
    }
    pendingTarget = resolveAnchor(pendingAnchor);
    schedulePaint();
    reportMissing();
  }
  /** Comments the page has no place for: its own, and those its frames report. */
  function reportMissing() {
    if (!loaded) return;
    var missing = ownMissing.slice();
    for (var i = 0; i < items.length; i += 1) {
      var split = frameSplit(items[i].anchor);
      if (!split) continue;
      var element = frameAt(split.head);
      var child = element ? childFor(element.contentWindow, false) : null;
      if (!element || (child && child.missing.indexOf(items[i].id) >= 0)) missing.push(items[i].id);
    }
    post({ type: "resolved", missing: missing });
  }

  // --- Frames: pages this page shows inside it --------------------------------
  function isFrame(element) { return !!element && (element.tagName === "IFRAME" || element.tagName === "FRAME"); }
  function frameSplit(anchor) {
    var path = anchor && typeof anchor.frame === "string" ? anchor.frame : "";
    if (!path) return null;
    var at = path.indexOf(FRAME_JOIN);
    return at < 0 ? { head: path, rest: "" } : { head: path.slice(0, at), rest: path.slice(at + FRAME_JOIN.length) };
  }
  function frameAt(selector) {
    var element = null;
    try { element = document.querySelector(selector); } catch (error) { element = null; }
    return isFrame(element) ? element : null;
  }
  function frameOf(source) {
    var list = document.querySelectorAll("iframe, frame");
    for (var i = 0; i < list.length; i += 1) if (list[i].contentWindow === source) return list[i];
    return null;
  }
  function childFor(win, create) {
    for (var i = 0; i < children.length; i += 1) if (children[i].win === win) return children[i];
    if (!create || !win) return null;
    var child = { win: win, missing: [] };
    children.push(child);
    return child;
  }
  function innerAnchor(anchor, rest) {
    var copy = copyOf(anchor);
    delete copy.frame;
    if (rest) copy.frame = rest;
    return copy;
  }
  function outerAnchor(anchor, path) {
    if (!anchor || typeof anchor !== "object") return null;
    var copy = copyOf(anchor);
    copy.frame = typeof anchor.frame === "string" && anchor.frame ? path + FRAME_JOIN + anchor.frame : path;
    return copy;
  }
  /** A rectangle in a frame's viewport, in this page's viewport (frames may be scaled). */
  function outerRect(element, rect) {
    if (!rect || typeof rect.x !== "number" || typeof rect.y !== "number") return null;
    var box = element.getBoundingClientRect();
    var scaleX = element.offsetWidth ? box.width / element.offsetWidth : 1;
    var scaleY = element.offsetHeight ? box.height / element.offsetHeight : 1;
    var style = window.getComputedStyle(element);
    var left = box.left + (element.clientLeft + (parseFloat(style.paddingLeft) || 0)) * scaleX;
    var top = box.top + (element.clientTop + (parseFloat(style.paddingTop) || 0)) * scaleY;
    return { x: left + rect.x * scaleX, y: top + rect.y * scaleY, w: (rect.w || 0) * scaleX, h: (rect.h || 0) * scaleY };
  }
  /** The part of the panel's state that belongs to one frame, with the frame's scale. */
  function frameMessage(element, type) {
    var message = { type: type };
    // Only the top page draws; its overlay covers the frames.
    if (type === "mode") message.mode = mode === "draw" ? "idle" : mode;
    if (type === "comments") {
      message.items = [];
      for (var i = 0; i < items.length; i += 1) {
        var split = frameSplit(items[i].anchor);
        if (!split || frameAt(split.head) !== element) continue;
        var item = copyOf(items[i]);
        item.anchor = innerAnchor(items[i].anchor, split.rest);
        message.items.push(item);
      }
    }
    if (type === "pending") {
      var pending = frameSplit(pendingAnchor);
      message.anchor = pending && frameAt(pending.head) === element ? innerAnchor(pendingAnchor, pending.rest) : null;
    }
    var box = element.getBoundingClientRect();
    message.scale = viewScale * (element.offsetWidth ? box.width / element.offsetWidth : 1);
    return message;
  }
  function toFrames(type) {
    var list = document.querySelectorAll("iframe, frame");
    for (var i = 0; i < list.length; i += 1) {
      if (list[i].contentWindow) sendTo(list[i].contentWindow, frameMessage(list[i], type));
    }
  }
  function fromFrame(element, data) {
    var path = cssPath(element);
    var win = element.contentWindow;
    if (data.type === "ready") {
      childFor(win, true).missing = [];
      sendTo(win, frameMessage(element, "mode"));
      sendTo(win, frameMessage(element, "comments"));
      sendTo(win, frameMessage(element, "pending"));
    } else if (data.type === "resolved") {
      childFor(win, true).missing = Array.isArray(data.missing) ? data.missing : [];
      reportMissing();
    } else if (data.type === "selection" || data.type === "element" || data.type === "shortcut") {
      post({ type: data.type, anchor: outerAnchor(data.anchor, path), rect: outerRect(element, data.rect) });
    } else if (data.type === "contextmenu") {
      var point = outerRect(element, { x: data.x, y: data.y, w: 0, h: 0 });
      if (point) post({ type: "contextmenu", anchor: outerAnchor(data.anchor, path), x: point.x, y: point.y });
    } else if (data.type === "reveal-at") {
      revealRect(outerRect(element, data.rect));
    } else if (data.type === "select") {
      post({ type: "select", id: data.id });
    } else if (data.type === "escape") {
      post({ type: "escape" });
    } else if (data.type === "hits-result" || data.type === "serialized") {
      answered(data);
    }
  }
  function withBridge(html) {
    var tag = "<script " + MARK + ">" + SOURCE + "</scr" + "ipt>";
    var head = /<head\b[^>]*>/i.exec(html);
    var doctype = /^\s*<!doctype[^>]*>/i.exec(html);
    var at = head ? head.index + head[0].length : doctype ? doctype[0].length : 0;
    return html.slice(0, at) + tag + html.slice(at);
  }
  /** A srcdoc the page set itself (the server covers the ones in its markup). */
  function bridgeFrame(element) {
    if (!SOURCE || !element || element.tagName !== "IFRAME" || !element.hasAttribute("srcdoc")) return;
    var html = element.getAttribute("srcdoc") || "";
    if (html.indexOf(MARK) < 0) element.setAttribute("srcdoc", withBridge(html));
  }
  // A frame that appears or resizes (a preview tab switched on, say) is
  // usually rescaled too: tell it its new scale.
  var frameSizes = window.ResizeObserver ? new ResizeObserver(function () { rescaleFrames(); }) : null;
  function rescaleFrames() {
    clearTimeout(scaleTimer);
    scaleTimer = setTimeout(function () { toFrames("scale"); }, 150);
  }
  function bridgeFramesIn(node) {
    if (!node || node.nodeType !== 1) return;
    var list = node.tagName === "IFRAME" ? [node] : node.firstElementChild ? node.getElementsByTagName("iframe") : [];
    for (var i = 0; i < list.length; i += 1) {
      if (frameSizes) frameSizes.observe(list[i]);
      bridgeFrame(list[i]);
    }
  }

  // --- Painting ---------------------------------------------------------------
  function ensureUi() {
    if (ui && ui.root.isConnected) return ui;
    // Nothing to paint on before the body arrives.
    if (!document.body) return null;
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
    var ink = document.createElement("div");
    ink.style.cssText = "position:absolute;left:0;top:0;width:0;height:0;overflow:visible;pointer-events:none;";
    root.appendChild(ink);
    root.appendChild(layer);
    root.appendChild(hover);
    document.documentElement.appendChild(root);
    ui = { root: root, hover: hover, layer: layer, ink: ink, style: style };
    listenForDrawing(root);
    applyDrawMode();
    return ui;
  }
  /** In draw mode the overlay takes the pointer; a finger still scrolls until it rests. */
  function applyDrawMode() {
    if (!ui) return;
    var on = mode === "draw";
    ui.root.style.pointerEvents = on ? "auto" : "none";
    ui.root.style.cursor = on ? "crosshair" : "";
    ui.root.style.touchAction = on ? "pan-x pan-y pinch-zoom" : "";
    ui.root.style.webkitUserSelect = on ? "none" : "";
    ui.root.style.userSelect = on ? "none" : "";
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
    paintRequest = 0;
    var parts = ensureUi();
    if (!parts) return;
    parts.layer.textContent = "";
    parts.ink.textContent = "";
    parts.ink.style.transform = "translate(" + -window.scrollX + "px," + -window.scrollY + "px)";
    var layers = { comment: [], active: [], pending: [] };
    var width = window.innerWidth;
    var height = window.innerHeight;
    for (var i = 0; i < resolved.length; i += 1) {
      var item = resolved[i];
      var rect = null;
      if (item.drawing) {
        parts.ink.appendChild(drawingSvg(document, item.drawing, item.active ? 1 : 0.45));
        var b = drawingBounds(item.drawing);
        if (b) rect = { left: b.x0 - window.scrollX, top: b.y0 - window.scrollY, right: b.x1 - window.scrollX, bottom: b.y1 - window.scrollY };
      } else if (item.range) {
        (item.active ? layers.active : layers.comment).push(item.range);
        var rects = item.range.getClientRects();
        rect = rects.length ? rects[0] : item.range.getBoundingClientRect();
      } else if (item.element) {
        rect = item.element.getBoundingClientRect();
        parts.layer.appendChild(box(rect.left, rect.top, rect.width, rect.height,
          "border:" + px(2) + " solid rgba(" + ACCENT + "," + (item.active ? "1" : "0.7") + ");background:rgba(" + ACCENT + "," + (item.active ? "0.14" : "0.05") + ");border-radius:" + px(3) + ";"));
      }
      if (!rect || rect.bottom < 0 || rect.top > height || rect.right < 0 || rect.left > width) continue;
      var pin = document.createElement("button");
      pin.type = "button";
      pin.textContent = String(item.seq);
      pin.setAttribute("data-comment-id", item.id);
      pin.setAttribute("aria-label", "Comment " + item.seq);
      var offset = parseFloat(px(10));
      pin.style.cssText = "all:initial;position:fixed;box-sizing:border-box;left:" + Math.max(2, rect.left - offset) + "px;top:" + Math.max(2, rect.top - offset) + "px;" +
        "min-width:" + px(20) + ";height:" + px(20) + ";padding:0 " + px(5) + ";border-radius:" + px(10) + ";background:rgb(" + ACCENT + ");color:#fff;" +
        "font:600 " + px(11) + "/" + px(20) + " -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;text-align:center;cursor:pointer;pointer-events:auto;" +
        "box-shadow:0 1px 3px rgba(0,0,0,0.3)" + (item.active ? ",0 0 0 " + px(3) + " rgba(" + ACCENT + ",0.35);" : ";");
      pin.addEventListener("click", onPinClick, true);
      parts.layer.appendChild(pin);
    }
    if (pendingTarget) {
      if (pendingTarget.range) layers.pending.push(pendingTarget.range);
      else if (pendingTarget.element) {
        var r = pendingTarget.element.getBoundingClientRect();
        parts.layer.appendChild(box(r.left, r.top, r.width, r.height, "border:" + px(2) + " dashed rgb(" + ACCENT + ");background:rgba(" + ACCENT + ",0.1);border-radius:" + px(3) + ";"));
      }
    }
    var strokes = stroke ? sketch.concat([stroke]) : sketch;
    if (strokes.length) parts.ink.appendChild(drawingSvg(document, strokes, 1));
    reportSketch();
    setHighlights(layers);
  }
  function schedulePaint() {
    if (!paintRequest) paintRequest = requestAnimationFrame(paint);
  }
  function onPinClick(event) {
    event.preventDefault();
    event.stopPropagation();
    post({ type: "select", id: event.currentTarget.getAttribute("data-comment-id") });
  }

  // --- Revealing a comment ------------------------------------------------------
  // The panel asks the top page; a comment inside a frame is scrolled to in
  // the frame first, and each page up centers the spot its frame reports.
  function reveal(id, nested) {
    var item = null;
    for (var i = 0; i < items.length && !item; i += 1) if (items[i].id === id) item = items[i];
    if (!item) return;
    revealNested = nested;
    var split = frameSplit(item.anchor);
    if (split) {
      var element = frameAt(split.head);
      if (element && element.contentWindow) sendTo(element.contentWindow, { type: "reveal", id: id, nested: true });
      return;
    }
    if (!loaded) { revealLater = { id: id, nested: nested }; return; }
    for (var j = 0; j < resolved.length; j += 1) {
      if (resolved[j].id !== id) continue;
      var found = resolved[j];
      if (found.drawing) {
        var bounds = drawingBounds(found.drawing);
        if (bounds) window.scrollTo({ left: Math.max(0, bounds.x0 - 40), top: Math.max(0, (bounds.y0 + bounds.y1) / 2 - window.innerHeight / 2), behavior: nested ? "auto" : "smooth" });
        return;
      }
      var target = found.element || (found.range && (found.range.startContainer.nodeType === 1 ? found.range.startContainer : found.range.startContainer.parentElement));
      if (!target || !target.scrollIntoView) return;
      target.scrollIntoView({ block: "center", behavior: nested ? "auto" : "smooth" });
      if (nested) post({ type: "reveal-at", rect: toRect(target.getBoundingClientRect()) });
      return;
    }
  }
  function revealRect(rect) {
    if (!rect) return;
    var dy = rect.y + rect.h / 2 - window.innerHeight / 2;
    var dx = rect.x < 0 || rect.x + rect.w > window.innerWidth ? rect.x + rect.w / 2 - window.innerWidth / 2 : 0;
    if (!revealNested) { window.scrollBy({ left: dx, top: dy, behavior: "smooth" }); return; }
    var x = window.scrollX;
    var y = window.scrollY;
    window.scrollBy(dx, dy);
    post({ type: "reveal-at", rect: { x: rect.x - (window.scrollX - x), y: rect.y - (window.scrollY - y), w: rect.w, h: rect.h } });
  }

  // --- Drawing ---------------------------------------------------------------------
  // A mouse or pen draws at once; a finger scrolls as usual and draws after
  // resting for a moment. Strokes are kept in page coordinates, so they stay
  // on what they were drawn over while the page scrolls.
  var HOLD_MS = 300;
  function pagePoint(event) { return [Math.round((event.clientX + window.scrollX) * 2) / 2, Math.round((event.clientY + window.scrollY) * 2) / 2]; }
  function startStroke(event) {
    var at = pagePoint(event);
    stroke = { tool: tool, points: [at[0], at[1]] };
    schedulePaint();
  }
  function extendStroke(event) {
    var at = pagePoint(event);
    var p = stroke.points;
    if (stroke.tool === "arrow") {
      stroke.points = [p[0], p[1], at[0], at[1]];
    } else {
      var n = p.length;
      if (Math.abs(at[0] - p[n - 2]) + Math.abs(at[1] - p[n - 1]) < DRAW_STEP || n >= 3998) return;
      p.push(at[0], at[1]);
    }
    schedulePaint();
  }
  function endStroke() {
    var done = stroke;
    stroke = null;
    if (!done) return;
    var p = done.points;
    // An arrow needs a direction; a click in arrow mode draws nothing.
    var shortArrow = done.tool === "arrow" && (p.length < 4 || Math.abs(p[2] - p[0]) + Math.abs(p[3] - p[1]) < 8);
    if (!shortArrow && sketch.length < 60) {
      if (p.length === 2) p.push(p[0], p[1]);
      sketch.push(done);
    }
    schedulePaint();
  }
  function cancelHold() {
    if (drawHold) clearTimeout(drawHold.timer);
    drawHold = null;
  }
  function listenForDrawing(root) {
    root.addEventListener("pointerdown", function (event) {
      if (mode !== "draw" || (event.target !== root && event.target.closest && event.target.closest("button"))) return;
      // A second finger is a pinch or a scroll, not a line.
      if (drawHold || stroke) { cancelHold(); stroke = null; schedulePaint(); return; }
      if (event.button !== 0) return;
      if (event.pointerType === "touch") {
        var pointerId = event.pointerId;
        var start = { clientX: event.clientX, clientY: event.clientY };
        drawHold = {
          x: event.clientX,
          y: event.clientY,
          timer: setTimeout(function () {
            drawHold = null;
            stroke = null;
            startStroke(start);
            stroke.pointerId = pointerId;
            if (navigator.vibrate) navigator.vibrate(10);
          }, HOLD_MS)
        };
        return;
      }
      event.preventDefault();
      try { root.setPointerCapture(event.pointerId); } catch (error) { /* gone */ }
      startStroke(event);
      stroke.pointerId = event.pointerId;
    });
    root.addEventListener("pointermove", function (event) {
      if (drawHold) {
        // Moving before the rest ends is a scroll.
        if (Math.abs(event.clientX - drawHold.x) + Math.abs(event.clientY - drawHold.y) > 8) cancelHold();
        return;
      }
      if (stroke && stroke.pointerId === event.pointerId) extendStroke(event);
    });
    var finish = function (event) {
      if (drawHold) { cancelHold(); return; }
      if (stroke && stroke.pointerId === event.pointerId) {
        delete stroke.pointerId;
        endStroke();
      }
    };
    root.addEventListener("pointerup", finish);
    root.addEventListener("pointercancel", function (event) {
      cancelHold();
      if (stroke && stroke.pointerId === event.pointerId) { stroke = null; schedulePaint(); }
    });
    // While a finger draws, the page must not scroll under it.
    root.addEventListener("touchmove", function (event) { if (stroke) event.preventDefault(); }, { passive: false });
    root.addEventListener("contextmenu", function (event) { if (mode === "draw") event.preventDefault(); });
  }
  /** Tells the panel how many strokes wait and where they are, for its Comment button. */
  function reportSketch() {
    if (!sketch.length) {
      if (sketchShown) post({ type: "sketch", count: 0 });
      sketchShown = false;
      return;
    }
    var b = drawingBounds(sketch);
    sketchShown = true;
    post({ type: "sketch", count: sketch.length, rect: { x: b.x0 - window.scrollX, y: b.y0 - window.scrollY, w: b.x1 - b.x0, h: b.y1 - b.y0 } });
  }
  function clearSketch() {
    cancelHold();
    sketch = [];
    stroke = null;
    schedulePaint();
  }

  // Questions to the bridges in this page's frames (what lies under a point,
  // what the frame's page looks like now). A frame that does not answer in
  // time is described as the frame itself.
  var askSeq = 0;
  var asking = {};
  function ask(win, message, timeoutMs) {
    return new Promise(function (resolve) {
      askSeq += 1;
      var id = askSeq;
      asking[id] = resolve;
      message.ask = id;
      sendTo(win, message);
      setTimeout(function () { if (asking[id]) { delete asking[id]; resolve(null); } }, timeoutMs);
    });
  }
  function answered(data) {
    var done = typeof data.ask === "number" ? asking[data.ask] : null;
    if (done) { delete asking[data.ask]; done(data); }
  }
  function bridgedFrame(element) { return isFrame(element) && element.contentWindow && childFor(element.contentWindow, false) ? element : null; }

  // What each stroke touches, for the agent: what a line lies on, the
  // largest element inside a loop, the elements at an arrow's ends.
  var INTERACTIVE = "a,button,input,select,textarea,label,summary,[role=button],[role=link],[role=tab],[role=menuitem],[role=checkbox],[role=switch]";
  function framePoint(frame, x, y) {
    var box = frame.getBoundingClientRect();
    var sx = frame.offsetWidth ? box.width / frame.offsetWidth : 1;
    var sy = frame.offsetHeight ? box.height / frame.offsetHeight : 1;
    var style = window.getComputedStyle(frame);
    var left = box.left + (frame.clientLeft + (parseFloat(style.paddingLeft) || 0)) * sx;
    var top = box.top + (frame.clientTop + (parseFloat(style.paddingTop) || 0)) * sy;
    return { x: (x - left) / (sx || 1), y: (y - top) / (sy || 1), scale: sx || 1 };
  }
  function elementAt(x, y) {
    var list = document.elementsFromPoint ? document.elementsFromPoint(x, y) : [];
    for (var i = 0; i < list.length; i += 1) {
      if (isUi(list[i])) continue;
      return list[i] === document.documentElement || list[i] === document.body ? null : list[i];
    }
    return null;
  }
  /** Lifts a hit from the text inside a button, or a shape inside an icon, to the thing itself. */
  function meaningful(element) {
    return (element.closest && (element.closest(INTERACTIVE) || element.closest("svg"))) || element;
  }
  /** Up from the center of a loop to the largest element that still fits inside it. */
  function climb(element, limit) {
    while (element.parentElement && element.parentElement !== document.body && element.parentElement !== document.documentElement) {
      var box = element.parentElement.getBoundingClientRect();
      if (box.width > limit.w || box.height > limit.h) break;
      element = element.parentElement;
    }
    return element;
  }
  // Elements get numbers for the length of a question, so what a frame
  // answers can still be compared: which hit holds which.
  var numbers = window.WeakMap ? new WeakMap() : null;
  var lastNumber = 0;
  function numberOf(element) {
    if (!numbers) return 0;
    var n = numbers.get(element);
    if (!n) { lastNumber += 1; n = lastNumber; numbers.set(element, n); }
    return n;
  }
  function describe(element) {
    var holders = [];
    for (var up = element.parentElement; up; up = up.parentElement) holders.push(numberOf(up));
    return {
      selector: (cssPath(element) || element.tagName.toLowerCase()).slice(0, 1000),
      tag: element.tagName.toLowerCase().slice(0, 40),
      text: visibleText(element).slice(0, 200),
      frame: "",
      n: numberOf(element),
      holders: holders
    };
  }
  /**
   * The element under each point of this page's viewport, as descriptions;
   * a point in a frame with a bridge is answered by that frame. A query with
   * "loop" climbs to the largest element that fits in that size.
   */
  function resolveQueries(queries) {
    var results = [];
    var groups = [];
    for (var i = 0; i < queries.length; i += 1) {
      var q = queries[i];
      results.push(null);
      var hit = elementAt(q.x, q.y);
      if (!hit) continue;
      var frame = bridgedFrame(hit);
      if (frame) {
        var at = framePoint(frame, q.x, q.y);
        var group = null;
        for (var g = 0; g < groups.length && !group; g += 1) if (groups[g].frame === frame) group = groups[g];
        if (!group) { group = { frame: frame, indexes: [], queries: [] }; groups.push(group); }
        group.indexes.push(i);
        group.queries.push({ x: at.x, y: at.y, loop: q.loop ? { w: q.loop.w / at.scale, h: q.loop.h / at.scale } : null });
        continue;
      }
      results[i] = describe(meaningful(q.loop ? climb(hit, q.loop) : hit));
    }
    return Promise.all(groups.map(function (group) {
      var path = cssPath(group.frame);
      return ask(group.frame.contentWindow, { type: "hits", queries: group.queries }, 800).then(function (reply) {
        var answers = reply && Array.isArray(reply.results) ? reply.results : [];
        for (var k = 0; k < group.indexes.length; k += 1) {
          var answer = answers[k];
          if (answer && typeof answer.selector === "string") {
            answer.frame = path + (answer.frame ? FRAME_JOIN + answer.frame : "");
            results[group.indexes[k]] = answer;
          } else {
            results[group.indexes[k]] = describe(group.frame);
          }
        }
      });
    })).then(function () { return results; });
  }
  function samplesOf(points, count) {
    var n = points.length / 2;
    var out = [];
    var step = Math.max(1, Math.floor(n / count));
    for (var i = 0; i < n; i += step) out.push({ x: points[2 * i] - window.scrollX, y: points[2 * i + 1] - window.scrollY, loop: null });
    return out;
  }
  function markOf(index, role, found) {
    var mark = { stroke: index, role: role, selector: found.selector, tag: found.tag, text: String(found.text || "").slice(0, 200) };
    if (found.frame) mark.frame = String(found.frame).slice(0, 1000);
    return mark;
  }
  function keyOf(found) { return found.frame + FRAME_JOIN + found.n + FRAME_JOIN + found.selector; }
  function holds(outer, inner) {
    return outer.frame === inner.frame && Array.isArray(inner.holders) && inner.holders.indexOf(outer.n) >= 0;
  }
  function marksFor(strokes) {
    var queries = [];
    var plans = [];
    for (var s = 0; s < strokes.length; s += 1) {
      var p = strokes[s].points;
      var n = p.length;
      var first = queries.length;
      if (strokes[s].tool === "arrow") {
        queries.push({ x: p[0] - window.scrollX, y: p[1] - window.scrollY, loop: null });
        queries.push({ x: p[n - 2] - window.scrollX, y: p[n - 1] - window.scrollY, loop: null });
        plans.push({ kind: "arrow", first: first });
        continue;
      }
      var b = drawingBounds([strokes[s]]);
      var w = b.x1 - b.x0;
      var h = b.y1 - b.y0;
      var gap = Math.abs(p[n - 2] - p[0]) + Math.abs(p[n - 1] - p[1]);
      if (n >= 16 && w >= 16 && h >= 16 && gap <= Math.max(24, 0.35 * Math.max(w, h))) {
        queries.push({ x: (b.x0 + b.x1) / 2 - window.scrollX, y: (b.y0 + b.y1) / 2 - window.scrollY, loop: { w: w * 1.2, h: h * 1.2 } });
        plans.push({ kind: "loop", first: first });
        continue;
      }
      var samples = samplesOf(p, 24);
      for (var i = 0; i < samples.length; i += 1) queries.push(samples[i]);
      plans.push({ kind: "line", first: first, count: samples.length });
    }
    return resolveQueries(queries).then(function (found) {
      var marks = [];
      for (var s = 0; s < plans.length; s += 1) {
        var plan = plans[s];
        if (plan.kind === "arrow") {
          if (found[plan.first]) marks.push(markOf(s, "from", found[plan.first]));
          if (found[plan.first + 1]) marks.push(markOf(s, "to", found[plan.first + 1]));
        } else if (plan.kind === "loop") {
          if (found[plan.first]) marks.push(markOf(s, "around", found[plan.first]));
        } else {
          // A line: what most of it lies on, skipping containers of what is picked.
          var counts = [];
          for (var i = plan.first; i < plan.first + plan.count; i += 1) {
            if (!found[i]) continue;
            var key = keyOf(found[i]);
            var known = null;
            for (var j = 0; j < counts.length && !known; j += 1) if (counts[j].key === key) known = counts[j];
            if (known) known.count += 1;
            else counts.push({ key: key, found: found[i], count: 1 });
          }
          counts.sort(function (a, c) { return c.count - a.count; });
          var picked = [];
          for (var k = 0; k < counts.length && picked.length < 3; k += 1) {
            if (counts[k].count < Math.max(1, plan.count * 0.2)) break;
            var holder = false;
            for (var m = 0; m < picked.length; m += 1) if (holds(counts[k].found, picked[m])) holder = true;
            if (!holder) picked.push(counts[k].found);
          }
          for (var q = 0; q < picked.length; q += 1) marks.push(markOf(s, "over", picked[q]));
        }
      }
      return marks;
    });
  }

  // The page as it looks now, for the server's picture: the live DOM with
  // form values, scroll positions, and canvases written in, and the frames'
  // own pages as their bridges report them; scripts and the bridge's marks
  // left out.
  function styleText(sheet) {
    try {
      var rules = sheet.cssRules;
      var text = "";
      for (var i = 0; i < rules.length; i += 1) text += rules[i].cssText + "\n";
      return text;
    } catch (error) {
      return null;
    }
  }
  function serializePage() {
    var doc = document;
    var root = doc.documentElement;
    var clone = root.cloneNode(true);
    var originals = root.getElementsByTagName("*");
    var copies = clone.getElementsByTagName("*");
    var count = Math.min(originals.length, copies.length);
    var pairs = [];
    for (var i = 0; i < count; i += 1) pairs.push([originals[i], copies[i]]);
    var drop = [];
    var frames = [];
    for (var j = 0; j < pairs.length; j += 1) {
      var o = pairs[j][0];
      var c = pairs[j][1];
      var tag = o.tagName;
      if (o.hasAttribute("data-doc-review-ui") || tag === "SCRIPT" || tag === "NOSCRIPT") { drop.push(c); continue; }
      for (var a = c.attributes.length - 1; a >= 0; a -= 1) {
        if (/^on/i.test(c.attributes[a].name)) c.removeAttribute(c.attributes[a].name);
      }
      if (o.scrollTop || o.scrollLeft) c.setAttribute("data-doc-review-scroll", o.scrollLeft + "," + o.scrollTop);
      if (tag === "INPUT") {
        var type = String(o.type).toLowerCase();
        if (type === "checkbox" || type === "radio") { if (o.checked) c.setAttribute("checked", ""); else c.removeAttribute("checked"); }
        else if (type !== "password" && type !== "file") c.setAttribute("value", o.value);
      } else if (tag === "TEXTAREA") {
        c.textContent = o.value;
      } else if (tag === "OPTION") {
        if (o.selected) c.setAttribute("selected", ""); else c.removeAttribute("selected");
      } else if (tag === "STYLE" && o.sheet && !collapse(o.textContent)) {
        // Styles a script added rule by rule leave the tag empty.
        var rules = styleText(o.sheet);
        if (rules) c.textContent = rules;
      } else if (tag === "CANVAS") {
        try {
          var picture = doc.createElement("img");
          picture.src = o.toDataURL();
          picture.setAttribute("style", (o.getAttribute("style") || "") + ";width:" + o.offsetWidth + "px;height:" + o.offsetHeight + "px");
          if (o.getAttribute("class")) picture.setAttribute("class", o.getAttribute("class"));
          if (c.parentNode) c.parentNode.replaceChild(picture, c);
        } catch (error) { /* a canvas with pictures from elsewhere cannot be read */ }
      } else if (bridgedFrame(o)) {
        frames.push({ win: o.contentWindow, copy: c });
      }
    }
    for (var d = 0; d < drop.length; d += 1) if (drop[d].parentNode) drop[d].parentNode.removeChild(drop[d]);
    clone.removeAttribute("data-doc-review-mode");
    // Styles a script built as objects (adoptedStyleSheets) have no tag at all.
    var adopted = doc.adoptedStyleSheets || [];
    for (var s = 0; s < adopted.length; s += 1) {
      var text = styleText(adopted[s]);
      if (!text) continue;
      var style = doc.createElement("style");
      style.textContent = text;
      (clone.querySelector("head") || clone).appendChild(style);
    }
    var doctype = doc.doctype ? "<!DOCTYPE " + doc.doctype.name + ">" : "";
    return Promise.all(frames.map(function (frame) {
      return ask(frame.win, { type: "serialize" }, 1500).then(function (reply) {
        if (!reply || typeof reply.html !== "string") return;
        frame.copy.setAttribute("srcdoc", reply.html);
        frame.copy.removeAttribute("src");
      });
    })).then(function () { return doctype + clone.outerHTML; });
  }
  function finishSketch() {
    if (!sketch.length) return;
    var strokes = sketch.map(function (st) { return { tool: st.tool, points: st.points.slice() }; });
    var b = drawingBounds(strokes);
    var rect = { x: b.x0 - window.scrollX, y: b.y0 - window.scrollY, w: b.x1 - b.x0, h: b.y1 - b.y0 };
    var viewport = { w: window.innerWidth, h: window.innerHeight };
    var scroll = { x: window.scrollX, y: window.scrollY };
    var fail = function () { return null; };
    Promise.all([marksFor(strokes).catch(function () { return []; }), serializePage().catch(fail)]).then(function (done) {
      post({
        type: "drawing",
        anchor: { kind: "html-drawing", strokes: strokes, viewport: viewport, marks: done[0] },
        snapshot: done[1] ? { html: done[1], scroll: scroll } : null,
        rect: rect
      });
    });
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
    // A frame with a bridge of its own picks inside itself.
    if (isFrame(element) && childFor(element.contentWindow, false)) return null;
    return element;
  }
  function showHover(element) {
    var parts = ensureUi();
    if (!parts) return;
    if (!element) { parts.hover.style.display = "none"; return; }
    var rect = element.getBoundingClientRect();
    parts.hover.style.display = "block";
    parts.hover.style.borderWidth = px(2);
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
    if (mode === "draw" && (event.metaKey || event.ctrlKey) && !event.shiftKey && event.code === "KeyZ") {
      event.preventDefault();
      sketch.pop();
      schedulePaint();
    } else if ((event.metaKey || event.ctrlKey) && event.altKey && event.code === "KeyM") {
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
  window.addEventListener("resize", function () {
    schedulePaint();
    // The page may rescale its frames in its own resize handler; ask after it.
    rescaleFrames();
  });

  function fromPanel(data) {
    var scale = data.scale;
    if (typeof scale === "number" && scale > 0 && isFinite(scale) && Math.abs(scale - viewScale) > 0.001) {
      viewScale = scale;
      schedulePaint();
      toFrames("scale");
    }
    if (data.type === "hello") {
      announce();
    } else if (data.type === "mode") {
      var next = data.mode === "element" || data.mode === "draw" || data.mode === "idle" ? data.mode : "text";
      if (next !== "draw" && mode === "draw") clearSketch();
      mode = next;
      if (data.tool === "pen" || data.tool === "arrow") tool = data.tool;
      document.documentElement.setAttribute("data-doc-review-mode", mode);
      applyDrawMode();
      if (mode !== "element") showHover(null);
      if (mode !== "text") { var selection = window.getSelection(); if (selection) selection.removeAllRanges(); }
      toFrames("mode");
    } else if (data.type === "sketch-undo") {
      sketch.pop();
      schedulePaint();
    } else if (data.type === "sketch-clear") {
      clearSketch();
    } else if (data.type === "sketch-done") {
      finishSketch();
    } else if (data.type === "hits" && Array.isArray(data.queries)) {
      var ask = data.ask;
      var queries = data.queries.slice(0, 400).filter(function (q) { return q && typeof q.x === "number" && typeof q.y === "number"; });
      resolveQueries(queries).then(function (results) { post({ type: "hits-result", ask: ask, results: results }); });
    } else if (data.type === "serialize") {
      var serializeAsk = data.ask;
      serializePage().then(function (html) { post({ type: "serialized", ask: serializeAsk, html: html }); }, function () { post({ type: "serialized", ask: serializeAsk, html: null }); });
    } else if (data.type === "comments") {
      items = Array.isArray(data.items) ? data.items.filter(function (item) { return item && typeof item === "object"; }) : [];
      resolveAll();
      toFrames("comments");
    } else if (data.type === "pending") {
      pendingAnchor = data.anchor && typeof data.anchor === "object" ? data.anchor : null;
      if (loaded) { pendingTarget = resolveAnchor(pendingAnchor); schedulePaint(); }
      if (!pendingAnchor) showHover(null);
      toFrames("pending");
    } else if (data.type === "reveal") {
      reveal(data.id, !!data.nested);
    } else if (data.type === "clear-selection") {
      var current = window.getSelection();
      if (current) current.removeAllRanges();
      selectionShown = false;
      toFrames("clear-selection");
    }
  }
  window.addEventListener("message", function (event) {
    var data = event.data;
    if (!data || data.docReview !== 1) return;
    if (event.source === parentWindow) { fromPanel(data); return; }
    var element = event.source ? frameOf(event.source) : null;
    if (element) fromFrame(element, data);
  });

  function onParsed() {
    if (loaded) return;
    loaded = true;
    cachedIndex = null;
    resolveAll();
    if (revealLater) { var later = revealLater; revealLater = null; reveal(later.id, later.nested); }
  }
  document.addEventListener("DOMContentLoaded", onParsed);
  window.addEventListener("load", function () { onParsed(); cachedIndex = null; resolveAll(); });

  if (window.MutationObserver) {
    // Our own pins and outlines change the page too; those do not count.
    var ownRecord = function (record) {
      if (isUi(record.target)) return true;
      if (record.type !== "childList") return false;
      var nodes = [].slice.call(record.addedNodes).concat([].slice.call(record.removedNodes));
      if (!nodes.length) return false;
      for (var i = 0; i < nodes.length; i += 1) if (!isUi(nodes[i])) return false;
      return true;
    };
    var mutationTimer = 0;
    new MutationObserver(function (records) {
      var changed = false;
      for (var i = 0; i < records.length; i += 1) {
        if (ownRecord(records[i])) continue;
        changed = true;
        if (records[i].type === "attributes") bridgeFrame(records[i].target);
        for (var j = 0; j < records[i].addedNodes.length; j += 1) bridgeFramesIn(records[i].addedNodes[j]);
      }
      // Throttled, not debounced: a page that never stops changing still repaints.
      if (!changed || !loaded || mutationTimer) return;
      mutationTimer = setTimeout(function () { mutationTimer = 0; cachedIndex = null; resolveAll(); }, 300);
    }).observe(document.documentElement, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ["srcdoc"] });
  }
  bridgeFramesIn(document.documentElement);

  announce();
})();`;

const ABSOLUTE_URL = /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i;
/** The doctype, after any comments before it: nothing may come ahead of it. */
const DOCTYPE = /^(?:\s|<!--[\s\S]*?-->)*<!doctype[^>]*>/i;

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

/** Where the page's own head can be: markup in its body and frames does not count. */
function headLimit(text: string): number {
  const lower = text.toLowerCase();
  const found = [lower.indexOf("<body"), lower.indexOf("<iframe")].filter((at) => at >= 0);
  return found.length ? Math.min(...found) : text.length;
}

interface Attribute {
  name: string;
  /** The value's bounds in the markup, without its quotes. */
  start: number;
  end: number;
  quote: string;
}

/** The attributes of the start tag whose name ends at `from`, and where the tag ends. */
function readTag(text: string, from: number): { end: number; attributes: Attribute[] } {
  const attributes: Attribute[] = [];
  const space = (at: number) => /[\t\n\f\r ]/.test(text.charAt(at));
  const n = text.length;
  let i = from;
  while (i < n) {
    while (i < n && (space(i) || text[i] === "/")) i += 1;
    if (i >= n) break;
    if (text[i] === ">") return { end: i + 1, attributes };
    const nameStart = i;
    i += 1;
    while (i < n && !space(i) && text[i] !== "/" && text[i] !== ">" && text[i] !== "=") i += 1;
    const name = text.slice(nameStart, i).toLowerCase();
    while (i < n && space(i)) i += 1;
    if (text[i] !== "=") {
      attributes.push({ name, start: i, end: i, quote: "" });
      continue;
    }
    i += 1;
    while (i < n && space(i)) i += 1;
    const quote = text[i] === '"' || text[i] === "'" ? text[i]! : "";
    if (quote) {
      const close = text.indexOf(quote, i + 1);
      if (close < 0) break;
      attributes.push({ name, start: i + 1, end: close, quote });
      i = close + 1;
    } else {
      const start = i;
      while (i < n && !space(i) && text[i] !== ">") i += 1;
      attributes.push({ name, start, end: i, quote: "" });
    }
  }
  return { end: n, attributes };
}

/** Elements whose content is text, not markup. */
const RAW_TEXT = new Set(["script", "style", "textarea", "title", "noscript", "xmp", "noembed", "noframes", "plaintext"]);
// Inside an attribute value markup is escaped, or not.
const LT = "(?:<|&lt;|&#0*60;|&#x0*3c;)";
const GT = "(?:>|&gt;|&#0*62;|&#x0*3e;)";
const SRCDOC_HEAD = new RegExp(`${LT}head(?![\\w-])[\\s\\S]*?${GT}`, "i");
const SRCDOC_DOCTYPE = new RegExp(`^\\s*${LT}!doctype[\\s\\S]*?${GT}`, "i");

function escapeForAttribute(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/**
 * The script added to each page an `<iframe srcdoc>` in the markup embeds,
 * first in its head, escaped the way the attribute needs it.
 */
function bridgeSrcdocFrames(text: string, scriptTag: string): string {
  const lower = text.toLowerCase();
  const tags = /<!--|<([a-z][a-z0-9-]*)/g;
  const inserted = escapeForAttribute(scriptTag);
  let out = "";
  let last = 0;
  let match: RegExpExecArray | null;
  while ((match = tags.exec(lower))) {
    if (match[0] === "<!--") {
      const end = lower.indexOf("-->", match.index + 4);
      if (end < 0) break;
      tags.lastIndex = end + 3;
      continue;
    }
    const name = match[1]!;
    const tag = readTag(text, tags.lastIndex);
    tags.lastIndex = tag.end;
    if (RAW_TEXT.has(name)) {
      const close = name === "plaintext" ? -1 : lower.indexOf(`</${name}`, tag.end);
      if (close < 0) break;
      tags.lastIndex = close;
      continue;
    }
    if (name !== "iframe") continue;
    const srcdoc = tag.attributes.find((attribute) => attribute.name === "srcdoc");
    if (!srcdoc?.quote) continue;
    const value = text.slice(srcdoc.start, srcdoc.end);
    if (value.includes(MARK)) continue;
    const head = SRCDOC_HEAD.exec(value);
    const doctype = SRCDOC_DOCTYPE.exec(value);
    const at = srcdoc.start + (head ? head.index + head[0].length : doctype ? doctype[0].length : 0);
    out += text.slice(last, at) + inserted;
    last = at;
  }
  return out + text.slice(last);
}

/**
 * The page as the frame gets it: relative URLs resolve next to the file (a
 * `<base>` pointing at bb's preview of its folder) and the bridge script runs
 * first in the head, so it answers while a large page is still arriving;
 * pages in srcdoc frames get the bridge too. Works on bytes, so any
 * ASCII-compatible encoding survives untouched; `contentType` names the
 * charset when it is known.
 */
export function injectIntoHtml(
  source: Buffer,
  options: { baseHref: string | null; script: string },
): { body: Buffer; contentType: string } {
  let text = source.toString("latin1");
  const bom = text.startsWith("ï»¿") ? "ï»¿" : "";
  if (bom) text = text.slice(bom.length);

  const scriptTag = `<script ${MARK}>${options.script}</script>`;
  text = bridgeSrcdocFrames(text, scriptTag);

  let baseTag = "";
  if (options.baseHref) {
    const found = /<base\b[^>]*>/i.exec(text);
    const base = found && found.index < headLimit(text) ? found : null;
    const href = base ? /\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(base[0]) : null;
    const existing = href ? (href[1] ?? href[2] ?? href[3] ?? "") : null;
    if (base && existing !== null && ABSOLUTE_URL.test(existing)) {
      // The page names its own absolute base; leave it.
    } else {
      // A relative base is relative to the file's folder: keep it under ours.
      const combined = existing
        ? new URL(existing, new URL(options.baseHref, "http://preview.invalid")).pathname
        : options.baseHref;
      const tag = `<base data-doc-review-base href="${escapeAttribute(combined)}">`;
      if (base) text = text.slice(0, base.index) + tag + text.slice(base.index + base[0].length);
      else baseTag = tag;
    }
  }

  const head = /<head\b[^>]*>/i.exec(text);
  const doctype = DOCTYPE.exec(text);
  const at = head && head.index < headLimit(text) ? head.index + head[0].length : doctype ? doctype[0].length : 0;
  text = text.slice(0, at) + baseTag + scriptTag + text.slice(at);

  const charset = declaredCharset(source) ?? (isUtf8(source) ? "utf-8" : null);
  return {
    body: Buffer.from(bom + text, "latin1"),
    contentType: charset ? `text/html; charset=${charset}` : "text/html",
  };
}
