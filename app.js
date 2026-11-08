'use strict';

/* Magic Lads: log commander games to the group tracker from a phone.
 *
 * Talks to the tracker's Apps Script web app (config.js). Lists are kept on the
 * phone so the form works without signal; games logged offline wait in an
 * outbox and are sent, in order, as soon as the tracker can be reached.
 */

const API = String(window.MAGIC_LADS_API || '').trim();
const API_READY = /^https:\/\/script\.google\.com\/macros\/s\/[^/]+\/exec$/.test(API) || /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?\//.test(API);
const STORE = { data: 'ml.data.v1', outbox: 'ml.outbox.v1', draft: 'ml.draft.v1', hint: 'ml.ioshint.v1' };
const NEW_DECK = '__new__';
const SEATS = 4;

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
let refreshing = false;

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

async function call(method, body) {
  if (!API_READY) throw new TrackerError('The app is not connected to the tracker yet (see config.js).');
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 45000);
  let res;
  try {
    const url = method === 'GET' ? `${API}?action=data&t=${Date.now()}` : API;
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
    if (json.retry || /busy/i.test(json.error || '')) throw new BusyError(json.error);
    throw new TrackerError(json.error || 'The tracker said no.');
  }
  return json;
}

async function refresh({ quiet } = {}) {
  if (refreshing) return;
  refreshing = true;
  $('#refresh').classList.add('spin');
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
    refreshing = false;
    $('#refresh').classList.remove('spin');
    renderAll();
  }
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

function renderForm() {
  const brackets = (data && data.brackets) || [];
  const players = (data && data.players) || [];

  $('#date').value = draft.date;
  $('#date').max = todayLocal();

  const chips = $('#brackets');
  chips.replaceChildren(...brackets.map(b => h('button', {
    type: 'button', class: 'chip', role: 'radio', 'aria-checked': String(draft.bracket === b),
    'aria-label': b, text: b.replace(/^Bracket\s*/i, ''),
    onclick: () => { draft.bracket = b; pruneDraft(); renderForm(); },
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
      cmdSel);
  }));

  const winners = $('#winners');
  const chosen = draft.players.map((p, i) => ({ p, c: draft.commanders[i] })).filter(x => x.p);
  if (!chosen.length) {
    winners.replaceChildren(h('p', { class: 'muted small', text: 'Pick the players first.' }));
  } else {
    winners.replaceChildren(...chosen.map(({ p, c }) => h('button', {
      type: 'button', class: 'win', role: 'radio', 'aria-checked': String(draft.winner === p),
      onclick: () => { draft.winner = draft.winner === p ? '' : p; saveDraft(); renderForm(); },
    }, h('b', { text: p }), h('small', { text: c || 'commander not picked' }))));
  }

  $('#notes').value = draft.notes;

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
  const done = await flushOutbox();
  $('#submit').textContent = 'Log game';
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
  const player = $('#deck-player').value;
  const bracket = $('#deck-bracket').value;
  const commander = $('#deck-name').value.replace(/\s+/g, ' ').trim();
  const err = $('#deck-error');
  if (!commander) { err.textContent = "Type the commander's name."; err.hidden = false; return; }
  const existing = decksFor(player, bracket).find(d => d.commander.toLowerCase() === commander.toLowerCase());
  if (!existing) {
    const id = uid();
    outbox.push({ id, type: 'addDeck', created: Date.now(), payload: { action: 'addDeck', clientId: id, player, bracket, commander } });
    saveOutbox();
  }
  if (deckSeat !== null && player === draft.players[deckSeat] && bracket === draft.bracket) {
    draft.commanders[deckSeat] = existing ? existing.commander : commander;
    saveDraft();
  }
  $('#deck-dialog').close();
  renderAll();
  if (existing) { toast(`${existing.commander} is already on the Decks sheet.`); return; }
  const done = await flushOutbox();
  const failed = outbox.find(i => i.type === 'addDeck' && i.error && i.payload.commander === commander);
  if (done.some(d => d.item.type === 'addDeck' && d.item.payload.commander === commander)) toast(`${commander} added to ${player}'s decks.`);
  else if (failed) toast(failed.error, true);
  else toast(`${commander} saved on this phone. It will be added when you have signal.`);
}

// --------------------------------------------------------------------------- recent games

function podList(players, commanders, winner) {
  return h('ul', { class: 'pod' }, players.map((p, i) =>
    h('li', { class: p === winner ? 'won' : '' }, h('b', { text: p }), h('span', { text: commanders[i] || '' }))));
}

