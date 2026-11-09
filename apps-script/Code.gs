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
 * It also has an onEdit trigger for the sheet: when a Games row is emptied, the
 * row gets its automatic Date back (see onEdit below).
 *
 * @OnlyCurrentDoc
 */

const CFG = {
  bracketsRange: 'Settings!F5:G9',   // F: game brackets, G: deck brackets
  recentCount: 10,
  rememberIds: 500,                  // how many request IDs to remember, so a retried request isn't logged twice
};

// The rows each sheet's formulas cover come from the sheet's named ranges, so they
// stay right if rows are inserted or deleted.
const GAMES_RANGE = 'G_Num';     // Games!A5:A2004
const DECKS_RANGE = 'K_Player';  // Decks!B5:B504
const PLAYERS_RANGE = 'P_Name';  // Players!B5:B34

// Games columns: A #, B Bracket, C-F Player 1-4, G-J Commander 1-4, K Winner, L Notes,
// M Date, N Winning Commander, O Status. A game is what's typed in B..L; the app also writes M.
const BRACKET_COL = 2;       // B
const NOTES_COL = 12;        // L
const DATE_COL = 13;         // M
const GAME_COLS = NOTES_COL - BRACKET_COL + 1;   // B..L
const GAMES_WIDTH = 15;      // A..O
// The Date cell's formula: today's date once B..L has something in it, kept from then on.
const DATE_FORMULA_R1C1 = '=IF(COUNTA(RC2:RC12)=0,"",IF(N(RC)=0,TODAY(),RC))';
const DECK_OPTION_WIDTH = 60;   // DeckOptions: one 60-column block per seat

const ID_PREFIX = 'req:';

// --------------------------------------------------------------------------- web entry points

