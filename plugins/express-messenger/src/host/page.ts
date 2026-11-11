// Expressions evaluated inside the eXpress web client page (over the DevTools protocol).
// The client keeps its state in a Redux store where messages are already decrypted, so the
// plugin reads data there instead of scraping the screen:
//   chats[]           chatType chat | group_chat | channel | botx | notes | thread | voex_call,
//                     members [{ userHuid }], lastEventInsertedAt, unreadCounter, fastSearchString
//   profiles{huid}    ctsProfile { name, companyPosition, department, email }, fastSortSearch
//   unreadChats{id}   unread count per chat
//   messages[]        the open chat: payload.body, sender, insertedAt, stealth
// Every expression returns plain JSON. Message text never leaves the person's machine except
// as a tool answer to an allowed agent.

/** Finds the react-redux store through React's fiber tree and keeps it on `window.__bbStore`. */
export const FIND_STORE = `(() => {
  if (window.__bbStore) return { ok: true };
  const fiberKey = (el) => Object.keys(el).find((k) => k.startsWith('__reactContainer$') || k.startsWith('__reactFiber$') || k.startsWith('__reactInternalInstance$'));
  let start = null;
  for (const el of [document.getElementById('root'), ...document.querySelectorAll('body *')].slice(0, 3000)) {
    if (!el) continue;
    const k = fiberKey(el);
    if (k) { start = el[k]; break; }
  }
  if (!start) return { ok: false, why: 'no React on the page' };
  let f = start;
  if (f && f.current) f = f.current;
  while (f.return) f = f.return;
  const stack = [f];
  let visited = 0;
  while (stack.length && visited < 200000) {
    const n = stack.pop();
    visited++;
    const p = n.memoizedProps;
    const cand = p && (p.store || (p.value && p.value.store));
    if (cand && typeof cand.getState === 'function' && typeof cand.dispatch === 'function') {
      window.__bbStore = cand;
      return { ok: true };
    }
    if (n.sibling) stack.push(n.sibling);
    if (n.child) stack.push(n.child);
  }
  return { ok: false, why: 'no store found' };
})()`;

/**
 * The sign-in screen as the page shows it. A company sign-in often has no marks of the client at
 * all, so a password field counts too; a page of another origin counts in READY.
 */
const SIGN_IN_SCREEN = `!!document.querySelector('.body--auth, .login, input[type="password"]')`;

/**
 * Where the page stands: `auth` the sign-in screen or a page of another origin (a company sign-in
 * page), `unreachable` the browser's own error page, `store` and `chats` a client that has loaded.
 */
export const READY = (origin: string) => `(() => {
  const href = location.href;
  const unreachable = href.startsWith('chrome-error:');
  const blank = href === 'about:blank';
  const foreign = !blank && !unreachable && location.origin !== ${JSON.stringify(origin)};
  const auth = foreign || ${SIGN_IN_SCREEN};
  if (foreign || unreachable || blank) return { auth, unreachable, store: false, chats: 0 };
  const found = ${FIND_STORE};
  const chats = found.ok ? (window.__bbStore.getState().chats || []).length : 0;
  return { auth, unreachable, store: found.ok, chats };
})()`;

/**
 * Whether the messenger answers right now. A client that has loaded keeps showing its last state
 * when the network goes away, so its counters alone cannot tell. Any answer counts, also a redirect
 * to a sign-in page or an error status.
 */
export const REACHABLE = `(async () => {
  try {
    await fetch(location.origin + '/', { method: 'HEAD', cache: 'no-store', redirect: 'manual', credentials: 'omit', signal: AbortSignal.timeout(8000) });
    return true;
  } catch {
    return false;
  }
})()`;

/**
 * Loads profiles of people in personal chats. The client loads them lazily, when a chat is shown
 * (before this, a name was known for about a quarter of personal chats). The client's own action
 * FETCH_PROFILE_BY_USER_HUID with { userHuid } fetches one; if it does not work, scrolling the chat
 * list makes the client load them itself. Read-only: the client asks the server the same way.
 */
