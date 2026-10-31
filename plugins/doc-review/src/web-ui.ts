// The review controls drawn inside a live page in bb's own browser. A Browser
// tab is a native view over the bb window, so nothing the plugin renders in
// bb can cover the page: the mode bar, the Comment button, the composer, the
// drawing bar, and the comment list live in the page itself, in a shadow root
// of the plugin's isolated world, and talk to two parties:
// - the bridge (src/html-bridge.ts), injected right after this script, which
//   reports selections, picked elements, and drawings, and paints pins;
// - the toolbar action in bb (ui/web-review.tsx), through `bb.postMessage`
//   one way and `__docReviewWeb.fromPlugin` the other.
//
// Plain ES2019 kept as a string, like the bridge. It expects `bb` in scope.

/**
 * The controls' texts in English. The toolbar action passes the panel's
 * language in `activate` and with every state; `{tag}` stands for an
 * element's tag.
 */
export const WEB_UI_TEXT = {
  replyPlaceholder: "Answer the agent",
  statusDraft: "Draft",
  statusSent: "Sent",
  statusReplied: "Answered",
  statusResolved: "Done",
  sentToChat: "Sent to the chat",
  element: "Element <{tag}>",
  drawing: "Drawing",
  text: "Text",
  page: "Page",
  cancel: "Cancel",
  modeText: "Text",
  modeTextTitle: "Select text to comment on it",
  modeElement: "Element",
  modeElementTitle: "Click a block, button, or picture to comment on it",
  modeDraw: "Draw",
  modeDrawTitle: "Draw over the page, then comment on the drawing",
  pen: "Pen",
  line: "Line",
  arrow: "Arrow",
  box: "Box",
  comments: "Comments",
  sending: "Sending…",
  send: "Send",
  sendTitle: "Send every draft on this site to the chat",
  stop: "Stop reviewing this page",
  placeholder: "What should change here?",
  comment: "Comment",
  agent: "Agent",
  you: "You",
  youNotSent: "You, not sent",
  discardReply: "Discard reply",
  delete: "Delete",
  deleteComment: "Delete comment",
  drawingPicture: "Drawing with a picture of the page",
  elementGone: "The element is not on the page now.",
  quoteGone: "The quoted text is not on the page now.",
  reply: "Reply",
  empty: "No comments on this page yet. Select text, or switch to Element or Draw.",
  listTitle: "Comments on this page",
  close: "Close",
  undo: "Undo",
  undoTitle: "Take back the last stroke (⌘Z)",
  clearAll: "Clear all",
  clear: "Clear",
  clearTitle: "Remove the whole drawing",
  /** A pin's name for screen readers; `{n}` is the comment's number. */
  pin: "Comment {n}",
};
export type WebUiText = typeof WEB_UI_TEXT;

