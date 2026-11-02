# Big Two (Hong Kong rules) with four wild jokers

A browser game. Play **solo** against three computer players (Easy, Medium, Hard), or **online**: accounts, one
shared game at a time, chat, points and leaderboards. No runtime dependencies beyond Node itself (the packages in
`package.json` are development tools only).

Needs **Node 22.13 or later** (the server uses the built-in `node:sqlite`, still marked experimental upstream; it
works on Node 24, so pin your Node version when deploying).

## Run it

```
npm test                         # all tests
npm start                        # solo only: static file server on :8765   (tools/serve.js)
npm run online                   # the full server: solo + online          (server/index.js)
```

Open the address it prints. The online server listens on `127.0.0.1:8765` by default.

| Environment variable | Meaning                                                            |
| -------------------- | ------------------------------------------------------------------ |
| `PORT`, `HOST`       | Where to listen. `HOST=0.0.0.0` exposes it on the network.         |
| `DB_FILE`            | SQLite file (default `data/big2.db`).                              |
| `AI_DELAY_MS`        | Pause before each computer move (default 700).                     |
| `TRUST_PROXY=1`      | Behind a reverse proxy: take the client IP from `X-Forwarded-For`. |
| `SECURE_COOKIES=1`   | Mark the session cookie `Secure` (use once served over HTTPS).     |

## Accounts and admin

There is no sign-up by default. The first admin is created from a shell on the machine:

```
node server/admin.js make-admin <name>          # asks for a password (hidden input)
node server/admin.js reset-password <name>
node server/admin.js list-users
```

Then sign in (Online, top bar) and open **Admin** to create users with a temporary password, reset passwords, disable
or enable accounts, promote or demote admins, open or close self-registration, cancel the running game, and read the
audit log. Every admin action is re-checked on the server and recorded. The last active admin cannot be removed or
disabled. Users change their own password with the **Password** button. There is no email, so a lost password is
reset by an admin.

## How online games work

- **One game at a time**, created by an admin. Anyone signed in can join it while it is waiting; the host starts it.
  Empty seats are played by the computer at the level the admin chose.
- A started game **holds its seats until it finishes or an admin cancels it**. There is no turn timer; the game waits
  for anyone who is offline. "Back to lobby" keeps your seat. The live game is saved to SQLite after every change, so
  it **survives a server restart**.
- A cancelled game is recorded as cancelled and **never counts toward scoring**.
- **Chat** is available while two or more people are at the table.
- Scoring (`src/scoring.js`): each loser pays the winner per card left (1 point a card for 1-7 cards, 2 for 8-10, 3 for
  11-13, 4 if they never played); a straight flush or five of a kind going out doubles every payment. Scores always sum
  to zero. These thresholds are an adaptation of the 13-card scale to 14-card hands, not a published rule: change
  `RATES`.
- **Leaderboards are cumulative:** running total points, with games, wins, win % and points per game beside them, and a
  toggle to rank by per-game instead of total. Games with computer players are scored on their own board.
- **Seasons** are date ranges set by an admin (Admin > Seasons): a name, a start and an optional end, in the admin's local
  time (stored as UTC). A game counts in the season in which it **finished** (`starts <= finished < ends`). Seasons
  cannot overlap; gaps are allowed, and games in a gap count only in **All-time**. Boards can be viewed for the current
  season, any past or upcoming season, or all-time. Boards are calculated from the games, so editing a season's dates
  re-sorts its games (and is audit-logged); nothing is ever deleted. There is always a first season: "Season 1", created
  automatically, open-ended, starting at the earliest existing game.

## On a phone

The page is responsive and can be added to the home screen (it has a web app manifest and icons). Your hand is one
curved row tucked into the bottom edge of the table: **tap** a card to select it, or **swipe** across several to select
(or deselect) them; selected cards lift well clear of the row. Landscape has its own compact layout. If the app was in
the background for a few seconds it reconnects and re-syncs when you return.

To try it from a phone on your own network, run the server with `HOST=0.0.0.0`, find your computer's IP address, allow
the port through the firewall, and open `http://<that-ip>:<port>` on the phone. That is plain http on a home network;
use HTTPS for anything beyond that. Verified with Chrome's touch and phone-size emulation; **not tested on a real iPhone
or Android device**.

## Rules in this implementation

56 cards (a standard deck plus 4 wild jokers), 14 each. Ranks 3 < … < K < A < 2; suits ♦ < ♣ < ♥ < ♠. The 3♦ opens.
Singles, pairs, triples and five-card hands (straight, flush, full house, four of a kind + kicker, straight flush,
five of a kind). A straight is worth its highest card; ace and 2 are low in A-2-3-4-5 and 2-3-4-5-6, the two weakest
straights. You can pass even with the lead. If the next player has one card left, a single must be your highest. A
real card beats a joker when plays are otherwise equal. If nobody left can beat a play, the others are passed
automatically. The in-game **Rules** dialog has the full text.

## Layout

```
index.html, styles.css, favicon.svg, manifest.webmanifest, icon-*.png   the page and its installable-app files
src/            cards, hands (classification and ranking), moves (legal-move generation), game (state machine),
                scoring, ui.js (browser UI), online.js (API client), online-view.js (server view -> UI state)
src/ai/         easy (greedy), medium (heuristic planner), hard (determinised Monte Carlo tree search), worker
server/         index.js (HTTP, SSE, admin API), table.js, lobby.js, auth.js, db.js, hub.js, ai-pool.js, admin.js (CLI)
tools/          serve.js (solo static server), arena.js (headless AI tournaments)
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
