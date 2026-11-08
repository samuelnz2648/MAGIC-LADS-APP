/**
 * Magic Lads Tracker: the web API behind the game-logging phone app.
 *
 * Paste this into Extensions > Apps Script on the tracker sheet, then
 * Deploy > New deployment > Web app, with "Execute as: Me" and
 * "Who has access: Anyone". The app talks to the /exec URL that gives you.
 *
 * The script runs as you, so the group doesn't need edit access to the sheet
 * to log games through the app. Games can only be added here, never changed or
 * deleted: fixing or deleting a game is done on the Games sheet itself.
 *
 * @OnlyCurrentDoc
 */

const CFG = {
  firstRow: 5,                 // first data row on Games, Decks and Players
  gamesLastRow: 2004,          // the Games sheet's formulas run to this row
  decksLastRow: 504,
  playersRange: 'Players!B5:B34',
  gameBracketsRange: 'Settings!F5:F9',
  deckBracketsRange: 'Settings!G5:G9',
  recentCount: 10,
  rememberIds: 500,            // how many request IDs to remember, so a retried request isn't logged twice
};

// Games columns B..M (2..13): Bracket, Player 1-4, Commander 1-4, Winner, Notes, Date
const GAME_FIRST_COL = 2;
const GAME_COLS = 12;

// --------------------------------------------------------------------------- web entry points

function doGet(e) {
  return respond_(() => {
    const action = (e && e.parameter && e.parameter.action) || 'data';
    if (action === 'data') return getData_();
    if (action === 'ping') return { pong: true };
    throw userError_('Unknown request.');
  });
}

function doPost(e) {
  return respond_(() => {
    let req;
    try {
      req = JSON.parse(e.postData.contents);
    } catch (err) {
      throw userError_('The app sent a request the tracker could not read.');
    }
    switch (req.action) {
      case 'logGame': return withLock_(() => logGame_(req));
      case 'addDeck': return withLock_(() => addDeck_(req));
      default: throw userError_('Unknown request.');
    }
  });
}

function respond_(fn) {
  let body;
  try {
    body = Object.assign({ ok: true }, fn());
  } catch (err) {
    body = { ok: false, error: err.userMessage || ('The tracker hit an error: ' + err.message) };
    if (!err.userMessage) console.error(err);
  }
  return ContentService.createTextOutput(JSON.stringify(body))
    .setMimeType(ContentService.MimeType.JSON);
}

function userError_(message) {
  const err = new Error(message);
  err.userMessage = message;
  return err;
}

function withLock_(fn) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(25000)) throw userError_('The tracker is busy. Try again in a moment.');
  try {
    return fn();
  } finally {
    lock.releaseLock();
  }
}

// --------------------------------------------------------------------------- reading

function getData_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const dash = ss.getSheetByName('Dashboard');
  return {
    brackets: listOf_(ss.getRange(CFG.gameBracketsRange).getDisplayValues()),
    deckBrackets: listOf_(ss.getRange(CFG.deckBracketsRange).getDisplayValues()),
    players: listOf_(ss.getRange(CFG.playersRange).getDisplayValues()),
    decks: okDecks_(ss),
    recent: recentGames_(ss),
    leaderboard: dashTable_(dash, 'Leaderboard', 'Player'),
    topDecks: dashTable_(dash, 'Top Decks', 'Commander'),
    today: today_(ss),
  };
}

function listOf_(rows) {
  return rows.map(r => String(r[0]).trim()).filter(v => v !== '');
}

/** Decks marked OK on the Decks sheet: the ones that can be picked for a game. */
function okDecks_(ss) {
  const sheet = ss.getSheetByName('Decks');
  const n = CFG.decksLastRow - CFG.firstRow + 1;
  const rows = sheet.getRange(CFG.firstRow, 2, n, 10).getDisplayValues();   // B..K
  const decks = [];
  rows.forEach(r => {
    const player = r[0].trim(), commander = r[1].trim(), bracket = r[2].trim(), status = r[9].trim();
    if (player && commander && status === 'OK') decks.push({ player, commander, bracket });
  });
  return decks;
}