export const LOAD_PROFILES = `(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const store = window.__bbStore;
  const profilesNow = () => store.getState().profiles || {};
  const count = () => Object.keys(profilesNow()).length;
  const me = Object.values(profilesNow()).find((p) => p && p.isMe);
  const meHuid = me ? me.userHuid : null;
  const missing = () => {
    const have = profilesNow();
    const out = new Set();
    for (const c of store.getState().chats || []) {
      if (!c || c.chatType !== 'chat' || !Array.isArray(c.members)) continue;
      for (const m of c.members) { const h = typeof m === 'string' ? m : m && m.userHuid; if (h && h !== meHuid && !have[h]) out.add(h); }
    }
    return [...out];
  };
  const need0 = missing();
  const start = count();
  if (!need0.length) return { missing: 0, loaded: 0, left: 0, method: 'none needed' };
  for (let i = 0; i < need0.length; i++) {
    store.dispatch({ type: 'FETCH_PROFILE_BY_USER_HUID', payload: { userHuid: need0[i] } });
    if (i % 20 === 19) await sleep(1000);
  }
  for (let i = 0; i < 10 && missing().length > need0.length * 0.05; i++) await sleep(1000);
  let method = 'fetch by id';
  if (missing().length > need0.length * 0.1) {
    method = 'scrolling the chat list';
    const first = document.querySelector('.chat-list-entry');
    let el = first && first.parentElement;
    while (el && !(el.scrollHeight > el.clientHeight + 10 && /auto|scroll/.test(getComputedStyle(el).overflowY))) el = el.parentElement;
    if (el) {
      let still = 0, steps = 0;
      while (still < 4 && steps < 300) {
        const top = el.scrollTop;
        el.scrollTop += el.clientHeight * 0.9;
        steps++;
        await sleep(600);
        still = el.scrollTop === top ? still + 1 : 0;
      }
      await sleep(3000);
      el.scrollTop = 0;
    }
  }
  return { missing: need0.length, loaded: count() - start, left: missing().length, method };
})()`;

/** The directory: every chat with its type, unread count and, for personal chats, the person. */
export const DIRECTORY = `(() => {
  const st = window.__bbStore.getState();
  const profiles = st.profiles || {};
  const me = Object.values(profiles).find((p) => p && p.isMe);
  const meHuid = me ? me.userHuid : null;
  const str = (x) => (typeof x === 'string' && x.trim() && x.length < 160 ? x.trim() : null);
  const uniq = (a) => [...new Set(a.map(str).filter(Boolean))];
  const pick = (o, keys) => { for (const k of keys) if (o && o[k] != null && o[k] !== '') return o[k]; return null; };
  const ts = (v) => v == null ? null : typeof v === 'number' ? v : typeof v === 'string' ? (Date.parse(v) || null)
    : typeof v.valueOf === 'function' ? (Number(v.valueOf()) || null) : null;
  const personOf = (huid) => {
    const p = profiles[huid];
    if (!p) return null;
    const c = p.ctsProfile || p.phonebookProfile || {};
    const f = p.fastSortSearch || {};
    const email = str(c.email);
    return {
      name: str(c.name) || str(c.ctsName),
      position: str(c.companyPosition),
      department: str(c.department),
      email,
      bot: !!c.isBot,
      aliases: uniq([...(f.nameTransliterations || []), ...(f.nameKeyboardVariants || []),
        ...(Array.isArray(p.searchStrings) ? p.searchStrings : []), email ? email.split('@')[0] : null, c.adLogin]),
    };
  };
  const huidOf = (m) => (typeof m === 'string' ? m : m && (m.userHuid || m.huid)) || null;
  const unread = st.unreadChats || {};
  const visible = new Set(((st.indexes || {}).visibleChats) || []);
  const chats = [];
  for (const c of st.chats || []) {
    if (!c) continue;
    const id = pick(c, ['groupChatId', 'id', 'chatId']);
    const type = pick(c, ['chatType', 'type']);
    const members = Array.isArray(c.members) ? c.members.map(huidOf).filter(Boolean) : [];
    const others = members.filter((h) => h !== meHuid);
    const personal = /^(chat|personal|direct)/i.test(String(type || '')) || (!type && members.length <= 2);
    const person = personal && others.length === 1 ? personOf(others[0]) : null;
    const f = c.fastSortSearch || {};
    const searchName = str(c.fastSearchString);
    let name = str(pick(c, ['name', 'chatName', 'title']));
    if (!name && person) name = person.name;
    if (!name && searchName) name = searchName.replace(/(^|\\s)\\S/g, (x) => x.toUpperCase());
    chats.push({
      id, type, name,
      aliases: uniq([...(f.nameTransliterations || []), ...(f.nameKeyboardVariants || []), searchName]),
      left: !!c.left,
      unread: Number(unread[id] ?? pick(c, ['unreadCounter', 'unreadCount']) ?? 0) || 0,
      members: members.length,
      visible: visible.size ? visible.has(id) : true,
      lastAt: ts(pick(c, ['lastEventInsertedAt', 'updatedAt', 'insertedAt'])),
      stealth: !!(c.stealth || c.stealthEnabled),
      person,
    });
  }
  return { chats, meFound: !!meHuid, auth: ${SIGN_IN_SCREEN} };
})()`;

