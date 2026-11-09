// Browser front end: rendering, input, and turn sequencing. All rules live
// in game.js; AI decisions run in a Web Worker and only see observe() views.

import { isJoker, suitOf, isRedSuit, cardName, sortByRank, sortBySuit } from './cards.js';
import { cardSVG } from './card-art.js';
import { serializeSolo, readSavedSolo } from './solo-save.js';
import { scoreRound, forfeitPenalty } from './scoring.js';
import { classify, describe } from './hands.js';
import {
  newGame,
  applyMove,
  validatePlay,
  observe,
  turnRules,
  autoSkip,
  normalizePasses,
  mustPass,
  initialDeals,
  moveLog,
} from './game.js';
import { heuristicMove } from './ai/heuristic.js';
import { chooseMove } from './ai/agents.js';
import { api, connect } from './online.js';
import { mirrorState, newEvents, seatNames, isComputer, isAway, unrot } from './online-view.js';
import { createTrace, describeView } from './trace.js';
import { applyOrder, moveCard, slotAfter } from './hand-order.js';
import {
  describeDevice,
  alertState,
  firstPrompt,
  browserEnv,
  permission,
  registerWorker,
  currentSubscription,
  turnOn,
  turnOff,
  turnOffAll,
  howToAllow,
  syncSubscription,
} from './push-client.js';

// Seats are numbered clockwise from you. At a table of four they sit West, North, East; at three, West and East.
const SOLO_NAMES = { 4: ['You', 'West', 'North', 'East'], 3: ['You', 'West', 'East'] };
let NAMES = SOLO_NAMES[4];
const noActions = (n) => new Array(n).fill(null);
// The page has a North seat element; a table of three leaves it empty and puts seat 2 in the East one.
const seatElId = (p, n) => (n === 3 && p === 2 ? 3 : p);
const AI_DELAY_MS = 750;
const TRICK_PAUSE_MS = 1200;
const AI_TIMEOUT_MS = 10000;
const $ = (id) => document.getElementById(id);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let game = null;
let selected = new Set();
let shownTrick = null; // stays visible briefly after a trick closes
let seatActions = noActions(4);
let soloLog = []; // the lines of the solo game's log, oldest first (kept with the saved game)
let thinking = -1;
let busy = false;
let gen = 0; // bumps on New game so stale async work is dropped
let sortMode = localStorage.getItem('big2.sort') || 'rank';
// The order the player has made by hand (a list of card ids), one for the solo game and one for the online game, so
// going to the other screen and back keeps it. Every new deal clears it: the hand starts sorted.
const orders = { solo: null, online: null };
let lift = null; // a card being carried to a new place: { id, from, at, order }
const LEVEL_LABEL = { easy: 'Easy', medium: 'Medium', hard: 'Hard' };
let level = localStorage.getItem('big2.level');
if (!(level in LEVEL_LABEL)) level = 'medium'; // a stale or edited stored value must not reach the AI
let soloPlayers = localStorage.getItem('big2.players') === '3' ? 3 : 4; // seats at a solo table
// Online mode (see the section at the end of this file).
let mode = 'solo'; // 'solo' | 'online'
let user = null;
let table = null; // the server's latest view of my table
let histLen = 0; // history entries already shown
let sending = false; // a move is in flight
let trickReset = null;
let eventSource = null;
let lobbyGame = null; // summary of the one game, or null
let lobbySeason; // why there is or is not a table ({ state: 'none' | 'needs-players' | 'running', ... }); undefined until the server has said
let seasonUsers = []; // accounts an admin can put in a new season
const pickedIds = new Set(); // ...and the ones ticked so far, in the order they were ticked
let playersSeason = null; // the season whose players the dialog shows
let viewingLobby = false; // seated, but looking at the lobby instead of the table
let adminView = false;
let chatMsgs = [];
const trace = createTrace(); // what this page was sent and showed, for "Copy debug info" (see trace.js)
let lbSeason = 'current'; // 'current' | 'all' | a season id
let lbSort = 'points'; // 'points' (running total) | 'perGame'
let lbView = 'standings'; // 'standings' | 'stats' (luck and skill)
// An admin can look at the game as a player sees it (no admin controls); the choice is kept on this device.
const adminUi = () => !!user && user.isAdmin && localStorage.getItem('big2.view') !== 'player';
let devTables = false; // the server's development switch (computer seats and 3-seat tables online); off in production
let editingSeason = null;

// ---------- AI worker ----------
let worker = null;
const pending = new Map();
let reqId = 0;
try {
  worker = new Worker(new URL('./ai/worker.js', import.meta.url), { type: 'module' });
  worker.onmessage = (e) => {
    const resolve = pending.get(e.data.id);
    if (resolve) {
      pending.delete(e.data.id);
      resolve(e.data);
    }
  };
  worker.onerror = (e) => {
    console.error('AI worker failed; using main thread', e);
    worker = null;
    for (const [id, resolve] of pending) resolve({ id, error: 'worker failed' });
    pending.clear();
  };
} catch (err) {
  console.warn('Module workers unavailable; AI runs on the main thread', err);
  worker = null;
}

function askAI(view, lvl) {
  if (!worker) {
    const m = chooseMove(view, lvl === 'hard' ? 'medium' : lvl);
    return Promise.resolve({ cards: m ? m.cards : null });
  }
  return new Promise((resolve) => {
    const id = ++reqId;
    pending.set(id, resolve);
    worker.postMessage({ id, view, level: lvl });
    setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id);
        resolve({ id, error: 'timeout' });
      }
    }, AI_TIMEOUT_MS);
  });
}

// ---------- Card elements ----------
function cardEl(c, mini = false) {
  const el = document.createElement('div');
  el.className = 'card' + (mini ? ' mini' : '');
  if (isJoker(c)) {
    el.classList.add('joker');
    if (c >= 54) el.classList.add('red');
    el.title = 'Joker (wild)';
  } else {
    if (isRedSuit(suitOf(c))) el.classList.add('red');
    el.title = cardName(c);
  }
  el.innerHTML = cardSVG(c, mini);
  return el;
}

function cardRow(cards, mini = true) {
  const frag = document.createDocumentFragment();
  for (const c of cards) frag.appendChild(cardEl(c, mini));
  return frag;
}

// Lay card i of n on an arc, like a hand held in the fingers: rotate by
// θ = (i - (n-1)/2)·deg and drop by R(1 - cos θ) so the outer cards sit lower.
// The CSS composes these with the hover/selected lift.
function fanStyle(el, i, n, deg = 3, radius = 420) {
  const t = (i - (n - 1) / 2) * deg;
  el.style.setProperty('--a', `${t}deg`);
  el.style.setProperty('--y', `${(radius * (1 - Math.cos((t * Math.PI) / 180))).toFixed(1)}px`);
  return el;
}

function fanRow(cards, deg = 3) {
  const frag = document.createDocumentFragment();
  cards.forEach((c, i) => frag.appendChild(fanStyle(cardEl(c), i, cards.length, deg)));
  return frag;
}

// ---------- Rendering ----------
function renderSeat(p) {
  const el = $(`seat-${seatElId(p, game.hands.length)}`);
  el.classList.toggle('active', game.turn === p && game.winner < 0);
  el.innerHTML = '';
  const n = game.hands[p].length;
  const name = document.createElement('div');
  name.className = 'seat-name';
  name.innerHTML = `${NAMES[p]} <span class="count${n <= 2 ? ' low' : ''}">${n} card${n === 1 ? '' : 's'}</span>`;
  el.appendChild(name);
  const backs = document.createElement('div');
  backs.className = 'backs';
  for (let i = 0; i < n; i++) {
    const b = document.createElement('div');
    b.className = 'back';
    backs.appendChild(b);
  }
  el.appendChild(backs);
  // Phones show this instead of the row of backs (see the CSS): one card-back with the count.
  const stack = document.createElement('div');
  stack.className = 'stack';
  stack.innerHTML = `<div class="back"></div><span class="num${n <= 2 ? ' low' : ''}">${n}</span>`;
  el.appendChild(stack);
  el.appendChild(actionEl(p));
}

function actionEl(p) {
  const a = document.createElement('div');
  a.className = 'action';
  const act = seatActions[p];
  if (thinking === p) {
    a.innerHTML = '<span class="thinking">Thinking</span>';
  } else if (act === 'pass') {
    a.textContent = 'Pass';
  } else if (act === 'leadpass') {
    a.textContent = 'Passed the lead';
  } else if (act === 'cantbeat') {
    a.textContent = "Can't beat it";
  } else if (act) {
    a.appendChild(cardRow(act.cards));
  }
  return a;
}

function renderCenter() {
  const cards = $('trickCards');
  const label = $('trickLabel');
  cards.innerHTML = '';
  if (shownTrick) {
    cards.appendChild(fanRow(shownTrick.cards, 4));
    label.innerHTML = `${describe(shownTrick.cls)}<small>played by ${NAMES[shownTrick.by]}</small>`;
  } else {
    label.innerHTML = game.first ? '<small>Waiting for the 3♦ to open</small>' : '<small>New trick</small>';
  }
}

// Someone watching has no seat and no hand; the bottom seat is a player like the rest.
const watching = () => !!table && !!table.spectator;
const isMe = (p) => p === 0 && !watching();
const myTurn = () => !!game && game.winner < 0 && game.turn === 0 && !busy && !sending && !watching();

// My cards left to right: while one is being carried, as it would land; else the order I made; else the sort.
function shownHand() {
  if (lift) return lift.order;
  const mine = orders[mode];
  if (mine) return applyOrder(mine, game.hands[0]);
  return sortMode === 'rank' ? sortByRank(game.hands[0]) : sortBySuit(game.hands[0]);
}

function renderHand() {
  const handEl = $('hand');
  handEl.innerHTML = '';
  handEl.classList.toggle('disabled', !myTurn());
  const cards = watching() ? [] : shownHand();
  const deg = PHONE.matches ? 2.3 : 3; // a gentler curve keeps 14 cards inside a phone's width
  cards.forEach((c, i) => {
    const el = fanStyle(cardEl(c), i, cards.length, deg);
    el.dataset.id = String(c);
    if (selected.has(c)) el.classList.add('selected');
    if (lift && lift.id === c) el.classList.add('carried');
    handEl.appendChild(el); // taps and swipes are handled on the hand itself (below)
  });
  const me = $('seat-0');
  const fan = $('playedFan');
  me.innerHTML = '';
  fan.innerHTML = '';
  const who = watching() ? NAMES[0] : 'You';
  if (seatActions[0] === 'pass') me.textContent = `${who} passed`;
  else if (seatActions[0] === 'leadpass') me.textContent = `${who} passed the lead`;
  else if (seatActions[0] === 'cantbeat') me.textContent = `${who} can't beat it`;
  else if (seatActions[0]) {
    me.textContent = `${who} played`;
    fan.appendChild(fanRow(seatActions[0].cards));
  }
  document.querySelector('.me').classList.toggle('active', game.turn === 0 && game.winner < 0);
  fitHand();
}

// A hand of 14 fits at the stylesheet's overlap, but at a table of three it can hold 20 cards. If the
// row would be wider than its section, overlap the cards more: width = n*cw - (n-1)*overlap, so
// overlap = (n*cw - available) / (n-1). The stylesheet's value is never reduced, only increased, and
// it goes in --hand-overlap so the width of the highlighted section (computed from --overlap) is unchanged.
const HAND_SLACK = 8; // px kept free for the tilt of the outer cards
function fitHand() {
  const me = document.querySelector('.me');
  const n = $('hand').children.length;
  me.style.removeProperty('--hand-overlap');
  // Not laid out yet (the table is hidden, so the width is 0): measuring now would give nonsense. The
  // observer below calls this again once the section has a size.
  if (n < 2 || me.clientWidth === 0) return;
  const cs = getComputedStyle(me);
  const cw = parseFloat(cs.getPropertyValue('--cw'));
  const base = parseFloat(cs.getPropertyValue('--overlap'));
  const avail = me.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight) - HAND_SLACK;
  const needed = (n * cw - avail) / (n - 1);
  if (Number.isFinite(needed) && Number.isFinite(base) && needed > base) {
    me.style.setProperty('--hand-overlap', `${Math.min(needed, cw - 8)}px`);
  }
}
// Re-fit whenever the section changes size: a resize, a rotation, or the table appearing.
new ResizeObserver(fitHand).observe(document.querySelector('.me'));