function renderRecent() {
  const list = $('#recent-list');
  const items = [];

  for (const item of outbox.filter(i => i.type === 'logGame')) {
    const g = item.payload.game;
    items.push(h('article', { class: 'game pending' },
      h('div', { class: 'game-top' },
        h('span', { class: 'no', text: 'New' }),
        h('span', { class: 'meta', text: `${niceDate(g.date)} · ${g.bracket}` }),
        h('span', { class: `badge ${item.error ? 'bad' : 'wait'}`, text: item.error ? 'Not sent' : 'Waiting to send' })),
      h('div', { class: 'game-winner' }, `🏆 ${g.winner}`, h('small', { text: g.commanders[g.players.indexOf(g.winner)] })),
      podList(g.players, g.commanders, g.winner),
      g.notes ? h('div', { class: 'game-notes', text: g.notes }) : null,
      item.error ? h('div', { class: 'game-notes error', text: item.error }) : null));
  }

  for (const g of (data && data.recent) || []) {
    items.push(h('article', { class: 'game' },
      h('div', { class: 'game-top' },
        h('span', { class: 'no', text: g.number ? `#${g.number}` : '—' }),
        h('span', { class: 'meta', text: [niceDate(g.date), g.bracket].filter(Boolean).join(' · ') }),
        h('span', { class: `badge ${g.status === 'OK' ? 'ok' : 'bad'}`, text: g.status || 'Incomplete' })),
      g.winner ? h('div', { class: 'game-winner' }, `🏆 ${g.winner}`, h('small', { text: g.winningCommander })) : null,
      podList(g.players, g.commanders, g.winner),
      g.notes ? h('div', { class: 'game-notes', text: g.notes }) : null,
      h('div', { class: 'game-actions' },
        h('button', { type: 'button', class: 'link-btn', text: 'Delete', onclick: () => confirmDelete(g) }))));
  }

  list.replaceChildren(...(items.length ? items : [h('p', { class: 'empty', text: data ? 'No games logged yet.' : 'Loading…' })]));
}

async function confirmDelete(g) {
  const dlg = $('#confirm-dialog');
  $('#confirm-title').textContent = `Delete game ${g.number ? '#' + g.number : ''}?`;
  $('#confirm-text').textContent = `${niceDate(g.date)}: ${g.players.join(', ')}. ${g.winner ? g.winner + ' won. ' : ''}This removes it from the tracker for everyone.`;
  dlg.returnValue = '';
  dlg.showModal();
  const answer = await new Promise(res => dlg.addEventListener('close', () => res(dlg.returnValue), { once: true }));
  if (answer !== 'ok') return;
  try {
    await call('POST', { action: 'deleteGame', row: g.row, key: g.key });
    toast(`Game ${g.number ? '#' + g.number + ' ' : ''}deleted.`);
    await refresh({ quiet: true });
  } catch (e) {
    toast(e instanceof BusyError ? 'The tracker is busy. Try again in a moment.' : e instanceof NetworkError ? 'You need signal to delete a game.' : e.message, true);
    if (!(e instanceof NetworkError)) refresh({ quiet: true });
  }
}

// --------------------------------------------------------------------------- standings

function renderStandings() {
  const lb = data && data.leaderboard;
  const body = $('#lb-table tbody');
  $('#lb-note').textContent = lb ? lb.note : '';
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
  $('#td-note').textContent = td ? td.note : '';
  const rows = (td && td.rows) || [];
  $('#td-list').replaceChildren(...(rows.length ? rows.map(r => h('div', { class: 'deck' },
    h('div', { class: 'rank', text: r.Rank }),
    h('div', { class: 'info' }, h('b', { text: r.Commander }), h('small', { text: `${r.Player} · ${r.Bracket} · ${r.Wins}/${r.Games} wins` })),
    h('div', { class: 'score' }, h('b', { class: 'adj', text: r['Adj. Win %'] }), h('small', { text: `win ${r['Win %']}` }))))
    : [h('p', { class: 'empty', text: data ? 'No decks have enough games yet.' : 'Loading…' })]));
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
function toast(msg, bad) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.toggle('bad', !!bad);
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, bad ? 6000 : 3500);
}

function renderAll() {
  renderStatus();
  renderOutbox();
  renderForm();
  renderRecent();
  renderStandings();
}

// --------------------------------------------------------------------------- navigation, install, start-up

function show(view) {
  for (const tab of $$('.tab')) tab.classList.toggle('active', tab.dataset.view === view);
  for (const sec of $$('.view')) sec.hidden = sec.id !== `view-${view}`;
  window.scrollTo(0, 0);
  if (view !== 'log' && online && data && Date.now() - data.fetchedAt > 30000) refresh({ quiet: true });
}

let installPrompt = null;
window.addEventListener('beforeinstallprompt', e => {
  e.preventDefault();
  installPrompt = e;
  $('#install').hidden = false;
});

function setup() {
  $$('.tab').forEach(t => t.addEventListener('click', () => show(t.dataset.view)));
  $('#refresh').addEventListener('click', async () => { await flushOutbox(); await refresh(); });
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

  window.addEventListener('online', () => { online = true; flushOutbox().then(() => refresh({ quiet: true })); });
  window.addEventListener('offline', () => { online = false; renderAll(); });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') flushOutbox().then(() => refresh({ quiet: true }));
  });
  setInterval(() => { if (outbox.some(i => !i.error)) flushOutbox(); }, 60000);

  draft.date = todayLocal();   // a fresh start is a new day's games; change the date to back-log
  pruneDraft();
  renderAll();
  if (API_READY) flushOutbox().then(() => refresh({ quiet: true }));

  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
}

setup();
