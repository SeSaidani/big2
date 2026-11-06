# Big Two (Hong Kong rules) with four wild jokers

A browser game. Play **solo** against computer players (Easy, Medium, Hard) any time, for practice and not scored, or
**online**: season games between four people, with accounts, one shared game at a time, chat, points and leaderboards. No runtime dependencies beyond Node itself (the packages in
`package.json` are development tools only).

Needs **Node 22.13 or later** (the server uses the built-in `node:sqlite`, still marked experimental upstream; it
works on Node 24, so pin your Node version when deploying).

## Run it

```
npm test                         # all tests
npm start                        # the server: sign-in, solo and online   (server/index.js)
npm run online                   # the same
```

Open the address it prints. The server listens on `127.0.0.1:8765` by default. Nothing of the game is served
until you sign in (a visitor gets only the sign-in page), so make an account first: `npm run admin -- make-admin <name>`.
A session lasts 30 days from its last use (using the site renews it, so regular players are not asked again),
and never more than 180 days from the sign-in.

| Environment variable       | Meaning                                                                                           |
| -------------------------- | ------------------------------------------------------------------------------------------------- |
| `PORT`, `HOST`             | Where to listen. `HOST=0.0.0.0` exposes it on the network.                                        |
| `DB_FILE`                  | SQLite file (default `data/big2.db`).                                                             |
| `AI_DELAY_MS`              | Pause before each computer move (default 700).                                                    |
| `DEV_TABLES=1`             | Development and tests only: computer seats and 3-seat online tables, created and started by hand. |
| `TABLE_START_DELAY_MS`     | Wait from the fourth person sitting down to the deal (default 10000).                             |
| `TABLE_NEXT_GAME_DELAY_MS` | How long a result stays up before the next game (default 30000).                                  |
| `TRUST_PROXY=1`            | Behind a reverse proxy: take the client IP from `X-Forwarded-For`.                                |
| `SECURE_COOKIES=1`         | Mark the session cookie `Secure` (use once served over HTTPS).                                    |

## Accounts and admin

There is no sign-up by default. The first admin is created from a shell on the machine:

```
node server/admin.js make-admin <name>          # asks for a password (hidden)
node server/admin.js create-user <name>         # a normal (non-admin) user
node server/admin.js reset-password <name>
node server/admin.js list-users                 # also shows who has turn alerts on
```

(`BIG2_PASSWORD` supplies the password in scripts.) Then sign in (Online, top bar) and open **Admin** to create users
with a temporary password, reset passwords, disable or enable accounts, promote or demote admins, open or close
self-registration, manage seasons, cancel the running game, and read the audit log. Every admin action is re-checked on
the server and recorded. The last active admin cannot be removed or disabled. Users change their own password with the
**Password** button. There is no email, so a lost password is reset by an admin. An account is a name and a password:
the game keeps no phone numbers.

## Turn alerts (push notifications)

If it is your turn and you have not played, your phone gets an alert: one when it has been your turn for **20 minutes**,
and one more if it is still your turn after **24 hours**. Never more than two for a turn, and nothing at all if you
move in time. An alert says it is your turn and never shows cards. They are standard web push notifications, so they
cost nothing, need no phone number and no account with a text-message company.

**Turning them on.** Under your name, **Turn alerts**. On an Android phone, signing in shows a one-tap bar (the browser
only ever asks for permission from a tap). On an iPhone or iPad, alerts only work for a site opened from its Home
Screen icon (iOS 16.4 or newer), so the first sign-in shows the steps: Share, Add to Home Screen, open the icon, sign in
again there (the icon keeps its own sign-in), and tap Turn on. The dialog also has **Send a test alert**, **Turn off for
this device**, the list of your devices, and a "Not getting alerts?" section (blocked in the phone's settings, Do Not
Disturb, starting again). Computers can turn them on from the same dialog. Alerts belong to one phone and browser, and
signing out takes that phone off your account, so the next person to use it is not told about your turns.