// Selecting cards: tap one to toggle it, or drag a finger (or the mouse) across
// several to select, or deselect, all of them. 14 overlapped cards on a phone
// leave only a thin slice of each exposed, so a swipe is easier than 5 exact taps.
// The first card touched decides whether the drag selects or deselects.
const PHONE = window.matchMedia('(max-width: 700px)');
PHONE.addEventListener('change', () => game && render());
let drag = null;
const cardAt = (x, y) => {
  const el = document.elementFromPoint(x, y);
  const card = el && el.closest ? el.closest('#hand .card') : null;
  return card ? Number(card.dataset.id) : null;
};
// While dragging, pick the card by where the finger is along the row, from the
// cards' layout positions. (elementFromPoint would hit a lifted, enlarged card
// that overlaps its neighbours' slices and skip them.)
const slotAt = (x, y) => {
  const hand = $('hand');
  const kids = [...hand.children];
  const r = hand.getBoundingClientRect();
  if (!kids.length || y < r.top - 90 || y > r.bottom + 60 || x < r.left - 4 || x > r.right + 4) return null;
  const base = kids[0].offsetLeft;
  let idx = 0;
  for (let i = 0; i < kids.length; i++) if (kids[i].offsetLeft - base <= x - r.left) idx = i;
  return Number(kids[idx].dataset.id);
};
function dragOver(id) {
  if (!drag || id === null || drag.seen.has(id) || game.winner >= 0) return;
  drag.seen.add(id);
  drag.undo.push([id, selected.has(id)]);
  if (drag.select) selected.add(id);
  else selected.delete(id);
  render();
}

// Rearranging: hold a card for LIFT_MS without moving it more than LIFT_SLOP and it comes away from the hand; slide it
// along and let go where you want it. A quicker swipe is still the select-swipe above, so the two never clash.
const LIFT_MS = 250;
const LIFT_SLOP = 8; // px
function startLift() {
  if (!drag || !game || watching()) return;
  const { id, undo } = drag;
  drag.timer = null;
  for (const [c, was] of undo.reverse()) {
    // the press toggled it: a carried card is not being selected
    if (was) selected.add(c);
    else selected.delete(c);
  }
  const order = shownHand();
  const from = order.indexOf(id);
  lift = { id, from, at: from, order, x: drag.x, step: 0 };
  drag = null;
  navigator.vibrate?.(12);
  render();
  const kids = $('hand').children; // the cards' spacing, measured once on the hand as it is
  lift.step = kids.length > 1 ? kids[1].offsetLeft - kids[0].offsetLeft : 0;
}
function moveLift(x) {
  const at = slotAfter(lift.from, x - lift.x, lift.step, lift.order.length);
  if (at === lift.at) return;
  lift.at = at;
  lift.order = moveCard(lift.order, lift.id, at);
  renderHand();
}
function endLift(commit) {
  if (!lift) return;
  const done = lift;
  lift = null;
  if (commit && done.at !== done.from) orders[mode] = done.order; // dropped where it was: nothing to remember
  render();
}
$('hand').addEventListener('pointerdown', (e) => {
  if (e.pointerType === 'mouse' && e.button !== 0) return;
  const id = cardAt(e.clientX, e.clientY);
  if (id === null || !game) return;
  drag = { select: !selected.has(id), seen: new Set(), undo: [], id, x: e.clientX, y: e.clientY, timer: null };
  try {
    $('hand').setPointerCapture(e.pointerId); // keep receiving moves after the cards are re-rendered
  } catch {
    /* synthetic pointer: no capture needed */
  }
  dragOver(id);
  if (drag) drag.timer = setTimeout(startLift, LIFT_MS);
});
$('hand').addEventListener('pointermove', (e) => {
  if (lift) return moveLift(e.clientX);
  if (!drag) return;
  if (drag.timer && Math.hypot(e.clientX - drag.x, e.clientY - drag.y) > LIFT_SLOP) {
    clearTimeout(drag.timer); // it is a swipe, not a hold
    drag.timer = null;
  }
  dragOver(slotAt(e.clientX, e.clientY));
});
$('hand').addEventListener('pointerup', () => {
  if (drag) clearTimeout(drag.timer);
  drag = null;
  endLift(true);
});
for (const type of ['pointercancel', 'lostpointercapture']) {
  $('hand').addEventListener(type, () => {
    if (drag) clearTimeout(drag.timer);
    drag = null;
    endLift(false); // the browser took the gesture away (or it was never finished): the hand stays as it was
  });
}
// While a card is carried the finger must not scroll the page or open a menu.
$('hand').addEventListener('touchmove', (e) => lift && e.preventDefault(), { passive: false });
$('hand').addEventListener('contextmenu', (e) => e.preventDefault());

function renderSelection() {
  const info = $('selInfo');
  if (watching()) {
    const n = game.hands[0].length;
    info.textContent = `${NAMES[0]} has ${n} card${n === 1 ? '' : 's'}`;
    for (const id of ['playBtn', 'passBtn', 'clearBtn']) $(id).disabled = true;
    return;
  }
  const cards = [...selected];
  let canPlay = false;
  // Whose move it is when it is not mine: said next to the selection, so a green combination is not mistaken for
  // "you can play this now".
  const waiting =
    game.winner < 0 && game.turn !== 0 ? `${game.passed[0] ? 'you passed; ' : ''}waiting for ${NAMES[game.turn]}` : '';
  if (!cards.length) {
    info.innerHTML = myTurn() ? '<span class="muted">Select cards to play</span>' : '';
    if (!myTurn() && waiting && game.passed[0]) info.innerHTML = `<span class="muted">${waiting}</span>`;
  } else {
    const cls = classify(cards);
    const err = myTurn() ? validatePlay(game, cards) : null;
    canPlay = myTurn() && !err;
    if (!cls) info.innerHTML = '<span class="bad">Not a valid combination</span>';
    else if (err) info.innerHTML = `${describe(cls)} · <span class="bad">${err}</span>`;
    else if (waiting) info.innerHTML = `${describe(cls)} · <span class="muted">${waiting}</span>`;
    else info.innerHTML = `<span class="ok">${describe(cls)}</span>`;
  }
  $('playBtn').disabled = !canPlay;
  $('passBtn').disabled = !(myTurn() && turnRules(game).canPass);
  $('clearBtn').disabled = selected.size === 0;
  $('sortBtn').textContent = orders[mode] ? 'Sort: mine' : `Sort: ${sortMode}`;
}

function render() {
  $('tableMain').classList.toggle('spectating', watching());
  const n = game.hands.length;
  $('seat-2').hidden = n === 3; // the North seat is empty at a table of three
  for (let p = 1; p < n; p++) renderSeat(p);
  renderCenter();
  renderHand();
  renderSelection();
}

function setStatus(text) {
  $('status').textContent = text;
}

function log(text, cls = '', cards = null) {
  const li = document.createElement('li');
  if (cls) li.className = cls;
  li.textContent = text;
  if (cards) {
    const span = document.createElement('div');
    span.className = 'cards-txt';
    span.textContent = cards.map(cardName).join(' ');
    li.appendChild(span);
  }
  $('log').prepend(li);
  if (mode === 'solo') soloLog.push({ text, cls, cards });
  else trace.add('log', { text, cards: cards ? [...cards] : null });
}

// ---------- Turn flow ----------
function renderSoloChip() {
  $('soloChip').textContent = `${soloPlayers} players · ${LEVEL_LABEL[level]}`;
}

// A new play gives every other seat another turn, so their "Pass" and "Can't beat it" markers (and any passed
// lead) from before it no longer say anything.
function clearOldMarkers() {
  for (let q = 0; q < seatActions.length; q++) {
    if (['pass', 'leadpass', 'cantbeat'].includes(seatActions[q])) seatActions[q] = null;
  }
}

function startGame() {
  soloGameId = newGameId();
  renderSoloChip();
  gen++;
  pending.clear();
  NAMES = SOLO_NAMES[soloPlayers];
  game = newGame(Math.random, null, soloPlayers);
  orders.solo = null; // a new deal: the hand starts sorted
  lift = null;
  selected = new Set();
  shownTrick = null;
  seatActions = noActions(soloPlayers);
  thinking = -1;
  busy = false;
  $('log').innerHTML = '';
  soloLog = [];
  $('overlay').hidden = true;
  const opener = game.turn === 0 ? 'You have the 3♦ and lead.' : `${NAMES[game.turn]} has the 3♦ and leads.`;
  log(`New round. ${opener}`, 'sys');
  saveSolo();
  continueTurn();
}

// ---- a solo game survives a trip to the online screen, and a reload ----
// The game is kept in this browser after every move, and brought back when you return to Solo or reload. (Nothing
// is sent to the server.) What is read back is checked first (src/solo-save.js); if anything is wrong, a new game
// is dealt instead.
const soloSaveKey = () => `big2.solo.${user ? user.id : 'nobody'}`;

function saveSolo() {
  if (mode !== 'solo' || !game || !soloGameId) return;
  try {
    localStorage.setItem(
      soloSaveKey(),
      serializeSolo({
        id: soloGameId,
        level,
        players: game.hands.length,
        game,
        shownTrick,
        seatActions,
        log: soloLog,
        overlay: !$('overlay').hidden,
      }),
    );
  } catch {
    /* storage is full or blocked: this game just will not survive */
  }
}

// Returns true if a saved game was put back (and play carried on from it).
function restoreSolo() {
  let raw;
  try {
    raw = localStorage.getItem(soloSaveKey());
  } catch {
    return false;
  }
  const s = readSavedSolo(raw, Object.keys(LEVEL_LABEL));
  if (!s) return false;
  soloGameId = s.id;
  level = s.level; // the settings are fixed for the whole game, so they come back with it
  soloPlayers = s.players;
  renderSoloChip();
  gen++;
  pending.clear();
  NAMES = SOLO_NAMES[soloPlayers];
  game = s.game;
  normalizePasses(game); // a game saved under the old pass rule is brought in line with the current one
  selected = new Set();
  // A play still on the table keeps its display; a closed trick has had its pause, so the table is clear.
  const open = game.trick !== null;
  shownTrick = open ? s.shownTrick : null;
  seatActions = open ? s.seatActions : noActions(soloPlayers);
  thinking = -1;
  busy = false;
  $('log').innerHTML = '';
  soloLog = [];
  for (const l of s.log) log(l.text, l.cls, l.cards); // oldest first; log() puts the newest on top
  $('overlay').hidden = true;
  if (game.winner >= 0) {
    // A finished game comes back with its result showing (and Play again on it), whether or not it was closed.
    render();
    showSoloEnd();
    const w = game.winner;
    setStatus(w === 0 ? 'Game over: you went out and won.' : `Game over: ${NAMES[w]} went out and wins.`);
    return true;
  }
  continueTurn(); // if it is the computer's move, it is asked again
  return true;
}
window.addEventListener('pagehide', saveSolo);

function myTurnMessage() {
  if (mustPass(game)) return 'Nothing in your hand beats that, so you pass.'; // the pass is made for you
  let msg;
  if (game.first) msg = 'You have the 3♦: open with a play that includes it.';
  else if (game.trick) msg = `Beat ${game.trick.cls.label}, or pass.`;
  else if (turnRules(game).canPass) msg = 'Your lead: play anything, or pass the lead on.';
  else msg = 'The lead came all the way back round: you must play.';
  if (turnRules(game).singleKey >= 0) msg += ` ${NAMES[1]} has one card left, so any single must be your highest.`;
  return msg;
}

async function continueTurn() {
  const g = gen;
  busy = false;
  render();
  if (game.winner >= 0) {
    endRound();
    return;
  }
  if (game.turn === 0) {
    setStatus(myTurnMessage());
    if (mustPass(game)) autoPassMe(g);
    return;
  }
  busy = true;
  thinking = game.turn;
  setStatus(`${NAMES[game.turn]} is thinking…`);
  render();
  const view = observe(game, game.turn);
  const [res] = await Promise.all([askAI(view, level), sleep(AI_DELAY_MS)]);
  if (g !== gen) return;
  thinking = -1;
  let cards = res.cards ?? null;
  if (res.error || validatePlay(game, cards)) {
    // Should never happen; fall back to the main-thread heuristic.
    console.error('AI response rejected', res);
    const m = heuristicMove(view);
    cards = m ? m.cards : null;
  }
  await commit(cards);
}

