// Browser front end: rendering, input, and turn sequencing. All rules live
// in game.js; AI decisions run in a Web Worker and only see observe() views.

import { isJoker, suitOf, isRedSuit, cardName, sortByRank, sortBySuit } from './cards.js';
import { cardSVG } from './card-art.js';
import { classify, describe } from './hands.js';
import { newGame, applyMove, validatePlay, observe, turnRules, autoSkip } from './game.js';
import { heuristicMove } from './ai/heuristic.js';
import { chooseMove } from './ai/agents.js';
import { api, connect } from './online.js';
import { mirrorState, newEvents, seatNames, isComputer, isAway, unrot } from './online-view.js';

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
let thinking = -1;
let busy = false;
let gen = 0; // bumps on New game so stale async work is dropped
let sortMode = localStorage.getItem('big2.sort') || 'rank';
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
let viewingLobby = false; // seated, but looking at the lobby instead of the table
let adminView = false;
let chatMsgs = [];
let lbSeason = 'current'; // 'current' | 'all' | a season id
let lbSort = 'points'; // 'points' (running total) | 'perGame'
let lbView = 'standings'; // 'standings' | 'stats' (luck and skill)
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

const myTurn = () => !!game && game.winner < 0 && game.turn === 0 && !busy && !sending;

function renderHand() {
  const handEl = $('hand');
  handEl.innerHTML = '';
  handEl.classList.toggle('disabled', !myTurn());
  const cards = sortMode === 'rank' ? sortByRank(game.hands[0]) : sortBySuit(game.hands[0]);
  const deg = PHONE.matches ? 2.3 : 3; // a gentler curve keeps 14 cards inside a phone's width
  cards.forEach((c, i) => {
    const el = fanStyle(cardEl(c), i, cards.length, deg);
    el.dataset.id = String(c);
    if (selected.has(c)) el.classList.add('selected');
    handEl.appendChild(el); // taps and swipes are handled on the hand itself (below)
  });
  const me = $('seat-0');
  const fan = $('playedFan');
  me.innerHTML = '';
  fan.innerHTML = '';
  if (seatActions[0] === 'pass') me.textContent = 'You passed';
  else if (seatActions[0] === 'leadpass') me.textContent = 'You passed the lead';
  else if (seatActions[0] === 'cantbeat') me.textContent = "You can't beat it";
  else if (seatActions[0]) {
    me.textContent = 'You played';
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
  if (drag.select) selected.add(id);
  else selected.delete(id);
  render();
}
$('hand').addEventListener('pointerdown', (e) => {
  if (e.pointerType === 'mouse' && e.button !== 0) return;
  const id = cardAt(e.clientX, e.clientY);
  if (id === null || !game) return;
  drag = { select: !selected.has(id), seen: new Set() };
  try {
    $('hand').setPointerCapture(e.pointerId); // keep receiving moves after the cards are re-rendered
  } catch {
    /* synthetic pointer: no capture needed */
  }
  dragOver(id);
});
$('hand').addEventListener('pointermove', (e) => drag && dragOver(slotAt(e.clientX, e.clientY)));
for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) {
  $('hand').addEventListener(type, () => {
    drag = null;
  });
}

function renderSelection() {
  const info = $('selInfo');
  const cards = [...selected];
  let canPlay = false;
  if (!cards.length) {
    info.innerHTML = myTurn() ? '<span class="muted">Select cards to play</span>' : '';
  } else {
    const cls = classify(cards);
    const err = myTurn() ? validatePlay(game, cards) : null;
    canPlay = myTurn() && !err;
    if (!cls) info.innerHTML = '<span class="bad">Not a valid combination</span>';
    else if (err) info.innerHTML = `${describe(cls)} · <span class="bad">${err}</span>`;
    else info.innerHTML = `<span class="ok">${describe(cls)}</span>`;
  }
  $('playBtn').disabled = !canPlay;
  $('passBtn').disabled = !(myTurn() && turnRules(game).canPass);
  $('clearBtn').disabled = selected.size === 0;
  $('sortBtn').textContent = `Sort: ${sortMode}`;
}

function renderRecord() {
  const rec = JSON.parse(localStorage.getItem('big2.record') || '{"played":0,"won":0}');
  $('record').textContent = rec.played ? `You've won ${rec.won} of ${rec.played}` : '';
}

function render() {
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
}

// ---------- Turn flow ----------
function renderSoloChip() {
  $('soloChip').textContent = `${soloPlayers} players · ${LEVEL_LABEL[level]}`;
}