/**
 * The last messages of a chat. The chat is opened by its route #/chats/<id>. With `hide`, the
 * message list is hidden by a style while it loads, so the client does not count the messages as
 * seen and the chat stays unread. Disappearing (stealth) messages are never returned.
 */
export const READ_CHAT = (id: string, last: number, hide: boolean) => `(async () => {
  const id = ${JSON.stringify(id)};
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const store = window.__bbStore;
  const unreadOf = () => ((store.getState().unreadChats || {})[id] || 0);
  const unreadBefore = unreadOf();
  const prevHash = location.hash;
  let style = null;
  if (${hide ? "true" : "false"}) {
    style = document.createElement('style');
    style.textContent = '[class*="chat-message"], [class*="messages-list"], [class*="message-list"] { display: none !important; }';
    document.head.appendChild(style);
  }
  location.hash = '#/chats/' + id;
  const ts = (v) => v == null ? null : typeof v === 'number' ? v : typeof v === 'string' ? (Date.parse(v) || null)
    : typeof v.valueOf === 'function' ? (Number(v.valueOf()) || null) : null;
  let msgs = [], stable = 0, prev = -1;
  for (let i = 0; i < 40; i++) {
    await sleep(500);
    if (${SIGN_IN_SCREEN}) {
      if (style) style.remove();
      return { auth: true, loaded: 0, messages: [], unreadBefore, unreadAfter: unreadBefore, stealthSkipped: 0 };
    }
    msgs = (store.getState().messages || []).filter((m) => m && m.groupChatId === id);
    if (msgs.length && msgs.length === prev) { if (++stable >= 3) break; } else stable = 0;
    prev = msgs.length;
  }
  const st = store.getState();
  const profiles = st.profiles || {};
  const me = Object.values(profiles).find((p) => p && p.isMe);
  const nameOf = (h) => { const p = profiles[h]; return (p && p.ctsProfile && (p.ctsProfile.name || p.ctsProfile.ctsName)) || null; };
  const textOf = (m) => {
    const p = m.payload || {};
    if (typeof p.body === 'string' && p.body.trim()) return p.body.trim();
    if (p.sticker) return '[sticker]';
    if (p.type && p.type !== 'text') return '[' + p.type + ']';
    return null;
  };
  let stealthSkipped = 0;
  const out = [];
  for (const m of msgs) {
    if (m.stealth) { stealthSkipped++; continue; }
    if (m.deletedAt) continue;
    const text = textOf(m);
    if (!text) continue;
    out.push({ at: ts(m.insertedAt) || ts((m.payload || {}).timestamp), from: nameOf(m.sender), mine: !!(me && m.sender === me.userHuid),
      text: text.slice(0, 4000), forwarded: !!((m.payload || {}).forward), reply: !!((m.payload || {}).reply) });
  }
  out.sort((a, b) => (a.at || 0) - (b.at || 0));
  location.hash = prevHash && !prevHash.startsWith('#/chats/' + id) ? prevHash : '#/chats';
  await sleep(1500);
  if (style) style.remove();
  return { auth: false, loaded: msgs.length, messages: out.slice(-${Math.max(1, Math.min(100, Math.floor(last)))}), unreadBefore, unreadAfter: unreadOf(), stealthSkipped };
})()`;

/**
 * Opens a chat for sending; the list stays visible (sending means the chat is read anyway). Answers
 * once the chat's history has stopped growing, so a message found in it later is a new one, and the
 * header is read last, when it no longer shows the chat before this one.
 */
export const OPEN_CHAT = (id: string) => `(async () => {
  const id = ${JSON.stringify(id)};
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  location.hash = '#/chats/' + id;
  const composerNow = () => document.querySelector(${JSON.stringify(COMPOSER_SELECTOR())});
  const headerNow = () => { const el = document.querySelector('.chat-header-title-container__text'); return el ? el.innerText.trim() : null; };
  for (let i = 0; i < 30 && !(headerNow() && composerNow()); i++) await sleep(500);
  const count = () => (window.__bbStore.getState().messages || []).filter((m) => m && m.groupChatId === id).length;
  let stable = 0, prev = -1;
  for (let i = 0; i < 12 && stable < 3; i++) {
    await sleep(500);
    const n = count();
    stable = n > 0 && n === prev ? stable + 1 : 0;
    prev = n;
  }
  return { header: headerNow(), composer: !!composerNow() };
})()`;

export function COMPOSER_SELECTOR(): string {
  return '.message-input__message-field [contenteditable="true"], .message-input__message-field[contenteditable="true"]';
}

/**
 * Text as the page compares it: line ends, zero-width marks and no-break spaces do not count, nor
 * do empty lines, which the field and the client insert on their own. Code points, not literals: a
 * zero-width character in this source would be invisible to whoever edits it next.
 */
