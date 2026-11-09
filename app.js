'use strict';

/* Magic Lads: log commander games to the group tracker from a phone.
 *
 * Talks to the tracker's Apps Script web app (config.js). Lists are kept on the
 * phone so the form works without signal; games logged offline wait in an
 * outbox and are sent, in order, as soon as the tracker can be reached.
 */

const API = String(window.MAGIC_LADS_API || '').trim();
const API_READY = /^https:\/\/script\.google\.com\/macros\/s\/[^/]+\/exec$/.test(API) || /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?\//.test(API);
const STORE = { data: 'ml.data.v1', outbox: 'ml.outbox.v1', draft: 'ml.draft.v1', hint: 'ml.ioshint.v1', cards: 'ml.cards.v2',
  games: 'ml.games.v1', player: 'ml.player.v1' };
const NEW_DECK = '__new__';
const SEATS = 4;
const STALE_MS = 30000;   // lists older than this are reloaded when you come back to the app

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

function h(tag, attrs, ...kids) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat()) {
    if (kid === null || kid === undefined || kid === false) continue;
    node.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  }
  return node;
}

function load(key, fallback) {
  try { const v = JSON.parse(localStorage.getItem(key)); return v === null ? fallback : v; }
  catch (e) { return fallback; }
}
function save(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch (e) { /* storage full or blocked */ }
}
function uid() {
  if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
  return Date.now().toString(36) + Math.random().toString(36).slice(2);
}
function todayLocal() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function niceDate(ymd) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(ymd || '')) return ymd || '';
  const [y, m, d] = ymd.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
}
function clockTime(ms) {
  return new Date(ms).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

// --------------------------------------------------------------------------- state

let data = load(STORE.data, null);          // lists from the tracker, plus fetchedAt
let outbox = load(STORE.outbox, []);        // requests waiting to be sent
let draft = Object.assign(blankDraft(), load(STORE.draft, {}));
let online = navigator.onLine;
let lastError = '';
let sending = false;
let trackerBusy = false;

function blankDraft(keepPod) {
  const prev = keepPod ? draft : null;
  return {
    date: prev ? prev.date : todayLocal(),
    bracket: prev ? prev.bracket : '',
    players: prev ? prev.players.slice() : ['', '', '', ''],
    commanders: prev ? prev.commanders.slice() : ['', '', '', ''],
    winner: '',
    notes: '',
  };
}
function saveDraft() { save(STORE.draft, draft); }
function saveOutbox() { save(STORE.outbox, outbox); }

/** Decks the app knows about: the tracker's, plus any added here that haven't reached it yet. */
function allDecks() {
  const decks = (data && data.decks) ? data.decks.slice() : [];
  for (const item of outbox) {
    if (item.type !== 'addDeck' || item.error) continue;
    const p = item.payload;
    if (!decks.some(d => d.player === p.player && d.bracket === p.bracket && d.commander.toLowerCase() === p.commander.toLowerCase())) {
      decks.push({ player: p.player, commander: p.commander, bracket: p.bracket, pending: true });
    }
  }
  return decks;
}
function decksFor(player, bracket) {
  return allDecks()
    .filter(d => d.player === player && d.bracket === bracket)
    .sort((a, b) => a.commander.localeCompare(b.commander));
}

// --------------------------------------------------------------------------- talking to the tracker

class NetworkError extends Error {}
class BusyError extends NetworkError {}   // the tracker is reachable but briefly locked: try again soon
class TrackerError extends Error {}

async function call(method, body, action = 'data') {
  if (!API_READY) throw new TrackerError('The app is not connected to the tracker yet (see config.js).');
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 45000);
  let res;
  try {
    const url = method === 'GET' ? `${API}?action=${action}&t=${Date.now()}` : API;
    res = await fetch(url, method === 'GET'
      ? { cache: 'no-store', redirect: 'follow', signal: ctrl.signal }
      // text/plain keeps this a "simple" request, which Apps Script accepts from another site.
      : { method: 'POST', body: JSON.stringify(body), headers: { 'Content-Type': 'text/plain;charset=utf-8' }, redirect: 'follow', signal: ctrl.signal });
  } catch (e) {
    throw new NetworkError("Couldn't reach the tracker.");
  } finally {
    clearTimeout(timer);
  }
  let json;
  try { json = await res.json(); }
  catch (e) { throw new NetworkError(`The tracker sent back something unexpected (HTTP ${res.status}).`); }
  if (!json.ok) {
    if (/busy/i.test(json.error || '')) throw new BusyError(json.error);
    throw new TrackerError(json.error || 'The tracker said no.');
  }
  return json;
}

function isStale() {
  return !data || Date.now() - data.fetchedAt > STALE_MS;
}

/** Reloads the lists. A call made while a load is running waits for it, then loads again,
 *  so a game sent during that load always shows up. */
let refreshRun = null;
let refreshAgain = false;
function refresh(opts) {
  if (refreshRun) { refreshAgain = true; return refreshRun; }
  $('#refresh').classList.add('spin');
  refreshRun = (async () => {
    do {
      refreshAgain = false;
      await loadData(opts);
    } while (refreshAgain);
  })().finally(() => {
    refreshRun = null;
    $('#refresh').classList.remove('spin');
  });
  return refreshRun;
}

async function loadData({ quiet } = {}) {
  try {
    const fresh = await call('GET');
    delete fresh.ok;
    fresh.fetchedAt = Date.now();
    data = fresh;
    save(STORE.data, data);
    online = true; lastError = '';
    pruneDraft();
  } catch (e) {
    if (e instanceof NetworkError) online = false;
    lastError = e.message;
    if (!quiet && !(e instanceof NetworkError)) toast(e.message, true);
  } finally {
    renderAll();
  }
}

/** Sends anything waiting, then reloads the lists if sending didn't already (and they're stale, unless `force`). */
async function sync({ force } = {}) {
  const done = await flushOutbox();
  if (!done.length && (force || isStale())) await refresh({ quiet: true });
}

/** Sends waiting requests in order. Calls made while a send is running wait their turn. */
let flushChain = Promise.resolve();
function flushOutbox() {
  const run = flushChain.then(sendWaiting, sendWaiting);
  flushChain = run.catch(() => {});
  return run;
}

/** Stops at the first request that can't get through, so they always arrive in order. */
let busyRetry = null;
async function sendWaiting() {
  if (!outbox.some(i => !i.error)) return [];
  sending = true;
  trackerBusy = false;
  renderOutbox();
  const done = [];
  try {
    for (const item of outbox.slice()) {
      if (item.error) continue;
      try {
        const result = await call('POST', item.payload);
        outbox = outbox.filter(i => i.id !== item.id);
        done.push({ item, result });
        online = true;
      } catch (e) {
        if (e instanceof BusyError) {
          trackerBusy = true;
          clearTimeout(busyRetry);
          busyRetry = setTimeout(() => flushOutbox(), 20000);
          break;
        }
        if (e instanceof NetworkError) { online = false; break; }
        item.error = e.message;   // the tracker refused it: keep it so it can be read, retried or discarded
      }
      saveOutbox();
    }
  } finally {
    sending = false;
    saveOutbox();
  }
  if (done.some(d => d.item.type === 'logGame') && games) {
    games.fetchedAt = 0;
    if (currentView === 'player') loadGames();
  }
  if (done.length) await refresh({ quiet: true });
  else renderAll();
  return done;
}

