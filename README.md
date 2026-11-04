# Big Two (Hong Kong rules) with four wild jokers

A browser game. Play **solo** against three computer players (Easy, Medium, Hard), or **online**: accounts, one
shared game at a time, chat, points and leaderboards. No runtime dependencies beyond Node itself (the packages in
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
node server/admin.js make-admin <name>          # asks for a password (hidden) and a mobile number
node server/admin.js reset-password <name>
node server/admin.js set-phone <name>
node server/admin.js login-code <name>          # prints a one-time sign-in code, for when texts do not arrive
node server/admin.js list-users
```

(`BIG2_PASSWORD` and `BIG2_PHONE` supply those answers in scripts.) Then sign in (Online, top bar) and open **Admin**
to create users with a temporary password and a mobile number, reset passwords, set a number, disable or enable
accounts, promote or demote admins, open or close self-registration, cancel the running game, and read the audit log.
Every admin action is re-checked on the server and recorded. The last active admin cannot be removed or disabled.
Users change their own password with the **Password** button. There is no email, so a lost password is reset by an
admin.

**Signing in by text message.** When a text provider is configured (`SMS_PROVIDER` other than `none`), the sign-in
dialog has **Text me a code**: enter your name, and a 6-digit code goes to the number on file. The code is stored
hashed, lasts 10 minutes, allows 5 tries and works once; a new one replaces the old. Asking for a code answers the same
for any name, so names cannot be probed, and costs at most 3 texts an hour per name and 20 an hour per address. Texts
only ever go to numbers already on file. A correct code also proves the number. SMS is a weak factor (SIM swaps,
interception), which is acceptable for a card game; if texts are down, `login-code` above is the way in.

## Phone numbers and text messages

**Every account has a mobile number** (international format, e.g. `+44 7700 900123`): it is how we tell you it is your
turn. You cannot create an account without one (admin, command line or self-registration), a number can belong to only
one account, and an account from before this rule is asked for one before it can join a game. Numbers are stored in
E.164, shown to their owner only in masked form (`+44•••••••123`), masked again in the admin screen and in logs, and
never written to the audit log or sent to other players.

**Verification.** When a text provider is configured, a new number must be confirmed with a 6-digit code (hashed,
10 minutes, 5 tries, at most 3 codes an hour) before the person can join a game. With no provider there is nothing that
could deliver a code, so numbers are required but accepted as entered. Numbers set at the command line count as verified.

**When we text.** When the turn passes to a person, the server waits about 20 seconds, checks it is still their turn
and (by default) that they have no page open, then sends one text: `Big Two: it's your turn. <link>`. Never any cards. At
most one every 10 minutes and 12 a day per person, tracked in the database so a restart cannot repeat a text. People
can switch texts off in the **Phone** dialog. If the carrier reports that someone opted out (STOP), texting them stops
until they set their number again. A provider failure is logged and never affects the game.

| Variable                                                                                   | Meaning                                                                                                        |
| ------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------- |
| `SMS_PROVIDER`                                                                             | `none` (no texts), `console` (default for local use: prints them), `aws-sns`, `twilio`, `http`                 |
| `PUBLIC_URL`                                                                               | Address put in the text, e.g. `https://big2.example.com`                                                       |
| `SMS_WHEN`                                                                                 | `offline` (default: only if no page is open) or `always`                                                       |
| `SMS_DELAY_MS`                                                                             | Wait before texting (default 20000)                                                                            |
| `SMS_COOLDOWN_MS`                                                                          | Minimum gap between turn texts per person (default 600000)                                                     |
| `SMS_MAX_PER_DAY`                                                                          | Cap per person per 24 hours (default 12)                                                                       |
| `PHONE_VERIFICATION=off`                                                                   | Accept numbers without a code even when a provider is set                                                      |
| `PHONE_ALLOWED_PREFIXES`                                                                   | Comma list such as `+44,+1` to accept only those countries                                                     |
| `SMS_SENDER_ID`                                                                            | Sender name, where the country and provider allow one                                                          |
| `AWS_REGION`                                                                               | For `aws-sns`; credentials come from `AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY` or, on EC2, the instance role |
| `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM` or `TWILIO_MESSAGING_SERVICE_SID` | For `twilio`                                                                                                   |
| `SMS_HTTP_URL`, `SMS_HTTP_AUTHORIZATION`                                                   | For `http`: a JSON `POST {"to": "...", "body": "..."}` to your own endpoint (https required)                   |

Providers live in `server/sms/` behind one small interface (`send({to, body})`), call their services with `fetch` and
need no SDK, so adding another is a single file. The AWS provider signs requests itself (SigV4, checked against AWS's
published test vector) and needs only `sns:Publish` on `*`. **What AWS controls that code cannot:** a new account is in
the SMS _sandbox_ (it can text only numbers you have verified in the console) until you request production access, the
monthly spend limit starts low and must be raised, and many countries require a registered sender ID or number (in the
US this takes weeks). Check the current SNS documentation and pricing before relying on it. The `console` provider
prints verification codes: never use it in production.

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
tools/          arena.js (headless AI tournaments)
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