// You hold nothing that beats the play on the table, so the pass is made for you after a short pause (long enough to
// read what is on the table). It is an ordinary pass: the log says "You passed". Passing yourself first is fine.
const AUTO_PASS_MS = 1000;
async function autoPassMe(g) {
  const at = game.history.length;
  await sleep(AUTO_PASS_MS);
  if (g !== gen || game.history.length !== at || game.turn !== 0 || game.winner >= 0 || busy) return;
  selected = new Set();
  await commit(null);
}

async function commit(cards) {
  const g = gen;
  busy = true;
  const p = game.turn;
  const hadTrick = game.trick !== null;
  const leadPass = !cards && !hadTrick;
  const cls = cards ? classify(cards) : null;
  applyMove(game, cards, cls);
  seatActions[p] = cards ? { cards, cls } : leadPass ? 'leadpass' : 'pass';
  let skipped = [];
  if (cards) {
    shownTrick = { cards, cls, by: p };
    // A new trick starts: clear the previous trick's lead-pass markers.
    clearOldMarkers();
    log(`${NAMES[p]}: ${describe(cls)}`, p === 0 ? 'you' : '', cards);
    skipped = autoSkip(game);
    for (const q of skipped) seatActions[q] = 'cantbeat';
  } else {
    log(leadPass ? `${NAMES[p]} passed the lead` : `${NAMES[p]} passed`, p === 0 ? 'you' : '');
  }
  saveSolo(); // the move is made: keep the game as it now stands
  // The trick closed: everyone else passed, or nobody could beat the play.
  // (A lead pass also leaves the table empty, but closes nothing.)
  if (game.winner < 0 && game.trick === null && !leadPass) {
    render();
    let who;
    if (skipped.length) {
      const whose = p === 0 ? 'your' : `${NAMES[p]}'s`;
      who = `Nobody can beat ${whose} ${describe(cls)}. ${p === 0 ? 'You lead' : `${NAMES[p]} leads`} again`;
    } else {
      who = game.turn === 0 ? 'You win the trick' : `${NAMES[game.turn]} wins the trick`;
    }
    setStatus(`${who}.`);
    log(`${who}.`, 'sys');
    await sleep(TRICK_PAUSE_MS);
    if (g !== gen) return;
    shownTrick = null;
    seatActions = noActions(game.hands.length);
  }
  continueTurn();
}

function endRound() {
  const w = game.winner;
  setStatus('');
  // The round is reported to my own solo table (kept and retried if the server cannot be reached).
  reportSoloResult({
    clientId: soloGameId,
    level,
    players: game.hands.length,
    won: w === 0,
    delta: scoreRound(game).delta[0],
    // The deal and every play, so the game can be studied and used for training (the server plays it again to check it).
    record: { deals: initialDeals(game), moves: moveLog(game) },
  });
  log(w === 0 ? 'You went out. You win!' : `${NAMES[w]} went out and wins.`, 'sys');
  showSoloEnd();
  saveSolo();
}

// The result of a finished solo game: who won and what everyone else was left holding.
function showSoloEnd() {
  const w = game.winner;
  $('endTitle').textContent = w === 0 ? 'You win! 🎉' : `${NAMES[w]} wins`;
  const box = $('endHands');
  box.innerHTML = '';
  for (let p = 0; p < game.hands.length; p++) {
    if (p === w) continue;
    const row = document.createElement('div');
    row.className = 'end-row';
    row.innerHTML = `<span class="who">${NAMES[p]}</span>`;
    const cards = document.createElement('div');
    cards.className = 'cards';
    cards.appendChild(cardRow(sortByRank(game.hands[p])));
    row.appendChild(cards);
    box.appendChild(row);
  }
  $('overlay').hidden = false;
}

// ---------- Input ----------
function playSelected() {
  if (!myTurn()) return;
  const cards = [...selected];
  const err = validatePlay(game, cards);
  if (err) {
    setStatus(err);
    return;
  }
  selected = new Set();
  if (mode === 'online') sendMove(cards);
  else commit(cards);
}

function pass() {
  if (!myTurn() || !turnRules(game).canPass) return;
  selected = new Set();
  if (mode === 'online') sendMove(null);
  else commit(null);
}

$('playBtn').addEventListener('click', playSelected);
$('passBtn').addEventListener('click', pass);
$('clearBtn').addEventListener('click', () => {
  selected = new Set();
  render();
});
$('sortBtn').addEventListener('click', () => {
  if (orders[mode]) {
    orders[mode] = null; // from my own order back to the sort that was on
  } else {
    sortMode = sortMode === 'rank' ? 'suit' : 'rank';
    localStorage.setItem('big2.sort', sortMode);
  }
  render();
});
// The settings of a solo game are chosen here and then fixed: the header only shows them. Starting a
// game replaces the one in progress, so the dialog says so when one is (the opening play has been made).
const gameInProgress = () => mode === 'solo' && !!game && game.winner < 0 && !game.first;
$('newBtn').addEventListener('click', () => {
  $('ngPlayers').value = String(soloPlayers);
  $('ngLevel').value = level;
  show('ngWarn', gameInProgress());
  $('newGameDlg').showModal();
});
$('ngStart').addEventListener('click', () => {
  soloPlayers = $('ngPlayers').value === '3' ? 3 : 4;
  level = $('ngLevel').value in LEVEL_LABEL ? $('ngLevel').value : 'medium';
  localStorage.setItem('big2.players', String(soloPlayers));
  localStorage.setItem('big2.level', level);
  $('newGameDlg').close();
  startGame();
});
$('ngCancel').addEventListener('click', () => $('newGameDlg').close());
$('helpBtn').addEventListener('click', () => {
  const dlg = $('helpDlg');
  dlg.showModal();
  dlg.scrollTop = 0; // focus lands on the Close button at the bottom, which would scroll the page down
});
$('helpClose').addEventListener('click', () => $('helpDlg').close());
$('helpX').addEventListener('click', () => $('helpDlg').close());
$('againBtn').addEventListener('click', () => (mode === 'online' ? startOnlineRound() : startGame()));
// After a solo round: choose the level and players first, just look at the table, or go to the online lobby.
$('againNewBtn').addEventListener('click', () => $('newBtn').click());
$('endClose').addEventListener('click', () => {
  $('overlay').hidden = true;
  saveSolo();
});
// The play log (and the chat under it). Beside the table it can be folded away. On a phone there is
// no room beside the table, so it is a sheet over it: the Log button opens it, the × closes it.
const logPanel = document.querySelector('.log');
const LOG_SHEET = window.matchMedia('(max-width: 700px), (orientation: landscape) and (max-height: 520px)');
const logWanted = () => (LOG_SHEET.matches ? false : (localStorage.getItem('big2.log') || 'open') === 'open');
const logIsOpen = () =>
  LOG_SHEET.matches ? document.body.classList.contains('log-open') : !logPanel.classList.contains('collapsed');
const LOG_OPENERS = ['logBtn', 'waitLogBtn']; // at the table, and in the waiting room (where chat is all there is)
function setLogOpen(open) {
  const sheet = LOG_SHEET.matches;
  logPanel.classList.toggle('collapsed', !sheet && !open);
  document.body.classList.toggle('log-open', sheet && open);
  $('logToggle').setAttribute('aria-expanded', String(open));
  for (const id of LOG_OPENERS) $(id).setAttribute('aria-expanded', String(sheet && open));
  if (sheet && open) {
    for (const id of LOG_OPENERS) $(id).classList.remove('unread');
    $('log').scrollTop = $('log').scrollHeight;
  }
}
setLogOpen(logWanted());
LOG_SHEET.addEventListener('change', () => setLogOpen(logWanted()));
$('logToggle').addEventListener('click', () => {
  const open = !logIsOpen();
  setLogOpen(open);
  if (!LOG_SHEET.matches) localStorage.setItem('big2.log', open ? 'open' : 'closed');
});
for (const id of LOG_OPENERS) $(id).addEventListener('click', () => setLogOpen(true));
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && LOG_SHEET.matches && logIsOpen()) setLogOpen(false);
});
document.addEventListener('keydown', (e) => {
  if (document.querySelector('dialog[open]') || ['SELECT', 'INPUT'].includes(e.target.tagName)) return;
  if (e.key === 'Enter') playSelected();
  else if (e.key === 'p' || e.key === 'P') pass();
  else if (e.key === 'Escape') {
    selected = new Set();
    render();
  }
});

// ---------- Online mode ----------
// The server owns the game. Every update arrives as this seat's view; it is
// rotated into a local game-shaped mirror (online-view.js) so the rendering,
// selection and validation above work unchanged. There is one game at a time;
// a started game holds its seats until it finishes or an admin cancels it.

const show = (id, on) => {
  $(id).hidden = !on;
};

let passwordChanging = false;
let acceptAny = true; // after (re)connecting, take the first view whatever its version
let lbSeq = 0;
let resetTarget = null;

function setModeUi(next) {
  mode = next;
  document.body.classList.toggle('online', next === 'online');
  document.body.classList.toggle('solo', next === 'solo');
  $('modeSolo').classList.toggle('active', next === 'solo');
  $('modeOnline').classList.toggle('active', next === 'online');
  localStorage.setItem('big2.mode', next);
}

function enterSolo() {
  closeStream();
  clearTrickReset();
  table = null;
  sending = false;
  adminView = false;
  viewingLobby = false;
  show('lobby', false);
  show('admin', false);
  show('chat', false);
  show('tableMain', true);
  show('againBtn', true); // online hides it for guests
  setModeUi('solo');
  setStatus(''); // whatever the online screen last said (a table waiting for someone) is not about this game
  if (!restoreSolo()) startGame();
}

// Going online takes a moment (it asks the server who you are). While that is under way, a second request, such as
// pressing Admin just as the page opens, joins it instead of starting a second copy that would reset the screen.
let enteringOnline = null;
function enterOnline() {
  enteringOnline ??= startOnline().finally(() => {
    enteringOnline = null;
  });
  return enteringOnline;
}

async function startOnline() {
  saveSolo(); // a solo game in progress is kept for when you come back
  gen++; // drops any solo round still waiting on an AI
  busy = false;
  pending.clear();
  setModeUi('online');
  $('log').innerHTML = '';
  $('overlay').hidden = true;
  show('tableMain', false);
  show('admin', false);
  show('lobby', true);
  show('lobbyHome', false); // shown once we know who is signed in
  show('waitRoom', false);
  try {
    user = (await api.me()).user;
  } catch {
    user = null;
  }
  if (!user) return sessionLost();
  beginOnline();
}

// The account menu has the same items in a solo game and online: Admin and the view switch for admins, Turn
// alerts, Password, My solo stats, Log out.
function renderAccountMenu() {
  show('passwordBtn', true);
  show('alertsBtn', true);
  show('adminBtn', adminUi());
  show('viewBtn', user.isAdmin);
  show('debugBtn', mode === 'online');
  renderViewBtn();
}

// What to send when a screen does not match the game: this page's trace and its log as shown. Never the player's
// own hand. Copied to the clipboard, or downloaded if the browser will not allow that.
async function copyDebugInfo() {
  const info = {
    when: new Date().toISOString(),
    user: user ? user.name : null,
    agent: navigator.userAgent,
    visible: document.visibilityState,
    table: table ? describeView(table) : null,
    logShown: [...document.querySelectorAll('#log li')].map((li) => li.textContent), // newest first
    trace: trace.dump(),
  };
  const text = JSON.stringify(info, null, 1);
  const msg = $('debugMsg');
  try {
    await navigator.clipboard.writeText(text);
    msg.textContent = 'Copied. Paste it into a message to Stephen.';
  } catch {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
    a.download = 'big2-debug.json';
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    msg.textContent = 'Saved as big2-debug.json; send that file to Stephen.';
  }
}