// --------------------------------------------------------------------------- log form

function pruneDraft() {
  if (!data) return;
  if (draft.bracket && !data.brackets.includes(draft.bracket)) draft.bracket = '';
  if (!draft.bracket && data.recent && data.recent[0]) draft.bracket = data.recent[0].bracket;   // the group's usual bracket
  draft.players = draft.players.map(p => (data.players.includes(p) ? p : ''));
  draft.commanders = draft.commanders.map((c, i) =>
    c && decksFor(draft.players[i], draft.bracket).some(d => d.commander === c) ? c : '');
  if (!draft.players.includes(draft.winner)) draft.winner = '';
  saveDraft();
}

// --------------------------------------------------------------------------- motion

// Every animation answers something you did: a pick, a tab, a new game arriving.
// Nothing plays with the phone's "reduce motion" setting on.
const calmMotion = window.matchMedia ? window.matchMedia('(prefers-reduced-motion: reduce)') : { matches: false };
const EASE_OUT = 'cubic-bezier(.2, .8, .2, 1)';

/** Plays a one-off animation. Returns null (and does nothing) when motion is off or unsupported. */
function play(el, keyframes, opts) {
  if (!el || !el.animate || calmMotion.matches) return null;
  return el.animate(keyframes, Object.assign({ duration: 220, easing: EASE_OUT }, opts));
}

const POP = [{ transform: 'scale(.92)' }, { transform: 'scale(1.05)', offset: 0.55 }, { transform: 'scale(1)' }];
const VIEW_IN = [{ opacity: 0, transform: 'translateY(8px)' }, { opacity: 1, transform: 'none' }];
const ARRIVE = [
  { opacity: 0, transform: 'translateY(-8px) scale(.98)', boxShadow: '0 0 0 2px rgba(227, 194, 122, .9)' },
  { opacity: 1, transform: 'none', boxShadow: '0 0 0 2px rgba(227, 194, 122, .9)', offset: 0.3 },
  { opacity: 1, transform: 'none', boxShadow: '0 0 0 2px rgba(227, 194, 122, 0)' },
];

function renderForm() {
  const brackets = (data && data.brackets) || [];
  const players = (data && data.players) || [];

  // Only when different: setting a field's value moves the cursor, even to the same text.
  if ($('#date').value !== draft.date) $('#date').value = draft.date;
  $('#date').max = todayLocal();

  const chips = $('#brackets');
  chips.replaceChildren(...brackets.map((b, i) => h('button', {
    type: 'button', class: 'chip', role: 'radio', 'aria-checked': String(draft.bracket === b),
    'aria-label': b, text: b.replace(/^Bracket\s*/i, ''),
    onclick: () => {
      const changed = draft.bracket !== b;
      draft.bracket = b; pruneDraft(); renderForm();
      if (changed) play(chips.children[i], POP, { duration: 260 });
    },
  })));
  if (!brackets.length) chips.replaceChildren(h('span', { class: 'muted small', text: 'Loading…' }));

  const seats = $('#seats');
  seats.replaceChildren(...draft.players.map((player, i) => {
    const taken = draft.players.filter((p, j) => p && j !== i);
    const playerSel = h('select', {
      'aria-label': `Player ${i + 1}`, 'data-seat': i,
      onchange: e => {
        draft.players[i] = e.target.value;
        draft.commanders[i] = '';
        if (!draft.players.includes(draft.winner)) draft.winner = '';
        saveDraft(); renderForm();
      },
    },
    h('option', { value: '', text: `Player ${i + 1}…` }),
    players.map(p => h('option', { value: p, selected: p === player, disabled: taken.includes(p), text: p })));

    const ready = player && draft.bracket;
    const decks = ready ? decksFor(player, draft.bracket) : [];
    const cmdSel = h('select', {
      'aria-label': `Commander ${i + 1}`, 'data-seat-cmd': i, disabled: !player,
      onchange: e => {
        if (e.target.value === NEW_DECK) {
          e.target.value = draft.commanders[i];
          openDeckDialog(i);
          return;
        }
        draft.commanders[i] = e.target.value; saveDraft(); renderForm();
      },
    },
    h('option', { value: '', text: !player ? 'Pick the player first' : !draft.bracket ? 'Pick the bracket first' : decks.length ? 'Commander…' : `No ${draft.bracket} decks yet` }),
    decks.map(d => h('option', { value: d.commander, selected: d.commander === draft.commanders[i], text: d.pending ? `${d.commander} (adding…)` : d.commander })),
    ready ? h('option', { value: NEW_DECK, text: '＋ New commander…' }) : null);

    return h('div', { class: 'card seat' },
      h('div', { class: 'seat-head' }, h('span', { class: 'seat-no', text: String(i + 1) }), playerSel),
      cmdSel,
      cardArt(player ? draft.commanders[i] : '', `seat:${i}`, 'seat-art'));
  }));

  const winners = $('#winners');
  const chosen = draft.players.map((p, i) => ({ p, c: draft.commanders[i] })).filter(x => x.p);
  if (!chosen.length) {
    winners.replaceChildren(h('p', { class: 'muted small', text: 'Pick the players first.' }));
  } else {
    winners.replaceChildren(...chosen.map(({ p, c }, i) => h('button', {
      type: 'button', class: 'win', role: 'radio', 'aria-checked': String(draft.winner === p),
      onclick: () => {
        draft.winner = draft.winner === p ? '' : p; saveDraft(); renderForm();
        if (draft.winner === p) play(winners.children[i], POP, { duration: 300 });
      },
    }, h('b', { text: p }), h('small', { text: c || 'commander not picked' }))));
  }

  if ($('#notes').value !== draft.notes) $('#notes').value = draft.notes;

  const missing = whatsMissing();
  $('#submit').disabled = missing.length > 0 || !data;
  $('#form-hint').textContent = !data ? (API_READY ? 'Loading the tracker…' : 'Not connected to the tracker yet.') : missing.length ? `Still to pick: ${missing.join(', ')}` : '';
}

function whatsMissing() {
  const out = [];
  if (!draft.bracket) out.push('bracket');
  const nPlayers = draft.players.filter(Boolean).length;
  if (nPlayers < SEATS) out.push(`${SEATS - nPlayers} player${SEATS - nPlayers === 1 ? '' : 's'}`);
  const nCmds = draft.players.filter((p, i) => p && !draft.commanders[i]).length;
  if (nCmds) out.push(`${nCmds} commander${nCmds === 1 ? '' : 's'}`);
  if (!draft.winner) out.push('winner');
  return out;
}

