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

/** Signed in and loaded: no sign-in screen, the store is found and has chats. */
export const READY = `(() => {
  const auth = !!document.querySelector('.body--auth, .login');
  const found = ${FIND_STORE};
  const chats = found.ok ? (window.__bbStore.getState().chats || []).length : 0;
  return { auth, store: found.ok, chats };
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
  return { chats, meFound: !!meHuid };
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
  return { loaded: msgs.length, messages: out.slice(-${Math.max(1, Math.min(100, Math.floor(last)))}), unreadBefore, unreadAfter: unreadOf(), stealthSkipped };
})()`;

/** Opens a chat for sending; the list stays visible (sending means the chat is read anyway). */
export const OPEN_CHAT = (id: string) => `(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  location.hash = '#/chats/' + ${JSON.stringify(id)};
  for (let i = 0; i < 30; i++) {
    await sleep(500);
    const header = document.querySelector('.chat-header-title-container__text');
    const composer = document.querySelector(${JSON.stringify(COMPOSER_SELECTOR())});
    if (header && composer) return { header: header.innerText.trim(), composer: true };
  }
  const header = document.querySelector('.chat-header-title-container__text');
  return { header: header ? header.innerText.trim() : null, composer: false };
})()`;

export function COMPOSER_SELECTOR(): string {
  return '.message-input__message-field [contenteditable="true"], .message-input__message-field[contenteditable="true"]';
}

/** My messages with this text in the chat (from the store), what is left in the composer, the send key setting. */
export const SEND_STATE = (id: string, text: string) => `(() => {
  const st = window.__bbStore.getState();
  const me = Object.values(st.profiles || {}).find((p) => p && p.isMe);
  const mine = (st.messages || []).filter((m) => m && m.groupChatId === ${JSON.stringify(id)} && me && m.sender === me.userHuid
    && (m.payload || {}).body && m.payload.body.trim() === ${JSON.stringify(text)}.trim()).length;
  const composer = document.querySelector(${JSON.stringify(COMPOSER_SELECTOR())});
  const left = composer ? composer.innerText.trim() : '';
  const sendButton = String((((st.settings || {}).mainSettings) || {}).sendButton || '');
  return { mine, left, sendButton };
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
