'use strict';

/* Magic Lads: log commander games to the group tracker from a phone.
 *
 * Talks to the tracker's Apps Script web app (config.js). Lists are kept on the
 * phone so the form works without signal; games logged offline wait in an
 * outbox and are sent, in order, as soon as the tracker can be reached.
 */

// --------------------------------------------------------------------------- settings

const API = String(window.MAGIC_LADS_API || '').trim();
const API_READY = /^https:\/\/script\.google\.com\/macros\/s\/[^/]+\/exec$/.test(API) || /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?\//.test(API);
const SCRYFALL = 'https://api.scryfall.com';
const CARD_CACHE = 'magic-lads-cards';   // card images on the phone; sw.js keeps this cache when the app updates
const STORE = {
  data: 'ml.data.v1', outbox: 'ml.outbox.v1', draft: 'ml.draft.v1', hint: 'ml.ioshint.v1',
  cards: 'ml.cards.v2', games: 'ml.games.v1', player: 'ml.player.v1',
};
const NEW_DECK = '__new__';
const SEATS = 4;
const STALE_MS = 30000;            // lists older than this are reloaded when you come back to the app
const TRACKER_TIMEOUT_MS = 45000;  // give up on a tracker request after this
const SCRYFALL_TIMEOUT_MS = 15000;
const BUSY_RETRY_MS = 20000;       // the tracker was busy with another request: try again after this
const OUTBOX_RETRY_MS = 60000;     // anything still waiting to send is tried again this often

// --------------------------------------------------------------------------- helpers

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
  for (const kid of kids.flat(Infinity)) {
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

const DAY = { weekday: 'short', day: 'numeric', month: 'short' };
function todayLocal() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function niceDate(ymd) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(ymd || '')) return ymd || '';
  const [y, m, d] = ymd.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString(undefined, DAY);
}
/** "3:04 pm" today, "Sat 8 Nov, 3:04 pm" on another day. */
function savedTime(ms) {
  const d = new Date(ms);
  const time = d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  return d.toDateString() === new Date().toDateString() ? time : `${d.toLocaleDateString(undefined, DAY)}, ${time}`;
}

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const tidy = s => String(s || '').replace(/\s+/g, ' ').trim();
/** How names are compared: "Atraxa,  praetors' voice" is "Atraxa, Praetors' Voice". */
const nameKey = s => tidy(s).toLowerCase();
/** The commander a player played in a game. */
const cmdOf = (game, player) => game.commanders[game.players.indexOf(player)];

/** Runs `start()` for `key` unless a run for it is already going, in which case that run is shared. */
function shared(runs, key, start) {
  if (!runs.has(key)) runs.set(key, start().finally(() => runs.delete(key)));
  return runs.get(key);
}
/** Wraps an async function so its calls run one at a time, in the order they were made. */
function serial(fn) {
  let tail = Promise.resolve();
  return (...args) => {
    const run = tail.then(() => fn(...args));
    tail = run.catch(() => {});
    return run;
  };
}
function debounce(fn, ms) {
  let timer = null;
  return () => { clearTimeout(timer); timer = setTimeout(fn, ms); };
}

/** Fetches JSON, giving up after `ms` (reading the answer included). Resolves to { status, ok, json },
 *  with json undefined if the answer wasn't JSON. Rejects if no answer came back. */
async function fetchJson(url, init, ms) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    const res = await fetch(url, Object.assign({ signal: ctrl.signal }, init));
    let json;
    try { json = await res.json(); } catch (e) { if (ctrl.signal.aborted) throw e; }
    return { status: res.status, ok: res.ok, json };
  } finally {
    clearTimeout(timer);
  }
}

// --------------------------------------------------------------------------- state

let data = listsOrNull(load(STORE.data, null));   // lists from the tracker, plus fetchedAt
let outbox = load(STORE.outbox, []);       // requests waiting to be sent
let draft = loadDraft();                   // the game being filled in
let games = load(STORE.games, null);       // { list: every game, newest first, fetchedAt } or { unsupported: true, fetchedAt }
let pickedPlayer = load(STORE.player, '');
let currentView = 'log';
let online = navigator.onLine;
let lastError = '';
let sending = false;
let trackerBusy = false;

/** The tracker's lists, if they have what the app needs (an old or damaged copy is dropped). */
function listsOrNull(lists) {
  const ok = lists && ['brackets', 'players', 'decks'].every(k => Array.isArray(lists[k]));
  return ok ? lists : null;
}

function blankDraft(pod) {
  return {
    date: pod ? pod.date : todayLocal(),
    bracket: pod ? pod.bracket : '',
    players: pod ? pod.players.slice() : Array(SEATS).fill(''),
    commanders: pod ? pod.commanders.slice() : Array(SEATS).fill(''),
    winner: '',
    notes: '',
  };
}
function loadDraft() {
  // A fresh start is a new day's games; change the date to back-log.
  const d = Object.assign(blankDraft(), load(STORE.draft, {}), { date: todayLocal() });
  for (const k of ['players', 'commanders']) {
    if (!Array.isArray(d[k]) || d[k].length !== SEATS) d[k] = Array(SEATS).fill('');
  }
  return d;
}
function saveDraft() { save(STORE.draft, draft); }
function saveOutbox() { save(STORE.outbox, outbox); }

/** Shows the list's text once the tracker's lists have loaded, "Loading…" until then. */
const orLoading = text => (data ? text : 'Loading…');