**How it works.** The browser gives the server a private address for the device (a push subscription) and two keys.
The server encrypts each alert for that device (RFC 8291) and signs the request with its own key pair (VAPID, RFC 8292)
before posting it to the browser's push service (Google, Apple or Mozilla), which delivers it. All of it is written with
Node's own crypto in `server/web-push.js` and checked against the RFC's test vector. The signing keys are made on first
start and kept in the database (so backups hold them: keep them private; changing them would silence every device).
Subscriptions may only point at the real push services (a signed-in person cannot make the server call any address).
A device the push service reports gone is forgotten. The time each turn began is saved with the game and what has been
sent is read from the database, so a restart cannot repeat or skip an alert. A safety cap of 6 a day per person applies.
A failing push service is logged and never affects the game.

| Variable               | Meaning                                                                                                    |
| ---------------------- | ---------------------------------------------------------------------------------------------------------- |
| `PUBLIC_URL`           | The https address of the site, e.g. `https://big2.example.com`. Identifies the sender to Apple and Google. |
| `PUSH_FIRST_AFTER_MS`  | First alert if the turn has not been played (default 1200000 = 20 minutes)                                 |
| `PUSH_SECOND_AFTER_MS` | Second and last alert if it is still their turn (default 86400000 = 24 hours)                              |
| `PUSH_MAX_PER_DAY`     | Safety cap per person per 24 hours (default 6)                                                             |

**Not checked by the automated tests, and cannot be:** a real alert through Google's or Apple's servers to a real phone.
The tests decrypt what the server sends, as a phone would. Use **Send a test alert** on each kind of phone to confirm.
Opening an old database erases any phone numbers and text-message records it still holds.

## How online games work

- **A season has players, and the table runs itself.** An admin makes a season and ticks its players from the accounts
  that exist (at least four for a season that is running or to come), or adds and removes them later with the season's
  **Players** button. While a season is running with at least four players there is one table, with the first four
  seated. Nobody creates or starts a game and nobody takes a seat by themselves: when all four are there the game
  starts after a 10 second countdown (`TABLE_START_DELAY_MS`). When it ends the result stays up for 30 seconds
  (`TABLE_NEXT_GAME_DELAY_MS`) and the next game starts. Players beyond the first four are reserves, in a line (see
  Rotation). Someone seated cannot be removed from the roster: cancel the game first. A season that ends **by its
  dates** lets the game in progress finish and then closes the table (the game counts in no season, as before); an
  admin's **End now** stops the game in progress (recorded as cancelled, never scored) and closes the table. **Cancel
  game** clears the table and, with a season running, a fresh one opens seated with the roster. A season that starts by
  its dates opens the table (a clock checks every few seconds). The countdown shows on screen and carries on after a
  server restart.
  (`DEV_TABLES=1` is for development and tests: an admin creates the game and starts it by hand, with computer seats
  and 3-seat tables. Production never sets it.)
- **Watching.** Anyone who is not seated sees **Watch the game** in the lobby: they see what is played at the table,
  never anyone's cards, and they can chat. **Stop watching** goes back to the lobby.
- **Rotation.** When a season has more players than seats (the extras are reserves, in a line), the player with the
  **lowest score in a game**, the loser who paid the most, goes out when the next game starts: to the back of the line,
  and the first reserve takes the seat. The winner and the others stay. A tie goes to whoever has been seated longest
  (and, if that ties too, one of the tied is picked at random). **Leaving counts as the lowest score**: leaving the
  result is that game's one swap (the lowest scorer then stays), and leaving a game in progress costs the most a round
  can (-56 for four players) and voids it for the other three. With exactly as many players as seats nobody rotates and
  nobody can leave. The result screen says who goes out and who comes in.
- An admin can **switch to the player view** (account menu) to see the game without the admin controls; it only hides
  them on this device, and the server still checks everything.