const NORMALIZE = `(() => {
  const zeroWidth = new RegExp('[' + String.fromCharCode(0x200b, 0xfeff) + ']', 'g');
  const noBreak = new RegExp(String.fromCharCode(0xa0), 'g');
  return (s) => String(s).replace(/\\r\\n?/g, '\\n').replace(zeroWidth, '').replace(noBreak, ' ').split('\\n').map((l) => l.trimEnd()).filter(Boolean).join('\\n').trim();
})()`;

/**
 * The field's own text, line by line: a placeholder is drawn inside the field in some editors
 * (Slate marks it contenteditable=false) and is not text the person typed.
 */
const FIELD_TEXT = `((root) => {
  const lines = [];
  let line = '';
  const flush = () => { lines.push(line); line = ''; };
  const walk = (node) => {
    for (const child of node.childNodes) {
      if (child.nodeType === 3) { line += child.nodeValue; continue; }
      if (child.nodeType !== 1) continue;
      if (child.getAttribute('contenteditable') === 'false' || child.hasAttribute('data-slate-placeholder')) continue;
      if (child.tagName === 'BR') { flush(); continue; }
      const block = !getComputedStyle(child).display.startsWith('inline');
      if (block) flush();
      walk(child);
      if (block) flush();
    }
  };
  walk(root);
  flush();
  return lines.join('\\n');
})`;

/**
 * For a send: my messages with this text in the chat and all of mine there, whether the field is
 * empty, whether it holds exactly this text, and the client's send key setting.
 */
export const SEND_STATE = (id: string, text: string) => `(() => {
  const normalize = ${NORMALIZE};
  const expected = normalize(${JSON.stringify(text)});
  const st = window.__bbStore.getState();
  const me = Object.values(st.profiles || {}).find((p) => p && p.isMe);
  const mine = (st.messages || []).filter((m) => m && m.groupChatId === ${JSON.stringify(id)} && me && m.sender === me.userHuid
    && (m.payload || {}).body && normalize(m.payload.body) === expected).length;
  const composer = document.querySelector(${JSON.stringify(COMPOSER_SELECTOR())});
  const field = composer ? normalize(${FIELD_TEXT}(composer)) : '';
  const sendButton = String((((st.settings || {}).mainSettings) || {}).sendButton || '');
  // All my messages in the chat: a line break that sends shows here, with only the first line in it.
  const own = (st.messages || []).filter((m) => m && m.groupChatId === ${JSON.stringify(id)} && me && m.sender === me.userHuid).length;
  return { mine, own, empty: !field, exact: field === expected, sendButton };
})()`;

/** Clears what a failed send typed, the way a person does: select all, delete. Answers whether the field is empty now. */
export const CLEAR_FIELD = `(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const normalize = ${NORMALIZE};
  const composer = document.querySelector(${JSON.stringify(COMPOSER_SELECTOR())});
  if (!composer) return true;
  const empty = () => !normalize(${FIELD_TEXT}(composer));
  for (let i = 0; i < 3 && !empty(); i++) {
    composer.focus();
    document.execCommand('selectAll');
    await sleep(200);
    document.execCommand('delete');
    await sleep(300);
  }
  return empty();
})()`;

/** For the watcher: unread count and time of the last event of chosen chats, without opening them. */
export const WATCH_SNAPSHOT = (ids: readonly string[]) => `(() => {
  const ids = new Set(${JSON.stringify(ids)});
  const st = window.__bbStore.getState();
  const u = st.unreadChats || {};
  const out = {};
  for (const c of st.chats || []) {
    if (!c || !ids.has(c.groupChatId)) continue;
    out[c.groupChatId] = { unread: Number(u[c.groupChatId] ?? c.unreadCounter ?? 0) || 0, lastEventAt: Number(c.lastEventInsertedAt) || 0 };
  }
  return out;
})()`;

// ---------- Answers in a thread under a message ----------
//
// How the real client keeps threads (seen on it): a thread is a chat of chatType 'thread' and an
// entry in threads.threadList; the thread's id is the syncId of the message it hangs under. Threads
// and the people of a group join the store only once the chat is opened. A thread does not open by
// its address (the client goes to #/), only by the button under the message. Ids shared by every
// thread of a chat (the chat, its people) say nothing: a thread belongs to a message by the message's
// own ids only. The client puts a mention in itself: type "@" and a name, pick the person in its list.
// The field is an old Slate editor: a pasted line break is dropped, Shift+Enter starts a new line,
// and an empty field draws its placeholder as text inside itself.
//
// String.raw keeps the backslashes of the page source as they are.