/** Decks the app knows about: the tracker's, plus any added here that haven't reached it yet. */
function allDecks() {
  const decks = (data && data.decks) ? data.decks.slice() : [];
  for (const item of outbox) {
    if (item.type !== 'addDeck' || item.error) continue;
    const p = item.payload;
    if (!decks.some(d => d.player === p.player && d.bracket === p.bracket && nameKey(d.commander) === nameKey(p.commander))) {
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

async function call(url, init) {
  if (!API_READY) throw new TrackerError('The app is not connected to the tracker yet (see config.js).');
  let res;
  try {
    res = await fetchJson(url, Object.assign({ redirect: 'follow' }, init), TRACKER_TIMEOUT_MS);
  } catch (e) {
    throw new NetworkError("Couldn't reach the tracker.");
  }
  const json = res.json;
  if (!json) throw new NetworkError(`The tracker sent back something unexpected (HTTP ${res.status}).`);
  if (!json.ok) {
    if (/busy/i.test(json.error || '')) throw new BusyError(json.error);
    throw new TrackerError(json.error || 'The tracker said no.');
  }
  return json;
}
const getTracker = action => call(`${API}?action=${action}&t=${Date.now()}`, { cache: 'no-store' });
// text/plain keeps this a "simple" request, which Apps Script accepts from another site.
const postTracker = body => call(API, { method: 'POST', body: JSON.stringify(body), headers: { 'Content-Type': 'text/plain;charset=utf-8' } });

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
    try {
      do {
        refreshAgain = false;
        await loadData(opts);
      } while (refreshAgain);
    } finally {
      // Cleared in the same step as the last check of refreshAgain, so no call can slip in between.
      refreshRun = null;
      $('#refresh').classList.remove('spin');
    }
  })();
  return refreshRun;
}

async function loadData({ quiet } = {}) {
  try {
    const fresh = listsOrNull(await getTracker('data'));
    if (!fresh) throw new TrackerError("The tracker's lists came back incomplete.");
    delete fresh.ok;
    fresh.fetchedAt = Date.now();
    data = fresh;
    save(STORE.data, data);
    online = true; lastError = '';
  } catch (e) {
    if (e instanceof NetworkError) online = false;
    lastError = e.message;
    if (!quiet && !(e instanceof NetworkError)) toast(e.message, true);
  } finally {
    renderAll();
  }
}

/** Sends anything waiting, then reloads the lists if sending didn't already (and they're stale, unless `force`). */
async function sync({ force, quiet = true } = {}) {
  const done = await flushOutbox();
  if (!done.length && (force || isStale())) await refresh({ quiet });
}

/** Results of requests the app is waiting on (see send), whichever run of sendWaiting sends them. */
const outcomes = new Map();
let busyRetry = null;

/** Sends waiting requests in order, stopping at the first that can't get through so they always arrive
 *  in order. Resolves to the requests it sent. Calls made while a send is running wait their turn. */
