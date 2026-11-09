# Magic Lads app

A phone app for logging Magic Lads commander games straight into the group tracker (the Google Sheet), without opening the spreadsheet.

- **Log game:** pick the bracket, the 4 players, their commanders and the winner. Only each player's decks for that bracket are offered, like the sheet's dropdowns. After logging, the same pod stays filled in for the next game.
- **New commander:** pick "＋ New commander…" in a commander list to add a deck to the Decks sheet. Card names are suggested from Scryfall as you type.
- **Card images:** each seat shows its commander's card, and each Recent game shows the winning commander's card. Tap one to see it big. Images come from Scryfall: each commander is looked up once, then the image is stored on the phone (it shows offline too, and survives app updates). Partner and background pairs written `A // B` show both cards.
- **Recent:** the last 10 games, newest first. The app can only add games: to fix or delete one, edit it on the Games sheet.
- **Standings:** the Dashboard's Leaderboard and Top Decks (they follow the Dashboard's Bracket filter).
- **Player:** pick a player to see their place on the leaderboard, adjusted win %, record (wins–losses) and best commander (with its card), from the Dashboard; plus their two most played colours (with mana symbols, from their commanders' colour identities on Scryfall), their nemesis (whoever has beaten them most) and their last 5 games, worked out from every game on the Games sheet. The page takes on the colour they play most.
- **No signal?** The app still opens with the last lists it loaded. Games and new commanders logged offline wait on the phone and are sent, in order, as soon as it's back online. Sending the same game twice never logs it twice.

## How it fits together

```
phone app (GitHub Pages)  ──►  Apps Script web app (runs as Sam)  ──►  tracker Google Sheet
```

The Apps Script runs as you, so the group doesn't need edit access to the sheet to log games through the app. There's no passcode: anyone with the app's link can log games and add commanders. Only people with edit access to the sheet can change or delete games.

The same script also tidies up after you on the sheet: when you clear a game from the Games sheet, its Date cell gets the automatic date back, so the next game typed into that row gets that day's date.

## One-time setup

### 1. Connect the tracker (Apps Script)

1. Open the tracker sheet, then **Extensions → Apps Script**.
2. Name the project (top left) **Magic Lads API**.
3. In `Code.gs`, delete what's there and paste in everything from [`apps-script/Code.gs`](apps-script/Code.gs). Press **Ctrl+S**.
4. **Deploy → New deployment**. Click the gear next to "Select type" and choose **Web app**.
   - Description: `Magic Lads app`
   - Execute as: **Me**
   - Who has access: **Anyone**
5. Click **Deploy**, then **Authorize access** and pick your Google account. Google warns that it "hasn't verified this app" because it's your own script: click **Advanced → Go to Magic Lads API (unsafe) → Allow**. The script can only see this one spreadsheet.
6. Copy the **Web app URL** (it ends in `/exec`) and put it in [`config.js`](config.js).

### 2. Publish the app (GitHub Pages)

Push these files to the `MAGIC-LADS-APP` repository, then in the repo go to **Settings → Pages**, set **Source: Deploy from a branch**, **Branch: main / (root)**, and save. After a minute the app is at `https://samuelnz2648.github.io/MAGIC-LADS-APP/`.

### 3. Install it on phones

- **Android (Chrome):** open the link, then tap **Install** at the top of the app (or ⋮ → **Install app**).
- **iPhone (Safari):** open the link, tap **Share**, then **Add to Home Screen**.

## Changing things later

- **The app:** edit the files, bump `VERSION` in `sw.js` (e.g. `magic-lads-v4` to `magic-lads-v5`) so phones pick up the change, and push. Phones switch to the new version the next time the app is opened or brought back to the front.
- **The Apps Script:** paste the new code, save, then **Deploy → Manage deployments → ✏️ Edit → Version: New version → Deploy**. Editing the existing deployment keeps the same URL; a *new* deployment would give a new URL that the app doesn't know about.
- **Sheet layout:** the script finds the Leaderboard and Top Decks by their titles on the Dashboard, and finds the Games, Decks and Players rows through the sheet's named ranges (`G_Num`, `K_Player`, `P_Name`), so inserting or deleting rows is fine. It expects the columns as they are now; if you move columns, update the constants at the top of `Code.gs`.