function beginOnline() {
  $('who').textContent = user.name;
  show('account', true);
  renderAccountMenu();
  document.body.dataset.online = 'ready'; // the online session has begun (the browser tests wait for this)
  adminView = false;
  viewingLobby = false;
  table = null;
  chatMsgs = [];
  openStream();
  refreshSeasons();
  refreshLeaderboard();
  route();
  startAlerts();
}

// (Re)open the live stream. The server answers every connection with the
// current lobby, my table (or null) and chat history, so reconnecting is safe.
function openStream() {
  closeStream();
  eventSource = connect({
    onOpen: () => {
      acceptAny = true;
      trace.add('open');
    },
    onLobby: ({ game, season }) => {
      lobbyGame = game;
      lobbySeason = season ?? null;
      route();
    },
    onTable,
    onChat: (m) => {
      if (!chatMsgs.some((x) => x.id === m.id)) chatMsgs.push(m);
      // A message from someone else while the sheet is shut: mark the Log button.
      if (LOG_SHEET.matches && !logIsOpen() && user && m.name !== user.name) {
        for (const id of LOG_OPENERS) $(id).classList.add('unread');
      }
      renderChat();
    },
    onChatHistory: (history) => {
      chatMsgs = history;
      renderChat();
    },
    onError: async () => {
      // EventSource retries by itself; only a dead session needs action. (While
      // I change my own password the server drops my stream on purpose, and the
      // fresh cookie may not have arrived yet.)
      if (passwordChanging) return;
      try {
        await api.me();
      } catch (err) {
        if (err.status === 401) sessionLost();
      }
    },
  });
}

// Phones suspend background pages, and an event stream can die without any
// error. Coming back after a few seconds, just reconnect: it re-sends everything.
let hiddenAt = 0;
function resync() {
  if (mode !== 'online' || !user || passwordChanging) return;
  openStream();
  refreshLeaderboard();
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') hiddenAt = Date.now();
  else if (hiddenAt && Date.now() - hiddenAt > 3000) {
    hiddenAt = 0;
    resync();
  }
});
window.addEventListener('pageshow', (e) => e.persisted && resync());
window.addEventListener('online', resync);

function closeStream() {
  if (eventSource) eventSource.close();
  eventSource = null;
}

// The server no longer knows me (expired, signed out elsewhere, account disabled): a reload
// brings the sign-in page, since the game is only served to a signed-in user.
function sessionLost() {
  closeStream();
  location.reload();
}

// ---- which screen is showing ----
// table: the game table; lobby: sign-in home or the waiting room; admin.
// "The game starts in 7s": counted down in the browser from the moment the server's view arrived.
let countdownTimer = null;
function renderCountdown() {
  const t = table;
  let line = '';
  if (t && t.next) {
    const s = Math.max(0, Math.ceil((t.next.deadline - Date.now()) / 1000));
    line =
      t.next.kind === 'start'
        ? `The game starts in ${s}s.`
        : `The next game starts in ${s}s, with the same players if you stay seated.`;
  }
  $('waitCount').textContent = t && t.status === 'waiting' ? line : '';
  $('endCount').textContent = t && t.status === 'done' ? line : '';
}
function syncCountdown() {
  clearInterval(countdownTimer);
  countdownTimer = null;
  if (table && table.next) {
    table.next.deadline = Date.now() + table.next.ms;
    countdownTimer = setInterval(renderCountdown, 500);
  }
  renderCountdown();
  renderLeaveButtons();
}

// What Leave can do for me right now comes from the server (t.leave): 'free', 'forfeit' (mid-game: it costs the most a
// round can) or null. Leaving mid-game asks first, in a popup that says what it costs.
function renderLeaveButtons() {
  const rule = table ? table.leave : null;
  const forfeit = !!table && table.status === 'playing' && rule === 'forfeit';
  show('forfeitBtn', forfeit);
  const spec = watching();
  show('watchStopBtn', spec);
  $('waitLeave').textContent = spec ? 'Stop watching' : 'Leave table';
  if (!devTables) {
    show('endLeave', spec || (!!table && table.status === 'done' && rule === 'free'));
    $('endLeave').textContent = spec ? 'Stop watching' : 'Leave table';
  }
}

async function forfeitSeat() {
  const cost = forfeitPenalty(table.seats.length);
  const sure = await confirmAction({
    title: 'Leave the game?',
    text: `Leaving a game in progress costs you ${cost} points, the most a round can, and the game does not count for the other players. The next player in line takes your seat and you go to the back of the line.`,
    ok: `Leave and lose ${cost} points`,
  });
  if (!sure) return;
  try {
    const r = await api.leave();
    if (r.game !== undefined) lobbyGame = r.game;
    if (r.season !== undefined) lobbySeason = r.season;
    onTable(r.table);
  } catch (err) {
    setStatus(err.message);
  }
}

function renderViewBtn() {
  $('viewBtn').textContent = adminUi() ? 'Switch to player view' : 'Switch to admin view';
}

function route() {
  if (mode !== 'online' || !user) return;
  const seated = !!table;
  const waiting = seated && table.status === 'waiting';
  const onTableScreen = !adminView && seated && !waiting && !viewingLobby;
  const inLobby = !adminView && !onTableScreen;
  show('tableMain', onTableScreen);
  show('admin', adminView);
  show('lobby', inLobby);
  show('lobbyHome', inLobby && !waiting);
  show('waitRoom', inLobby && waiting);
  $('overlay').hidden = !(onTableScreen && table.status === 'done');
  $('adminBtn').classList.toggle('active', adminView);
  // Away from the table while it is my move: a dot on Online says so.
  $('modeOnline').classList.toggle('attention', myMoveWaiting() && !onTableScreen);
  if (inLobby && !waiting) renderLobbyHome();
  if (inLobby && waiting) renderWaitRoom(table);
  renderChat();
}

// Why there is no table (production): no season, or a season that is short of players.
function noTableNote() {
  const s = lobbySeason;
  if (s && s.state === 'needs-players') {
    const base = `${s.name} is running but has ${s.players} of the ${s.needed} players it needs, so there is no table yet.`;
    return adminUi()
      ? `${base} Add ${s.needed - s.players} more under Admin, then Seasons, then Players.`
      : `${base} An admin adds the players.`;
  }
  return adminUi()
    ? 'No season is running, so there is no table. Create a season under Admin, then Seasons, and pick its players.'
    : 'There is no table right now: games run while a season is running.';
}

function renderLobbyHome() {
  const box = $('gameBox');
  box.innerHTML = '';
  const g = lobbyGame;
  const line = (text, cls) => {
    const p = document.createElement('p');
    p.textContent = text;
    if (cls) p.className = cls;
    box.appendChild(p);
  };
  const button = (label, onClick, primary = true) => {
    const b = document.createElement('button');
    b.className = primary ? 'primary' : 'ghost';
    b.textContent = label;
    b.addEventListener('click', onClick);
    return b;
  };
  // Only with the development rules does an admin create games by hand; otherwise the table runs itself.
  show('createRow', devTables && adminUi() && (!g || g.status === 'done'));
  if (!g) {
    if (devTables) {
      if (!adminUi()) line('No game is running. An admin starts the games.', 'muted');
    } else if (lobbySeason !== undefined) {
      line(noTableNote(), 'muted'); // (not before the server has said why: that would flash the wrong reason)
    }
    return;
  }
  // The current game, as a card: who is hosting, where it is up to, who is in, and what the empty seats get.
  const state = devTables
    ? { waiting: 'Waiting to start', playing: 'In progress', done: 'Just finished' }[g.status] || g.status
    : {
        waiting: g.humans === g.seats ? 'Starting' : 'Waiting for players',
        playing: 'In progress',
        done: 'Just finished: the next game starts soon',
      }[g.status] || g.status;
  const empty = g.seats - g.humans;
  const facts = document.createElement('dl');
  facts.className = 'facts';
  for (const [label, value] of [
    ...(devTables ? [['Host', g.host]] : []),
    ['Status', state],
    ['Table', `${g.seats} seats`],
    ['Players', `${g.players.length ? g.players.join(', ') : 'nobody yet'} (${g.humans} of ${g.seats})`],
    ...(!devTables && g.watching ? [['Watching', String(g.watching)]] : []),
    ...(devTables
      ? [
          [
            'Computer',
            empty > 0
              ? `${LEVEL_LABEL[g.aiLevel] || g.aiLevel} AI plays the ${empty} empty seat${empty === 1 ? '' : 's'}, so this game will not count on the leaderboard`
              : 'no computer players',
          ],
        ]
      : []),
  ]) {
    const dt = document.createElement('dt');
    dt.textContent = label;
    const dd = document.createElement('dd');
    dd.textContent = value;
    facts.append(dt, dd);
  }
  box.appendChild(facts);
  const row = document.createElement('div');
  row.className = 'row';
  const backToTable = () => {
    viewingLobby = false;
    route();
  };
  if (table && !table.spectator) {
    if (myMoveWaiting()) line("It's your turn in your game.", 'turn-note');
    row.appendChild(button(g.status === 'done' ? 'See the result' : 'Rejoin your game', backToTable));
  } else if (table) {
    row.appendChild(button('Back to the table', backToTable));
    row.appendChild(button('Stop watching', leaveTable, false));
  } else if (devTables && g.status === 'waiting') {
    row.appendChild(button('Join game', joinGame));
  } else if (!devTables) {
    row.appendChild(button('Watch the game', watchGame));
    line(
      "Seats belong to the season's players, picked by an admin. You can watch, see what is played (never anyone's cards) and chat.",
      'muted',
    );
  } else {
    line('This game is already running, so it cannot be joined. Watch for the next one.', 'muted');
  }
  box.appendChild(row);
}

function renderWaitRoom(t) {
  $('waitNotice').textContent = t.notice || '';
  const needed = t.seats.filter((s) => s.kind === 'empty').length;
  $('waitInfo').textContent = devTables
    ? `Host: ${t.host}. Empty seats will be played by ${t.aiLevel} AI, and a game with computer players does not count on the leaderboard.`
    : `This is a season game: it starts by itself a few seconds after all ${t.seats.length} seats are taken by people, with no computer players. When it ends the next one follows with the same people.`;
  const ul = $('waitSeats');
  ul.innerHTML = '';
  t.seats.forEach((s, i) => {
    const li = document.createElement('li');
    const empty = s.kind === 'empty';
    li.textContent = empty
      ? `Seat ${i + 1}: ${devTables ? `empty (${t.aiLevel} AI will play)` : 'waiting for a player'}`
      : `Seat ${i + 1}: ${s.name}${i === t.you && !t.spectator ? ' (you)' : ''}`;
    if (empty) li.className = 'muted';
    ul.appendChild(li);
  });
  show('startBtn', devTables && t.isHost); // production games start by themselves
  $('startBtn').disabled = !devTables && needed > 0; // every seat needs a person
  if (!$('waitMsg').textContent || $('waitMsg').className === 'muted') {
    const more = `${needed} more ${needed === 1 ? 'player' : 'players'}`;
    $('waitMsg').textContent = devTables
      ? needed > 0 && !t.isHost
        ? `Waiting for ${more} to join.`
        : t.isHost
          ? ''
          : 'Waiting for the host to start.'
      : needed > 0
        ? `Waiting for ${more} to join.`
        : '';
    $('waitMsg').className = 'muted';
  }
}

const fmtDate = (t) => new Date(t).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
const fmtRange = (s) => `${fmtDate(s.starts)} to ${s.ends === null ? 'open-ended' : fmtDate(s.ends)}`;

// The season picker: the current season, every season, or all-time.
async function refreshSeasons() {
  let list;
  try {
    list = (await api.seasons()).seasons;
  } catch {
    return;
  }
  const sel = $('lbSeason');
  sel.innerHTML = '';
  const add = (value, text) => {
    const o = document.createElement('option');
    o.value = value;
    o.textContent = text;
    sel.appendChild(o);
  };
  const current = list.find((s) => s.status === 'active');
  if (current) add('current', `Current season (${current.name})`);
  for (const s of list) add(String(s.id), `${s.name}${s.status === 'upcoming' ? ' (upcoming)' : ''}`);
  add('all', 'All-time');
  if (![...sel.options].some((o) => o.value === lbSeason)) lbSeason = current ? 'current' : 'all';
  sel.value = lbSeason;
}