export const WEB_UI_SCRIPT = String.raw`(function () {
  "use strict";
  if (window.__docReviewWeb) return;
  var T = ${JSON.stringify(WEB_UI_TEXT)};
  /** Takes the texts the plugin sends, in the panel's language. */
  function useText(text) {
    if (!text || typeof text !== "object") return;
    for (var key in T) if (typeof text[key] === "string") T[key] = text[key];
  }
  function statusText(status) {
    return status === "draft" ? T.statusDraft : status === "sent" ? T.statusSent : status === "replied" ? T.statusReplied : T.statusResolved;
  }
  var ORDER = { replied: 0, draft: 1, sent: 2, resolved: 3 };
  var host = { send: fromBridge, receive: null };
  window.__docReviewHost = host;

  var state = {
    active: false,
    mode: "text",
    tool: "pen",
    comments: [],
    drafts: 0,
    missing: [],
    listOpen: false,
    activeId: null,
    composer: null,
    button: null,
    sketch: null,
    replyingId: null,
    capturing: false,
    sending: false,
    note: ""
  };
  var requests = 0;
  var waiting = {};
  var hideButtonTimer = 0;
  var noteTimer = 0;
  var element = null;
  var shadow = null;
  var theme = {};

  function toPlugin(message) { try { bb.postMessage(message); } catch (error) { /* the tab went away */ } }
  function ask(message, done) {
    requests += 1;
    message.req = requests;
    waiting[requests] = done || null;
    toPlugin(message);
  }
  function toBridge(message) {
    message.docReview = 1;
    if (host.receive) host.receive(message);
  }

  // --- Bridge state ----------------------------------------------------------
  function isHtmlAnchor(anchor) {
    return !!anchor && (anchor.kind === "html-text" || anchor.kind === "html-element" || anchor.kind === "html-drawing");
  }
  function syncBridge() {
    toBridge({ type: "mode", mode: state.active ? (state.mode === "element" ? "element" : state.mode === "draw" ? "draw" : "text") : "idle", tool: state.tool });
    toBridge({
      type: "comments",
      items: state.active ? state.comments.filter(function (comment) {
        return isHtmlAnchor(comment.anchor) && (comment.status !== "resolved" || comment.id === state.activeId);
      }).map(function (comment) {
        return { id: comment.id, seq: comment.seq, label: T.pin.replace("{n}", String(comment.seq)), active: comment.id === state.activeId, anchor: comment.anchor };
      }) : []
    });
    toBridge({ type: "pending", anchor: state.active && state.composer ? state.composer.anchor : null });
  }

  function fromBridge(message) {
    if (!message || !state.active) return;
    switch (message.type) {
      case "ready":
        syncBridge();
        break;
      case "selection":
        clearTimeout(hideButtonTimer);
        if (message.anchor && message.rect && state.mode === "text") {
          state.button = { anchor: message.anchor, rect: message.rect };
          render();
        } else {
          // A click on the button can clear the selection before it lands.
          hideButtonTimer = setTimeout(function () { state.button = null; render(); }, 350);
        }
        break;
      case "contextmenu":
        if (message.anchor) {
          state.button = { anchor: message.anchor, rect: { x: message.x, y: message.y, w: 0, h: 0 } };
          render();
        }
        break;
      case "element":
      case "shortcut":
        if (message.anchor && message.rect) openComposer(message.anchor, message.rect);
        break;
      case "sketch":
        state.sketch = message.count > 0 && message.rect ? { rect: message.rect, count: message.count } : null;
        render();
        break;
      case "drawing":
        if (message.anchor && message.rect) captureThenCompose(message.anchor, message.rect);
        break;
      case "select":
        if (typeof message.id === "string") showComment(message.id);
        break;
      case "resolved":
        state.missing = Array.isArray(message.missing) ? message.missing : [];
        render();
        break;
      case "escape":
        if (state.composer) closeComposer();
        else if (state.listOpen) { state.listOpen = false; render(); }
        state.button = null;
        render();
        break;
    }
  }

  // --- Requests to the plugin ---------------------------------------------
  function openComposer(anchor, rect) {
    clearTimeout(hideButtonTimer);
    state.button = null;
    state.composer = { anchor: anchor, rect: rect, busy: false, error: "" };
    toBridge({ type: "clear-selection" });
    syncBridge();
    render();
    var field = shadow && shadow.querySelector(".composer textarea");
    if (field) field.focus({ preventScroll: true });
  }
  function closeComposer() {
    var wasDrawing = state.composer && state.composer.anchor.kind === "html-drawing";
    state.composer = null;
    if (wasDrawing) toPlugin({ type: "drop-capture" });
    syncBridge();
    render();
  }
  function captureThenCompose(anchor, rect) {
    // The picture is the tab as it looks: the strokes on the page, without
    // these controls over it.
    state.sketch = null;
    state.capturing = true;
    render();
    requestAnimationFrame(function () {
      requestAnimationFrame(function () {
        ask({ type: "capture" }, function () {
          state.capturing = false;
          openComposer(anchor, rect);
        });
      });
    });
  }
  function submitComposer(body) {
    var composer = state.composer;
    if (!composer || composer.busy) return;
    composer.busy = true;
    composer.error = "";
    render();
    ask({ type: "create", anchor: composer.anchor, body: body }, function (reply) {
      if (state.composer !== composer) return;
      if (reply.error) {
        composer.busy = false;
        composer.error = reply.error;
        render();
        return;
      }
      if (composer.anchor.kind === "html-drawing") toBridge({ type: "sketch-clear" });
      state.composer = null;
      state.activeId = reply.id || null;
      syncBridge();
      render();
    });
  }
  function send() {
    if (state.sending || !state.drafts) return;
    state.sending = true;
    render();
    ask({ type: "send" }, function (reply) {
      state.sending = false;
      flash(reply.error ? reply.error : T.sentToChat);
    });
  }
  function flash(text) {
    state.note = text;
    clearTimeout(noteTimer);
    noteTimer = setTimeout(function () { state.note = ""; render(); }, 3500);
    render();
  }
  function showComment(id) {
    state.activeId = id;
    state.listOpen = true;
    syncBridge();
    render();
    var card = shadow && shadow.querySelector('[data-id="' + id + '"]');
    if (card) card.scrollIntoView({ block: "nearest" });
  }

  // --- Drawing the controls ---------------------------------------------------
  function h(tag, attributes, children) {
    var node = document.createElement(tag);
    if (attributes) for (var key in attributes) {
      if (!Object.prototype.hasOwnProperty.call(attributes, key) || attributes[key] === null || attributes[key] === undefined) continue;
      if (key === "text") node.textContent = attributes[key];
      else if (key.slice(0, 2) === "on") node.addEventListener(key.slice(2), attributes[key]);
      else node.setAttribute(key, attributes[key]);
    }
    (children || []).forEach(function (child) { if (child) node.appendChild(child); });
    return node;
  }
  function button(label, onClick, extra) {
    var attributes = { type: "button", class: "btn" + (extra && extra.cls ? " " + extra.cls : ""), text: label, onclick: function (event) { event.stopPropagation(); onClick(); } };
    if (extra && extra.title) attributes.title = extra.title;
    if (extra && extra.disabled) attributes.disabled = "";
    if (extra && extra.pressed !== undefined) attributes["aria-pressed"] = extra.pressed ? "true" : "false";
    return h("button", attributes);
  }
  function clamp(value, low, high) { return Math.max(low, Math.min(value, high)); }
  function shorten(text, max) {
    var flat = String(text || "").replace(/\s+/g, " ").trim();
    return flat.length <= max ? flat : flat.slice(0, max - 1) + "…";
  }
  function anchorLabel(anchor) {
    if (anchor.kind === "html-element") return T.element.replace("{tag}", anchor.tag);
    if (anchor.kind === "html-drawing") return T.drawing;
    if (anchor.kind === "html-text") return T.text;
    return T.page;
  }
  function anchorQuote(anchor) {
    if (anchor.kind === "html-text") return anchor.quote;
    if (anchor.kind === "html-element") return anchor.text;
    return "";
  }

  /** A text field with Cancel and a submit button; Cmd/Ctrl+Enter submits, Escape cancels. */
  function editor(options) {
    var field = h("textarea", { rows: "3", placeholder: options.placeholder, "aria-label": options.placeholder });
    field.value = options.initial || "";
    var submit = button(options.submitLabel, function () { var body = field.value.trim(); if (body) options.onSubmit(body); }, { cls: "primary", disabled: options.busy });
    field.addEventListener("keydown", function (event) {
      event.stopPropagation();
      if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        var body = field.value.trim();
        if (body && !options.busy) options.onSubmit(body);
      } else if (event.key === "Escape") {
        event.preventDefault();
        options.onCancel();
      }
    });
    var children = [field];
    if (options.error) children.push(h("div", { class: "error", text: options.error }));
    children.push(h("div", { class: "row end" }, [h("span", { class: "hint", text: "⌘↵" }), button(T.cancel, options.onCancel), submit]));
    return h("div", { class: "editor" }, children);
  }

  function modeBar() {
    var modes = [
      ["text", T.modeText, T.modeTextTitle],
      ["element", T.modeElement, T.modeElementTitle],
      ["draw", T.modeDraw, T.modeDrawTitle]
    ];
    var items = modes.map(function (entry) {
      return button(entry[1], function () {
        state.mode = entry[0];
        state.button = null;
        if (entry[0] !== "draw") state.sketch = null;
        syncBridge();
        render();
      }, { pressed: state.mode === entry[0], title: entry[2] });
    });
    if (state.mode === "draw") {
      items.push(h("span", { class: "sep" }));
      [["pen", T.pen], ["line", T.line], ["arrow", T.arrow], ["rect", T.box]].forEach(function (entry) {
        items.push(button(entry[1], function () { state.tool = entry[0]; syncBridge(); render(); }, { pressed: state.tool === entry[0] }));
      });
    }
    var open = state.comments.filter(function (comment) { return comment.status !== "resolved"; }).length;
    items.push(h("span", { class: "sep" }));
    items.push(button(T.comments + (open ? " " + open : ""), function () { state.listOpen = !state.listOpen; render(); }, { pressed: state.listOpen }));
    items.push(button(state.sending ? T.sending : T.send + (state.drafts ? " " + state.drafts : ""), send, { cls: "primary", disabled: !state.drafts || state.sending, title: T.sendTitle }));
    items.push(button("×", function () { toPlugin({ type: "close" }); }, { cls: "icon", title: T.stop }));
    return h("div", { class: "bar panel", role: "toolbar", "aria-label": "Doc Review" }, items);
  }

  function composerPanel() {
    var composer = state.composer;
    var width = Math.min(340, window.innerWidth - 16);
    var top = clamp(composer.rect.y + composer.rect.h + 8, 8, window.innerHeight - 210);
    var left = clamp(composer.rect.x, 8, window.innerWidth - width - 8);
    var quote = anchorQuote(composer.anchor);
    var children = [h("div", { class: "label", text: anchorLabel(composer.anchor) })];
    if (quote) children.push(h("div", { class: "quote", text: shorten(quote, 200) }));
    children.push(editor({
      placeholder: T.placeholder,
      submitLabel: T.comment,
      busy: composer.busy,
      error: composer.error,
      onSubmit: submitComposer,
      onCancel: closeComposer
    }));
    return h("div", { class: "composer panel", style: "top:" + top + "px;left:" + left + "px;width:" + width + "px" }, children);
  }

  function bubble(reply, comment) {
    var draft = reply.author === "user" && reply.sentAt === null;
    var who = reply.author === "agent" ? T.agent : draft ? T.youNotSent : T.you;
    var children = [h("p", null, [h("b", { text: who + ": " }), document.createTextNode(reply.body)])];
    if (draft) children.push(button("×", function () { ask({ type: "discard-reply", id: comment.id }); }, { cls: "icon", title: T.discardReply }));
    return h("div", { class: "bubble " + (reply.author === "agent" ? "agent" : draft ? "user draft" : "user") }, children);
  }

  function card(comment) {
    var quote = anchorQuote(comment.anchor);
    var head = h("div", { class: "row" }, [
      h("span", { class: "seq" + (comment.status === "resolved" ? " done" : ""), text: String(comment.seq) }),
      h("span", { class: "meta", text: anchorLabel(comment.anchor) + ", " + statusText(comment.status) }),
      button(T.delete, function () { ask({ type: "delete", id: comment.id }); }, { cls: "link", title: T.deleteComment })
    ]);
    var children = [head];
    if (comment.imageUrl) children.push(h("div", { class: "quote", text: T.drawingPicture }));
    else if (quote) children.push(h("div", { class: "quote", text: shorten(quote, 160) }));
    children.push(h("p", { class: "body", text: comment.body }));
    (comment.thread || []).forEach(function (reply) { children.push(bubble(reply, comment)); });
    if (state.missing.indexOf(comment.id) >= 0 && comment.status !== "resolved") {
      children.push(h("div", { class: "hint", text: comment.anchor.kind === "html-element" ? T.elementGone : T.quoteGone }));
    }
    if (comment.status === "replied" || comment.status === "resolved") {
      if (state.replyingId === comment.id) {
        children.push(editor({
          placeholder: T.replyPlaceholder,
          submitLabel: T.reply,
          onSubmit: function (body) {
            ask({ type: "reply", id: comment.id, body: body }, function (reply) {
              if (reply.error) { flash(reply.error); return; }
              state.replyingId = null;
              render();
            });
          },
          onCancel: function () { state.replyingId = null; render(); }
        }));
      } else {
        children.push(button(T.reply, function () { state.replyingId = comment.id; render(); }, { cls: "link" }));
      }
    }
    return h("div", {
      class: "card" + (comment.id === state.activeId ? " active" : "") + (comment.status === "resolved" ? " resolved" : ""),
      "data-id": comment.id,
      onclick: function (event) {
        if (event.target && event.target.tagName === "TEXTAREA") return;
        state.activeId = comment.id;
        syncBridge();
        toBridge({ type: "reveal", id: comment.id });
        render();
      }
    }, children);
  }

  function listPanel() {
    var comments = state.comments.slice().sort(function (a, b) { return (ORDER[a.status] - ORDER[b.status]) || (a.seq - b.seq); });
    var cards = comments.length ? comments.map(card) : [h("p", { class: "hint", text: T.empty })];
    return h("div", { class: "list panel" }, [
      h("div", { class: "row" }, [h("b", { class: "grow", text: T.listTitle }), button("×", function () { state.listOpen = false; render(); }, { cls: "icon", title: T.close })]),
      h("div", { class: "cards" }, cards)
    ]);
  }

  function render() {
    if (!shadow) return;
    var focused = shadow.activeElement;
    var keep = focused && focused.tagName === "TEXTAREA" ? { value: focused.value, start: focused.selectionStart, end: focused.selectionEnd, key: focused.closest("[data-id]") ? focused.closest("[data-id]").getAttribute("data-id") : "composer" } : null;
    var view = shadow.querySelector(".view");
    var next = h("div", { class: "view" + (state.capturing ? " hidden" : "") });
    if (state.active) {
      next.appendChild(modeBar());
      if (state.button && !state.composer && state.mode === "text") {
        var b = state.button.rect;
        var anchor = state.button.anchor;
        next.appendChild(h("button", {
          type: "button",
          class: "btn primary float",
          style: "top:" + clamp(b.y + b.h + 6, 8, window.innerHeight - 40) + "px;left:" + clamp(b.x + b.w - 40, 8, window.innerWidth - 110) + "px",
          text: T.comment,
          onmousedown: function (event) { event.preventDefault(); },
          onclick: function (event) { event.stopPropagation(); openComposer(anchor, b); }
        }));
      }
      if (state.sketch && !state.composer && state.mode === "draw") {
        var s = state.sketch.rect;
        var drawBar = [button(T.comment, function () { toBridge({ type: "sketch-done" }); }, { cls: "primary" })];
        // With one stroke Undo and Clear would do the same.
        if (state.sketch.count > 1) drawBar.push(button(T.undo, function () { toBridge({ type: "sketch-undo" }); }, { title: T.undoTitle }));
        drawBar.push(button(state.sketch.count > 1 ? T.clearAll : T.clear, function () { toBridge({ type: "sketch-clear" }); state.sketch = null; render(); }, { title: T.clearTitle }));
        next.appendChild(h("div", {
          class: "drawbar panel row",
          style: "top:" + clamp(s.y + s.h + 6, 8, window.innerHeight - 48) + "px;left:" + clamp(s.x, 8, window.innerWidth - 250) + "px"
        }, drawBar));
      }
      if (state.composer) next.appendChild(composerPanel());
      if (state.listOpen) next.appendChild(listPanel());
      if (state.note) next.appendChild(h("div", { class: "note panel", text: state.note }));
    }
    if (view) shadow.replaceChild(next, view); else shadow.appendChild(next);
    // Keep what was being typed when the controls redraw under it.
    if (keep) {
      var target = keep.key === "composer" ? shadow.querySelector(".composer textarea") : shadow.querySelector('[data-id="' + keep.key + '"] textarea');
      if (target) {
        target.value = keep.value;
        target.focus({ preventScroll: true });
        try { target.setSelectionRange(keep.start, keep.end); } catch (error) { /* not a text field now */ }
      }
    }
    // The bridge adds its own layer later; stay above it.
    if (element && element.parentNode && element.nextSibling) element.parentNode.appendChild(element);
  }

  function css() {
    var t = theme;
    return [
      ":host{all:initial}",
      ".view{position:fixed;inset:0;pointer-events:none;font:13px/1.4 " + (t.font || "system-ui,-apple-system,sans-serif") + ";color:" + (t.fg || "#111") + "}",
      ".view.hidden{display:none}",
      ".panel{pointer-events:auto;position:fixed;box-sizing:border-box;background:" + (t.popover || "#fff") + ";color:" + (t.popoverFg || t.fg || "#111") + ";border:1px solid " + (t.border || "#ddd") + ";border-radius:10px;box-shadow:0 8px 28px rgba(0,0,0,.18)}",
      ".row{display:flex;align-items:center;gap:6px}",
      ".row.end{justify-content:flex-end;margin-top:6px}",
      ".grow{flex:1}",
      ".bar{left:50%;bottom:16px;transform:translateX(-50%);display:flex;align-items:center;gap:4px;padding:5px;max-width:calc(100vw - 16px);overflow-x:auto}",
      ".sep{width:1px;align-self:stretch;margin:2px 2px;background:" + (t.border || "#ddd") + "}",
      ".btn{all:unset;box-sizing:border-box;cursor:pointer;padding:5px 9px;border-radius:7px;font:inherit;font-weight:500;white-space:nowrap;color:inherit}",
      ".btn:hover{background:" + (t.accent || "rgba(0,0,0,.06)") + "}",
      ".btn[aria-pressed=true]{background:" + (t.muted || "rgba(0,0,0,.08)") + "}",
      ".btn.primary{background:" + (t.primary || "#4f6bed") + ";color:" + (t.primaryFg || "#fff") + "}",
      ".btn.primary:hover{filter:brightness(1.08)}",
      ".btn[disabled]{opacity:.5;cursor:default}",
      ".btn.icon{padding:3px 8px;font-size:15px;line-height:1}",
      ".btn.link{padding:2px 4px;font-size:12px;color:" + (t.mutedFg || "#666") + "}",
      ".btn.float{position:fixed;pointer-events:auto;box-shadow:0 4px 14px rgba(0,0,0,.2)}",
      ".composer{padding:10px}",
      ".label{font-size:12px;color:" + (t.mutedFg || "#666") + ";margin-bottom:4px}",
      ".quote{font-size:12px;color:" + (t.mutedFg || "#666") + ";border-left:2px solid " + (t.border || "#ddd") + ";padding-left:8px;margin:4px 0}",
      "textarea{box-sizing:border-box;width:100%;min-height:64px;max-height:220px;resize:vertical;font:inherit;color:inherit;background:" + (t.bg || "#fff") + ";border:1px solid " + (t.border || "#ccc") + ";border-radius:7px;padding:6px 8px;outline:none}",
      "textarea:focus{border-color:" + (t.primary || "#4f6bed") + "}",
      ".hint{font-size:11px;color:" + (t.mutedFg || "#777") + ";margin-right:auto}",
      ".error{font-size:12px;color:" + (t.destructive || "#c00") + ";margin-top:4px}",
      ".drawbar{padding:4px}",
      ".list{top:12px;right:12px;bottom:72px;width:min(360px,calc(100vw - 24px));display:flex;flex-direction:column;padding:10px;gap:8px}",
      ".cards{overflow-y:auto;display:flex;flex-direction:column;gap:8px;min-height:0}",
      ".card{border:1px solid " + (t.border || "#ddd") + ";border-radius:8px;padding:8px;cursor:pointer}",
      ".card.active{border-color:" + (t.primary || "#4f6bed") + "}",
      ".card.resolved{opacity:.7}",
      ".seq{display:inline-flex;align-items:center;justify-content:center;min-width:20px;height:20px;border-radius:10px;font-size:11px;font-weight:600;background:" + (t.primary || "#4f6bed") + ";color:" + (t.primaryFg || "#fff") + "}",
      ".seq.done{background:" + (t.muted || "#eee") + ";color:" + (t.mutedFg || "#666") + "}",
      ".meta{flex:1;font-size:12px;color:" + (t.mutedFg || "#666") + ";overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
      ".body{margin:6px 0 0;white-space:pre-wrap;overflow-wrap:anywhere}",
      ".bubble{display:flex;gap:4px;align-items:flex-start;margin-top:6px;padding:6px 8px;border-radius:7px;font-size:12px}",
      ".bubble p{margin:0;flex:1;white-space:pre-wrap;overflow-wrap:anywhere}",
      ".bubble.agent{background:" + (t.muted || "#f2f2f2") + "}",
      ".bubble.user{margin-left:14px;border:1px solid " + (t.border || "#ddd") + "}",
      ".bubble.draft{border-style:dashed;border-color:" + (t.primary || "#4f6bed") + "}",
      ".editor{margin-top:6px}",
      ".note{left:50%;bottom:64px;transform:translateX(-50%);padding:6px 12px;font-size:12px}"
    ].join("\n");
  }

  function mount() {
    if (element && element.isConnected) return;
    element = document.createElement("doc-review-web");
    element.setAttribute("data-doc-review-ui", "");
    element.style.cssText = "all:initial;position:fixed;inset:0;z-index:2147483647;pointer-events:none;";
    shadow = element.attachShadow({ mode: "open" });
    shadow.appendChild(h("style", { text: css() }));
    // Keys typed into the controls are not the page's business.
    ["keydown", "keyup", "keypress"].forEach(function (type) {
      element.addEventListener(type, function (event) { event.stopPropagation(); });
    });
    document.documentElement.appendChild(element);
  }

  window.addEventListener("resize", function () { if (state.active) render(); });

  window.__docReviewWeb = {
    activate: function (config) {
      theme = (config && config.theme) || {};
      useText(config && config.text);
      state.active = true;
      mount();
      syncBridge();
      render();
      return { active: true };
    },
    deactivate: function () {
      state.active = false;
      state.composer = null;
      state.button = null;
      state.sketch = null;
      state.listOpen = false;
      toBridge({ type: "sketch-clear" });
      syncBridge();
      if (element && element.parentNode) element.parentNode.removeChild(element);
      element = null;
      shadow = null;
      return { active: false };
    },
    state: function () { return { active: state.active }; },
    fromPlugin: function (message) {
      if (!message || typeof message !== "object") return null;
      if (message.type === "state") {
        useText(message.text);
        state.comments = Array.isArray(message.comments) ? message.comments : [];
        state.drafts = typeof message.drafts === "number" ? message.drafts : 0;
        if (state.activeId && !state.comments.some(function (comment) { return comment.id === state.activeId; })) state.activeId = null;
        syncBridge();
        render();
      } else if (message.type === "done") {
        var done = waiting[message.req];
        delete waiting[message.req];
        if (done) done(message);
        else if (message.error) flash(message.error);
      }
      return null;
    }
  };
})();`;
