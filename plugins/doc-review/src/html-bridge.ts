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
    if (!anchor || frameSplit(anchor)) return null;
    if (anchor.kind === "html-text") { var range = findQuote(anchor); return range ? { range: range } : null; }
    if (anchor.kind === "html-element") { var element = findElement(anchor); return element ? { element: element } : null; }
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
      if (target) resolved.push({ id: item.id, seq: item.seq, active: !!item.active, range: target.range || null, element: target.element || null });
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
    if (type === "mode") message.mode = mode;
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
    paintRequest = 0;
    var parts = ensureUi();
    if (!parts) return;
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
      mode = data.mode === "element" ? "element" : "text";
      document.documentElement.setAttribute("data-doc-review-mode", mode);
      if (mode !== "element") showHover(null);
      else { var selection = window.getSelection(); if (selection) selection.removeAllRanges(); }
      toFrames("mode");
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
      const tag = `<base href="${escapeAttribute(combined)}">`;
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