function startGame() {
  renderSoloChip();
  gen++;
  pending.clear();
  NAMES = SOLO_NAMES[soloPlayers];
  game = newGame(Math.random, null, soloPlayers);
  selected = new Set();
  shownTrick = null;
  seatActions = noActions(soloPlayers);
  thinking = -1;
  busy = false;
  $('log').innerHTML = '';
  $('overlay').hidden = true;
  const opener = game.turn === 0 ? 'You have the 3♦ and lead.' : `${NAMES[game.turn]} has the 3♦ and leads.`;
  log(`New round. ${opener}`, 'sys');
  continueTurn();
}

function myTurnMessage() {
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
    for (let q = 0; q < seatActions.length; q++) if (seatActions[q] === 'leadpass') seatActions[q] = null;
    log(`${NAMES[p]}: ${describe(cls)}`, p === 0 ? 'you' : '', cards);
    skipped = autoSkip(game);
    for (const q of skipped) seatActions[q] = 'cantbeat';
  } else {
    log(leadPass ? `${NAMES[p]} passed the lead` : `${NAMES[p]} passed`, p === 0 ? 'you' : '');
  }
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
  const rec = JSON.parse(localStorage.getItem('big2.record') || '{"played":0,"won":0}');
  rec.played++;
  if (w === 0) rec.won++;
  localStorage.setItem('big2.record', JSON.stringify(rec));
  renderRecord();
  log(w === 0 ? 'You went out. You win!' : `${NAMES[w]} went out and wins.`, 'sys');
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
  sortMode = sortMode === 'rank' ? 'suit' : 'rank';
  localStorage.setItem('big2.sort', sortMode);
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
  startGame();
}