- A started game **holds its seats until it finishes or an admin cancels it** (you can only leave on the result). There is no turn timer; the game waits
  for anyone who is offline. "‹ Online home" (or the Online button) keeps your seat. The live game is saved to SQLite after every change, so
  it **survives a server restart**.
- A cancelled game is recorded as cancelled and **never counts toward scoring**.
- **Chat** is available while two or more people are at the table.
- Scoring (`src/scoring.js`): each loser pays the winner per card left (1 point a card for 1-7 cards, 2 for 8-10, 3 for
  11-13, 4 if they never played); a straight flush or five of a kind going out doubles every payment. Scores always sum
  to zero. These thresholds are an adaptation of the 13-card scale to 14-card hands, not a published rule: change
  `RATES`.
- **Leaderboards are cumulative:** running total points, with games, wins, win % and points per game beside them, and a
  toggle to rank by per-game instead of total. Only online season games count; solo games are not scored.
- **My solo stats** (account menu): your own finished solo games against the computer, by table size (4 and 3 players)
  and level, each size's total, each level over both sizes, and an overall row: games, wins, win %, points and points
  per game. The browser reports each round when it ends (and keeps it and sends it later if the server cannot be
  reached); the server counts each round once, checks it could be a real result, and only ever returns the signed-in
  person's own rows. Nobody else, an admin included, can see them, and they are on no leaderboard.
- **Seasons** are date ranges set by an admin (Admin > Seasons): a name, a start and an optional end, in the admin's local
  time (stored as UTC). A game counts in the season in which it **finished** (`starts <= finished < ends`). Seasons
  cannot overlap; gaps are allowed, and games in a gap count only in **All-time**. Boards can be viewed for the current
  season, any past or upcoming season, or all-time. Boards are calculated from the games, so editing a season's dates
  re-sorts its games (and is audit-logged); nothing is ever deleted. A new database starts with "Season 1" (open-ended,
  starting at the earliest existing game). After that, having no season is allowed and lasts across restarts: no online
  game can start until an admin creates one. **End now** on a running season stops it at that moment; a new season's
  start defaults to now.

## On a phone

The page is responsive and can be added to the home screen (it has a web app manifest and icons; on an iPhone that is also what turn alerts need). Your hand is one
curved row tucked into the bottom edge of the table: **tap** a card to select it, or **swipe** across several to select
(or deselect) them; selected cards lift well clear of the row. Landscape has its own compact layout. If the app was in
the background for a few seconds it reconnects and re-syncs when you return.

To try it from a phone on your own network, run the server with `HOST=0.0.0.0`, find your computer's IP address, allow
the port through the firewall, and open `http://<that-ip>:<port>` on the phone. That is plain http on a home network;
use HTTPS for anything beyond that. Verified with Chrome's touch and phone-size emulation; **not tested on a real iPhone
or Android device**.

## Rules in this implementation

56 cards (a standard deck plus 4 wild jokers), 14 each at a table of four. At a table of three it is 18 each, and the two
spare cards go to the holders of the 3♦ and the 2♠ (the scoring bands stretch in proportion; see `src/scoring.js`).
Ranks 3 < … < K < A < 2; suits ♦ < ♣ < ♥ < ♠. The 3♦ opens.
Singles, pairs, triples and five-card hands (straight, flush, full house, four of a kind + kicker, straight flush,
five of a kind). A straight is worth its highest card; ace and 2 are low in A-2-3-4-5 and 2-3-4-5-6, the two weakest
straights. You can pass even with the lead. If the next player has one card left, a single must be your highest. A
real card always beats a joker standing for the same thing: a joker hand ranks as the hand its jokers represent, and
the real hand wins any exact tie. So nothing beats the real 2♠, a lone joker is a 2♠ that loses to it (but beats the
2♥ and everything below), and two jokers cannot beat each other. If nobody left can beat a play, the others are passed
automatically.