/** Every Games row (B..O) with something in it, as {row, values, display}. */
function usedGameRows_(sheet) {
  const n = CFG.gamesLastRow - CFG.firstRow + 1;
  const range = sheet.getRange(CFG.firstRow, 1, n, 15);   // A..O
  const values = range.getValues();
  const display = range.getDisplayValues();
  const used = [];
  for (let i = 0; i < n; i++) {
    if (values[i].slice(1, 12).some(v => v !== '' && v !== null)) {
      used.push({ row: CFG.firstRow + i, values: values[i], display: display[i] });
    }
  }
  return used;
}

function recentGames_(ss) {
  const used = usedGameRows_(ss.getSheetByName('Games'));
  return used.slice(-CFG.recentCount).reverse().map(g => {
    const d = g.display;
    return {
      row: g.row,
      number: d[0],
      bracket: d[1],
      players: d.slice(2, 6),
      commanders: d.slice(6, 10),
      winner: d[10],
      notes: d[11],
      date: d[12],
      winningCommander: d[13],
      status: d[14],
    };
  });
}

/** A table on the Dashboard: the title cell, a header row under it, rows until `keyHeader` is blank. */
function dashTable_(sheet, title, keyHeader) {
  const grid = sheet.getRange(1, 1, Math.min(sheet.getMaxRows(), 120), 14).getDisplayValues();
  let r0 = -1, c0 = -1;
  for (let r = 0; r < grid.length && r0 < 0; r++) {
    for (let c = 0; c < grid[r].length; c++) {
      if (grid[r][c].trim() === title) { r0 = r; c0 = c; break; }
    }
  }
  if (r0 < 0) return { title, note: '', headers: [], rows: [] };
  let note = '';
  for (let c = c0 + 1; c < grid[r0].length; c++) {
    if (grid[r0][c].trim()) { note = grid[r0][c].trim(); break; }
  }
  const hdr = grid[r0 + 1];
  const cols = [];
  hdr.forEach((h, c) => { if (h.trim()) cols.push([c, h.trim()]); });
  const keyCol = (cols.find(([, h]) => h === keyHeader) || [])[0];
  const rows = [];
  for (let r = r0 + 2; r < grid.length; r++) {
    if (keyCol === undefined || !grid[r][keyCol].trim()) break;
    const row = {};
    cols.forEach(([c, h]) => { row[h] = grid[r][c].trim(); });
    rows.push(row);
  }
  return { title, note, headers: cols.map(([, h]) => h), rows };
}

function today_(ss) {
  return Utilities.formatDate(new Date(), ss.getSpreadsheetTimeZone(), 'yyyy-MM-dd');
}

// --------------------------------------------------------------------------- writing

function logGame_(req) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName('Games');
  if (seenBefore_(req.clientId)) return { duplicate: true };

  const g = req.game || {};
  const brackets = listOf_(ss.getRange(CFG.gameBracketsRange).getDisplayValues());
  const players = listOf_(ss.getRange(CFG.playersRange).getDisplayValues());
  const bracket = clean_(g.bracket);
  const who = (g.players || []).map(clean_);
  const cmds = (g.commanders || []).map(clean_);
  const winner = clean_(g.winner);

  if (brackets.indexOf(bracket) < 0) throw userError_('Pick a bracket.');
  if (who.length !== 4 || who.some(p => !p)) throw userError_('Pick all 4 players.');
  if (new Set(who.map(p => p.toLowerCase())).size !== 4) throw userError_('The same player is in the game twice.');
  who.forEach(p => {
    if (players.indexOf(p) < 0) throw userError_(p + " isn't on the Players sheet.");
  });
  const decks = okDecks_(ss);
  if (cmds.length !== 4) throw userError_("Pick each player's commander.");
  cmds.forEach((c, i) => {
    if (!c) throw userError_('Pick a commander for ' + who[i] + '.');
    const ok = decks.some(d => d.player === who[i] && d.commander === c && d.bracket === bracket);
    if (!ok) throw userError_(c + " isn't one of " + who[i] + "'s " + bracket + ' decks on the Decks sheet.');
  });
  if (who.indexOf(winner) < 0) throw userError_('Pick the winner.');
  const notes = safeText_(clean_(g.notes).slice(0, 300));
  const serial = dateSerial_(g.date, ss);

  const used = usedGameRows_(sheet);
  const row = used.length ? used[used.length - 1].row + 1 : CFG.firstRow;
  if (row > CFG.gamesLastRow) throw userError_('The Games sheet is full (2000 games). Extend it before logging more.');

  sheet.getRange(row, GAME_FIRST_COL, 1, GAME_COLS)
    .setValues([[bracket].concat(who, cmds, [winner, notes, serial])]);
  SpreadsheetApp.flush();
  remember_(req.clientId);

  const after = sheet.getRange(row, 1, 1, 15).getDisplayValues()[0];
  return { row, number: after[0], date: after[12], winningCommander: after[13], status: after[14] };
}