const THREAD_HELPERS = String.raw`
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const store = window.__bbStore;
  const words = (s) => String(s || '').toLowerCase().replace(/ё/g, 'е').replace(/@\{[^}]*\}/g, ' ').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  const fiberOf = (el) => { const k = el && Object.keys(el).find((x) => x.startsWith('__reactFiber$') || x.startsWith('__reactInternalInstance$')); return k ? el[k] : null; };
  const huidOf = (m) => (typeof m === 'string' ? m : m && (m.userHuid || m.huid)) || null;
  const meNow = () => Object.values(store.getState().profiles || {}).find((p) => p && p.isMe) || null;
  const TARGET = '[data-bb-target]';
  const PLACEHOLDER = '[data-slate-placeholder], [data-placeholder], [class*="placeholder"], [contenteditable="false"][style*="pointer-events"]';
`;

/**
 * What the thread's field holds, line by line: the placeholder does not count, a mention does.
 * `inline`: a node that is not text, such as a mention, is in the field.
 */
const THREAD_FIELD = String.raw`((root) => {
  const lines = [];
  let line = '';
  let inline = false;
  const flush = () => { lines.push(line); line = ''; };
  const walk = (node) => {
    for (const child of node.childNodes) {
      if (child.nodeType === 3) { line += child.nodeValue; continue; }
      if (child.nodeType !== 1) continue;
      if (child.matches(PLACEHOLDER)) continue;
      if (child.getAttribute('contenteditable') === 'false') inline = true;
      if (child.tagName === 'BR') { flush(); continue; }
      const block = !getComputedStyle(child).display.startsWith('inline');
      if (block) flush();
      walk(child);
      if (block) flush();
    }
  };
  walk(root);
  flush();
  return { text: lines.join('\n'), inline };
})`;

/**
 * The message in a chat that holds a piece of text, its thread and the people of the chat. The
 * message list is hidden while it loads, so the chat stays unread. A chat the client shows empty is
 * opened again, up to three times; history that arrives in parts is waited for.
 */
export const FIND_MESSAGE = (chatId: string, fragment: string) => `(async () => {
  ${THREAD_HELPERS}
  const a = ${JSON.stringify({ chatId, fragment })};
  const signIn = () => ${SIGN_IN_SCREEN};
  ${String.raw`
  const st0 = store.getState();
  const parent = (st0.chats || []).find((c) => c && c.groupChatId === a.chatId);
  if (!parent) return { auth: false, missing: true, loaded: 0, opens: 0, total: 0, hits: [], people: [] };
  const profiles = () => store.getState().profiles || {};
  const known = new Set([...(st0.chats || []).filter(Boolean).map((c) => c.groupChatId), ...Object.keys(st0.profiles || {})]);
  const isId = (s) => typeof s === 'string' && s.length <= 64 && (/^[0-9a-f-]{16,64}$/i.test(s) || /^\d{6,20}$/.test(s) || known.has(s));
  const idVals = (v, d = 0, out = []) => {
    if (isId(v)) out.push(v);
    if (d >= 4 || v == null || typeof v !== 'object') return out;
    for (const x of Array.isArray(v) ? v.slice(0, 30) : Object.values(v).slice(0, 120)) idVals(x, d + 1, out);
    return out;
  };
  const ts = (v) => (v == null ? null : typeof v === 'number' ? v : typeof v === 'string' ? Date.parse(v) || null : Number(v.valueOf()) || null);
  const bodyOf = (m) => (m && m.payload && typeof m.payload.body === 'string' ? m.payload.body : '');
  const str = (x) => (typeof x === 'string' && x.trim() && x.length < 160 ? x.trim() : null);
  const person = (h) => {
    const p = profiles()[h];
    const c = (p && (p.ctsProfile || p.phonebookProfile)) || {};
    const f = (p && p.fastSortSearch) || {};
    const email = str(c.email);
    return { huid: h, name: str(c.name) || str(c.ctsName), position: str(c.companyPosition), department: str(c.department), email,
      aliases: [...(f.nameTransliterations || []), ...(Array.isArray(p && p.searchStrings) ? p.searchStrings : []), email ? email.split('@')[0] : null].filter((x) => typeof x === 'string' && x.length < 160) };
  };
  const chatNow = () => (store.getState().chats || []).find((c) => c && c.groupChatId === a.chatId) || parent;
  const inChat = () => (store.getState().messages || []).filter((m) => m && m.groupChatId === a.chatId);
  const frag = words(a.fragment);
  const prevHash = location.hash;
  const style = document.createElement('style');
  style.textContent = '[class*="chat-message"], [class*="messages-list"], [class*="message-list"] { display: none !important; }';
  document.head.appendChild(style);
  let msgs = [], opens = 0;
  try {
    for (let attempt = 1; attempt <= 3; attempt++) {
      opens = attempt;
      if (attempt > 1) { location.hash = '#/chats'; await sleep(2000); }
      location.hash = '#/chats/' + a.chatId;
      let prev = -1, stable = 0;
      for (let i = 0; i < 40; i++) {
        await sleep(500);
        if (signIn()) return { auth: true, missing: false, loaded: 0, opens, total: 0, hits: [], people: [] };
        msgs = inChat();
        if (msgs.length && msgs.length === prev && ((chatNow().members || []).length || i >= 20)) { if (++stable >= 3) break; } else stable = 0;
        prev = msgs.length;
      }
      if (msgs.length) break;
    }
    const members = (chatNow().members || []).map(huidOf).filter(Boolean);
    for (const h of members) if (!profiles()[h]) store.dispatch({ type: 'FETCH_PROFILE_BY_USER_HUID', payload: { userHuid: h } });
    for (let i = 0; i < 12 && members.some((h) => !profiles()[h]); i++) await sleep(700);
    const me = meNow();
    const meHuid = me ? me.userHuid : null;
    const hitsNow = () => msgs.filter((m) => frag && !m.stealth && !m.deletedAt && words(bodyOf(m)).includes(frag));
    for (let i = 0; i < 30 && !hitsNow().length; i++) { await sleep(500); msgs = inChat(); }
    const st = store.getState();
    const threadChats = (st.chats || []).filter((c) => c && c.chatType === 'thread');
    const threadList = Object.values(((st.threads || {}).threadList) || {}).filter(Boolean);
    const all = hitsNow();
    const hits = all.slice(-10).map((m) => {
      const own = new Set([m.syncId, (m.payload || {}).msgId].filter((v) => typeof v === 'string' && v.length >= 8));
      const has = (t) => idVals(t).some((v) => own.has(v));
      const ids = new Set([...threadChats.filter(has).map((t) => t.groupChatId), ...threadList.filter(has).map((e) => e.threadId).filter(Boolean)]);
      return {
        syncId: typeof m.syncId === 'string' ? m.syncId : null,
        at: ts(m.insertedAt) || ts((m.payload || {}).timestamp),
        from: m.sender ? person(m.sender).name : null,
        mine: !!(meHuid && m.sender === meHuid),
        preview: bodyOf(m).replace(/@\{mention:[^}]*\}/g, '@').replace(/\s+/g, ' ').trim().slice(0, 200),
        threads: [...ids],
      };
    });
    return { auth: false, missing: false, loaded: msgs.length, opens, total: all.length, hits, people: members.filter((h) => h !== meHuid).map(person) };
  } finally {
    location.hash = prevHash && !/^#\/chats\/./.test(prevHash) ? prevHash : '#/chats';
    await sleep(1200);
    style.remove();
  }`}
})()`;