// "+1.2" or "−3" (a real minus sign, as on the result panel).
const signed = (v, digits) => `${v < 0 ? '−' : '+'}${Math.abs(v).toFixed(digits)}`;

// The luck-and-skill view: the same season and board as the standings.
async function refreshStats(seq) {
  const body = $('lsBody');
  const note = (text) => ($('lsNote').textContent = text);
  const message = (text) => {
    body.innerHTML = '';
    const tr = document.createElement('tr');
    const td = document.createElement('td');
    td.colSpan = 7;
    td.className = 'muted';
    td.textContent = text;
    tr.appendChild(td);
    body.appendChild(tr);
  };
  try {
    const { season, rows, minGames, pending } = await api.stats(lbSeason);
    if (seq !== lbSeq) return;
    if (!season) $('lbSeasonInfo').textContent = 'No season is running right now. Pick a past season, or All-time.';
    else if (season.id === null) {
      $('lbSeasonInfo').textContent = 'All-time: every game ever played, across all seasons.';
    } else {
      $('lbSeasonInfo').textContent =
        `${season.name}: ${fmtRange(season)}. Games count in the season they finished in.`;
    }
    note(
      pending > 0
        ? `Still working out ${pending} game${pending === 1 ? '' : 's'}: look again in a moment.`
        : `Shown from ${minGames} games. Only online season games, saved with their deals, count (the "of" column shows how many of a player's games that is).`,
    );
    if (!rows.length) return message(season ? 'No games with their deals saved yet.' : '');
    body.innerHTML = '';
    for (const r of rows) {
      const games = r.played > r.games ? `${r.games} of ${r.played}` : String(r.games);
      const cells = r.ready
        ? [
            r.name,
            games,
            r.wins,
            r.expWins.toFixed(1),
            `${signed(r.winsAbove, 1)} ± ${(1.96 * r.winsSe).toFixed(1)}`,
            signed(r.luck, 0),
            `${signed(r.play, 0)} ± ${(1.96 * r.playSe).toFixed(0)}`,
          ]
        : [r.name, games, '—', '—', '—', '—', `needs ${minGames - r.games} more`];
      const tr = document.createElement('tr');
      for (const v of cells) {
        const td = document.createElement('td');
        td.textContent = v;
        tr.appendChild(td);
      }
      body.appendChild(tr);
    }
  } catch {
    if (seq === lbSeq) body.innerHTML = '';
  }
}

async function refreshLeaderboard() {
  const body = $('lbBody');
  const seq = ++lbSeq;
  $('lbViewStandings').classList.toggle('active', lbView === 'standings');
  $('lbViewStats').classList.toggle('active', lbView === 'stats');
  show('lbStandings', lbView === 'standings');
  show('lsBox', lbView === 'stats');
  show('lbSort', lbView === 'standings');
  if (lbView === 'stats') return refreshStats(seq);
  $('lbSort').textContent = `Ranked by: ${lbSort === 'perGame' ? 'points per game' : 'total points'}`;
  const note = (text) => {
    body.innerHTML = '';
    const tr = document.createElement('tr');
    const td = document.createElement('td');
    td.colSpan = 7;
    td.className = 'muted';
    td.textContent = text;
    tr.appendChild(td);
    body.appendChild(tr);
  };
  try {
    const { season, rows } = await api.leaderboard(lbSeason, lbSort);
    if (seq !== lbSeq) return; // a newer request (another tab clicked) owns the table now
    if (!season) $('lbSeasonInfo').textContent = 'No season is running right now. Pick a past season, or All-time.';
    else if (season.id === null) {
      $('lbSeasonInfo').textContent = 'All-time: every game ever played, across all seasons.';
    } else {
      $('lbSeasonInfo').textContent =
        `${season.name}: ${fmtRange(season)}. Games count in the season they finished in.`;
    }
    if (!rows.length) return note(season ? 'No games yet.' : '');
    body.innerHTML = '';
    rows.forEach((r, i) => {
      const tr = document.createElement('tr');
      for (const v of [i + 1, r.name, r.games, r.wins, `${r.winPct}%`, r.points, r.perGame.toFixed(2)]) {
        const td = document.createElement('td');
        td.textContent = v;
        tr.appendChild(td);
      }
      body.appendChild(tr);
    });
  } catch {
    if (seq === lbSeq) body.innerHTML = '';
  }
}

// Runs a game API call whose reply carries the new table/summary; errors go to `msgId`.
async function gameAction(fn, msgId) {
  $(msgId).textContent = '';
  $(msgId).className = 'bad';
  try {
    const r = await fn();
    if (r.game !== undefined) lobbyGame = r.game;
    if (r.season !== undefined) lobbySeason = r.season;
    onTable(r.table);
  } catch (err) {
    $(msgId).textContent = err.message;
  }
}

const joinGame = () => gameAction(() => api.join(), 'lobbyMsg');
const watchGame = () => gameAction(() => api.watch(), 'lobbyMsg');
const startOnlineRound = () => gameAction(() => api.start(), table && table.status === 'done' ? 'endNote' : 'waitMsg');
const leaveTable = () => gameAction(() => api.leave(), table && table.status === 'done' ? 'endNote' : 'waitMsg');
// The lobby (or the waiting room), from the table or the Admin screen. A seated player keeps their seat; the lobby
// offers Rejoin.
const goLobby = () => {
  adminView = false;
  viewingLobby = true;
  route();
};

// It is my move in a game in progress.
const myMoveWaiting = () =>
  !!table && !table.spectator && table.status === 'playing' && !!table.game && table.game.turn === table.you;

function clearTrickReset() {
  clearTimeout(trickReset);
  trickReset = null;
}

function clearTrickDisplay() {
  shownTrick = null;
  seatActions = noActions(game ? game.hands.length : 4);
}

// A new view from the server (or the reply to my own move). Views carry a
// version, so seeing the same one twice (POST reply and event) is harmless.
function onTable(t) {
  if (mode !== 'online') return;
  if (!t) {
    table = null;
    orders.online = null;
    lift = null;
    histLen = 0;
    clearTrickReset();
    clearTrickDisplay();
    chatMsgs = [];
    viewingLobby = false;
    acceptAny = false;
    route();
    return;
  }
  const prev = table;
  if (!acceptAny && prev && prev.id === t.id && t.version <= prev.version) {
    trace.add('stale', describeView(t, { kept: prev.version }));
    return;
  }
  const wasAny = acceptAny;
  acceptAny = false;
  const fresh = !prev || prev.id !== t.id || (prev.status !== 'playing' && t.status === 'playing');
  table = t;
  syncCountdown();
  if (t.status === 'waiting') {
    if (fresh || !prev) $('waitMsg').textContent = '';
    return route();
  }
  // A new round, or the result of the one in progress, brings you back to the table.
  if (fresh || (t.status === 'done' && (!prev || prev.status !== 'done'))) viewingLobby = false;

  NAMES = seatNames(t);
  if (fresh) {
    selected = new Set();
    orders.online = null; // a new deal: the hand starts sorted
    lift = null;
    histLen = 0;
    clearTrickReset();
    clearTrickDisplay();
    $('log').innerHTML = '';
  }
  game = mirrorState(t);
  const events = newEvents(histLen, t);
  histLen = t.game.view.history.length;
  const replay = fresh && events.length > 1; // joining mid-game: log it, don't animate it
  trace.add(
    'view',
    describeView(t, {
      fresh,
      replay,
      any: wasAny,
      added: events.map((e) => ({ p: e.p, cards: e.cards, auto: e.auto, leadPass: e.leadPass })),
    }),
  );
  if (fresh && !replay) {
    log(
      `New round. ${NAMES[game.turn]} ${isMe(game.turn) ? 'have' : 'has'} the 3♦ and ${isMe(game.turn) ? 'lead' : 'leads'}.`,
      'sys',
    );
  }
  const closed = applyEvents(events, replay);
  thinking = game.winner < 0 && game.turn !== 0 && isComputer(t, game.turn) ? game.turn : -1;
  render();
  if (game.winner >= 0) {
    endOnlineRound(t, !!prev && prev.status === 'done' && prev.id === t.id);
  } else if (!closed) {
    if (isMe(game.turn)) setStatus(myTurnMessage());
    else if (isComputer(t, game.turn)) setStatus(`${NAMES[game.turn]} is thinking…`);
    else if (isAway(t, game.turn)) setStatus(`Waiting for ${NAMES[game.turn]}; the game holds until they return.`);
    else setStatus(`${NAMES[game.turn]} to play`);
  }
  route();
}

// Updates the log and the seat markers. Returns true when this batch closed a
// trick (the table is cleared after a short pause, purely as a visual effect).
function applyEvents(events, replay) {
  if (trickReset) {
    clearTrickReset();
    clearTrickDisplay();
  }
  let skipped = false;
  let lastPlay = null;
  for (const e of events) {
    const who = NAMES[e.p];
    if (e.cards) {
      clearOldMarkers();
      if (!replay) seatActions[e.p] = { cards: e.cards, cls: e.cls };
      shownTrick = { cards: e.cards, cls: e.cls, by: e.p };
      lastPlay = e;
      skipped = false;
      log(`${who}: ${describe(e.cls)}`, e.p === 0 ? 'you' : '', e.cards);
    } else if (e.auto) {
      if (!replay) seatActions[e.p] = 'cantbeat';
      skipped = true;
    } else {
      if (!replay) seatActions[e.p] = e.leadPass ? 'leadpass' : 'pass';
      log(e.leadPass ? `${who} passed the lead` : `${who} passed`, e.p === 0 ? 'you' : '');
    }
  }
  if (replay) shownTrick = game.trick ? { cards: game.trick.cards, cls: game.trick.cls, by: game.trick.by } : null;
  const last = events[events.length - 1];
  if (replay || !last || game.winner >= 0 || game.trick !== null || last.leadPass) return false;

  let msg;
  if (skipped && lastPlay) {
    const whose = isMe(lastPlay.p) ? 'your' : `${NAMES[lastPlay.p]}'s`;
    msg = `Nobody can beat ${whose} ${describe(lastPlay.cls)}. ${isMe(lastPlay.p) ? 'You lead' : `${NAMES[lastPlay.p]} leads`} again.`;
  } else {
    msg = `${isMe(game.turn) ? 'You win' : `${NAMES[game.turn]} wins`} the trick.`;
  }
  setStatus(msg);
  log(msg, 'sys');
  trickReset = setTimeout(() => {
    trickReset = null;
    clearTrickDisplay();
    render();
    if (game.winner < 0) setStatus(isMe(game.turn) ? myTurnMessage() : '');
  }, TRICK_PAUSE_MS);
  return true;
}

function endOnlineRound(t, alreadyShown) {
  const w = game.winner;
  const r = t.result;
  setStatus('');
  if (!alreadyShown) log(isMe(w) ? 'You went out. You win!' : `${NAMES[w]} went out and wins.`, 'sys');
  $('endTitle').textContent = isMe(w) ? 'You win! 🎉' : `${NAMES[w]} wins`;
  const box = $('endHands');
  box.innerHTML = '';
  for (let p = 0; p < game.hands.length; p++) {
    const row = document.createElement('div');
    row.className = 'end-row';
    row.innerHTML = `<span class="who">${NAMES[p]}</span>`;
    const cards = document.createElement('div');
    cards.className = 'cards';
    if (p !== w) cards.appendChild(cardRow(sortByRank(game.hands[p])));
    row.appendChild(cards);
    const d = r ? r.delta[unrot(p, t.you, t.seats.length)] : 0;
    const pts = document.createElement('span');
    pts.className = `pts ${d > 0 ? 'win' : 'loss'}`;
    pts.textContent = `${d > 0 ? '+' : d < 0 ? '−' : ''}${Math.abs(d)}`;
    row.appendChild(pts);
    box.appendChild(row);
  }
  const notes = [];
  if (r && r.multiplier > 1) notes.push('Going out with a straight flush or five of a kind doubles every payment.');
  if (r && !r.saved) notes.push('This result could not be saved to the leaderboard.');
  else if (r && r.hasAi) notes.push('This game had computer players, so it is not on the leaderboard.');
  if (r && r.rotation) {
    const { out, in: taker, why } = r.rotation;
    const you = !t.spectator && out === t.seats[t.you]?.name;
    const who = you ? 'You' : out;
    const goes = you ? 'go' : 'goes';
    const gone = why === 'left' ? `${who} left` : `${who} scored lowest`;
    notes.push(
      taker
        ? `${gone}, so ${taker} takes that seat for the next game and ${who} ${goes} to the back of the line.`
        : `${gone} and ${goes} to the back of the line.`,
    );
  }
  if (devTables && !t.isHost) notes.push(`Waiting for ${t.host} to start another round.`);
  if (!devTables && t.leave === null) {
    notes.push('There are only as many players as seats, so every seat stays filled.');
  }
  $('endNote').className = 'muted';
  $('endNote').textContent = notes.join(' ');
  show('againBtn', devTables && t.isHost); // production games follow on by themselves
}