async function submitGame(ev) {
  ev.preventDefault();
  if (whatsMissing().length) return;
  const game = {
    date: draft.date || todayLocal(),
    bracket: draft.bracket,
    players: draft.players.slice(),
    commanders: draft.commanders.slice(),
    winner: draft.winner,
    notes: draft.notes.trim(),
  };
  const id = uid();
  outbox.push({ id, type: 'logGame', created: Date.now(), payload: { action: 'logGame', clientId: id, game } });
  saveOutbox();

  // Same pod next game: keep the bracket, players and commanders; clear the result.
  draft = blankDraft(true);
  saveDraft();
  renderAll();

  $('#submit').disabled = true;
  $('#submit').textContent = 'Logging…';
  $('#submit').classList.add('busy');
  const done = await flushOutbox();
  $('#submit').textContent = 'Log game';
  $('#submit').classList.remove('busy');
  renderForm();

  const mine = done.find(d => d.item.id === id);
  const failed = outbox.find(i => i.id === id && i.error);
  if (mine) {
    const r = mine.result;
    if (r.duplicate) toast('Already logged.');
    else if (r.status && r.status !== 'OK') toast(`Game ${r.number || ''} logged, but the tracker flags it: ${r.status}`, true);
    else toast(`Game ${r.number} logged. ${game.winner} wins! 🏆`);
  } else if (failed) {
    // The tracker refused it while you're still here: put the game back in the form to fix.
    outbox = outbox.filter(i => i.id !== id);
    saveOutbox();
    Object.assign(draft, { date: game.date, bracket: game.bracket, players: game.players, commanders: game.commanders, winner: game.winner, notes: game.notes });
    saveDraft();
    renderAll();
    toast(failed.error, true);
  } else if (trackerBusy) {
    toast('The tracker is busy. Your game is saved and will be sent in a moment.');
  } else {
    toast('Saved on this phone. It will be sent when you have signal.');
  }
}

// --------------------------------------------------------------------------- new commander

let deckSeat = null;
let suggestTimer = null;

function openDeckDialog(seat) {
  deckSeat = seat;
  const dlg = $('#deck-dialog');
  const players = (data && data.players) || [];
  const brackets = (data && (data.deckBrackets || data.brackets)) || [];
  $('#deck-player').replaceChildren(...players.map(p => h('option', { value: p, selected: p === draft.players[seat], text: p })));
  $('#deck-bracket').replaceChildren(...brackets.map(b => h('option', { value: b, selected: b === draft.bracket, text: b })));
  $('#deck-name').value = '';
  $('#deck-error').hidden = true;
  $('#card-suggestions').replaceChildren();
  dlg.showModal();
  setTimeout(() => $('#deck-name').focus(), 50);
}

async function suggestCards() {
  const q = $('#deck-name').value.trim();
  if (q.length < 2 || !navigator.onLine) return;
  try {
    const res = await fetch(`https://api.scryfall.com/cards/autocomplete?q=${encodeURIComponent(q)}`, { headers: { Accept: 'application/json' } });
    const json = await res.json();
    if ($('#deck-name').value.trim() !== q) return;
    $('#card-suggestions').replaceChildren(...(json.data || []).slice(0, 12).map(name => h('option', { value: name })));
  } catch (e) { /* suggestions are a nice-to-have */ }
}

async function saveDeck(ev) {
  ev.preventDefault();
  const seat = deckSeat;
  const player = $('#deck-player').value;
  const bracket = $('#deck-bracket').value;
  const commander = $('#deck-name').value.replace(/\s+/g, ' ').trim();
  const err = $('#deck-error');
  if (!commander) { err.textContent = "Type the commander's name."; err.hidden = false; return; }
  const existing = decksFor(player, bracket).find(d => d.commander.toLowerCase() === commander.toLowerCase());
  const forSeat = seat !== null && player === draft.players[seat] && bracket === draft.bracket;
  if (forSeat) {
    draft.commanders[seat] = existing ? existing.commander : commander;
    saveDraft();
  }
  $('#deck-dialog').close();
  if (existing) { renderAll(); toast(`${existing.commander} is already on the Decks sheet.`); return; }

  const id = uid();
  outbox.push({ id, type: 'addDeck', created: Date.now(), payload: { action: 'addDeck', clientId: id, player, bracket, commander } });
  saveOutbox();
  renderAll();
  const done = await flushOutbox();
  const mine = done.find(d => d.item.id === id);
  const failed = outbox.find(i => i.id === id && i.error);
  if (mine) {
    // The Decks sheet may already have it under different capitals: use its spelling.
    const name = mine.result.commander || commander;
    if (forSeat && name !== commander && draft.players[seat] === player && draft.bracket === bracket
        && (!draft.commanders[seat] || draft.commanders[seat] === commander)) {
      draft.commanders[seat] = name;
      saveDraft();
      renderForm();
    }
    toast(mine.result.existing ? `${name} is already on the Decks sheet.` : `${name} added to ${player}'s decks.`);
  } else if (failed) {
    toast(failed.error, true);
  } else {
    toast(`${commander} saved on this phone. It will be added when you have signal.`);
  }
}

// --------------------------------------------------------------------------- commander card images
//
// Each commander is looked up on Scryfall once. Which card it is (and its image address) is kept
// in localStorage, and the image itself in the phone's Cache Storage, so from then on it shows
// straight from the phone, without signal too, and Scryfall is never asked for it again.

const CARD_CACHE = 'magic-lads-cards';    // sw.js keeps this cache when the app updates
const SCRYFALL = 'https://api.scryfall.com';
const SCRYFALL_GAP_MS = 550;              // Scryfall allows 2 card lookups a second
const SCRYFALL_BATCH = 75;                // names per /cards/collection request (Scryfall's maximum)
const RETRY_FAILED_MS = 60000;            // after a failed lookup (no signal, Scryfall down), wait before asking again
const RECHECK_MISS_MS = 7 * 86400000;     // a name Scryfall didn't know is asked about again after a week
const RECHECK_LOWRES_MS = 3 * 86400000;   // a card with only a preview scan (new sets) is checked for a proper one

const WUBRG = ['W', 'U', 'B', 'R', 'G'];
let cardInfo = load(STORE.cards, {});     // commander name (lower case) -> { cards: [{name, img}], colors, at, lowres? } or { miss: true, at }
try { localStorage.removeItem('ml.cards.v1'); } catch (e) { /* v1 picked the standard printing for "Alt name (Real name)" commanders */ }
const cardLookups = new Map();            // name -> Promise, while it's being looked up
const lookupFailed = new Map();           // name -> when its last lookup failed
const imageUrls = new Map();              // image address -> blob: URL of the copy stored on the phone
const imageLoads = new Map();             // image address -> Promise, while it's being fetched or read
const artSlots = new Map();               // where an image is shown -> its element, reused so re-drawing doesn't flicker

function cardKey(name) { return String(name || '').replace(/\s+/g, ' ').trim().toLowerCase(); }