function doGet(e) {
  return respond_(() => {
    const action = (e && e.parameter && e.parameter.action) || 'data';
    if (action === 'data') return getData_();
    if (action === 'games') return { games: games_(SpreadsheetApp.getActiveSpreadsheet()) };
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

// --------------------------------------------------------------------------- sheet trigger

/**
 * Runs by itself on every edit made in the spreadsheet. When a Games row is emptied
 * (Bracket to Notes cleared), its Date cell gets the auto-date formula back. A game
 * logged from the app has its date typed in, which would otherwise stay behind after
 * the game is cleared and end up on the next game typed into that row.
 */
function onEdit(e) {
  const range = e && e.range;
  if (!range || range.getSheet().getName() !== 'Games') return;
  if (range.getColumn() > NOTES_COL || range.getLastColumn() < BRACKET_COL) return;   // only edits in B..L
  const g = gameRows_(e.source);
  const top = Math.max(range.getRow(), g.first);
  const bottom = Math.min(range.getLastRow(), g.first + g.count - 1);
  if (top > bottom) return;
  const n = bottom - top + 1;
  const values = g.sheet.getRange(top, BRACKET_COL, n, GAME_COLS).getValues();   // B..L
  const formulas = g.sheet.getRange(top, DATE_COL, n, 1).getFormulas();          // M
  // Rows next to each other get their formula back in one write (clearing many games at once).
  let start = -1;
  for (let i = 0; i <= n; i++) {
    const emptied = i < n && !formulas[i][0] && values[i].every(v => v === '');
    if (emptied && start < 0) start = i;
    if (!emptied && start >= 0) {
      resetDates_(g.sheet, top + start, i - start);
      start = -1;
    }
  }
}

/** Puts the auto-date formula back in the Date cells of `count` Games rows from `row`. */
function resetDates_(sheet, row, count) {
  sheet.getRange(row, DATE_COL, count, 1).setFormulaR1C1(DATE_FORMULA_R1C1);
}

// --------------------------------------------------------------------------- reading

function getData_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const brackets = bracketLists_(ss);
  const dash = ss.getSheetByName('Dashboard');
  const grid = dash.getRange(1, 1, Math.min(dash.getMaxRows(), 120), 14).getDisplayValues();
  return {
    brackets: brackets.game,
    deckBrackets: brackets.deck,
    players: players_(ss),
    decks: okDecks_(ss),
    recent: games_(ss, CFG.recentCount),
    leaderboard: dashTable_(grid, 'Leaderboard', 'Player'),
    topDecks: dashTable_(grid, 'Top Decks', 'Commander'),
  };
}

function named_(ss, name) {
  const range = ss.getRangeByName(name);
  if (!range) throw userError_('The tracker is missing its ' + name + ' named range (Data > Named ranges).');
  return range;
}

/** Where a sheet's rows are: {sheet, first, count}. */
function rowsOf_(ss, name) {
  const range = named_(ss, name);
  return { sheet: range.getSheet(), first: range.getRow(), count: range.getNumRows() };
}
function gameRows_(ss) { return rowsOf_(ss, GAMES_RANGE); }
function deckRows_(ss) { return rowsOf_(ss, DECKS_RANGE); }

function listOf_(values) {
  return values.map(v => String(v).trim()).filter(v => v !== '');
}

function bracketLists_(ss) {
  const rows = ss.getRange(CFG.bracketsRange).getDisplayValues();
  return { game: listOf_(rows.map(r => r[0])), deck: listOf_(rows.map(r => r[1])) };
}

function players_(ss) {
  return listOf_(named_(ss, PLAYERS_RANGE).getDisplayValues().map(r => r[0]));
}

/** Decks marked OK on the Decks sheet: the ones that can be picked for a game. */
function okDecks_(ss) {
  const k = deckRows_(ss);
  const rows = k.sheet.getRange(k.first, 2, k.count, 10).getDisplayValues();   // B..K
  const decks = [];
  rows.forEach(r => {
    const player = r[0].trim(), commander = r[1].trim(), bracket = r[2].trim(), status = r[9].trim();
    if (player && commander && status === 'OK') decks.push({ player, commander, bracket });
  });
  return decks;
}

/** Row numbers of the Games rows with anything in Bracket..Notes (B..L), top to bottom. */
function usedGameRows_(g) {
  const values = g.sheet.getRange(g.first, BRACKET_COL, g.count, GAME_COLS).getValues();
  const used = [];
  values.forEach((r, i) => {
    if (r.some(v => v !== '')) used.push(g.first + i);
  });
  return used;
}

/** The games on the Games sheet, newest first: the last `limit` of them (Recent), or every one
 *  (the app's Player tab works out each player's stats from these). */
function games_(ss, limit) {
  const g = gameRows_(ss);
  const used = usedGameRows_(g);
  return gamesAt_(g, limit ? used.slice(-limit) : used);
}

/** The games in these Games rows (top to bottom), newest first, as the sheet displays them. */
function gamesAt_(g, rows) {
  if (!rows.length) return [];
  const top = rows[0];
  // Only these rows are read as the sheet displays them (the slow kind of read).
  const display = g.sheet.getRange(top, 1, rows[rows.length - 1] - top + 1, GAMES_WIDTH).getDisplayValues();
  return rows.slice().reverse().map(row => {
    const d = display[row - top];
    return {
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
function dashTable_(grid, title, keyHeader) {
  let r0 = -1, c0 = -1;
  for (let r = 0; r < grid.length && r0 < 0; r++) {
    for (let c = 0; c < grid[r].length; c++) {
      if (grid[r][c].trim() === title) { r0 = r; c0 = c; break; }
    }
  }
  if (r0 < 0 || r0 + 1 >= grid.length) return { note: '', rows: [] };
  let note = '';
  for (let c = c0 + 1; c < grid[r0].length; c++) {
    if (grid[r0][c].trim()) { note = grid[r0][c].trim(); break; }
  }
  const cols = [];
  grid[r0 + 1].forEach((h, c) => { if (h.trim()) cols.push([c, h.trim()]); });
  const keyCol = (cols.find(([, h]) => h === keyHeader) || [])[0];
  const rows = [];
  if (keyCol === undefined) return { note, rows };
  for (let r = r0 + 2; r < grid.length; r++) {
    if (!grid[r][keyCol].trim()) break;
    const row = {};
    cols.forEach(([c, h]) => { row[h] = grid[r][c].trim(); });
    rows.push(row);
  }
  return { note, rows };
}

function today_(ss) {
  return Utilities.formatDate(new Date(), ss.getSpreadsheetTimeZone(), 'yyyy-MM-dd');
}

// --------------------------------------------------------------------------- writing

function logGame_(req) {
  if (seenBefore_(req.clientId)) return { duplicate: true };
  const ss = SpreadsheetApp.getActiveSpreadsheet();

  const g = req.game || {};
  const brackets = bracketLists_(ss).game;
  const players = players_(ss);
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
  if (cmds.length !== 4) throw userError_("Pick each player's commander.");
  const decks = okDecks_(ss);
  cmds.forEach((c, i) => {
    if (!c) throw userError_('Pick a commander for ' + who[i] + '.');
    const ok = decks.some(d => d.player === who[i] && d.commander === c && d.bracket === bracket);
    if (!ok) throw userError_(c + " isn't one of " + who[i] + "'s " + bracket + ' decks on the Decks sheet.');
  });
  if (who.indexOf(winner) < 0) throw userError_('Pick the winner.');
  const game = {
    bracket, players: who, commanders: cmds, winner,
    notes: clean_(g.notes).slice(0, 300),
    date: dateSerial_(g.date, ss),
  };

  const rows = gameRows_(ss);
  const used = usedGameRows_(rows);
  const row = used.length ? used[used.length - 1] + 1 : rows.first;
  if (row > rows.first + rows.count - 1) {
    throw userError_('The Games sheet is full (' + rows.count + ' games). Extend it before logging more.');
  }

  writeGameRow_(ss, rows.sheet, row, game);   // flushes, so the next request sees this row
  remember_(req.clientId);

  const after = rows.sheet.getRange(row, 1, 1, GAMES_WIDTH).getDisplayValues()[0];
  return { number: after[0], status: after[14] };
}

/**
 * Fills a Games row the way a person would. The sheet's dropdowns check each cell as it is
 * written: a commander must be on that seat's list (worked out from the bracket and player),
 * and the winner must be one of the players. So the bracket and players go in first, then the
 * commanders once their lists have caught up, then the winner, notes and date.
 * If the sheet refuses any of it, the row is cleared so no half-written game is left behind.
 * Text goes through safeText_, so a name that starts like a formula is written as text.
 */
function writeGameRow_(ss, sheet, row, game) {
  const text = values => values.map(safeText_);
  try {
    sheet.getRange(row, BRACKET_COL, 1, 5).setValues([text([game.bracket].concat(game.players))]);        // B:F
    SpreadsheetApp.flush();
    waitForDeckLists_(ss, row, game.commanders);
    sheet.getRange(row, BRACKET_COL + 5, 1, 4).setValues([text(game.commanders)]);                        // G:J
    sheet.getRange(row, BRACKET_COL + 9, 1, 3).setValues([text([game.winner, game.notes]).concat(game.date)]);   // K:M
    SpreadsheetApp.flush();
  } catch (err) {
    sheet.getRange(row, BRACKET_COL, 1, GAME_COLS).clearContent();   // B:L
    resetDates_(sheet, row, 1);                                      // M
    SpreadsheetApp.flush();
    throw userError_("The sheet wouldn't accept that game, so nothing was saved (" +
      (err.userMessage || err.message) + ').');
  }
}

/** Waits until each seat's commander list on DeckOptions includes the commander being logged. */
function waitForDeckLists_(ss, row, cmds) {
  const opts = ss.getSheetByName('DeckOptions');
  for (let attempt = 0; attempt < 5; attempt++) {
    const line = opts.getRange(row, 1, 1, DECK_OPTION_WIDTH * 4).getDisplayValues()[0];
    const ready = cmds.every((c, i) => line.slice(i * DECK_OPTION_WIDTH, (i + 1) * DECK_OPTION_WIDTH).indexOf(c) >= 0);
    if (ready) return;
    Utilities.sleep(700);
    SpreadsheetApp.flush();
  }
  throw userError_("the commander lists for this game didn't update in time");
}

function addDeck_(req) {
  if (seenBefore_(req.clientId)) return { duplicate: true };
  const ss = SpreadsheetApp.getActiveSpreadsheet();

  const player = clean_(req.player);
  const bracket = clean_(req.bracket);
  const commander = clean_(req.commander).slice(0, 150);

  if (players_(ss).indexOf(player) < 0) throw userError_('Pick a player.');
  if (bracketLists_(ss).deck.indexOf(bracket) < 0) throw userError_('Pick a bracket.');
  if (!commander) throw userError_("Type the commander's name.");

  const k = deckRows_(ss);
  const rows = k.sheet.getRange(k.first, 2, k.count, 4).getDisplayValues();   // B..E: Player, Commander, Bracket, Notes
  let empty = -1;
  for (let i = 0; i < rows.length; i++) {
    const [p, c, b, note] = rows[i].map(v => v.trim());
    if (p === player && c.toLowerCase() === commander.toLowerCase() && b === bracket) {
      return { existing: true, commander: c };
    }
    if (empty < 0 && !p && !c && !b && !note) empty = i;
  }
  if (empty < 0) throw userError_('The Decks sheet is full. Make room before adding more.');

  k.sheet.getRange(k.first + empty, 2, 1, 3).setValues([[player, commander, bracket].map(safeText_)]);   // B..D
  SpreadsheetApp.flush();
  remember_(req.clientId);
  return { commander };
}

// --------------------------------------------------------------------------- helpers

function clean_(v) {
  return v === undefined || v === null ? '' : String(v).replace(/\s+/g, ' ').trim();
}

/** Stops typed text being read as a formula. */
function safeText_(s) {
  return /^[=+\-@]/.test(s) ? "'" + s : s;
}

/** The game's date as a sheet date number: the app's date if it's a real date and not in the future, else today. */
function dateSerial_(text, ss) {
  const today = today_(ss);
  const ymd = utcOf_(text) !== null && text <= today ? text : today;
  return utcOf_(ymd) / 86400000 + 25569;   // days since 1899-12-30
}

/** A "yyyy-MM-dd" date as milliseconds at midnight UTC, or null if it isn't a real date (2026-02-30). */
function utcOf_(text) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(text));
  if (!m) return null;
  const [y, mo, d] = m.slice(1).map(Number);
  const t = new Date(Date.UTC(y, mo - 1, d));
  return t.getUTCMonth() === mo - 1 && t.getUTCDate() === d ? t.getTime() : null;
}

// Each request ID is its own script property ("req:<id>" -> when it was saved). One
// property holding every ID would pass Apps Script's 9 KB limit per property.

function seenBefore_(id) {
  if (!id) return false;
  return PropertiesService.getScriptProperties().getProperty(ID_PREFIX + id) !== null;
}

/** Never throws: the sheet already has the change, so a failure here must not report one. */
function remember_(id) {
  if (!id) return;
  try {
    const props = PropertiesService.getScriptProperties();
    props.setProperty(ID_PREFIX + id, String(Date.now()));
    const all = props.getProperties();
    const ids = Object.keys(all).filter(key => key.indexOf(ID_PREFIX) === 0);
    if (ids.length > CFG.rememberIds) {
      ids.sort((a, b) => Number(all[a]) - Number(all[b]))
        .slice(0, ids.length - CFG.rememberIds)
        .forEach(key => props.deleteProperty(key));
    }
  } catch (err) {
    console.error(err);
  }
}
