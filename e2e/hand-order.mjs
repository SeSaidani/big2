// Rearranging your own hand: hold a card and slide it; a quick swipe still selects; the order is yours until the next
// deal; the Sort button takes you back to the sort. Done with a mouse, and with real touch at phone size.
import { launch, newPage, sleep, outDir, HELPERS } from './lib.mjs';

const OUT = outDir(process.argv[2]);
const PORT = 8783;
const CDP = 9351;
const BASE = `http://127.0.0.1:${PORT}/`;
const PW = 'admin-password-123';

const env = await launch({ port: PORT, cdp: CDP, tmpPrefix: 'big2-e2e-ho-' });
const results = [];
const check = (label, ok, extra = '') => {
  results.push(ok);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${extra ? '  ' + extra : ''}`);
  if (!ok) throw new Error('check failed: ' + label);
};

let A;
const byId = (id) => `document.getElementById(${JSON.stringify(id)})`;
const order = () => A.ev(`[...document.querySelectorAll('#hand .card')].map((c) => Number(c.dataset.id))`);
const selectedCount = () => A.ev(`document.querySelectorAll('#hand .card.selected').length`);
const sortLabel = () => A.text('sortBtn');
const inSolo = `document.body.classList.contains('solo') && document.querySelectorAll('#hand .card').length > 0`;
// The point on card i that is really that card (cards overlap), and how far apart neighbouring cards sit.
const where = (i) =>
  A.ev(
    `(() => { ${HELPERS} const p = slice(${i}); const k = $('hand').children; return p && { x: p.x, y: p.y, step: k[1].offsetLeft - k[0].offsetLeft }; })()`,
  );
// A pointer event on the hand, as the page sees them from a mouse.
const fire = (type, x, y) =>
  A.ev(
    `document.getElementById('hand').dispatchEvent(new PointerEvent(${JSON.stringify(type)}, { bubbles: true, clientX: ${x}, clientY: ${y}, pointerId: 1, pointerType: 'mouse', button: 0 }))`,
  );
const moved = (ids, id, to) => {
  const rest = ids.filter((c) => c !== id);
  return [...rest.slice(0, to), id, ...rest.slice(to)];
};

// Hold card `i` (no movement for longer than the hold time), slide it `slots` places to the right, and let go.
async function carry(i, slots) {
  const p = await where(i);
  await fire('pointerdown', p.x, p.y);
  await sleep(380);
  check('the held card comes away from the hand', await A.ev(`!!document.querySelector('#hand .card.carried')`));
  for (let s = 1; s <= Math.abs(slots); s++) {
    await fire('pointermove', p.x + Math.sign(slots) * s * p.step, p.y);
    await sleep(30);
  }
  await fire('pointerup', p.x + slots * p.step, p.y);
  await sleep(80);
}

async function main() {
  console.log('CLI:', env.makeAdmin('boss', PW).stdout.trim());
  await env.state.start();
  A = await newPage(CDP, 'A', OUT);
  await A.goto(BASE);
  await A.signIn('boss', PW);
  await A.click('modeSolo');
  await A.waitFor(inSolo, 8000, 'a solo game');

  // ---- hold and slide ----
  const start = await order();
  check('the hand starts sorted, not "mine"', /Sort: (rank|suit)/.test(await sortLabel()), await sortLabel());
  await carry(0, 4);
  const after = await order();
  check(
    'the card is where it was dropped and the others kept their order',
    after.join() === moved(start, start[0], 4).join(),
    after.join(),
  );
  check(
    'the same cards are still held',
    [...after].sort((a, b) => a - b).join() === [...start].sort((a, b) => a - b).join(),
  );
  check('nothing was selected by it', (await selectedCount()) === 0);
  check('the Sort button says the order is mine', (await sortLabel()) === 'Sort: mine', await sortLabel());
  await A.shot('1-rearranged');

  // ---- a quick swipe still selects, and does not move cards ----
  const before = await order();
  const a = await where(1);
  await fire('pointerdown', a.x, a.y);
  await fire('pointermove', a.x + a.step, a.y);
  await fire('pointermove', a.x + 2 * a.step, a.y);
  await fire('pointerup', a.x + 2 * a.step, a.y);
  await sleep(60);
  check(
    'a quick swipe selects the cards it crosses',
    (await selectedCount()) >= 2,
    `${await selectedCount()} selected`,
  );
  check('and does not rearrange the hand', (await order()).join() === before.join());
  await A.click('clearBtn');

  // ---- a tap still toggles one card ----
  const t = await where(3);
  await fire('pointerdown', t.x, t.y);
  await fire('pointerup', t.x, t.y);
  await sleep(60);
  check('a tap selects one card', (await selectedCount()) === 1);
  await A.click('clearBtn');

  // ---- holding a card and putting it back where it was changes nothing ----
  const keep = await order();
  const h = await where(2);
  await fire('pointerdown', h.x, h.y);
  await sleep(380);
  await fire('pointerup', h.x, h.y);
  await sleep(60);
  check('picking a card up and putting it back leaves the order alone', (await order()).join() === keep.join());
  check('and does not leave it selected', (await selectedCount()) === 0);

  // ---- my order survives going online and back ----
  await A.click('modeOnline');
  await A.waitFor(`document.body.classList.contains('online') && !${byId('lobbyHome')}.hidden`, 8000, 'the lobby');
  await A.click('modeSolo');
  await A.waitFor(inSolo, 8000, 'the solo table again');
  check(
    'my order is kept when I go online and come back',
    (await order()).join() === keep.join() && (await sortLabel()) === 'Sort: mine',
  );

  // ---- Sort takes me back to the sort ----
  await A.click('sortBtn');
  const sorted = await order();
  check('Sort puts the hand back in order', /Sort: (rank|suit)/.test(await sortLabel()), await sortLabel());
  check('and changes the order I made', sorted.join() !== keep.join());

  // ---- a new deal always starts sorted ----
  await carry(0, 3);
  check('rearranged again', (await sortLabel()) === 'Sort: mine');
  await A.click('newBtn');
  await A.click('ngStart');
  await A.waitFor(`!${byId('newGameDlg')}.open`, 5000, 'the dialog closing');
  await sleep(400);
  check(
    'a new game starts sorted, not in my old order',
    /Sort: (rank|suit)/.test(await sortLabel()),
    await sortLabel(),
  );

  // ---- real touch at phone size ----
  await A.phone();
  await sleep(600);
  await A.waitFor(`document.querySelectorAll('#hand .card').length > 0`, 5000, 'the hand at phone size');
  const phoneStart = await order();
  const q = await where(0);
  const scroll0 = await A.ev('window.scrollY');
  await A.touch('touchStart', q.x, q.y);
  await sleep(400);
  check('on a phone, holding a card lifts it', await A.ev(`!!document.querySelector('#hand .card.carried')`));
  for (let s = 1; s <= 4; s++) {
    // the finger drifts up a little as it slides, as a real one does: that must not turn into a page scroll
    await A.touch('touchMove', q.x + s * q.step, q.y - 6 * s);
    await sleep(40);
  }
  await A.touch('touchEnd', q.x + 4 * q.step, q.y - 24);
  await sleep(120);
  const phoneAfter = await order();
  check(
    'on a phone, sliding it moves it',
    phoneAfter.join() === moved(phoneStart, phoneStart[0], 4).join(),
    phoneAfter.join(),
  );
  check('and the page did not scroll', (await A.ev('window.scrollY')) === scroll0);
  await A.shot('2-phone-rearranged');

  // a quick swipe on the phone still selects
  const s0 = await where(1);
  await A.swipe(s0.x, s0.y, s0.x + 3 * s0.step, s0.y, 6);
  check(
    'on a phone a quick swipe still selects, and moves nothing',
    (await selectedCount()) >= 2 && (await order()).join() === phoneAfter.join(),
  );
}

let failed = false;
try {
  await main();
} catch (err) {
  failed = true;
  console.log('FAILED:', err.message);
  try {
    if (A) await A.shot('failure');
  } catch {
    /* ignore */
  }
}
if (A) console.log(`browser errors [${A.name}]:`, A.errors.length ? [...new Set(A.errors)] : 'none');
console.log(`${results.length} checks passed${failed ? ', then FAILED' : ''}`);
await sleep(100);
await env.cleanup();
process.exit(failed ? 1 : 0);