async function sendMove(cards) {
  sending = true;
  render();
  try {
    onTable((await api.move(cards)).table);
  } catch (err) {
    setStatus(err.message); // the next event resyncs the view
  } finally {
    sending = false;
    render();
  }
}

// ---- chat ----
function renderChat() {
  const on = mode === 'online' && !!table && table.chatEnabled;
  show('chat', on);
  // The opener says "Chat" when there is chat (the thing people look for); the sheet holds both.
  $('logBtn').firstChild.textContent = on ? 'Chat' : 'Log';
  $('logToggle').firstChild.textContent = on ? 'Play log & chat' : 'Play log';
  $('waitLogBtn').hidden = !on;
  if (!on) return;
  const ol = $('chatMsgs');
  const atBottom = ol.scrollTop + ol.clientHeight >= ol.scrollHeight - 24;
  ol.innerHTML = '';
  for (const m of chatMsgs) {
    const li = document.createElement('li');
    const who = document.createElement('b');
    who.textContent = m.name;
    li.append(who, document.createTextNode(` ${m.text}`)); // text, never HTML
    ol.appendChild(li);
  }
  if (atBottom) ol.scrollTop = ol.scrollHeight;
}

async function sendChat() {
  const input = $('chatInput');
  if (!input.value.trim()) return;
  $('chatErr').textContent = '';
  try {
    await api.say(input.value);
    input.value = '';
  } catch (err) {
    $('chatErr').textContent = err.message;
  }
}

// ---- admin ----
function randomPassword() {
  const alphabet = 'abcdefghjkmnpqrstuvwxyzACDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = new Uint8Array(14);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join('');
}

// A popup that asks before something that cannot be undone, or costs something. It says what will happen and
// resolves true if they confirm, false if they cancel (or press Escape). Focus starts on Cancel, so a stray
// Enter never confirms. danger: false is for things that are easily reversed.
function confirmAction({ title, text, ok = 'Confirm', danger = true }) {
  return new Promise((resolve) => {
    const dlg = $('confirmDlg');
    $('confirmTitle').textContent = title;
    $('confirmText').textContent = text;
    const okBtn = $('confirmOk');
    okBtn.textContent = ok;
    okBtn.className = danger ? 'danger' : 'primary';
    okBtn.onclick = () => {
      resolve(true);
      dlg.close();
    };
    $('confirmCancel').onclick = () => dlg.close();
    dlg.onclose = () => resolve(false); // Cancel, Escape; harmless after a confirm (already resolved)
    dlg.showModal();
    $('confirmCancel').focus();
  });
}

// A button that asks in the popup first.
function confirmButton(label, ask, action) {
  const btn = document.createElement('button');
  btn.textContent = label;
  btn.addEventListener('click', async () => {
    if (await confirmAction(ask)) action();
  });
  return btn;
}

async function adminDo(fn) {
  $('adminMsg').textContent = '';
  try {
    await fn();
  } catch (err) {
    $('adminMsg').textContent = err.message;
  }
  await refreshAdmin();
}

async function refreshAdmin() {
  try {
    const [o, u, a, s] = await Promise.all([api.admin.overview(), api.admin.users(), api.admin.audit(), api.seasons()]);
    renderAdmin(o, u.users, a.entries);
    renderSeasons(s.seasons);
  } catch (err) {
    $('adminMsg').textContent = err.message;
  }
}

// ---- admin tabs ----
const ADMIN_TABS = ['overview', 'seasons', 'users', 'audit'];
function savedAdminTab() {
  try {
    const t = localStorage.getItem('big2.adminTab');
    return ADMIN_TABS.includes(t) ? t : null;
  } catch {
    return null; // storage can be blocked: just use the default
  }
}
// One section at a time. The panels all stay in the page (they are only hidden), so they keep being updated.
function showAdminTab(name, focus = false) {
  for (const t of ADMIN_TABS) {
    const on = t === name;
    const tab = $(`tab-${t}`);
    tab.setAttribute('aria-selected', String(on));
    tab.tabIndex = on ? 0 : -1;
    $(`admin-${t}`).hidden = !on;
    if (on && focus) tab.focus();
  }
  try {
    localStorage.setItem('big2.adminTab', name);
  } catch {
    /* not remembered */
  }
}
// The tab you were last on; the first time, Seasons if the season still needs players, otherwise Overview.
const firstAdminTab = () =>
  savedAdminTab() ?? (lobbySeason && lobbySeason.state === 'needs-players' ? 'seasons' : 'overview');

// ---- seasons (admin) ----
const pad2 = (n) => String(n).padStart(2, '0');
// A <input type="datetime-local"> value, in the browser's local time.
const toLocalInput = (ms) => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}T${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
};
const fmtDateTime = (ms) => new Date(ms).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });

function renderSeasons(list) {
  const body = $('seasonsBody');
  body.innerHTML = '';
  for (const s of list) {
    const tr = document.createElement('tr');
    const cell = (text) => {
      const td = document.createElement('td');
      td.textContent = text;
      tr.appendChild(td);
    };
    cell(s.name);
    cell(s.status);
    cell(fmtDateTime(s.starts));
    cell(s.ends === null ? 'open-ended' : fmtDateTime(s.ends));
    cell(s.players ?? 0);
    cell(s.games);
    cell(s.champion || '-');
    const actions = document.createElement('td');
    actions.className = 'actions-cell';
    const people = document.createElement('button');
    people.textContent = 'Players';
    people.addEventListener('click', () => openPlayers(s));
    actions.append(people);
    const edit = document.createElement('button');
    edit.textContent = 'Edit';
    edit.addEventListener('click', () => startSeasonEdit(s));
    actions.append(edit);
    // A running season can be ended on the spot, so the next one can start.
    if (s.status === 'active') {
      actions.append(
        confirmButton(
          'End now',
          {
            title: `End ${s.name} now?`,
            text: 'A game in progress is stopped and not scored, the table closes and the season is over. This cannot be undone.',
            ok: 'End the season',
          },
          () => seasonDo(() => api.admin.endSeason(s.id)),
        ),
      );
    }
    actions.append(
      confirmButton(
        'Delete',
        {
          title: `Delete ${s.name}?`,
          text: 'The season and its list of players are removed. Games already played stay in the record and still count in All-time. This cannot be undone.',
          ok: 'Delete the season',
        },
        () => seasonDo(() => api.admin.deleteSeason(s.id)),
      ),
    );
    tr.appendChild(actions);
    body.appendChild(tr);
  }
}

function startSeasonEdit(s) {
  editingSeason = s;
  $('seasonFormTitle').textContent = `Edit ${s.name}`;
  $('seasonName').value = s.name;
  $('seasonStart').value = toLocalInput(s.starts);
  $('seasonEnd').value = s.ends === null ? '' : toLocalInput(s.ends);
  $('seasonSave').textContent = 'Save changes';
  show('seasonPicksBox', false); // an existing season's players are managed with its Players button
  show('seasonCancel', true);
  $('seasonMsg').textContent = '';
}

function resetSeasonForm() {
  editingSeason = null;
  $('seasonFormTitle').textContent = 'New season';
  $('seasonName').value = '';
  $('seasonStart').value = '';
  $('seasonEnd').value = '';
  $('seasonSave').textContent = 'Create season';
  show('seasonCancel', false);
  show('seasonPicksBox', true);
  pickedIds.clear();
  renderPicks();
}

// The accounts an admin can put in a new season, as tick boxes. The order they are ticked is the order they sit.
function renderPicks() {
  const box = $('seasonPicks');
  box.innerHTML = '';
  for (const u of seasonUsers) {
    const label = document.createElement('label');
    label.className = 'check';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = pickedIds.has(u.id);
    cb.addEventListener('change', () => {
      if (cb.checked) pickedIds.add(u.id);
      else pickedIds.delete(u.id);
    });
    label.append(cb, document.createTextNode(` ${u.name}`));
    box.appendChild(label);
  }
}

// ---- a season's players (admin): who sits, who waits, add and remove
async function openPlayers(season) {
  playersSeason = season;
  $('playersTitle').textContent = `${season.name}: players`;
  $('playersMsg').textContent = '';
  await playersDo(() => api.admin.seasonPlayers(season.id));
  $('playersDlg').showModal();
}

async function playersDo(fn) {
  $('playersMsg').className = 'muted';
  try {
    renderPlayers(await fn());
  } catch (err) {
    $('playersMsg').className = 'bad';
    $('playersMsg').textContent = err.message;
    return;
  }
  await refreshAdmin(); // the players column
}

function renderPlayers(p) {
  const body = $('playersBody');
  body.innerHTML = '';
  const anySeated = p.members.some((m) => m.seated);
  let reserve = 0;
  p.members.forEach((m, i) => {
    const tr = document.createElement('tr');
    const cell = (text) => {
      const td = document.createElement('td');
      td.textContent = text;
      tr.appendChild(td);
      return td;
    };
    cell(String(i + 1));
    cell(m.name);
    const sits = anySeated ? m.seated : i < p.min;
    cell(sits ? (m.seated ? 'Seated' : 'Will sit down') : `Reserve ${++reserve}`);
    const actions = document.createElement('td');
    actions.className = 'actions-cell';
    if (m.seated) {
      const b = document.createElement('button');
      b.textContent = 'Remove';
      b.disabled = true;
      b.title = 'Seated: cancel the game first';
      actions.append(b);
    } else {
      const season = playersSeason;
      actions.append(
        confirmButton(
          'Remove',
          {
            title: `Remove ${m.name}?`,
            text: `${m.name} will no longer be a player in ${season.name}. Their games stay in the record.`,
            ok: 'Remove the player',
          },
          () => playersDo(() => api.admin.removeSeasonPlayer(season.id, m.userId)),
        ),
      );
    }
    tr.appendChild(actions);
    body.appendChild(tr);
  });
  const sel = $('playersAdd');
  sel.innerHTML = '';
  for (const c of p.candidates) {
    const o = document.createElement('option');
    o.value = String(c.id);
    o.textContent = c.name;
    sel.appendChild(o);
  }
  if (!p.candidates.length) {
    const o = document.createElement('option');
    o.textContent = 'Every account is already a player';
    sel.appendChild(o);
  }
  sel.disabled = !p.candidates.length;
  $('playersAddBtn').disabled = !p.candidates.length;
}

async function seasonDo(fn) {
  $('seasonMsg').className = 'muted';
  $('seasonMsg').textContent = '';
  try {
    await fn();
  } catch (err) {
    $('seasonMsg').className = 'bad';
    $('seasonMsg').textContent = err.message;
    $('seasonMsg').scrollIntoView({ block: 'nearest' }); // on a phone the message is below the fold
    return false;
  }
  await refreshAdmin();
  await refreshSeasons();
  refreshLeaderboard();
  return true;
}