function addDeck_(req) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName('Decks');
  if (seenBefore_(req.clientId)) return { duplicate: true };

  const players = listOf_(ss.getRange(CFG.playersRange).getDisplayValues());
  const brackets = listOf_(ss.getRange(CFG.deckBracketsRange).getDisplayValues());
  const player = clean_(req.player);
  const bracket = clean_(req.bracket);
  const commander = safeText_(clean_(req.commander).slice(0, 150));
  const notes = safeText_(clean_(req.notes).slice(0, 200));

  if (players.indexOf(player) < 0) throw userError_('Pick a player.');
  if (brackets.indexOf(bracket) < 0) throw userError_('Pick a bracket.');
  if (!commander) throw userError_("Type the commander's name.");

  const n = CFG.decksLastRow - CFG.firstRow + 1;
  const rows = sheet.getRange(CFG.firstRow, 2, n, 10).getDisplayValues();   // B..K
  let empty = -1;
  for (let i = 0; i < n; i++) {
    const [p, c, b, note] = rows[i].map(v => v.trim());
    if (p === player && c.toLowerCase() === commander.toLowerCase() && b === bracket) {
      return { existing: true, row: CFG.firstRow + i, commander: c, status: rows[i][9] };
    }
    if (empty < 0 && !p && !c && !b && !note) empty = i;
  }
  if (empty < 0) throw userError_('The Decks sheet is full. Make room before adding more.');

  const row = CFG.firstRow + empty;
  sheet.getRange(row, 2, 1, 4).setValues([[player, commander, bracket, notes]]);
  SpreadsheetApp.flush();
  remember_(req.clientId);
  const status = sheet.getRange(row, 11).getDisplayValue();
  return { row, commander, status };
}

// --------------------------------------------------------------------------- helpers

function clean_(v) {
  return v === undefined || v === null ? '' : String(v).replace(/\s+/g, ' ').trim();
}

/** Stops typed text being read as a formula. */
function safeText_(s) {
  return /^[=+\-@]/.test(s) ? "'" + s : s;
}

/** The game's date as a sheet date number. Uses the app's date if sensible, else today. */
function dateSerial_(text, ss) {
  const todayText = today_(ss);
  let ymd = /^\d{4}-\d{2}-\d{2}$/.test(String(text || '')) ? String(text) : todayText;
  if (ymd > todayText) ymd = todayText;   // never in the future
  const [y, m, d] = ymd.split('-').map(Number);
  const utc = Date.UTC(y, m - 1, d);
  if (isNaN(utc)) return dateSerial_(todayText, ss);
  return utc / 86400000 + 25569;           // days since 1899-12-30
}

function seenBefore_(id) {
  if (!id) return false;
  const ids = JSON.parse(PropertiesService.getScriptProperties().getProperty('requestIds') || '[]');
  return ids.indexOf(String(id)) >= 0;
}

function remember_(id) {
  if (!id) return;
  const props = PropertiesService.getScriptProperties();
  const ids = JSON.parse(props.getProperty('requestIds') || '[]');
  ids.push(String(id));
  props.setProperty('requestIds', JSON.stringify(ids.slice(-CFG.rememberIds)));
}