## Layout

```
index.html, signin.html/.js, styles.css, favicon.svg, manifest.webmanifest, icon-*.png   the page and its installable-app files
src/            cards, hands (classification and ranking), moves (legal-move generation), game (state machine),
                scoring, ui.js (browser UI), online.js (API client), online-view.js (server view -> UI state)
src/ai/         easy (greedy), medium (heuristic planner), hard (determinised Monte Carlo tree search), worker
server/         index.js (HTTP, SSE, admin API), table.js, lobby.js, auth.js, db.js, hub.js, ai-pool.js, admin.js (CLI)
src/stats/      the deal model: features, statistics, and the fitted models (see docs/deal-model.md)
tools/          arena.js (headless AI tournaments), fit-deal-model.js (fits the deal model)
test/           node --test suites
```

`node tools/arena.js --a hard --b medium --deals 200 --iters 600 --workers 8` pits one agent against three of
another over duplicate deals (each deal replayed with the agent in every seat) and reports the win rate with a
confidence interval. Hard currently wins about 32% against three Medium players (25% would mean no better).

## Development

```
npm ci              # install the development tools (from the lockfile)
npm run check       # everything below, in order: this is what CI runs
npm run format      # Prettier: rewrite files in place (the equivalent of black)
npm run lint        # ESLint (JavaScript), Stylelint (CSS), html-validate (HTML)
npm test            # unit and integration tests (node:test)
npm run e2e         # real-browser tests (see below)
```

| Language / file type | Formatter                                        | Linter                               |
| -------------------- | ------------------------------------------------ | ------------------------------------ |
| JavaScript           | Prettier                                         | ESLint (`eslint.config.js`)          |
| CSS                  | Prettier                                         | Stylelint (`.stylelintrc.json`)      |
| HTML                 | Prettier                                         | html-validate (`.htmlvalidate.json`) |
| JSON, Markdown       | Prettier                                         | (Prettier only)                      |
| Everything           | EditorConfig, `.gitattributes` (LF line endings) |

Style: 2 spaces, single quotes, trailing commas, 120 columns (`.prettierrc.json`). Where a linter and Prettier disagree
(`<!doctype>` case, self-closing void tags, `max-width` media queries for older phones) the linter is configured to
agree with Prettier or with browser support, and Safari-only `-webkit-` properties carry an explanatory
`stylelint-disable` comment. Run `npm audit` occasionally; the current findings are in ESLint's own dependency tree
(`minimatch`), are build-time only, and do not reach the game or the server.

**End-to-end tests** (`e2e/`) drive real headless Chrome over the DevTools protocol against a throwaway server and
database: sign-in, an admin creating users, two people playing one game with chat, a server kill and restart in the
middle of a game, admin cancel, seasons, cumulative totals, and a phone-sized touch session (tap, swipe, landscape).
They need Chrome or Chromium (`CHROME_PATH` if it is not in a standard place) and are not run in CI. Screenshots go to
`e2e/out/` (git-ignored).

**Branches.** `main` is protected by a repository ruleset: no direct pushes, no force pushes, no deletion, and a pull
request with one approving review is required. Work on a branch, open a pull request, and let CI (`npm run check`)
pass.

## Security notes

Passwords are hashed with scrypt; session tokens are random and only their SHA-256 is stored; the cookie is HttpOnly
and SameSite=Strict. Logins and sign-ups are rate limited, request bodies are capped, state-changing requests reject
foreign origins, only the client files are served, and each player is sent only their own hand. This code has not had
an independent security review. Before exposing it to the internet: serve it over HTTPS (set `SECURE_COOKIES=1` and
`TRUST_PROXY=1` behind the proxy, and let the proxy add HSTS), keep registration closed, put `data/` on durable
storage and back up the SQLite file (a plain copy while it is being written is not safe; use SQLite's backup API or
Litestream). Run a single instance: live games are held in memory and in one database file.