async function saveSeason() {
  const name = $('seasonName').value.trim();
  const startText = $('seasonStart').value;
  const endText = $('seasonEnd').value;
  // An untouched field keeps its exact stored time (the input only shows minutes).
  const keep = (text, original) =>
    editingSeason && original !== null && text === toLocalInput(original) ? original : new Date(text).getTime();
  const starts = startText ? keep(startText, editingSeason && editingSeason.starts) : Date.now(); // empty means now
  const ends = endText ? keep(endText, editingSeason && editingSeason.ends) : null;
  if (Number.isNaN(starts) || (ends !== null && Number.isNaN(ends))) {
    $('seasonMsg').className = 'bad';
    $('seasonMsg').textContent = 'Please enter a valid start time (and a valid end time, or leave it empty).';
    return;
  }
  const editing = editingSeason;
  const members = [...pickedIds];
  const over = ends !== null && ends <= Date.now();
  if (!editing && !over && members.length < 4) {
    $('seasonMsg').className = 'bad';
    $('seasonMsg').textContent =
      `A season that is running or to come needs at least 4 players: ${members.length} ticked.`;
    return;
  }
  const ok = await seasonDo(() =>
    editing
      ? api.admin.updateSeason(editing.id, name, starts, ends)
      : api.admin.createSeason(name, starts, ends, members),
  );
  if (ok) {
    resetSeasonForm();
    $('seasonMsg').textContent = editing ? 'Season updated.' : 'Season created.';
  }
}

function renderAdmin(o, users, entries) {
  seasonUsers = users.filter((u) => !u.disabled);
  renderPicks();
  $('adminStats').textContent =
    `${o.stats.users} accounts · ${o.stats.gamesFinished} finished games · ${o.stats.gamesCancelled} cancelled · ${o.online} connected now`;
  $('regState').textContent = o.registrationOpen
    ? 'Anyone can create an account.'
    : 'Closed: only admins create accounts.';
  $('regBtn').textContent = o.registrationOpen ? 'Close registration' : 'Open registration';
  $('regBtn').onclick = () => adminDo(() => api.admin.setRegistration(!o.registrationOpen));

  const box = $('adminGame');
  box.innerHTML = '';
  const p = document.createElement('p');
  if (!o.game) {
    p.className = 'muted';
    p.textContent = 'No game is running.';
    box.appendChild(p);
  } else {
    p.textContent = devTables
      ? `${o.game.host}'s game (${o.game.status}). Players: ${o.game.players.join(', ') || 'nobody'}. ${o.game.aiLevel} AI.`
      : `The table (${o.game.status}). Players: ${o.game.players.join(', ') || 'nobody'}.`;
    box.appendChild(p);
    const note = document.createElement('p');
    note.className = 'muted';
    note.textContent =
      o.game.status === 'playing'
        ? 'Cancelling a game in progress ends it for everyone and it is not scored.'
        : 'Cancelling clears the table' + (devTables ? '.' : ', and a fresh one opens while a season is running.');
    box.append(
      note,
      confirmButton(
        'Cancel game',
        {
          title: 'Cancel the game?',
          text: 'A game in progress is stopped for everyone and is not scored. While a season is running a fresh table opens.',
          ok: 'Cancel the game',
        },
        () => adminDo(() => api.admin.cancelGame()),
      ),
    );
  }

  const body = $('usersBody');
  body.innerHTML = '';
  for (const u of users) {
    const tr = document.createElement('tr');
    const cell = (text) => {
      const td = document.createElement('td');
      td.textContent = text;
      tr.appendChild(td);
      return td;
    };
    cell(u.name);
    cell([u.isAdmin ? 'admin' : 'player', u.disabled ? 'disabled' : ''].filter(Boolean).join(', '));
    cell(u.devices ? `on (${u.devices} device${u.devices === 1 ? '' : 's'})` : 'off');
    cell(u.games);
    cell(u.lastLogin ? new Date(u.lastLogin).toLocaleString() : 'never');
    const actions = document.createElement('td');
    actions.className = 'actions-cell';
    const reset = document.createElement('button');
    reset.textContent = 'Reset password';
    reset.addEventListener('click', () => openReset(u));
    const dis = confirmButton(
      u.disabled ? 'Enable' : 'Disable',
      u.disabled
        ? { title: `Enable ${u.name}?`, text: `${u.name} will be able to sign in again.`, ok: 'Enable', danger: false }
        : {
            title: `Disable ${u.name}?`,
            text: `${u.name} is signed out everywhere and cannot sign in until you enable them again. Their games stay in the record.`,
            ok: 'Disable',
          },
      () => adminDo(() => api.admin.setDisabled(u.id, !u.disabled)),
    );
    const role = confirmButton(
      u.isAdmin ? 'Remove admin' : 'Make admin',
      u.isAdmin
        ? {
            title: `Remove ${u.name} as an admin?`,
            text: `${u.name} goes back to being a normal player.`,
            ok: 'Remove admin',
          }
        : {
            title: `Make ${u.name} an admin?`,
            text: `${u.name} will be able to create accounts and seasons, cancel games, and see everything on the Admin screen.`,
            ok: 'Make admin',
            danger: false,
          },
      () => adminDo(() => api.admin.setAdmin(u.id, !u.isAdmin)),
    );
    actions.append(reset, dis, role);
    tr.appendChild(actions);
    body.appendChild(tr);
  }

  const ul = $('auditList');
  ul.innerHTML = '';
  for (const e of entries) {
    const li = document.createElement('li');
    li.textContent = `${new Date(e.ts).toLocaleString()} · ${e.admin || 'command line'} · ${e.action}${e.target ? ` · ${e.target}` : ''}${e.detail ? ` (${e.detail})` : ''}`;
    ul.appendChild(li);
  }
}

function openReset(u) {
  resetTarget = u;
  $('resetName').textContent = u.name;
  $('resetPw').value = randomPassword();
  $('resetErr').textContent = '';
  $('resetDlg').showModal();
}

async function submitReset() {
  try {
    await api.admin.resetPassword(resetTarget.id, $('resetPw').value);
  } catch (err) {
    $('resetErr').textContent = err.message;
    return;
  }
  $('resetDlg').close();
  $('adminMsg').textContent = '';
  await refreshAdmin();
}

async function submitCreateUser() {
  const msg = $('createUserMsg');
  msg.className = 'muted';
  msg.textContent = '';
  try {
    const name = $('newUserName').value.trim();
    await api.admin.createUser(name, $('newUserPw').value, $('newUserAdmin').checked);
    msg.textContent = `Created ${name}. Give them the temporary password.`;
    $('newUserName').value = '';
    $('newUserPw').value = '';
    $('newUserAdmin').checked = false;
  } catch (err) {
    msg.className = 'bad';
    msg.textContent = err.message;
    return;
  }
  await refreshAdmin();
}

// ---- turn alerts (push notifications) ----
const DEVICE = describeDevice(browserEnv());
const IOS_HELP_SEEN = 'big2.iosHelpSeen';
const ALERTS_DISMISSED = 'big2.alertsDismissed';
let alertsNow = 'off'; // what alertState() says about this device
let alertDevices = []; // every device of mine that has alerts on, as the server lists them

async function readAlertState() {
  let subscribed = false;
  try {
    subscribed = !!(await currentSubscription());
  } catch {
    /* no service worker here (a private window, an old browser): alertState says what is possible */
  }
  alertsNow = alertState(DEVICE, { permission: permission(), subscribed });
  return alertsNow;
}

// On sign-in: a device that already has alerts is kept registered (quietly), and a phone that could have them
// is offered them once: an iPhone is shown how to add the game to its Home Screen; any other phone gets a
// one-tap bar. Nothing here asks the browser for permission: that only ever happens from a tap.
async function startAlerts() {
  try {
    if (DEVICE.canPush) await registerWorker();
    let state = await readAlertState();
    if (state === 'on' || state === 'resubscribe') {
      alertDevices = (await syncSubscription(api, DEVICE)).devices;
      state = await readAlertState();
    }
    const first = firstPrompt(DEVICE, state, {
      iosHelpSeen: !!localStorage.getItem(IOS_HELP_SEEN),
      dismissed: !!localStorage.getItem(ALERTS_DISMISSED),
    });
    show('alertsBanner', first === 'banner');
    if (first === 'ios-help') {
      localStorage.setItem(IOS_HELP_SEEN, '1');
      $('iosDlg').showModal();
    }
  } catch {
    /* alerts are an extra: the game works without them, and the menu explains what is wrong */
  }
}

const ALERT_STATUS = {
  on: () => `Alerts are on for this device (${DEVICE.label}).`,
  off: () => 'Alerts are off for this device.',
  resubscribe: () => 'This browser allowed alerts, but this device needs switching on again.',
  blocked: () => 'This browser has blocked alerts for this site.',
  install: () => 'On an iPhone or iPad, alerts need the game on your Home Screen first.',
  unsupported: () => 'This browser cannot show turn alerts.',
};

let lastAlertError = ''; // what the browser last said went wrong (shown in the details line at the bottom)

const ALERT_HELP = {
  blocked:
    'Your browser is set to Block alerts for this site, so it will not ask. The steps below show how to change that: start with step 2.',
  unsupported:
    'Try Chrome on an Android phone, or on an iPhone add the game to the Home Screen (needs iOS 16.4 or newer). Computers work in Chrome, Edge and Firefox.',
};

function renderAlerts() {
  $('alertsStatus').textContent = ALERT_STATUS[alertsNow]();
  const help = $('alertsHelp');
  help.textContent = ALERT_HELP[alertsNow] || '';
  if (alertsNow === 'install') {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'primary';
    b.textContent = 'Show me how';
    b.addEventListener('click', () => $('iosDlg').showModal());
    help.appendChild(b);
  }
  show('alertsOn', alertsNow === 'off' || alertsNow === 'resubscribe');
  show('alertsTest', alertsNow === 'on');
  show('alertsOff', alertsNow === 'on');
  show('alertsDevices', alertDevices.length > 0);
  // The steps for this phone and browser: always there when alerts are not on yet, open when something went wrong.
  const how = howToAllow(DEVICE);
  const needsHow = ['off', 'resubscribe', 'blocked'].includes(alertsNow);
  show('alertsHow', needsHow);
  $('alertsHowTitle').textContent = how.title;
  const steps = $('alertsHowSteps');
  steps.innerHTML = '';
  for (const text of how.steps) {
    const li = document.createElement('li');
    li.textContent = text;
    steps.appendChild(li);
  }
  if (alertsNow === 'blocked') $('alertsHow').open = true;
  // What this browser reports: one line to read out or photograph if something does not work.
  $('alertsDiag').textContent = [
    `This device: ${DEVICE.label}`,
    `permission: ${permission()}`,
    `alerts supported: ${DEVICE.canPush ? 'yes' : 'no'}${DEVICE.needsInstall ? ' (needs the Home Screen icon)' : ''}`,
    `opened as an installed app: ${DEVICE.standalone ? 'yes' : 'no'}`,
    ...(lastAlertError ? [`last problem: ${lastAlertError}`] : []),
  ].join(' | ');
  const list = $('alertsDeviceList');
  list.innerHTML = '';
  for (const d of alertDevices) {
    const li = document.createElement('li');
    li.textContent = `${d.label}: ${d.lastOk ? `last alert ${new Date(d.lastOk).toLocaleString()}` : 'no alert sent yet'}`;
    list.appendChild(li);
  }
}

async function openAlertsDialog() {
  $('alertsMsg').textContent = '';
  await readAlertState();
  try {
    alertDevices = (await api.push()).devices;
  } catch {
    alertDevices = [];
  }
  renderAlerts();
  if (!$('alertsDlg').open) $('alertsDlg').showModal();
}

async function alertsDo(fn, okText = '') {
  const msg = $('alertsMsg');
  msg.className = 'muted';
  msg.textContent = '';
  try {
    await fn();
    msg.textContent = okText;
  } catch (err) {
    msg.className = 'bad';
    msg.textContent = err.message || 'Something went wrong.';
    lastAlertError = err.name && err.name !== 'Error' ? `${err.name}: ${err.message}` : err.message || '';
    $('alertsHow').open = true; // something went wrong: the steps are the next thing to read
  }
  await readAlertState();
  renderAlerts();
  show('alertsBanner', false);
}