/**
 * Opens a thread the way a person does: the chat, the message's row, the thread button under it, or
 * the row's own navigateToThread. Marks the one field that belongs to the thread, found by walking
 * up React's tree from the field to the first component that names one of the chats (the thread's
 * id wins: a thread chat names its parent too). Then waits until the thread's history stops
 * growing, so that a later count of my messages there is not thrown by history arriving late.
 */
export const OPEN_THREAD = (threadId: string, parentId: string, syncId: string) => `(async () => {
  ${THREAD_HELPERS}
  const a = ${JSON.stringify({ threadId, parentId, syncId, composer: COMPOSER_SELECTOR() })};
  ${String.raw`
  for (const el of document.querySelectorAll(TARGET)) el.removeAttribute('data-bb-target');
  const tokensOf = (el) => String(el.className && el.className.baseVal !== undefined ? el.className.baseVal : el.className || '').split(/\s+/).filter(Boolean);
  const bound = (ed) => {
    for (let f = fiberOf(ed), i = 0; f && i < 120; f = f.return, i++) {
      const p = f.memoizedProps;
      if (!p || typeof p !== 'object') continue;
      let parent = false;
      const stack = [[p, 0]];
      while (stack.length) {
        const [v, d] = stack.pop();
        if (v === a.threadId) return 'thread';
        if (v === a.parentId) parent = true;
        if (d < 2 && v && typeof v === 'object' && !(v instanceof Node) && !v.$$typeof) for (const x of Object.values(v).slice(0, 60)) stack.push([x, d + 1]);
      }
      if (parent) return 'parent';
    }
    return null;
  };
  const waitBound = async (n) => {
    let eds = [];
    for (let i = 0; i < n; i++) {
      await sleep(500);
      eds = [...document.querySelectorAll(a.composer)];
      const mine = eds.filter((ed) => bound(ed) === 'thread');
      if (mine.length === 1 && i >= 2) { mine[0].setAttribute('data-bb-target', '1'); return true; }
    }
    return false;
  };
  const settle = async () => {
    const count = () => (store.getState().messages || []).filter((m) => m && m.groupChatId === a.threadId).length;
    let prev = -1, stable = 0, n = 0;
    for (let i = 0; i < 30; i++) {
      await sleep(500);
      n = count();
      stable = n === prev ? stable + 1 : 0;
      prev = n;
      // An empty thread counts only once nothing has come for a while.
      if (stable >= 4 && (n > 0 || i >= 16)) return { loaded: n, settled: true };
    }
    return { loaded: n, settled: false };
  };
  const done = async (how) => ({ opened: true, how, composers: document.querySelectorAll(a.composer).length, ...(await settle()) });
  location.hash = '#/chats/' + a.parentId;
  await sleep(2500);
  const rowOf = () => {
    for (const el of document.querySelectorAll('[class*="chat-message"]')) {
      for (let f = fiberOf(el), i = 0; f && i < 20; f = f.return, i++) {
        const p = f.memoizedProps;
        if (p && p.message && p.message.syncId === a.syncId) return { el: el.closest('.chat-message-row') || el, props: p };
      }
    }
    return null;
  };
  let row = rowOf();
  // A message above the visible part of the list: scroll up until the client draws it.
  if (!row) {
    const any = document.querySelector('[class*="chat-message"]');
    let box = any && any.parentElement;
    while (box && !(box.scrollHeight > box.clientHeight + 10 && /auto|scroll/.test(getComputedStyle(box).overflowY))) box = box.parentElement;
    for (let i = 0; box && i < 25 && !row; i++) {
      box.scrollTop = Math.max(0, box.scrollTop - box.clientHeight * 0.8);
      await sleep(900);
      row = rowOf();
    }
  }
  if (!row) return { opened: false, why: 'row', composers: 0, loaded: 0, settled: false };
  const buttons = [...row.el.querySelectorAll('*')].filter((e) => tokensOf(e).some((c) => /thread/i.test(c)));
  const button = buttons[0] || row.el.querySelector('.chat-message-bottom-action');
  if (button) {
    button.scrollIntoView({ block: 'center' });
    button.click();
    if (await waitBound(12)) return done('button');
  }
  const nav = row.props.navigateToThread;
  if (typeof nav === 'function') {
    try { nav.length ? nav(row.props.message) : nav(); } catch {}
    if (await waitBound(12)) return done('navigateToThread');
  }
  return { opened: false, why: 'field', composers: document.querySelectorAll(a.composer).length, loaded: 0, settled: false };`}
})()`;