function recheckDue(entry) {
  if (!entry.miss && !entry.colors) return true;   // looked up before colours were kept (for the Player tab)
  const age = Date.now() - (entry.at || 0);
  return entry.miss ? age > RECHECK_MISS_MS : !!entry.lowres && age > RECHECK_LOWRES_MS;
}

/** One request to Scryfall's API (a POST when `body` is given), queued so they're spaced out.
 *  Resolves to null when Scryfall has no match. */
let scryfallQueue = Promise.resolve();
let scryfallNext = 0;
function scryfall(path, body) {
  const run = scryfallQueue.then(async () => {
    const wait = scryfallNext - Date.now();
    if (wait > 0) await new Promise(r => setTimeout(r, wait));
    scryfallNext = Date.now() + SCRYFALL_GAP_MS;
    const res = await fetch(SCRYFALL + path, body
      ? { method: 'POST', headers: { Accept: 'application/json', 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
      : { headers: { Accept: 'application/json' } });
    if (res.status === 404) return null;
    if (res.status === 429) scryfallNext = Date.now() + 10000;   // told to slow down: back off for a while
    if (!res.ok) throw new Error(`Scryfall said ${res.status}`);
    return res.json();
  });
  scryfallQueue = run.catch(() => {});
  return run;
}

/** Finds a card by its exact name. Names asked for together (a screenful of commanders) go to
 *  Scryfall as one request. Resolves to the card, or null if no card has that name. */
let collectWaiting = new Map();   // lower-case name -> { name, done: [resolve], fail: [reject] }
let collectTimer = null;
function cardByName(name) {
  return new Promise((resolve, reject) => {
    const key = name.toLowerCase();
    if (!collectWaiting.has(key)) collectWaiting.set(key, { name, done: [], fail: [] });
    collectWaiting.get(key).done.push(resolve);
    collectWaiting.get(key).fail.push(reject);
    if (!collectTimer) collectTimer = setTimeout(sendCollect, 40);
  });
}
function sendCollect() {
  collectTimer = null;
  const all = Array.from(collectWaiting.values());
  collectWaiting = new Map();
  for (let i = 0; i < all.length; i += SCRYFALL_BATCH) {
    const chunk = all.slice(i, i + SCRYFALL_BATCH);
    scryfall('/cards/collection', { identifiers: chunk.map(w => ({ name: w.name })) }).then(json => {
      const found = (json && json.data) || [];
      for (const w of chunk) {
        const card = found.find(c => cardNames(c).includes(w.name.toLowerCase())) || null;
        w.done.forEach(f => f(card));
      }
    }, err => chunk.forEach(w => w.fail.forEach(f => f(err))));
  }
}
/** Every name a card answers to: "A // B", each face, and any printed or flavor name. */
function cardNames(card) {
  return [card.name, card.printed_name, card.flavor_name].concat((card.card_faces || []).map(f => f.name))
    .filter(Boolean).map(n => n.toLowerCase());
}

/** The ways to find a commander on Scryfall, best first. Each way is a list of names that must all
 *  find a card: one for most commanders, two for partners and backgrounds ("Alena… // Gilanra…"). */
function lookupPlans(name) {
  if (!name.includes('//')) return [[name]];
  const parts = name.split('//').map(s => s.trim()).filter(Boolean);
  return [
    [name],               // a double-faced card: "Bruce Banner // The Incredible Hulk"
    parts.slice(0, 2),    // two cards: "Merry, Warden of Isengard // Pippin, Warden of Isengard"
  ];
}

/** A card's image (the front face for double-faced cards). */
function cardFace(card) {
  const faces = card.card_faces || [];
  const uris = card.image_uris || (faces[0] && faces[0].image_uris);
  if (!uris || !uris.normal) return null;
  return { name: card.flavor_name || card.printed_name || card.name, img: uris.normal,
    lowres: card.image_status !== 'highres_scan', ci: card.color_identity || [] };
}

/** A commander written with its card's real name in brackets, "Chun-Li, Countless Kicks (Zethi, Arcane
 *  Blademaster)", is looked up by the name it's printed under first, so it shows that printing's art. */
async function findCards(name) {
  const paren = name.match(/^(.+?)\s*\(([^()]+)\)\s*$/);
  for (const n of paren ? [paren[1], paren[2]] : [name]) {
    const entry = await findByName(n);
    if (entry) return entry;
  }
  return { miss: true, at: Date.now() };
}

/** First by exact name (batched with the other commanders on screen), then with Scryfall's forgiving
 *  search, which answers one name at a time but copes with typos and finds Universes Beyond and
 *  Secret Lair names ("Zombie Scarlet Witch") on the printing that uses them. */
async function findByName(name) {
  const plans = lookupPlans(name);
  const fuzzy = part => scryfall(`/cards/named?fuzzy=${encodeURIComponent(part)}`);
  for (const find of [cardByName, fuzzy]) {
    for (const plan of plans) {
      const found = (await Promise.all(plan.map(find))).map(c => c && cardFace(c));
      // Both halves of "A // B" can find the same double-faced card: show it once.
      const cards = found.filter((c, i) => !c || found.findIndex(d => d && d.img === c.img) === i);
      if (found.every(Boolean)) {
        const ci = new Set(cards.flatMap(c => c.ci));
        return { cards: cards.map(c => ({ name: c.name, img: c.img })), colors: WUBRG.filter(c => ci.has(c)),
          lowres: cards.some(c => c.lowres) || undefined, at: Date.now() };
      }
    }
  }
  return null;
}

/** Looks a commander up on Scryfall and saves the answer. Resolves to what's known if it can't. */
function lookupCommander(name) {
  const key = cardKey(name);
  const known = cardInfo[key] || null;
  if (cardLookups.has(key)) return cardLookups.get(key);
  if (!navigator.onLine || Date.now() - (lookupFailed.get(key) || 0) < RETRY_FAILED_MS) return Promise.resolve(known);
  const run = findCards(name.replace(/\s+/g, ' ').trim())
    .then(entry => {
      cardInfo[key] = entry;
      save(STORE.cards, cardInfo);
      return entry;
    }, () => { lookupFailed.set(key, Date.now()); return known; })
    .finally(() => cardLookups.delete(key));
  cardLookups.set(key, run);
  return run;
}

/** The phone's copy of a card image, as a URL an <img> can show. Fetched from Scryfall and stored the first time. */
function storedImage(url) {
  if (imageUrls.has(url)) return Promise.resolve(imageUrls.get(url));
  if (imageLoads.has(url)) return imageLoads.get(url);
  const run = (async () => {
    let cache = null;
    try { if (window.caches) cache = await caches.open(CARD_CACHE); } catch (e) { /* storage blocked: just show it */ }
    let res = cache ? await cache.match(url) : null;
    if (!res) {
      res = await fetch(url, { mode: 'cors' });
      if (!res.ok) throw new Error(`Image ${res.status}`);
      if (cache) await cache.put(url, res.clone()).catch(() => {});
    }
    return URL.createObjectURL(await res.blob());
  })()
    .then(src => { imageUrls.set(url, src); return src; },
      () => url)   // couldn't fetch or store it: let the browser try the address itself (tried again next time)
    .finally(() => imageLoads.delete(url));
  imageLoads.set(url, run);
  return run;
}

/** The card image box for a commander. `slot` names where it's shown, so re-drawing reuses the same box. */
function cardArt(name, slot, cls) {
  const key = cardKey(name);
  const old = artSlots.get(slot);
  if (old && old.dataset.card === key) { updateArt(old, name); return old; }
  const box = h('button', { type: 'button', class: `card-art ${cls || ''}` });
  box.dataset.card = key;
  artSlots.set(slot, box);
  const known = key ? cardInfo[key] : null;
  fillArt(box, known);
  if (key && !known) box.classList.add('loading');
  updateArt(box, name);
  return box;
}

/** Looks the commander up if it hasn't been (or is due a re-check), and re-shows an image that failed to load. */
function updateArt(box, name) {
  const key = cardKey(name);
  if (!key) return;
  const known = cardInfo[key];
  if (known && !recheckDue(known)) {
    if (box._entry !== known || box._broken) fillArt(box, known);
    return;
  }
  lookupCommander(name).then(entry => {
    if (!box.isConnected || box.dataset.card !== key) return;
    if (entry && (entry !== box._entry || box._broken)) fillArt(box, entry);
    else if (!entry) box.classList.remove('loading');
  });
}

function fillArt(box, entry) {
  box._entry = entry;
  box._broken = false;
  const cards = entry && entry.cards;
  box.classList.toggle('missing', !!(entry && entry.miss));
  box.classList.toggle('pair', !!cards && cards.length > 1);
  box.classList.toggle('has-card', !!cards);
  box.disabled = !cards;
  if (!cards) {
    box.classList.remove('loading');
    box.replaceChildren();
    box.setAttribute('aria-hidden', 'true');
    box.tabIndex = -1;
    if (entry && entry.miss) box.title = 'No card image found on Scryfall'; else box.removeAttribute('title');
    return;
  }
  box.removeAttribute('aria-hidden');
  box.removeAttribute('tabindex');
  box.removeAttribute('title');
  box.setAttribute('aria-label', `Show ${cards.map(c => c.name).join(' and ')}`);
  box.onclick = () => openCardView(cards);

  const settle = () => { if (!box.querySelector('img:not(.shown)')) box.classList.remove('loading'); };
  box.replaceChildren(...cards.map(c => {
    const ready = imageUrls.get(c.img);
    const img = h('img', { alt: '', draggable: 'false', class: ready ? 'shown' : '' });
    img.addEventListener('load', () => { img.classList.add('shown'); settle(); });
    img.addEventListener('error', () => { box._broken = true; img.remove(); settle(); });
    if (ready) img.src = ready;
    else storedImage(c.img).then(src => { img.src = src; });
    return img;
  }));
  box.classList.toggle('loading', !!box.querySelector('img:not(.shown)'));
}

/** Shows a commander's card(s) big. Tap anywhere to close. */
function openCardView(cards) {
  const wrap = $('#card-view-imgs');
  wrap.classList.toggle('pair', cards.length > 1);
  wrap.replaceChildren(...cards.map(c => {
    const img = h('img', { alt: c.name });
    storedImage(c.img).then(src => { img.src = src; });
    return img;
  }));
  $('#card-dialog').showModal();
}

// --------------------------------------------------------------------------- recent games

function podList(players, commanders, winner) {
  return h('ul', { class: 'pod' }, players.map((p, i) =>
    h('li', { class: p === winner ? 'won' : '' }, h('b', { text: p }), h('span', { text: commanders[i] || '' }))));
}

/** A game's winner and pod, with the winning commander's card beside them. */
function gameBody(slot, winner, winningCommander, players, commanders) {
  return h('div', { class: 'game-body' },
    h('div', { class: 'game-main' },
      winner ? h('div', { class: 'game-winner' }, `🏆 ${winner}`, h('small', { text: winningCommander })) : null,
      podList(players, commanders, winner)),
    winner && winningCommander ? cardArt(winningCommander, slot, 'game-art') : null);
}

function renderRecent() {
  const list = $('#recent-list');
  const items = [];

  for (const item of outbox.filter(i => i.type === 'logGame')) {
    const g = item.payload.game;
    items.push(h('article', { class: 'game pending', 'data-key': 'p:' + item.id },
      h('div', { class: 'game-top' },
        h('span', { class: 'no', text: 'New' }),
        h('span', { class: 'meta', text: `${niceDate(g.date)} · ${g.bracket}` }),
        h('span', { class: `badge ${item.error ? 'bad' : 'wait'}`, text: item.error ? 'Not sent' : 'Waiting to send' })),
      gameBody('p:' + item.id, g.winner, g.commanders[g.players.indexOf(g.winner)], g.players, g.commanders),
      g.notes ? h('div', { class: 'game-notes', text: g.notes }) : null,
      item.error ? h('div', { class: 'game-notes error', text: item.error }) : null));
  }

  for (const g of (data && data.recent) || []) {
    const key = ['g', g.number, g.date, g.winner].concat(g.players).join('|');
    items.push(h('article', { class: 'game', 'data-key': key },
      h('div', { class: 'game-top' },
        h('span', { class: 'no', text: g.number ? `#${g.number}` : '—' }),
        h('span', { class: 'meta', text: [niceDate(g.date), g.bracket].filter(Boolean).join(' · ') }),
        h('span', { class: `badge ${g.status === 'OK' ? 'ok' : 'bad'}`, text: g.status || 'Incomplete' })),
      gameBody(key, g.winner, g.winningCommander, g.players, g.commanders),
      g.notes ? h('div', { class: 'game-notes', text: g.notes }) : null));
  }

  list.replaceChildren(...(items.length ? items : [h('p', { class: 'empty', text: data ? 'No games logged yet.' : 'Loading…' })]));
  if (data) markNewGames();
}

let seenGames = null;   // the games Recent has already shown, so only new arrivals light up
/** Lights up games that weren't there last time Recent was on screen. Called again when Recent is opened. */
function markNewGames() {
  const cards = $$('#recent-list article[data-key]');
  const keys = new Set(cards.map(c => c.dataset.key));
  if (!seenGames) { seenGames = keys; return; }    // the first lists loaded are the starting point
  if ($('#view-recent').hidden) return;           // wait until Recent is opened
  cards.filter(c => !seenGames.has(c.dataset.key))
    .forEach((c, i) => play(c, ARRIVE, { duration: 1500, delay: i * 70 }));
  seenGames = keys;
}

// --------------------------------------------------------------------------- standings

/** The Dashboard's caption for a table, minus its "see the Guide" pointer (the Guide is on the sheet). */
function caption(table) {
  return ((table && table.note) || '').split(' · ').filter(p => !/^see /i.test(p)).join(' · ');
}

function renderStandings() {
  const lb = data && data.leaderboard;
  const body = $('#lb-table tbody');
  $('#lb-note').textContent = caption(lb);
  if (!lb || !lb.rows.length) {
    body.replaceChildren(h('tr', {}, h('td', { colspan: 5, class: 'empty', text: data ? 'No games yet.' : 'Loading…' })));
  } else {
    body.replaceChildren(...lb.rows.map(r => {
      const idle = !Number(r.Games);
      return h('tr', { class: idle ? 'idle' : '' },
        h('td', { class: 'rank', text: r.Rank }),
        h('td', { class: 'player' }, h('b', { text: r.Player }), !idle && r['Best Commander'] ? h('small', { text: `Best: ${r['Best Commander']}` }) : null),
        h('td', { class: 'num', text: idle ? '–' : `${r.Wins}/${r.Games}` }),
        h('td', { class: 'num', text: r['Win %'] || '–' }),
        h('td', { class: 'num adj', text: r['Adj. Win %'] || '–' }));
    }));
  }

  const td = data && data.topDecks;
  $('#td-note').textContent = caption(td);
  const rows = (td && td.rows) || [];
  $('#td-list').replaceChildren(...(rows.length ? rows.map(r => h('div', { class: 'deck' },
    h('div', { class: 'rank', text: r.Rank }),
    h('div', { class: 'info' }, h('b', { text: r.Commander }), h('small', { text: `${r.Player} · ${r.Bracket} · ${r.Wins}/${r.Games} wins` })),
    h('div', { class: 'score' }, h('b', { class: 'adj', text: r['Adj. Win %'] }), h('small', { text: `win ${r['Win %']}` }))))
    : [h('p', { class: 'empty', text: data ? 'No decks have enough games yet.' : 'Loading…' })]));
}

// --------------------------------------------------------------------------- player

// Rank, adjusted win %, record and best commander are the Dashboard's (so they match the sheet, bracket
// filter and all). Colours, nemesis and recent games are worked out here from every game on the Games sheet.

const COLOURS = { W: 'White', U: 'Blue', B: 'Black', R: 'Red', G: 'Green', C: 'Colourless' };
const COLOUR_ORDER = ['W', 'U', 'B', 'R', 'G', 'C'];
// The page's background in the player's most played colour: strong enough to read as that colour,
// dark enough for the text on top.
const WASH = {   // colour, strength at the top, strength further down
  W: ['246, 230, 180', 0.32, 0.13], U: ['36, 120, 214', 0.58, 0.24], B: ['150, 104, 172', 0.50, 0.20],
  R: ['222, 52, 46', 0.54, 0.22], G: ['24, 150, 86', 0.54, 0.22], C: ['196, 190, 184', 0.30, 0.11],
};
const MEDALS = { 1: '🥇', 2: '🥈', 3: '🥉' };
const manaUrl = c => `https://svgs.scryfall.io/card-symbols/${c}.svg`;

let games = load(STORE.games, null);      // { list: every game, newest first, fetchedAt } or { unsupported: true, fetchedAt }
let pickedPlayer = load(STORE.player, '');

function gamesStale() { return !games || Date.now() - games.fetchedAt > STALE_MS; }

/** Loads every game from the tracker (its own request: the Player tab is the only thing that needs them). */
let gamesRun = null;
function loadGames() {
  if (gamesRun) return gamesRun;
  gamesRun = (async () => {
    try {
      const res = await call('GET', null, 'games');
      games = { list: res.games || [], fetchedAt: Date.now() };
    } catch (e) {
      // The tracker's Apps Script is older than the Player tab: say so, and ask again later in case it's updated.
      if (e instanceof TrackerError && /unknown request/i.test(e.message)) games = { unsupported: true, fetchedAt: Date.now() };
      else return;   // no signal or busy: keep the games saved on the phone
    }
    save(STORE.games, games);
  })().finally(() => { gamesRun = null; renderPlayer(); });
  return gamesRun;
}

function ordinal(n) {
  const s = n % 100 >= 11 && n % 100 <= 13 ? 'th' : ({ 1: 'st', 2: 'nd', 3: 'rd' }[n % 10] || 'th');
  return n + s;
}

/** A leaderboard row's place: the Rank column shows medals for the top 3. */
function placeOf(row, index) {
  const medal = Object.keys(MEDALS).find(k => MEDALS[k] === row.Rank);
  if (medal) return Number(medal);
  return /^\d+$/.test(row.Rank) ? Number(row.Rank) : index + 1;
}

/** What the games say about a player: colours, nemesis, recent games. Null until the games are loaded. */
function playerStats(name) {
  if (!games || !games.list) return null;
  const mine = games.list.filter(g => g.status === 'OK' && g.players.includes(name));
  const counts = {}, beats = {}, together = {}, beatWith = {};
  const unknown = new Set();
  for (const g of mine) {
    const cmd = g.commanders[g.players.indexOf(name)];
    const e = cardInfo[cardKey(cmd)];
    if (e && e.colors) (e.colors.length ? e.colors : ['C']).forEach(c => { counts[c] = (counts[c] || 0) + 1; });
    else if (cmd && !(e && e.miss)) unknown.add(cmd);
    g.players.forEach(p => { if (p && p !== name) together[p] = (together[p] || 0) + 1; });
    if (g.winner && g.winner !== name) {
      beats[g.winner] = (beats[g.winner] || 0) + 1;
      const by = beatWith[g.winner] = beatWith[g.winner] || {};
      by[g.winningCommander] = (by[g.winningCommander] || 0) + 1;
    }
  }
  const colours = Object.entries(counts)
    .sort((a, b) => b[1] - a[1] || COLOUR_ORDER.indexOf(a[0]) - COLOUR_ORDER.indexOf(b[0]))
    .slice(0, 2).map(([c, n]) => ({ c, n }));
  // Nemesis: whoever has beaten them most; on a tie, whoever beats them more often when they play.
  let nemesis = null;
  for (const [p, wins] of Object.entries(beats)) {
    const rate = wins / together[p];
    if (!nemesis || wins > nemesis.wins || (wins === nemesis.wins && rate > nemesis.rate)) nemesis = { name: p, wins, games: together[p], rate };
  }
  if (nemesis) nemesis.with = Object.entries(beatWith[nemesis.name]).sort((a, b) => b[1] - a[1])[0];
  return { mine, colours, unknown: Array.from(unknown), nemesis };
}

/** Looks up the colours of commanders not looked up yet (one batched request), then re-draws. */
let colourLookups = false;
function lookUpColours(names) {
  if (colourLookups || !names.length || !navigator.onLine) return;
  colourLookups = true;
  Promise.all(names.map(n => lookupCommander(n))).then(found => {
    colourLookups = false;
    if (found.some(e => e && (e.colors || e.miss))) renderPlayer();
  });
}

function manaSymbol(c) {
  const url = manaUrl(c);
  const ready = imageUrls.get(url);
  const img = h('img', { class: 'mana', alt: '', src: ready || null });
  if (!ready) storedImage(url).then(src => { img.src = src; });
  return img;
}

function setWash(colour) {
  const wash = $('#mana-wash');
  if (colour) {
    const [rgb, top, low] = WASH[colour];
    wash.style.setProperty('--wash', `rgba(${rgb}, ${top})`);
    wash.style.setProperty('--wash-low', `rgba(${rgb}, ${low})`);
  }
  wash.classList.toggle('on', !!colour);
}

function renderPlayer() {
  const players = (data && data.players) || [];
  const lb = data && data.leaderboard;
  const rows = (lb && lb.rows) || [];
  const ranked = rows.filter(r => Number(r.Games) > 0);
  if (!players.includes(pickedPlayer)) pickedPlayer = (ranked[0] && ranked[0].Player) || players[0] || '';

  const sel = $('#player-select');
  sel.replaceChildren(...(players.length ? players.map(p => h('option', { value: p, selected: p === pickedPlayer, text: p }))
    : [h('option', { text: data ? 'No players yet' : 'Loading…' })]));
  sel.disabled = !players.length;

  const body = $('#player-body');
  const name = pickedPlayer;
  if (!name) { body.replaceChildren(); $('#player-rank').textContent = ''; $('#player-place').textContent = ''; setWash(null); return; }

  // Leaderboard: place, adjusted win %, record.
  const row = rows.find(r => r.Player === name);
  const playedAny = row && Number(row.Games) > 0;
  const place = playedAny ? placeOf(row, ranked.indexOf(row)) : 0;
  $('#player-rank').textContent = place ? (MEDALS[place] || `#${place}`) : '–';
  $('#player-rank').classList.toggle('medal', !!MEDALS[place]);
  $('#player-place').textContent = place ? `${ordinal(place)} of ${ranked.length} on the leaderboard` : 'Not on the leaderboard yet';
  const wins = playedAny ? Number(row.Wins) : 0;
  const played = playedAny ? Number(row.Games) : 0;
  $('#player-stats').replaceChildren(
    h('div', { class: 'pstat' }, h('span', { class: 'label', text: 'Adj. win %' }), h('b', { class: 'adj', text: playedAny ? row['Adj. Win %'] : '–' }),
      h('small', { text: playedAny ? `win ${row['Win %']}` : 'no games yet' })),
    h('div', { class: 'pstat' }, h('span', { class: 'label', text: 'Record' }), h('b', { text: playedAny ? `${wins}–${played - wins}` : '–' }),
      h('small', { text: playedAny ? `${wins} win${wins === 1 ? '' : 's'} · ${played} game${played === 1 ? '' : 's'}` : '' })));
  $('#player-note').textContent = caption(lb);

  const st = playerStats(name);
  if (st && currentView === 'player') lookUpColours(st.unknown);
  const fromGames = st ? null
    : games && games.unsupported ? "Update the tracker's Apps Script to see this (see the README)."
    : !navigator.onLine ? 'Connect once to load the games.' : 'Loading games…';
  const waiting = text => h('p', { class: 'muted small', text });

  // Best commander, with its card.
  const best = playedAny ? row['Best Commander'] : '';
  const bestGames = st && best ? st.mine.filter(g => g.commanders[g.players.indexOf(name)] === best) : [];
  const bestWins = bestGames.filter(g => g.winner === name).length;
  const bestCard = h('div', { class: 'card player-best' },
    best ? cardArt(best, 'player:best', 'best-art') : h('div', { class: 'card-art best-art', 'aria-hidden': 'true' }),
    h('div', { class: 'info' },
      h('span', { class: 'label', text: 'Best commander' }),
      h('b', { text: best || 'None yet' }),
      bestGames.length ? h('small', { text: `Won ${bestWins} of ${bestGames.length} game${bestGames.length === 1 ? '' : 's'}` }) : null));

  // Most played colours, with mana symbols. The page takes on the top one.
  const colourCard = h('div', { class: 'card player-colours' }, h('span', { class: 'label', text: 'Most played colours' }),
    !st ? waiting(fromGames)
      : st.colours.length ? st.colours.map(({ c, n }) => h('div', { class: 'mana-row' }, manaSymbol(c),
        h('div', {}, h('b', { text: COLOURS[c] }), h('small', { text: `${n} of ${st.mine.length} games` }))))
      : waiting(st.mine.length ? 'Looking up commanders…' : 'No games yet.'));
  setWash(st && st.colours[0] ? st.colours[0].c : null);

  const nem = st && st.nemesis;
  const nemesisCard = h('div', { class: 'card player-nemesis' }, h('span', { class: 'label', text: 'Nemesis' }),
    !st ? waiting(fromGames)
      : nem ? [h('b', { class: 'nemesis-name', text: nem.name }),
        h('small', { text: `Won ${nem.wins} of ${nem.games} game${nem.games === 1 ? '' : 's'} against ${name}` }),
        h('small', { class: 'muted', text: `${nem.with[1] > 1 ? 'Mostly with' : 'With'} ${nem.with[0]}` })]
      : waiting(st.mine.length ? 'Unbeaten so far.' : 'No games yet.'));

  const recentCard = h('div', { class: 'card player-recent' }, h('span', { class: 'label', text: 'Recent games' }),
    !st ? waiting(fromGames)
      : st.mine.length ? h('ul', { class: 'presults' }, st.mine.slice(0, 5).map(g => {
        const won = g.winner === name;
        return h('li', { class: won ? 'won' : '' },
          h('span', { class: 'res', text: won ? 'W' : 'L' }),
          h('div', { class: 'what' },
            h('b', { text: g.commanders[g.players.indexOf(name)] }),
            h('small', { text: [`#${g.number}`, niceDate(g.date), won ? 'Won' : `${g.winner} won with ${g.winningCommander}`].join(' · ') })));
      }))
      : waiting('No games yet.'));

  body.replaceChildren(bestCard, h('div', { class: 'pgrid' }, colourCard, nemesisCard), recentCard);
}

// --------------------------------------------------------------------------- status, outbox, toast

function renderStatus() {
  const s = $('#status');
  s.classList.remove('warn');
  if (!API_READY) {
    s.textContent = 'Not connected to the tracker yet: put the web app URL in config.js.';
    s.classList.add('warn'); s.hidden = false; return;
  }
  if (!online) {
    s.textContent = data ? `Offline. Using lists saved ${clockTime(data.fetchedAt)}.` : 'Offline. Connect once to load the players and decks.';
    s.classList.add('warn'); s.hidden = false; return;
  }
  if (trackerBusy) { s.textContent = 'The tracker is busy. Trying again shortly.'; s.classList.add('warn'); s.hidden = false; return; }
  if (lastError) { s.textContent = lastError; s.classList.add('warn'); s.hidden = false; return; }
  s.textContent = data ? `Up to date as of ${clockTime(data.fetchedAt)}` : 'Loading…';
  s.hidden = false;
}

function renderOutbox() {
  const box = $('#outbox');
  const waiting = outbox.filter(i => !i.error);
  const failed = outbox.filter(i => i.error);
  if (!outbox.length) { box.hidden = true; return; }
  const kids = [];
  if (waiting.length) {
    const games = waiting.filter(i => i.type === 'logGame').length;
    const decks = waiting.length - games;
    const parts = [];
    if (games) parts.push(`${games} game${games === 1 ? '' : 's'}`);
    if (decks) parts.push(`${decks} new commander${decks === 1 ? '' : 's'}`);
    kids.push(h('span', { class: 'grow', text: `${parts.join(' and ')} waiting to send.` }));
    kids.push(h('button', { type: 'button', class: 'link-btn', text: sending ? 'Sending…' : 'Send now', disabled: sending, onclick: () => flushOutbox() }));
  }
  for (const item of failed) {
    const what = item.type === 'logGame' ? `Game on ${niceDate(item.payload.game.date)}` : `New commander ${item.payload.commander}`;
    kids.push(h('div', { class: 'failed' },
      h('span', { text: `${what} wasn't saved: ${item.error}` }),
      h('button', { type: 'button', class: 'link-btn', text: 'Retry', onclick: () => { delete item.error; saveOutbox(); flushOutbox(); } }),
      h('button', { type: 'button', class: 'link-btn', text: 'Discard', onclick: () => { outbox = outbox.filter(i => i.id !== item.id); saveOutbox(); renderAll(); } })));
  }
  box.replaceChildren(...kids);
  box.hidden = false;
}

let toastTimer = null;
let toastExit = null;
function toast(msg, bad) {
  const t = $('#toast');
  const showing = !t.hidden && !toastExit;
  if (toastExit) { toastExit.cancel(); toastExit = null; }
  t.textContent = msg;
  t.classList.toggle('bad', !!bad);
  t.hidden = false;
  if (showing) play(t, [{ transform: 'translateX(-50%) scale(.96)' }, { transform: 'translateX(-50%) scale(1)' }], { duration: 160 });
  else play(t, [{ opacity: 0, transform: 'translate(-50%, 16px)' }, { opacity: 1, transform: 'translate(-50%, 0)' }], { duration: 260 });
  clearTimeout(toastTimer);
  toastTimer = setTimeout(hideToast, bad ? 6000 : 3500);
}

function hideToast() {
  const t = $('#toast');
  const exit = play(t, [{ opacity: 1, transform: 'translate(-50%, 0)' }, { opacity: 0, transform: 'translate(-50%, 10px)' }],
    { duration: 180, easing: 'ease-in', fill: 'forwards' });
  if (!exit) { t.hidden = true; return; }
  toastExit = exit;
  exit.onfinish = () => {
    if (toastExit !== exit) return;   // a new toast took over
    t.hidden = true; exit.cancel(); toastExit = null;
  };
}

function renderAll() {
  renderStatus();
  renderOutbox();
  renderForm();
  renderRecent();
  renderStandings();
  renderPlayer();
}

// --------------------------------------------------------------------------- navigation, install, start-up

let currentView = 'log';
function show(view) {
  for (const tab of $$('.tab')) tab.classList.toggle('active', tab.dataset.view === view);
  for (const sec of $$('.view')) sec.hidden = sec.id !== `view-${view}`;
  window.scrollTo(0, 0);
  if (view !== currentView) play($(`#view-${view}`), VIEW_IN);
  currentView = view;
  document.body.dataset.view = view;
  if (view === 'recent') markNewGames();
  if (view === 'player') {
    renderPlayer();
    if (API_READY && navigator.onLine && gamesStale()) loadGames();
  }
  if (view !== 'log' && online && data && isStale()) refresh({ quiet: true });
}

let installPrompt = null;
window.addEventListener('beforeinstallprompt', e => {
  e.preventDefault();
  installPrompt = e;
  $('#install').hidden = false;
});

function setup() {
  document.addEventListener('touchstart', () => {}, { passive: true });   // lets iOS show the :active press
  $$('.tab').forEach(t => t.addEventListener('click', () => show(t.dataset.view)));
  $('#refresh').addEventListener('click', async () => {
    if (currentView === 'player') loadGames();
    const done = await flushOutbox();   // sending reloads the lists itself
    if (!done.length) await refresh();
  });
  $('#player-select').addEventListener('change', e => {
    pickedPlayer = e.target.value;
    save(STORE.player, pickedPlayer);
    renderPlayer();
    play($('#player-body'), VIEW_IN);
  });
  $('#game-form').addEventListener('submit', submitGame);
  $('#date').addEventListener('change', e => { draft.date = e.target.value || todayLocal(); saveDraft(); });
  $('#notes').addEventListener('input', e => { draft.notes = e.target.value; saveDraft(); });
  $('#clear').addEventListener('click', () => {
    const bracket = draft.bracket;
    draft = blankDraft(false);
    draft.bracket = bracket;
    saveDraft(); renderForm(); window.scrollTo(0, 0);
  });
  $('#deck-form').addEventListener('submit', saveDeck);
  $('#deck-cancel').addEventListener('click', () => $('#deck-dialog').close());
  $('#card-dialog').addEventListener('click', () => $('#card-dialog').close());
  $('#deck-name').addEventListener('input', () => { clearTimeout(suggestTimer); suggestTimer = setTimeout(suggestCards, 250); });
  $('#install').addEventListener('click', async () => {
    if (!installPrompt) return;
    installPrompt.prompt();
    await installPrompt.userChoice;
    installPrompt = null;
    $('#install').hidden = true;
  });
  $$('[data-dismiss]').forEach(b => b.addEventListener('click', () => { $('#' + b.dataset.dismiss).hidden = true; save(STORE.hint, true); }));

  const standalone = window.matchMedia('(display-mode: standalone)').matches || navigator.standalone;
  const ios = /iphone|ipad|ipod/i.test(navigator.userAgent);
  if (ios && !standalone && !load(STORE.hint, false)) $('#ios-hint').hidden = false;

  window.addEventListener('online', () => { online = true; sync({ force: true }); });
  window.addEventListener('offline', () => { online = false; renderAll(); });
  // Switching back to the app reloads the lists only if they're stale: each load wakes the tracker.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    sync();
    if (currentView === 'player' && gamesStale()) loadGames();
    // Phones often resume the app instead of reopening it, so check for a new version here too.
    if ('serviceWorker' in navigator) navigator.serviceWorker.getRegistration().then(r => r && r.update()).catch(() => {});
  });
  setInterval(() => { if (outbox.some(i => !i.error)) flushOutbox(); }, 60000);

  document.body.dataset.view = currentView;
  draft.date = todayLocal();   // a fresh start is a new day's games; change the date to back-log
  pruneDraft();
  renderAll();
  if (API_READY) sync({ force: true });

  if ('serviceWorker' in navigator) {
    // When a new version of the app has just been saved to the phone, switch to it straight away.
    // The form and any waiting games are stored on the phone, so reloading loses nothing.
    const hadOldVersion = !!navigator.serviceWorker.controller;
    let reloading = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (!hadOldVersion || reloading || document.querySelector('dialog[open]')) return;
      reloading = true;
      location.reload();
    });
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
}

setup();