// Straight from the tap: turnOn asks the browser's permission question before anything else.
const alertsTurnOn = () =>
  alertsDo(async () => {
    const r = await turnOn(api, DEVICE);
    if (r.permission === 'denied') {
      throw new Error(
        'The phone said no, or has notifications switched off for this browser. Follow the steps below to allow them, then press Turn on alerts again.',
      );
    }
    if (r.permission !== 'granted') {
      throw new Error(
        'No answer was given, so alerts are still off. If no question appeared on screen, follow the steps below.',
      );
    }
    lastAlertError = '';
    alertDevices = r.devices;
  }, 'Alerts are on. Press Send a test alert to check.');

const alertsTurnOffAll = () =>
  alertsDo(async () => {
    alertDevices = (await turnOffAll(api)).devices;
  }, 'Alerts are off on all your devices.');

const alertsTurnOff = () =>
  alertsDo(async () => {
    alertDevices = (await turnOff(api)).devices;
  }, 'Alerts are off for this device.');

const alertsTest = () =>
  alertsDo(async () => {
    const r = await api.pushTest();
    alertDevices = r.devices;
    if (!r.delivered) throw new Error('The test did not reach any device. Try turning alerts off and on again.');
  }, 'Sent. It should arrive on your phone in a few seconds.');

// ---- my solo stats ----
// A solo round is reported when it ends. If the server cannot be reached the report waits in this browser (per
// person) and is sent again later; the server counts each round once however often it is sent.
let soloGameId = null;
const newGameId = () =>
  typeof crypto !== 'undefined' && crypto.randomUUID
    ? crypto.randomUUID()
    : `g${Date.now().toString(36)}${Math.random().toString(36).slice(2, 12)}`;
const soloQueueKey = () => `big2.soloQueue.${user ? user.id : 'nobody'}`;
function soloQueue() {
  try {
    const q = JSON.parse(localStorage.getItem(soloQueueKey()) || '[]');
    return Array.isArray(q) ? q : [];
  } catch {
    return [];
  }
}
const saveSoloQueue = (q) => localStorage.setItem(soloQueueKey(), JSON.stringify(q.slice(-200)));
let soloFlushing = false;

function reportSoloResult(result) {
  if (!user || !result.clientId) return;
  saveSoloQueue([...soloQueue(), result]);
  flushSoloResults();
}

async function flushSoloResults() {
  if (soloFlushing || !user) return;
  soloFlushing = true;
  try {
    for (let q = soloQueue(); q.length; q = soloQueue()) {
      try {
        await api.soloResult(q[0]);
      } catch (err) {
        // Out of reach, signed out, or told to slow down: keep it for later. Anything else is a report the
        // server will never accept, so it is dropped rather than retried for ever.
        if (!err.status || err.status >= 500 || err.status === 401 || err.status === 429) break;
      }
      saveSoloQueue(soloQueue().slice(1));
    }
  } finally {
    soloFlushing = false;
  }
}

const pct = (c) => (c.games ? `${Math.round((100 * c.wins) / c.games)}%` : '-');
const perGame = (c) => (c.games ? signed(c.points / c.games, 1) : '-');

function renderSoloStats(s) {
  const body = $('soloStatsBody');
  body.innerHTML = '';
  const cell = (tr, text) => {
    const td = document.createElement('td');
    td.textContent = text;
    tr.appendChild(td);
  };
  const section = (title) => {
    const tr = document.createElement('tr');
    tr.className = 'section';
    const th = document.createElement('th');
    th.colSpan = 6;
    th.textContent = title;
    tr.appendChild(th);
    body.appendChild(tr);
  };
  const row = (label, c, total = false) => {
    const tr = document.createElement('tr');
    if (total) tr.className = 'total';
    cell(tr, label);
    cell(tr, c.games);
    cell(tr, c.wins);
    cell(tr, pct(c));
    cell(tr, c.games ? signed(c.points, 0) : '-');
    cell(tr, perGame(c));
    body.appendChild(tr);
  };
  for (const size of [4, 3]) {
    section(`${size} players`);
    for (const l of ['easy', 'medium', 'hard']) row(LEVEL_LABEL[l], s.bySize[size][l]);
    row(`All ${size}-player games`, s.bySize[size].all, true);
  }
  section('By level, both table sizes together');
  for (const l of ['easy', 'medium', 'hard']) row(LEVEL_LABEL[l], s.byLevel[l]);
  row('Overall', s.overall, true);
  show('soloStatsEmpty', s.overall.games === 0);
}

async function openSoloStats() {
  $('account').open = false;
  await flushSoloResults(); // what finished a moment ago, or while offline, counts
  try {
    renderSoloStats(await api.soloStats());
  } catch (err) {
    if (err.status === 401) return sessionLost();
    $('soloStatsEmpty').textContent = 'Your stats could not be loaded. Try again in a moment.';
    show('soloStatsEmpty', true);
  }
  if (!$('soloStatsDlg').open) $('soloStatsDlg').showModal();
}

// ---- my password ----
async function submitPassword() {
  $('pwErr').textContent = '';
  passwordChanging = true;
  try {
    await api.changePassword($('pwCurrent').value, $('pwNext').value);
  } catch (err) {
    passwordChanging = false;
    $('pwErr').textContent = err.message;
    return;
  }
  passwordChanging = false;
  $('pwCurrent').value = '';
  $('pwNext').value = '';
  $('pwDlg').close();
  beginOnline(); // the server closed my old stream; open a new one with the fresh session
}

// ---- wiring ----
$('modeSolo').addEventListener('click', () => mode !== 'solo' && enterSolo());
$('modeOnline').addEventListener('click', () => (mode !== 'online' ? enterOnline() : goLobby()));
// The account menu closes when an item is chosen, on a click elsewhere, or on Escape.
const account = $('account');
account.addEventListener('click', (e) => {
  if (e.target.closest('.menu button')) account.open = false;
});
document.addEventListener('click', (e) => {
  if (account.open && !account.contains(e.target)) account.open = false;
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && account.open) account.open = false;
});
$('logoutBtn').addEventListener('click', async () => {
  try {
    // This phone stops getting your alerts (it keeps its browser permission, so signing in again turns them back on).
    const sub = DEVICE.canPush && (await currentSubscription());
    if (sub) await api.pushUnsubscribe(sub.endpoint);
  } catch {
    /* signing out matters more */
  }
  try {
    await api.logout();
  } catch {
    /* already signed out */
  }
  location.reload(); // the sign-in page is all that is served now
});
$('viewBtn').addEventListener('click', () => {
  localStorage.setItem('big2.view', adminUi() ? 'player' : 'admin');
  $('account').open = false;
  adminView = false;
  show('adminBtn', adminUi());
  renderViewBtn();
  route();
});
$('adminBtn').addEventListener('click', async () => {
  if (mode !== 'online') {
    // From a solo game: go online first, then open Admin.
    await enterOnline();
    if (mode !== 'online') return;
    adminView = false;
  }
  adminView = !adminView;
  route();
  if (adminView) {
    showAdminTab(firstAdminTab());
    refreshAdmin();
  }
});
for (const t of ADMIN_TABS) $(`tab-${t}`).addEventListener('click', () => showAdminTab(t));
// Arrow keys move along the tabs (and Home and End jump), as people expect of a tab row.
document.querySelector('.tabs').addEventListener('keydown', (e) => {
  const at = ADMIN_TABS.findIndex((t) => $(`tab-${t}`).getAttribute('aria-selected') === 'true');
  const to = { ArrowRight: at + 1, ArrowLeft: at - 1, Home: 0, End: ADMIN_TABS.length - 1 }[e.key];
  if (to === undefined) return;
  e.preventDefault();
  showAdminTab(ADMIN_TABS[(to + ADMIN_TABS.length) % ADMIN_TABS.length], true);
});
$('alertsBtn').addEventListener('click', () => {
  $('account').open = false;
  openAlertsDialog();
});
$('alertsOn').addEventListener('click', alertsTurnOn);
$('alertsOff').addEventListener('click', alertsTurnOff);
$('alertsOffAll').addEventListener('click', alertsTurnOffAll);
$('alertsTest').addEventListener('click', alertsTest);
$('alertsClose').addEventListener('click', () => $('alertsDlg').close());
$('alertsBannerOn').addEventListener('click', async () => {
  await alertsTurnOn(); // straight from the tap, as the browser requires
  if (alertsNow !== 'on') openAlertsDialog(); // it did not work: the dialog says why and what to do
});
$('alertsBannerLater').addEventListener('click', () => {
  localStorage.setItem(ALERTS_DISMISSED, '1');
  show('alertsBanner', false);
});
$('iosOk').addEventListener('click', () => $('iosDlg').close());
$('soloStatsBtn').addEventListener('click', openSoloStats);
$('soloStatsClose').addEventListener('click', () => $('soloStatsDlg').close());
$('soloStatsX').addEventListener('click', () => $('soloStatsDlg').close());
$('debugBtn').addEventListener('click', copyDebugInfo);
$('passwordBtn').addEventListener('click', () => {
  $('pwErr').textContent = '';
  $('pwDlg').showModal();
});
$('pwOk').addEventListener('click', submitPassword);
$('pwCancel').addEventListener('click', () => $('pwDlg').close());
$('resetOk').addEventListener('click', submitReset);
$('resetCancel').addEventListener('click', () => $('resetDlg').close());
$('resetGen').addEventListener('click', () => ($('resetPw').value = randomPassword()));
$('genPwBtn').addEventListener('click', () => ($('newUserPw').value = randomPassword()));
$('createUserBtn').addEventListener('click', submitCreateUser);
$('createBtn').addEventListener('click', () =>
  gameAction(() => api.createGame($('newLevel').value, Number($('newSeats').value)), 'lobbyMsg'),
);
$('startBtn').addEventListener('click', startOnlineRound);
$('waitLeave').addEventListener('click', leaveTable);
$('lobbyBtn').addEventListener('click', goLobby);
// The logo goes to the lobby too, once you are online (in a solo game it does nothing: it must not end the game).
$('brandBtn').addEventListener('click', () => {
  if (mode === 'online') goLobby();
});
$('forfeitBtn').addEventListener('click', forfeitSeat);
$('watchStopBtn').addEventListener('click', leaveTable);
$('playersAddBtn').addEventListener('click', () => {
  const id = Number($('playersAdd').value);
  if (id) playersDo(() => api.admin.addSeasonPlayer(playersSeason.id, id));
});
$('playersClose').addEventListener('click', () => $('playersDlg').close());
$('endLeave').addEventListener('click', leaveTable);
$('chatSend').addEventListener('click', sendChat);
$('chatInput').addEventListener('keydown', (e) => e.key === 'Enter' && sendChat());
$('seasonSave').addEventListener('click', saveSeason);
$('seasonCancel').addEventListener('click', resetSeasonForm);
$('lbSeason').addEventListener('change', (e) => {
  lbSeason = e.target.value;
  refreshLeaderboard();
});
$('lbSort').addEventListener('click', () => {
  lbSort = lbSort === 'points' ? 'perGame' : 'points';
  refreshLeaderboard();
});
$('lbViewStandings').addEventListener('click', () => {
  lbView = 'standings';
  refreshLeaderboard();
});
$('lbViewStats').addEventListener('click', () => {
  lbView = 'stats';
  refreshLeaderboard();
});

// The game is only served to a signed-in user, so this is a check that the session still holds,
// not a login. Signed in, you land where you left off (online the first time).
async function boot() {
  localStorage.removeItem('big2.record'); // the old count kept in this browser: stats live on the server now
  try {
    user = (await api.me()).user;
  } catch (err) {
    if (err.status === 401) return sessionLost();
  }
  if (user) {
    $('who').textContent = user.name;
    show('account', true);
    renderAccountMenu();
    flushSoloResults();
  }
  try {
    const config = await api.config();
    devTables = !!config.devTables;
    if (config.label) {
      // A test copy says so on every page, so it cannot be mistaken for the real one.
      $('siteLabel').textContent = config.label;
      show('siteLabel', true);
      document.title = `${config.label}: ${document.title}`;
    }
  } catch {
    /* the production rules are the safe default */
  }
  for (const el of document.querySelectorAll('.dev-only')) el.hidden = !devTables;
  if (user && localStorage.getItem('big2.mode') !== 'solo') enterOnline();
  else {
    if (!restoreSolo()) startGame();
    document.body.dataset.online = 'solo'; // started in a solo game (the browser tests wait for this or 'ready')
  }
}
boot();