/**
 * For an answer in a thread: my messages there and in its chat, whether one already ends with this
 * text, how the last one mentions people, what the thread's field holds, and the send key.
 */
export const THREAD_STATE = (threadId: string, parentId: string, text: string, huid: string | null) => `(() => {
  ${THREAD_HELPERS}
  const a = ${JSON.stringify({ threadId, parentId, text, huid })};
  const normalize = ${NORMALIZE};
  const field = ${THREAD_FIELD};
  ${String.raw`
  const st = store.getState();
  const me = meNow();
  const all = (st.messages || []).filter((m) => m && me && m.sender === me.userHuid);
  const mine = all.filter((m) => m.groupChatId === a.threadId);
  const want = words(a.text);
  const same = want ? mine.filter((m) => words((m.payload || {}).body).endsWith(want)).length : 0;
  const last = mine[mine.length - 1];
  const has = (v, d = 0) => v === a.huid || (d < 6 && v && typeof v === 'object' && Object.values(v).some((x) => has(x, d + 1)));
  const pl = (last && last.payload) || {};
  const mentions = Array.isArray(pl.mentions) ? pl.mentions : Array.isArray(last && last.mentions) ? last.mentions : [];
  const ed = document.querySelector(TARGET);
  const now = ed ? field(ed) : { text: '', inline: false };
  return {
    composer: !!ed,
    mine: mine.length,
    same,
    inParent: all.filter((m) => m.groupChatId === a.parentId).length,
    lastMentionsPerson: last && a.huid ? mentions.some((x) => has(x)) : null,
    field: normalize(now.text),
    inline: now.inline,
    sendButton: String((((st.settings || {}).mainSettings) || {}).sendButton || ''),
  };`}
})()`;

/** Remembers the elements on the page, so that the "@" list is found among the ones that appear after typing. */
export const MARK_PAGE = `(() => { window.__bbBefore = new Set(document.querySelectorAll('*')); return true; })()`;

/**
 * The item of the "@" list for this person: by the person's id in the item's React props, else by
 * the full name. A point to click, as a person's mouse does, and how many people the list shows.
 */