const flushOutbox = serial(async () => {
  if (!outbox.some(i => !i.error)) return [];
  sending = true;
  trackerBusy = false;
  renderOutbox();
  const done = [];
  try {
    for (const item of outbox.slice()) {
      if (item.error) continue;
      try {
        const result = await postTracker(item.payload);
        outbox = outbox.filter(i => i.id !== item.id);
        if (outcomes.has(item.id)) outcomes.set(item.id, result);
        done.push(item);
        online = true;
      } catch (e) {
        if (e instanceof BusyError) {
          trackerBusy = true;
          clearTimeout(busyRetry);
          busyRetry = setTimeout(flushOutbox, BUSY_RETRY_MS);
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
  if (games && done.some(item => item.type === 'logGame')) {
    games.fetchedAt = 0;   // the Player tab's games are out of date now
    if (currentView === 'player') loadGames();
  }
  if (done.length) await refresh({ quiet: true });
  else renderAll();
  return done;
});

/** Queues a request for the tracker and sends it. Resolves to { id, result } if it got through,
 *  { id, error } if the tracker refused it, or just { id } if it's still waiting (no signal, busy). */
async function send(action, fields) {
  const id = uid();
  outbox.push({ id, type: action, created: Date.now(), payload: Object.assign({ action, clientId: id }, fields) });
  saveOutbox();
  outcomes.set(id, null);
  renderAll();
  await flushOutbox();
  const result = outcomes.get(id) || undefined;
  outcomes.delete(id);
  const failed = outbox.find(i => i.id === id && i.error);
  return { id, result, error: failed && failed.error };
}

function discard(id) {
  outbox = outbox.filter(i => i.id !== id);
  saveOutbox();
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

// --------------------------------------------------------------------------- log form

/** Drops picks the lists no longer allow: a player or deck that's gone, a new deck the tracker refused. */
function pruneDraft() {
  if (!data) return;
  if (!data.brackets.includes(draft.bracket)) {
    const usual = data.recent && data.recent[0] && data.recent[0].bracket;   // the group's usual bracket
    draft.bracket = data.brackets.includes(usual) ? usual : '';
  }
  draft.players = draft.players.map(p => (data.players.includes(p) ? p : ''));
  draft.commanders = draft.commanders.map((c, i) =>
    (c && decksFor(draft.players[i], draft.bracket).some(d => d.commander === c) ? c : ''));
  if (!draft.players.includes(draft.winner)) draft.winner = '';
  saveDraft();
}

function renderForm() {
  renderBrackets();
  $('#seats').replaceChildren(...draft.players.map(seatCard));
  renderWinners();

  // Only when different: setting a field's value moves the cursor, even to the same text.
  if ($('#date').value !== draft.date) $('#date').value = draft.date;
  $('#date').max = todayLocal();
  if ($('#notes').value !== draft.notes) $('#notes').value = draft.notes;

  const missing = whatsMissing();
  $('#submit').disabled = !data || missing.length > 0;
  $('#form-hint').textContent = !data ? (API_READY ? 'Loading the tracker…' : 'Not connected to the tracker yet.')
    : missing.length ? `Still to pick: ${missing.join(', ')}` : '';
}

function renderBrackets() {
  const chips = $('#brackets');
  const brackets = (data && data.brackets) || [];
  if (!brackets.length) { chips.replaceChildren(h('span', { class: 'muted small', text: 'Loading…' })); return; }
  chips.replaceChildren(...brackets.map((b, i) => h('button', {
    type: 'button', class: 'chip', role: 'radio', 'aria-checked': String(draft.bracket === b),
    'aria-label': b, text: b.replace(/^Bracket\s*/i, ''),
    onclick: () => {
      if (draft.bracket === b) return;
      draft.bracket = b; pruneDraft(); renderForm();
      play(chips.children[i], POP, { duration: 260 });
    },
  })));
}

function seatCard(player, i) {
  const players = (data && data.players) || [];
  const taken = draft.players.filter((p, j) => p && j !== i);
  const playerSel = h('select', {
    'aria-label': `Player ${i + 1}`,
    onchange: e => { draft.players[i] = e.target.value; draft.commanders[i] = ''; pruneDraft(); renderForm(); },
  },
  h('option', { value: '', text: `Player ${i + 1}…` }),
  players.map(p => h('option', { value: p, selected: p === player, disabled: taken.includes(p), text: p })));

  const ready = player && draft.bracket;
  const decks = ready ? decksFor(player, draft.bracket) : [];
  const prompt = !player ? 'Pick the player first' : !draft.bracket ? 'Pick the bracket first'
    : decks.length ? 'Commander…' : `No ${draft.bracket} decks yet`;
  const cmdSel = h('select', {
    'aria-label': `Commander ${i + 1}`, disabled: !player,
    onchange: e => {
      if (e.target.value === NEW_DECK) {
        e.target.value = draft.commanders[i];
        openDeckDialog(i);
        return;
      }
      draft.commanders[i] = e.target.value; saveDraft(); renderForm();
    },
  },
  h('option', { value: '', text: prompt }),
  decks.map(d => h('option', { value: d.commander, selected: d.commander === draft.commanders[i], text: d.pending ? `${d.commander} (adding…)` : d.commander })),
  ready ? h('option', { value: NEW_DECK, text: '＋ New commander…' }) : null);

  return h('div', { class: 'card seat' },
    h('div', { class: 'seat-head' }, h('span', { class: 'seat-no', text: String(i + 1) }), playerSel),
    cmdSel,
    cardArt(player ? draft.commanders[i] : '', `seat:${i}`, 'seat-art'));
}

function renderWinners() {
  const winners = $('#winners');
  const chosen = draft.players.map((p, i) => ({ p, c: draft.commanders[i] })).filter(x => x.p);
  if (!chosen.length) { winners.replaceChildren(h('p', { class: 'muted small', text: 'Pick the players first.' })); return; }
  winners.replaceChildren(...chosen.map(({ p, c }, i) => h('button', {
    type: 'button', class: 'win', role: 'radio', 'aria-checked': String(draft.winner === p),
    onclick: () => {
      draft.winner = draft.winner === p ? '' : p; saveDraft(); renderForm();
      if (draft.winner === p) play(winners.children[i], POP, { duration: 300 });
    },
  }, h('b', { text: p }), h('small', { text: c || 'commander not picked' }))));
}

function whatsMissing() {
  const out = [];
  if (!draft.bracket) out.push('bracket');
  const players = SEATS - draft.players.filter(Boolean).length;
  if (players) out.push(plural(players, 'player'));
  const commanders = draft.players.filter((p, i) => p && !draft.commanders[i]).length;
  if (commanders) out.push(plural(commanders, 'commander'));
  if (!draft.winner) out.push('winner');
  return out;
}

async function submitGame(ev) {
  ev.preventDefault();
  if (!data || whatsMissing().length) return;
  const game = {
    date: draft.date || todayLocal(),
    bracket: draft.bracket,
    players: draft.players.slice(),
    commanders: draft.commanders.slice(),
    winner: draft.winner,
    notes: draft.notes.trim(),
  };
  // Same pod next game: keep the date, bracket, players and commanders; clear the result.
  draft = blankDraft(draft);
  saveDraft();

  const btn = $('#submit');
  btn.textContent = 'Logging…';
  btn.classList.add('busy');
  const sent = await send('logGame', { game });
  btn.textContent = 'Log game';
  btn.classList.remove('busy');

  if (sent.result) {
    const r = sent.result;
    const what = r.number ? `Game ${r.number}` : 'Game';
    if (r.duplicate) toast('Already logged.');
    else if (r.status && r.status !== 'OK') toast(`${what} logged, but the tracker flags it: ${r.status}`, true);
    else toast(`${what} logged. ${game.winner} wins! 🏆`);
  } else if (sent.error) {
    // The tracker refused it while you're still here: put the game back in the form to fix.
    discard(sent.id);
    Object.assign(draft, game);
    renderAll();
    toast(sent.error, true);
  } else {
    toast(trackerBusy ? 'The tracker is busy. Your game is saved and will be sent in a moment.'
      : 'Saved on this phone. It will be sent when you have signal.');
  }
}

// --------------------------------------------------------------------------- new commander

let deckSeat = null;   // the seat the dialog was opened from

function openDeckDialog(seat) {
  deckSeat = seat;
  const players = (data && data.players) || [];
  const brackets = (data && (data.deckBrackets || data.brackets)) || [];
  $('#deck-player').replaceChildren(...players.map(p => h('option', { value: p, selected: p === draft.players[seat], text: p })));
  $('#deck-bracket').replaceChildren(...brackets.map(b => h('option', { value: b, selected: b === draft.bracket, text: b })));
  $('#deck-name').value = '';
  deckError('');
  $('#card-suggestions').replaceChildren();
  $('#deck-dialog').showModal();
  setTimeout(() => $('#deck-name').focus(), 50);
}

function deckError(text) {
  $('#deck-error').textContent = text;
  $('#deck-error').hidden = !text;
}

async function suggestCards() {
  const q = $('#deck-name').value.trim();
  if (q.length < 2 || !navigator.onLine) return;
  try {
    const res = await fetchJson(`${SCRYFALL}/cards/autocomplete?q=${encodeURIComponent(q)}`, { headers: { Accept: 'application/json' } }, SCRYFALL_TIMEOUT_MS);
    if (!res.ok || !res.json || $('#deck-name').value.trim() !== q) return;   // typed on since: a newer list is coming
    $('#card-suggestions').replaceChildren(...(res.json.data || []).slice(0, 12).map(name => h('option', { value: name })));
  } catch (e) { /* suggestions are a nice-to-have */ }
}

async function saveDeck(ev) {
  ev.preventDefault();
  const seat = deckSeat;
  const player = $('#deck-player').value;
  const bracket = $('#deck-bracket').value;
  const commander = tidy($('#deck-name').value);
  if (!commander) { deckError("Type the commander's name."); return; }
  // The new deck goes on the seat it was added from, if that seat still has this player and bracket.
  const seatFits = () => seat !== null && draft.players[seat] === player && draft.bracket === bracket;
  const forSeat = seatFits();
  const pick = name => { draft.commanders[seat] = name; saveDraft(); };
  const existing = decksFor(player, bracket).find(d => nameKey(d.commander) === nameKey(commander));
  $('#deck-dialog').close();
  if (existing) {
    if (forSeat) pick(existing.commander);
    renderAll();
    toast(`${existing.commander} is already on the Decks sheet.`);
    return;
  }

  if (forSeat) pick(commander);
  const sent = await send('addDeck', { player, bracket, commander });
  if (sent.result) {
    // The Decks sheet may already have it under different capitals: use its spelling.
    const name = sent.result.commander || commander;
    if (forSeat && name !== commander && seatFits() && [commander, ''].includes(draft.commanders[seat])) {
      pick(name);
      renderForm();
    }
    toast(sent.result.existing ? `${name} is already on the Decks sheet.` : `${name} added to ${player}'s decks.`);
  } else if (sent.error) {
    toast(sent.error, true);
  } else {
    toast(`${commander} saved on this phone. It will be added when you have signal.`);
  }
}

// --------------------------------------------------------------------------- commander card images
//
// Each commander is looked up on Scryfall once. Which card it is (and its image address) is kept
// in localStorage, and the image itself in the phone's Cache Storage, so from then on it shows
// straight from the phone, without signal too, and Scryfall is never asked for it again.

const SCRYFALL_GAP_MS = 550;              // Scryfall allows 2 card lookups a second
const SCRYFALL_BATCH = 75;                // names per /cards/collection request (Scryfall's maximum)
const RETRY_FAILED_MS = 60000;            // after a failed lookup (no signal, Scryfall down), wait before asking again
const RECHECK_MISS_MS = 7 * 86400000;     // a name Scryfall didn't know is asked about again after a week
const RECHECK_LOWRES_MS = 3 * 86400000;   // a card with only a preview scan (new sets) is checked for a proper one
const WUBRG = ['W', 'U', 'B', 'R', 'G'];

const cardInfo = load(STORE.cards, {});   // nameKey(commander) -> { cards: [{name, img}], colors, at, lowres? } or { miss: true, at }
try { localStorage.removeItem('ml.cards.v1'); } catch (e) { /* v1 picked the standard printing for "Alt name (Real name)" commanders */ }
const saveCardInfo = debounce(() => save(STORE.cards, cardInfo), 0);   // lookups that finish together are saved in one go
const cardLookups = new Map();            // key -> Promise, while it's being looked up
const lookupFailed = new Map();           // key -> when its last lookup failed
const imageUrls = new Map();              // image address -> blob: URL of the copy stored on the phone
const imageLoads = new Map();             // image address -> Promise, while it's being fetched or read
const artSlots = new Map();               // where an image is shown -> its element, reused so re-drawing doesn't flicker

function recheckDue(entry) {
  if (!entry.miss && !entry.colors) return true;   // looked up before colours were kept (for the Player tab)
  const age = Date.now() - (entry.at || 0);
  return entry.miss ? age > RECHECK_MISS_MS : !!entry.lowres && age > RECHECK_LOWRES_MS;
}

/** Whether Scryfall can be asked about a commander now: there's signal and it hasn't just failed. */
function canLookUp(key) {
  return navigator.onLine && Date.now() - (lookupFailed.get(key) || 0) >= RETRY_FAILED_MS;
}

/** One request to Scryfall's API (a POST when `body` is given), queued so they're spaced out.
 *  Resolves to null when Scryfall has no match. */
let scryfallNext = 0;
const scryfall = serial(async (path, body) => {
  const wait = scryfallNext - Date.now();
  if (wait > 0) await new Promise(r => setTimeout(r, wait));
  scryfallNext = Date.now() + SCRYFALL_GAP_MS;
  const res = await fetchJson(SCRYFALL + path, body
    ? { method: 'POST', headers: { Accept: 'application/json', 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
    : { headers: { Accept: 'application/json' } }, SCRYFALL_TIMEOUT_MS);
  if (res.status === 404) return null;
  if (res.status === 429) scryfallNext = Date.now() + 10000;   // told to slow down: back off for a while
  if (!res.ok || !res.json) throw new Error(`Scryfall said ${res.status}`);
  return res.json;
});

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
      if (!found.every(Boolean)) continue;
      // Both halves of "A // B" can find the same double-faced card: show it once.
      const cards = found.filter((c, i) => found.findIndex(d => d.img === c.img) === i);
      const ci = new Set(cards.flatMap(c => c.ci));
      return { cards: cards.map(c => ({ name: c.name, img: c.img })), colors: WUBRG.filter(c => ci.has(c)),
        lowres: cards.some(c => c.lowres) || undefined, at: Date.now() };
    }
  }
  return null;
}

/** Looks a commander up on Scryfall and saves the answer. Resolves to what's known if it can't. */
function lookupCommander(name) {
  const key = nameKey(name);
  const known = cardInfo[key] || null;
  if (!cardLookups.has(key) && !canLookUp(key)) return Promise.resolve(known);
  return shared(cardLookups, key, () => findCards(tidy(name)).then(entry => {
    cardInfo[key] = entry;
    saveCardInfo();
    return entry;
  }, () => {
    lookupFailed.set(key, Date.now());
    return known;
  }));
}

/** The phone's copy of an image (a card or a mana symbol), as a URL an <img> can show.
 *  Fetched and stored the first time. */
function storedImage(url) {
  if (imageUrls.has(url)) return Promise.resolve(imageUrls.get(url));
  return shared(imageLoads, url, async () => {
    try {
      const src = URL.createObjectURL(await (await cachedImage(url)).blob());
      imageUrls.set(url, src);
      return src;
    } catch (e) {
      return url;   // couldn't fetch or store it: let the browser try the address itself (tried again next time)
    }
  });
}
async function cachedImage(url) {
  let cache = null;
  try { if (window.caches) cache = await caches.open(CARD_CACHE); } catch (e) { /* storage blocked: just show it */ }
  const stored = cache && await cache.match(url);
  if (stored) return stored;
  const res = await fetch(url, { mode: 'cors' });
  if (!res.ok) throw new Error(`Image ${res.status}`);
  if (cache) await cache.put(url, res.clone()).catch(() => {});
  return res;
}
/** An <img> showing the phone's copy of an image: straight away if it's been read already. */
function storedImg(url, attrs) {
  const ready = imageUrls.get(url);
  const img = h('img', Object.assign({ src: ready }, attrs));
  if (!ready) storedImage(url).then(src => { img.src = src; });
  return img;
}

/** The card image box for a commander. `slot` names where it's shown, so re-drawing reuses the same box. */
function cardArt(name, slot, cls) {
  const key = nameKey(name);
  const old = artSlots.get(slot);
  if (old && old.dataset.card === key) { updateArt(old, name); return old; }
  const box = h('button', { type: 'button', class: `card-art ${cls}` });
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
  const key = nameKey(name);
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
  box.disabled = !cards;   // also takes it out of the tab order
  if (cards) box.removeAttribute('aria-hidden'); else box.setAttribute('aria-hidden', 'true');
  if (entry && entry.miss) box.title = 'No card image found on Scryfall'; else box.removeAttribute('title');
  if (!cards) {
    box.classList.remove('loading');
    box.replaceChildren();
    return;
  }
  box.setAttribute('aria-label', `Show ${cards.map(c => c.name).join(' and ')}`);
  box.onclick = () => openCardView(cards);

  const settle = () => box.classList.toggle('loading', !!box.querySelector('img:not(.shown)'));
  box.replaceChildren(...cards.map(c => {
    const img = storedImg(c.img, { alt: '', draggable: 'false', class: imageUrls.has(c.img) ? 'shown' : null });
    img.addEventListener('load', () => { img.classList.add('shown'); settle(); });
    img.addEventListener('error', () => { box._broken = true; img.remove(); settle(); });
    return img;
  }));
  settle();
}

/** Shows a commander's card(s) big. Tap anywhere to close. */
function openCardView(cards) {
  const wrap = $('#card-view-imgs');
  wrap.classList.toggle('pair', cards.length > 1);
  wrap.replaceChildren(...cards.map(c => storedImg(c.img, { alt: c.name })));
  $('#card-dialog').showModal();
}

// --------------------------------------------------------------------------- recent games

/** A game in Recent: number, date and status on top, then the winner and pod beside the winning commander's card. */
function gameCard(key, top, g) {
  return h('article', { class: top.pending ? 'game pending' : 'game', 'data-key': key },
    h('div', { class: 'game-top' },
      h('span', { class: 'no', text: top.no }),
      h('span', { class: 'meta', text: top.meta }),
      h('span', { class: `badge ${top.badge[0]}`, text: top.badge[1] })),
    h('div', { class: 'game-body' },
      h('div', { class: 'game-main' },
        g.winner ? h('div', { class: 'game-winner' }, `🏆 ${g.winner}`, h('small', { text: g.winningCommander })) : null,
        h('ul', { class: 'pod' }, g.players.map((p, i) =>
          h('li', { class: p === g.winner ? 'won' : null }, h('b', { text: p }), h('span', { text: g.commanders[i] || '' }))))),
      g.winner && g.winningCommander ? cardArt(g.winningCommander, key, 'game-art') : null),
    g.notes ? h('div', { class: 'game-notes', text: g.notes }) : null,
    top.error ? h('div', { class: 'game-notes error', text: top.error }) : null);
}

function renderRecent() {
  const pending = outbox.filter(i => i.type === 'logGame').map(item => {
    const g = item.payload.game;
    return gameCard('p:' + item.id, {
      pending: true, no: 'New', meta: `${niceDate(g.date)} · ${g.bracket}`, error: item.error,
      badge: item.error ? ['bad', 'Not sent'] : ['wait', 'Waiting to send'],
    }, Object.assign({ winningCommander: cmdOf(g, g.winner) }, g));
  });
  const logged = ((data && data.recent) || []).map(g => gameCard(['g', g.number, g.date, g.winner].concat(g.players).join('|'), {
    no: g.number ? `#${g.number}` : '—',
    meta: [niceDate(g.date), g.bracket].filter(Boolean).join(' · '),
    badge: [g.status === 'OK' ? 'ok' : 'bad', g.status || 'Incomplete'],
  }, g));
  const items = pending.concat(logged);
  $('#recent-list').replaceChildren(...(items.length ? items : [h('p', { class: 'empty', text: orLoading('No games logged yet.') })]));
  if (data) markNewGames();
}

let seenGames = null;   // the games Recent has already shown, so only new arrivals light up
/** Lights up games that weren't there last time Recent was on screen. Called again when Recent is opened. */
function markNewGames() {
  const cards = $$('#recent-list article[data-key]');
  const keys = new Set(cards.map(c => c.dataset.key));
  if (!seenGames) { seenGames = keys; return; }    // the first lists loaded are the starting point
  if (currentView !== 'recent') return;           // wait until Recent is opened
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
  $('#lb-note').textContent = caption(lb);
  $('#lb-table tbody').replaceChildren(...(lb && lb.rows.length ? lb.rows.map(r => {
    const idle = !Number(r.Games);
    return h('tr', { class: idle ? 'idle' : null },
      h('td', { class: 'rank', text: r.Rank }),
      h('td', { class: 'player' }, h('b', { text: r.Player }), !idle && r['Best Commander'] ? h('small', { text: `Best: ${r['Best Commander']}` }) : null),
      h('td', { class: 'num', text: idle ? '–' : `${r.Wins}/${r.Games}` }),
      h('td', { class: 'num', text: r['Win %'] || '–' }),
      h('td', { class: 'num adj', text: r['Adj. Win %'] || '–' }));
  }) : [h('tr', {}, h('td', { colspan: 5, class: 'empty', text: orLoading('No games yet.') }))]));

  const td = data && data.topDecks;
  const rows = (td && td.rows) || [];
  $('#td-note').textContent = caption(td);
  $('#td-list').replaceChildren(...(rows.length ? rows.map(r => h('div', { class: 'deck' },
    h('div', { class: 'rank', text: r.Rank }),
    h('div', { class: 'info' }, h('b', { text: r.Commander }), h('small', { text: `${r.Player} · ${r.Bracket} · ${r.Wins}/${r.Games} wins` })),
    h('div', { class: 'score' }, h('b', { class: 'adj', text: r['Adj. Win %'] }), h('small', { text: `win ${r['Win %']}` }))))
    : [h('p', { class: 'empty', text: orLoading('No decks have enough games yet.') })]));
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

function gamesStale() { return !games || Date.now() - games.fetchedAt > STALE_MS; }

/** Loads every game from the tracker (its own request: the Player tab is the only thing that needs them). */
const gameLoads = new Map();
function loadGames() {
  return shared(gameLoads, 'games', async () => {
    try {
      games = { list: (await getTracker('games')).games || [], fetchedAt: Date.now() };
      save(STORE.games, games);
    } catch (e) {
      // The tracker's Apps Script is older than the Player tab: say so, and ask again later in case it's updated.
      // Anything else (no signal, busy) keeps the games saved on the phone.
      if (e instanceof TrackerError && /unknown request/i.test(e.message)) {
        games = { unsupported: true, fetchedAt: Date.now() };
        save(STORE.games, games);
      }
    } finally {
      renderPlayer();
    }
  });
}
function loadGamesIfStale() {
  if (API_READY && navigator.onLine && gamesStale()) loadGames();
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
  const add = (tally, key) => { tally[key] = (tally[key] || 0) + 1; };
  for (const g of mine) {
    const cmd = cmdOf(g, name);
    const e = cardInfo[nameKey(cmd)];
    if (e && e.colors) (e.colors.length ? e.colors : ['C']).forEach(c => add(counts, c));
    else if (cmd && !(e && e.miss)) unknown.add(cmd);
    g.players.forEach(p => { if (p && p !== name) add(together, p); });
    if (g.winner && g.winner !== name) {
      add(beats, g.winner);
      const by = beatWith[g.winner] || (beatWith[g.winner] = {});
      if (g.winningCommander) add(by, g.winningCommander);
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
  if (nemesis) nemesis.with = Object.entries(beatWith[nemesis.name] || {}).sort((a, b) => b[1] - a[1])[0] || null;
  return { mine, colours, unknown: Array.from(unknown), nemesis };
}

/** Looks up the colours of commanders not looked up yet (one batched request), then re-draws.
 *  Returns true while a lookup is running, so the colours aren't shown half counted. A name whose
 *  lookup fails (no signal, Scryfall down) isn't waited on again for a while (RETRY_FAILED_MS). */
let colourLookups = false;
function lookUpColours(names) {
  if (colourLookups) return true;
  const todo = names.filter(n => canLookUp(nameKey(n)));
  if (!todo.length) return false;
  colourLookups = true;
  Promise.all(todo.map(n => lookupCommander(n))).then(() => {
    colourLookups = false;
    renderPlayer();
  });
  return true;
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
  if (currentView !== 'player') return;   // drawn when the tab is opened
  const players = (data && data.players) || [];
  const lb = data && data.leaderboard;
  const rows = (lb && lb.rows) || [];
  const ranked = rows.filter(r => Number(r.Games) > 0);
  // Until the players have loaded, keep the saved choice rather than replacing it.
  if (players.length && !players.includes(pickedPlayer)) pickedPlayer = (ranked[0] && ranked[0].Player) || players[0];

  const sel = $('#player-select');
  sel.replaceChildren(...(players.length ? players.map(p => h('option', { value: p, selected: p === pickedPlayer, text: p }))
    : [h('option', { text: orLoading('No players yet') })]));
  sel.disabled = !players.length;

  const name = players.length ? pickedPlayer : '';
  if (!name) {
    for (const id of ['#player-rank', '#player-place', '#player-note']) $(id).textContent = '';
    $('#player-rank').classList.remove('medal');
    $('#player-stats').replaceChildren();
    $('#player-body').replaceChildren();
    setWash(null);
    return;
  }

  // Leaderboard: place, adjusted win %, record (`row` only once they've played).
  const row = ranked.find(r => r.Player === name) || null;
  const place = row ? placeOf(row, ranked.indexOf(row)) : 0;
  $('#player-rank').textContent = place ? (MEDALS[place] || `#${place}`) : '–';
  $('#player-rank').classList.toggle('medal', !!MEDALS[place]);
  $('#player-place').textContent = place ? `${ordinal(place)} of ${ranked.length} on the leaderboard` : 'Not on the leaderboard yet';
  const wins = row ? Number(row.Wins) : 0;
  const played = row ? Number(row.Games) : 0;
  const stat = (label, value, sub, cls) =>
    h('div', { class: 'pstat' }, h('span', { class: 'label', text: label }), h('b', { class: cls, text: value }), h('small', { text: sub }));
  $('#player-stats').replaceChildren(
    stat('Adj. win %', row ? row['Adj. Win %'] : '–', row ? `win ${row['Win %']}` : 'no games yet', 'adj'),
    stat('Record', row ? `${wins}–${played - wins}` : '–', row ? `${plural(wins, 'win')} · ${plural(played, 'game')}` : ''));
  $('#player-note').textContent = caption(lb);

  const st = playerStats(name);
  const lookingUp = !!st && lookUpColours(st.unknown);
  const note = text => h('p', { class: 'muted small', text });
  const notLoaded = () => note(games && games.unsupported ? "Update the tracker's Apps Script to see this (see the README)."
    : navigator.onLine ? 'Loading games…' : 'Connect once to load the games.');
  const panel = (cls, label, ...content) => h('div', { class: `card ${cls}` }, h('span', { class: 'label', text: label }), ...content);

  // Best commander, with its card.
  const best = row ? row['Best Commander'] : '';
  const bestGames = st && best ? st.mine.filter(g => cmdOf(g, name) === best) : [];
  const bestWins = bestGames.filter(g => g.winner === name).length;
  const bestCard = h('div', { class: 'card player-best' },
    best ? cardArt(best, 'player:best', 'best-art') : h('div', { class: 'card-art best-art', 'aria-hidden': 'true' }),
    h('div', { class: 'info' },
      h('span', { class: 'label', text: 'Best commander' }),
      h('b', { text: best || 'None yet' }),
      bestGames.length ? h('small', { text: `Won ${bestWins} of ${plural(bestGames.length, 'game')}` }) : null));

  // Most played colours, with mana symbols. The page takes on the top one.
  const colourCard = panel('player-colours', 'Most played colours',
    !st ? notLoaded()
      : lookingUp ? note('Looking up commanders…')
      : st.colours.length ? [
        st.colours.map(({ c, n }) => h('div', { class: 'mana-row' },
          storedImg(manaUrl(c), { class: 'mana', alt: '' }),
          h('div', {}, h('b', { text: COLOURS[c] }), h('small', { text: `${n} of ${plural(st.mine.length, 'game')}` })))),
        st.unknown.length ? h('small', { class: 'colour-note', text: `${plural(st.unknown.length, 'commander')} not looked up yet` }) : null]
      : note(st.mine.length ? "Couldn't look up their commanders yet." : 'No games yet.'));
  setWash(st && !lookingUp && st.colours[0] ? st.colours[0].c : null);

  const nem = st && st.nemesis;
  const nemesisCard = panel('player-nemesis', 'Nemesis',
    !st ? notLoaded()
      : nem ? [h('b', { class: 'nemesis-name', text: nem.name }),
        h('small', { text: `Won ${nem.wins} of ${plural(nem.games, 'game')} against ${name}` }),
        nem.with ? h('small', { class: 'muted', text: `${nem.with[1] === nem.wins ? 'With' : 'Mostly with'} ${nem.with[0]}` }) : null]
      : note(st.mine.length ? 'Unbeaten so far.' : 'No games yet.'));

  const recentCard = panel('player-recent', 'Recent games',
    !st ? notLoaded()
      : st.mine.length ? h('ul', { class: 'presults' }, st.mine.slice(0, 5).map(g => {
        const won = g.winner === name;
        return h('li', { class: won ? 'won' : null },
          h('span', { class: 'res', text: won ? 'W' : 'L' }),
          h('div', { class: 'what' },
            h('b', { text: cmdOf(g, name) }),
            h('small', { text: [`#${g.number}`, niceDate(g.date), won ? 'Won' : `${g.winner} won with ${g.winningCommander}`].join(' · ') })));
      }))
      : note('No games yet.'));

  $('#player-body').replaceChildren(bestCard, h('div', { class: 'pgrid' }, colourCard, nemesisCard), recentCard);
}

// --------------------------------------------------------------------------- status, outbox, toast

function renderStatus() {
  const [text, warn] = !API_READY ? ['Not connected to the tracker yet: put the web app URL in config.js.', true]
    : !online ? [data ? `Offline. Using lists saved ${savedTime(data.fetchedAt)}.` : 'Offline. Connect once to load the players and decks.', true]
    : trackerBusy ? ['The tracker is busy. Trying again shortly.', true]
    : lastError ? [lastError, true]
    : [data ? `Up to date as of ${savedTime(data.fetchedAt)}` : 'Loading…', false];
  const s = $('#status');
  s.textContent = text;
  s.classList.toggle('warn', warn);
  s.hidden = false;
}

function renderOutbox() {
  const box = $('#outbox');
  box.hidden = !outbox.length;
  if (!outbox.length) return;
  const kids = [];
  const waiting = outbox.filter(i => !i.error);
  if (waiting.length) {
    const nGames = waiting.filter(i => i.type === 'logGame').length;
    const nDecks = waiting.length - nGames;
    const what = [nGames && plural(nGames, 'game'), nDecks && plural(nDecks, 'new commander')].filter(Boolean).join(' and ');
    kids.push(
      h('span', { class: 'grow', text: `${what} waiting to send.` }),
      h('button', { type: 'button', class: 'link-btn', text: sending ? 'Sending…' : 'Send now', disabled: sending, onclick: () => flushOutbox() }));
  }
  for (const item of outbox.filter(i => i.error)) {
    const what = item.type === 'logGame' ? `Game on ${niceDate(item.payload.game.date)}` : `New commander ${item.payload.commander}`;
    kids.push(h('div', { class: 'failed' },
      h('span', { text: `${what} wasn't saved: ${item.error}` }),
      h('button', { type: 'button', class: 'link-btn', text: 'Retry', onclick: () => { delete item.error; saveOutbox(); renderOutbox(); flushOutbox(); } }),
      h('button', { type: 'button', class: 'link-btn', text: 'Discard', onclick: () => { discard(item.id); renderAll(); } })));
  }
  box.replaceChildren(...kids);
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

/** Re-draws everything after the lists or the outbox change. */
function renderAll() {
  pruneDraft();
  renderStatus();
  renderOutbox();
  renderForm();
  renderRecent();
  renderStandings();
  renderPlayer();
}

// --------------------------------------------------------------------------- navigation, install, start-up

function show(view) {
  const changed = view !== currentView;
  currentView = view;
  document.body.dataset.view = view;
  for (const tab of $$('.tab')) tab.classList.toggle('active', tab.dataset.view === view);
  for (const sec of $$('.view')) sec.hidden = sec.id !== `view-${view}`;
  window.scrollTo(0, 0);
  if (changed) play($(`#view-${view}`), VIEW_IN);
  if (view === 'recent') markNewGames();
  if (view === 'player') { renderPlayer(); loadGamesIfStale(); }
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
  $('#refresh').addEventListener('click', () => {
    if (currentView === 'player') loadGames();
    sync({ force: true, quiet: false });
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
    draft = Object.assign(blankDraft(), { bracket: draft.bracket });
    saveDraft(); renderForm(); window.scrollTo(0, 0);
  });
  $('#deck-form').addEventListener('submit', saveDeck);
  $('#deck-cancel').addEventListener('click', () => $('#deck-dialog').close());
  $('#deck-name').addEventListener('input', debounce(suggestCards, 250));
  $('#card-dialog').addEventListener('click', () => $('#card-dialog').close());
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
    if (currentView === 'player') loadGamesIfStale();
    // Phones often resume the app instead of reopening it, so check for a new version here too.
    if ('serviceWorker' in navigator) navigator.serviceWorker.getRegistration().then(r => r && r.update()).catch(() => {});
  });
  setInterval(() => { if (navigator.onLine && outbox.some(i => !i.error)) flushOutbox(); }, OUTBOX_RETRY_MS);

  document.body.dataset.view = currentView;
  renderAll();
  if (API_READY) sync({ force: true });
  registerServiceWorker();
}

function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
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

setup();