async function enterOnline() {
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

function beginOnline() {
  $('who').textContent = user.name;
  show('account', true);
  show('passwordBtn', true);
  show('phoneBtn', true);
  show('adminBtn', user.isAdmin);
  adminView = false;
  viewingLobby = false;
  table = null;
  chatMsgs = [];
  openStream();
  refreshSeasons();
  refreshLeaderboard();
  route();
  // Everyone needs a verified number to play online: ask straight away.
  if (user.phoneRequired) openPhoneDialog();
}

// (Re)open the live stream. The server answers every connection with the
// current lobby, my table (or null) and chat history, so reconnecting is safe.
function openStream() {
  closeStream();
  eventSource = connect({
    onOpen: () => {
      acceptAny = true;
    },
    onLobby: ({ game }) => {
      lobbyGame = game;
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
  if (inLobby && !waiting) renderLobbyHome();
  if (inLobby && waiting) renderWaitRoom(table);
  renderChat();
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
  // Nobody joins or creates a game without a verified number: that is how we tell them it is their turn.
  if (user.phoneRequired) {
    show('createRow', false);
    line(
      user.phone
        ? 'Confirm your phone number to play: we will text you a code.'
        : 'Add your phone number to play online: we text you when it is your turn.',
    );
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'primary';
    b.textContent = user.phone ? 'Confirm my number' : 'Add my number';
    b.addEventListener('click', openPhoneDialog);
    box.appendChild(b);
    return;
  }
  // A finished round's result does not block a new game (the server replaces it).
  show('createRow', !!user.isAdmin && (!g || g.status === 'done'));
  if (!g) {
    if (!user.isAdmin) line('No game is running. An admin starts the games.', 'muted');
    return;
  }
  // The current game, as a card: who is hosting, where it is up to, who is in, and what the empty seats get.
  const state = { waiting: 'Waiting to start', playing: 'In progress', done: 'Just finished' }[g.status] || g.status;
  const empty = g.seats - g.humans;
  const facts = document.createElement('dl');
  facts.className = 'facts';
  for (const [label, value] of [
    ['Host', g.host],
    ['Status', state],
    ['Table', `${g.seats} seats`],
    ['Players', g.players.length ? g.players.join(', ') : 'nobody yet'],
    [
      'Computer',
      empty > 0
        ? `${LEVEL_LABEL[g.aiLevel] || g.aiLevel} AI plays the ${empty} empty seat${empty === 1 ? '' : 's'}, so this game will not count on the leaderboard`
        : 'no computer players',
    ],
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
  if (table) {
    const b = document.createElement('button');
    b.className = 'primary';
    b.textContent = g.status === 'done' ? 'See the result' : 'Rejoin your game';
    b.addEventListener('click', () => {
      viewingLobby = false;
      route();
    });
    row.appendChild(b);
  } else if (g.status === 'waiting') {
    const b = document.createElement('button');
    b.className = 'primary';
    b.textContent = 'Join game';
    b.addEventListener('click', joinGame);
    row.appendChild(b);
  } else {
    line('This game is already running, so it cannot be joined. Watch for the next one.', 'muted');
  }
  box.appendChild(row);
}

function renderWaitRoom(t) {
  $('waitInfo').textContent =
    `Host: ${t.host}. Empty seats will be played by ${t.aiLevel} AI, and a game with computer players does not count on the leaderboard.`;
  const ul = $('waitSeats');
  ul.innerHTML = '';
  t.seats.forEach((s, i) => {
    const li = document.createElement('li');
    const empty = s.kind === 'empty';
    li.textContent = empty
      ? `Seat ${i + 1}: empty (${t.aiLevel} AI will play)`
      : `Seat ${i + 1}: ${s.name}${i === t.you ? ' (you)' : ''}`;
    if (empty) li.className = 'muted';
    ul.appendChild(li);
  });
  show('startBtn', t.isHost);
  if (!$('waitMsg').textContent || $('waitMsg').className === 'muted') {
    $('waitMsg').textContent = t.isHost ? '' : 'Waiting for the host to start.';
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
  add('current', current ? `Current season (${current.name})` : 'Current season (none right now)');
  for (const s of list) add(String(s.id), `${s.name}${s.status === 'upcoming' ? ' (upcoming)' : ''}`);
  add('all', 'All-time');
  if (![...sel.options].some((o) => o.value === lbSeason)) lbSeason = 'current';
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
        : `Shown from ${minGames} games. Only games with no computer players, saved with their deals, count (the "of" column shows how many of a player's games that is).`,
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
    onTable(r.table);
  } catch (err) {
    $(msgId).textContent = err.message;
  }
}

const joinGame = () => gameAction(() => api.join(), 'lobbyMsg');
const startOnlineRound = () => gameAction(() => api.start(), table && table.status === 'done' ? 'endNote' : 'waitMsg');
const leaveTable = () => gameAction(() => api.leave(), table && table.status === 'done' ? 'endNote' : 'waitMsg');
const backToLobby = () => {
  viewingLobby = true;
  route();
};

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
  if (!acceptAny && prev && prev.id === t.id && t.version <= prev.version) return;
  acceptAny = false;
  const fresh = !prev || prev.id !== t.id || (prev.status !== 'playing' && t.status === 'playing');
  table = t;
  if (t.status === 'waiting') {
    if (fresh || !prev) $('waitMsg').textContent = '';
    return route();
  }
  // A new round, or the result of the one in progress, brings you back to the table.
  if (fresh || (t.status === 'done' && (!prev || prev.status !== 'done'))) viewingLobby = false;

  NAMES = seatNames(t);
  if (fresh) {
    selected = new Set();
    histLen = 0;
    clearTrickReset();
    clearTrickDisplay();
    $('log').innerHTML = '';
  }
  game = mirrorState(t);
  const events = newEvents(histLen, t);
  histLen = t.game.view.history.length;
  const replay = fresh && events.length > 1; // joining mid-game: log it, don't animate it
  if (fresh && !replay) {
    log(
      `New round. ${NAMES[game.turn]} ${game.turn === 0 ? 'have' : 'has'} the 3♦ and ${game.turn === 0 ? 'lead' : 'leads'}.`,
      'sys',
    );
  }
  const closed = applyEvents(events, replay);
  thinking = game.winner < 0 && game.turn !== 0 && isComputer(t, game.turn) ? game.turn : -1;
  render();
  if (game.winner >= 0) {
    endOnlineRound(t, !!prev && prev.status === 'done' && prev.id === t.id);
  } else if (!closed) {
    if (game.turn === 0) setStatus(myTurnMessage());
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
      for (let q = 0; q < seatActions.length; q++) if (seatActions[q] === 'leadpass') seatActions[q] = null;
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
    const whose = lastPlay.p === 0 ? 'your' : `${NAMES[lastPlay.p]}'s`;
    msg = `Nobody can beat ${whose} ${describe(lastPlay.cls)}. ${lastPlay.p === 0 ? 'You lead' : `${NAMES[lastPlay.p]} leads`} again.`;
  } else {
    msg = `${game.turn === 0 ? 'You win' : `${NAMES[game.turn]} wins`} the trick.`;
  }
  setStatus(msg);
  log(msg, 'sys');
  trickReset = setTimeout(() => {
    trickReset = null;
    clearTrickDisplay();
    render();
    if (game.winner < 0) setStatus(game.turn === 0 ? myTurnMessage() : '');
  }, TRICK_PAUSE_MS);
  return true;
}

function endOnlineRound(t, alreadyShown) {
  const w = game.winner;
  const r = t.result;
  setStatus('');
  if (!alreadyShown) log(w === 0 ? 'You went out. You win!' : `${NAMES[w]} went out and wins.`, 'sys');
  $('endTitle').textContent = w === 0 ? 'You win! 🎉' : `${NAMES[w]} wins`;
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
  if (!t.isHost) notes.push(`Waiting for ${t.host} to start another round.`);
  $('endNote').className = 'muted';
  $('endNote').textContent = notes.join(' ');
  show('againBtn', t.isHost);
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

// A button that needs a second click within four seconds, for things that can't be undone.
function armedButton(label, action) {
  const btn = document.createElement('button');
  let timer = null;
  btn.textContent = label;
  btn.addEventListener('click', () => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
      btn.textContent = label;
      action();
    } else {
      btn.textContent = 'Click again to confirm';
      timer = setTimeout(() => {
        timer = null;
        btn.textContent = label;
      }, 4000);
    }
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
    cell(s.games);
    cell(s.champion || '-');
    const actions = document.createElement('td');
    actions.className = 'actions-cell';
    const edit = document.createElement('button');
    edit.textContent = 'Edit';
    edit.addEventListener('click', () => startSeasonEdit(s));
    actions.append(
      edit,
      armedButton('Delete', () => seasonDo(() => api.admin.deleteSeason(s.id))),
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
}

async function seasonDo(fn) {
  $('seasonMsg').className = 'muted';
  $('seasonMsg').textContent = '';
  try {
    await fn();
  } catch (err) {
    $('seasonMsg').className = 'bad';
    $('seasonMsg').textContent = err.message;
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
  const starts = startText ? keep(startText, editingSeason && editingSeason.starts) : NaN;
  const ends = endText ? keep(endText, editingSeason && editingSeason.ends) : null;
  if (Number.isNaN(starts) || (ends !== null && Number.isNaN(ends))) {
    $('seasonMsg').className = 'bad';
    $('seasonMsg').textContent = 'Please enter a valid start time (and a valid end time, or leave it empty).';
    return;
  }
  const editing = editingSeason;
  const ok = await seasonDo(() =>
    editing ? api.admin.updateSeason(editing.id, name, starts, ends) : api.admin.createSeason(name, starts, ends),
  );
  if (ok) {
    resetSeasonForm();
    $('seasonMsg').textContent = editing ? 'Season updated.' : 'Season created.';
  }
}

function renderAdmin(o, users, entries) {
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
    p.textContent = `${o.game.host}'s game (${o.game.status}). Players: ${o.game.players.join(', ') || 'nobody'}. ${o.game.aiLevel} AI.`;
    box.appendChild(p);
    const note = document.createElement('p');
    note.className = 'muted';
    note.textContent =
      o.game.status === 'playing'
        ? 'Cancelling a game in progress ends it for everyone and it is not scored.'
        : 'Cancelling clears the table.';
    box.append(
      note,
      armedButton('Cancel game', () => adminDo(() => api.admin.cancelGame())),
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
    cell(u.phone ? `${u.phone} (${u.phoneVerified ? 'verified' : 'not verified'})` : 'none');
    cell(u.games);
    cell(u.lastLogin ? new Date(u.lastLogin).toLocaleString() : 'never');
    const actions = document.createElement('td');
    actions.className = 'actions-cell';
    const reset = document.createElement('button');
    reset.textContent = 'Reset password';
    reset.addEventListener('click', () => openReset(u));
    const setPhone = document.createElement('button');
    setPhone.textContent = 'Set phone';
    setPhone.addEventListener('click', () => openAdminPhone(u));
    const dis = armedButton(u.disabled ? 'Enable' : 'Disable', () =>
      adminDo(() => api.admin.setDisabled(u.id, !u.disabled)),
    );
    const role = armedButton(u.isAdmin ? 'Remove admin' : 'Make admin', () =>
      adminDo(() => api.admin.setAdmin(u.id, !u.isAdmin)),
    );
    actions.append(reset, setPhone, dis, role);
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
    await api.admin.createUser(name, $('newUserPw').value, $('newUserPhone').value, $('newUserAdmin').checked);
    msg.textContent = `Created ${name}. Give them the temporary password; they confirm their number when they sign in.`;
    $('newUserName').value = '';
    $('newUserPw').value = '';
    $('newUserPhone').value = '';
    $('newUserAdmin').checked = false;
  } catch (err) {
    msg.className = 'bad';
    msg.textContent = err.message;
    return;
  }
  await refreshAdmin();
}

// ---- my phone number ----
function renderPhoneDialog() {
  $('phoneCurrent').textContent = user.phone || 'none';
  $('phoneState').textContent = user.phone ? (user.phoneVerified ? '(verified)' : '(not verified yet)') : '';
  show('phoneCodeField', !!user.needsCode);
  $('smsToggle').checked = !!user.smsEnabled;
}

function openPhoneDialog() {
  $('phoneMsg').textContent = '';
  $('phoneInput').value = '';
  $('phoneCode').value = '';
  renderPhoneDialog();
  if (!$('phoneDlg').open) $('phoneDlg').showModal();
}

async function phoneDo(fn, okText) {
  const msg = $('phoneMsg');
  msg.className = 'bad';
  msg.textContent = '';
  try {
    const reply = await fn();
    if (reply && reply.user) user = reply.user;
    if (okText) {
      msg.className = 'muted';
      msg.textContent = okText(reply);
    }
  } catch (err) {
    msg.textContent = err.message;
    return false;
  } finally {
    renderPhoneDialog();
    route();
  }
  return true;
}

const savePhone = () =>
  phoneDo(
    () => api.setPhone($('phoneInput').value),
    (r) => (r.codeSent ? 'Saved. We texted you a 6-digit code: enter it below.' : 'Saved.'),
  );
const verifyPhoneCode = async () => {
  if (
    await phoneDo(
      () => api.verifyPhone($('phoneCode').value),
      () => 'Verified. Thank you.',
    )
  ) {
    $('phoneCode').value = '';
  }
};
const resendPhoneCode = () =>
  phoneDo(
    () => api.resendCode(),
    () => 'A new code is on its way.',
  );
const toggleSms = () => phoneDo(() => api.setSms($('smsToggle').checked));

// ---- an admin sets someone's number ----
let adminPhoneTarget = null;
function openAdminPhone(u) {
  adminPhoneTarget = u;
  $('adminPhoneName').textContent = u.name;
  $('adminPhoneInput').value = '';
  $('adminPhoneErr').textContent = '';
  $('adminPhoneDlg').showModal();
}

async function submitAdminPhone() {
  try {
    await api.admin.setPhone(adminPhoneTarget.id, $('adminPhoneInput').value);
  } catch (err) {
    $('adminPhoneErr').textContent = err.message;
    return;
  }
  $('adminPhoneDlg').close();
  await refreshAdmin();
}

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
$('modeOnline').addEventListener('click', () => mode !== 'online' && enterOnline());
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
    await api.logout();
  } catch {
    /* already signed out */
  }
  location.reload(); // the sign-in page is all that is served now
});
$('adminBtn').addEventListener('click', () => {
  adminView = !adminView;
  route();
  if (adminView) refreshAdmin();
});
$('phoneBtn').addEventListener('click', openPhoneDialog);
$('phoneSave').addEventListener('click', savePhone);
$('phoneVerify').addEventListener('click', verifyPhoneCode);
$('phoneResend').addEventListener('click', resendPhoneCode);
$('smsToggle').addEventListener('change', toggleSms);
$('phoneClose').addEventListener('click', () => $('phoneDlg').close());
$('adminPhoneOk').addEventListener('click', submitAdminPhone);
$('adminPhoneCancel').addEventListener('click', () => $('adminPhoneDlg').close());
for (const [id, fn] of [
  ['phoneInput', savePhone],
  ['phoneCode', verifyPhoneCode],
]) {
  $(id).addEventListener('keydown', (e) => e.key === 'Enter' && fn());
}
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
$('leaveBtn').addEventListener('click', backToLobby);
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
  renderRecord();
  try {
    user = (await api.me()).user;
  } catch (err) {
    if (err.status === 401) return sessionLost();
  }
  if (user) {
    $('who').textContent = user.name;
    show('account', true);
  }
  if (user && localStorage.getItem('big2.mode') !== 'solo') enterOnline();
  else startGame();
}
boot();