export const MENTION_ITEM = (huid: string, huids: readonly string[], name: string | null, names: readonly string[]) => `(() => {
  ${THREAD_HELPERS}
  const a = ${JSON.stringify({ huid, huids, name, names })};
  ${String.raw`
  const before = window.__bbBefore || new Set();
  const shown = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
  const target = document.querySelector(TARGET);
  const added = [...document.querySelectorAll('*')].filter((e) => !before.has(e) && shown(e) && !(target && target.contains(e)));
  const huidsIn = (el) => {
    const found = new Set();
    for (let f = fiberOf(el), i = 0; f && i < 6; f = f.return, i++) {
      const p = f.memoizedProps;
      if (!p || typeof p !== 'object') continue;
      const stack = [[p, 0]];
      while (stack.length) {
        const [v, d] = stack.pop();
        if (typeof v === 'string' && a.huids.includes(v)) found.add(v);
        if (d < 2 && v && typeof v === 'object' && !(v instanceof Node) && !v.$$typeof) for (const x of Object.values(v).slice(0, 40)) stack.push([x, d + 1]);
      }
    }
    return [...found];
  };
  const byHuid = new Map();
  for (const el of added) {
    const hs = huidsIn(el);
    if (hs.length !== 1) continue;
    const prev = byHuid.get(hs[0]);
    if (!prev || el.contains(prev)) byHuid.set(hs[0], el);
  }
  const point = (el) => { const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; };
  if (byHuid.size) {
    const el = byHuid.get(a.huid);
    return { people: byHuid.size, point: el ? point(el) : null };
  }
  const want = words(a.name);
  const leaves = added.filter((e) => !e.children.length && want && words(e.textContent) === want);
  const people = new Set(added.filter((e) => !e.children.length && a.names.some((n) => words(n) && words(e.textContent) === words(n))).map((e) => words(e.textContent)));
  return { people: people.size, point: leaves.length === 1 ? point(leaves[0]) : null };`}
})()`;

/**
 * Whether the thread's field holds a mention of this person (a node with the person's id, or the
 * editor's model holding it), and whether the "@" list is still open.
 */
export const FIELD_MENTION = (huid: string, name: string | null) => `(() => {
  ${THREAD_HELPERS}
  const a = ${JSON.stringify({ huid, name })};
  ${String.raw`
  const ed = document.querySelector(TARGET);
  if (!ed) return { composer: false, mention: false, listOpen: false, endsWithSpace: false };
  let editor = null;
  for (let f = fiberOf(ed), i = 0; f && i < 60 && !editor; f = f.return, i++) {
    const p = f.memoizedProps;
    if (p && typeof p === 'object') for (const v of Object.values(p)) if (v && typeof v === 'object' && Array.isArray(v.children) && typeof v.apply === 'function') { editor = v; break; }
  }
  const hasValue = (v, d = 0) => v === a.huid || (d < 8 && v && typeof v === 'object' && Object.values(v).some((x) => hasValue(x, d + 1)));
  const inEditor = editor ? hasValue(editor.children) : false;
  const first = String(a.name || '').split(/[\s,]+/).filter((w) => w.length >= 2)[0] || '';
  const nodes = [...ed.querySelectorAll('[contenteditable="false"], [data-slate-inline], [class*="mention"]')].filter((n) => !n.matches(PLACEHOLDER));
  const inDom = nodes.some((n) => [...n.attributes].some((x) => x.value === a.huid) || (first && n.textContent.includes(first)));
  const before = window.__bbBefore;
  const listOpen = !!(before && first) && [...document.querySelectorAll('*')].some((e) => !before.has(e) && !ed.contains(e) && !e.children.length
    && e.textContent.includes(first) && e.getBoundingClientRect().width > 0 && !e.closest('[class*="chat-message"]'));
  // What the field shows: a space the browser collapses at the end of a field is not there for the next word.
  return { composer: true, mention: inEditor || inDom, listOpen, endsWithSpace: /[\s\u00a0]$/.test(ed.innerText.replace(/[\u200b\ufeff]/g, '')) };`}
})()`;

/** Whether the focus is in the thread's field; puts it there when a click did not. */
export const FOCUS_TARGET = `(() => {
  const ed = document.querySelector('[data-bb-target]');
  if (!ed) return false;
  if (!(document.activeElement === ed || ed.contains(document.activeElement))) ed.focus();
  return document.activeElement === ed || ed.contains(document.activeElement);
})()`;

export const TARGET_SELECTOR = "[data-bb-target]";

/** Leaves the thread: the mark off the field, back to the chat list. */
export const LEAVE_THREAD = `(async () => {
  for (const el of document.querySelectorAll('[data-bb-target]')) el.removeAttribute('data-bb-target');
  location.hash = '#/chats';
  await new Promise((r) => setTimeout(r, 800));
  return true;
})()`;
