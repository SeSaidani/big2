// Shared plumbing for the headless-Chrome end-to-end scripts: start a real server
// on a throwaway database, drive Chrome over the DevTools protocol (no browser
// automation library), and take screenshots.
//
// Needs Chrome or Chromium. Set CHROME_PATH if it is not in a standard location.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function findChrome() {
  const candidates = [
    process.env.CHROME_PATH,
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
  ].filter(Boolean);
  const found = candidates.find((c) => fs.existsSync(c));
  if (!found) throw new Error('Chrome not found. Set CHROME_PATH to a Chrome or Chromium executable.');
  return found;
}
export const CHROME = findChrome();

// Screenshots go to the given directory, default e2e/out (git-ignored).
export function outDir(arg) {
  const dir = arg ? path.resolve(arg) : path.join(ROOT, 'e2e', 'out');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class Conn {
  constructor(url, onEvent) {
    this.ws = new WebSocket(url);
    this.n = 0;
    this.waiting = new Map();
    this.onEvent = onEvent;
    this.ready = new Promise((r) => (this.ws.onopen = r));
    this.ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && this.waiting.has(m.id)) {
        this.waiting.get(m.id)(m);
        this.waiting.delete(m.id);
      } else if (this.onEvent) this.onEvent(m);
    };
  }

  send(method, params = {}) {
    return new Promise((res) => {
      const id = ++this.n;
      this.waiting.set(id, res);
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
}

export class Page {
  constructor(name, wsUrl, out) {
    this.name = name;
    this.out = out;
    this.errors = [];
    this.conn = new Conn(wsUrl, (m) => this.onEvent(m));
  }

  onEvent(m) {
    if (m.method === 'Runtime.exceptionThrown') {
      const d = m.params.exceptionDetails;
      this.errors.push('EXCEPTION ' + ((d.exception && d.exception.description) || d.text));
    } else if (m.method === 'Runtime.consoleAPICalled' && ['error', 'warning'].includes(m.params.type)) {
      this.errors.push(`console.${m.params.type}: ` + m.params.args.map((a) => a.value || a.description).join(' '));
    } else if (m.method === 'Log.entryAdded' && m.params.entry.level === 'error') {
      this.errors.push('LOG ' + m.params.entry.text + ' ' + (m.params.entry.url || ''));
    }
  }

  async init() {
    await this.conn.ready;
    for (const d of ['Runtime', 'Log', 'Page']) await this.conn.send(`${d}.enable`);
    await this.desktop();
  }

  async desktop() {
    await this.conn.send('Emulation.setTouchEmulationEnabled', { enabled: false });
    await this.conn.send('Emulation.setDeviceMetricsOverride', {
      width: 1400,
      height: 900,
      deviceScaleFactor: 1,
      mobile: false,
    });
  }

  // Window size for desktop-style tests (mobile = false) without touch input.
  async size(width, height, mobile = false) {
    await this.conn.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile });
  }

  async phone(width = 390, height = 844) {
    await this.conn.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 2, mobile: true });
    await this.conn.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
  }

  async ev(expression) {
    const r = await this.conn.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.result.exceptionDetails) {
      throw new Error(`[${this.name}] ` + JSON.stringify(r.result.exceptionDetails).slice(0, 500));
    }
    return r.result.result.value;
  }

  async waitFor(expr, ms = 15000, label = expr) {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      if (await this.ev(expr)) return;
      await sleep(100);
    }
    throw new Error(`[${this.name}] timed out waiting for: ${label}`);
  }

  async shot(name) {
    const r = await this.conn.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(this.out, `${this.name}-${name}.png`), Buffer.from(r.result.data, 'base64'));
  }

  goto(url) {
    return this.conn.send('Page.navigate', { url });
  }

  click(id) {
    return this.ev(`document.getElementById(${JSON.stringify(id)}).click()`);
  }

  text(id) {
    return this.ev(`document.getElementById(${JSON.stringify(id)}).textContent`);
  }

  visible(id) {
    return this.ev(`!document.getElementById(${JSON.stringify(id)}).hidden`);
  }

  clickButton(selector, text) {
    return this.ev(
      `(() => { const b = [...document.querySelectorAll(${JSON.stringify(selector + ' button')})].find(x => x.textContent.trim() === ${JSON.stringify(text)}); if (!b) return false; b.click(); return true; })()`,
    );
  }

  async signIn(name, password) {
    await this.click('modeOnline');
    await this.waitFor(`document.getElementById('loginDlg').open`, 5000, 'login dialog');
    await this.ev(
      `document.getElementById('loginName').value=${JSON.stringify(name)}; document.getElementById('loginPw').value=${JSON.stringify(password)}; document.getElementById('loginBtn').click()`,
    );
    await this.waitFor(
      `document.getElementById('lobbyUser').textContent===${JSON.stringify(name)} && !document.getElementById('lobbyHome').hidden`,
      10000,
      `${name} in the lobby`,
    );
  }

  // Real touch input (needs phone() first): the browser turns these into pointer events.
  async touch(type, x, y) {
    await this.conn.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x, y }] });
  }

  async tap(x, y) {
    await this.touch('touchStart', x, y);
    await sleep(40);
    await this.touch('touchEnd', x, y);
    await sleep(60);
  }

  async swipe(x1, y1, x2, y2, steps = 12) {
    await this.touch('touchStart', x1, y1);
    for (let i = 1; i <= steps; i++) {
      await this.touch('touchMove', x1 + ((x2 - x1) * i) / steps, y1 + ((y2 - y1) * i) / steps);
      await sleep(15);
    }
    await this.touch('touchEnd', x2, y2);
    await sleep(80);
  }
}

// Page-side helpers. The hand selects on pointer events at a card's exposed
// slice, so tests find a point that really hits card i (cards overlap and are
// rotated, so a bounding box is not enough) and fire pointer events there.
export const HELPERS = `
  const $ = (id) => document.getElementById(id);
  const slice = (i) => {
    const el = $('hand').children[i];
    if (!el) return null;
    const r = el.getBoundingClientRect();
    for (const dy of [14, 22, 30]) {
      const hits = [];
      for (let x = Math.max(0, Math.floor(r.left)); x < Math.min(innerWidth, r.right); x += 1) {
        const t = document.elementFromPoint(x, r.top + dy);
        if (t && t.closest('.card') === el) hits.push(x);
      }
      if (hits.length) return { x: hits[Math.floor(hits.length / 2)], y: r.top + dy, width: hits.length };
    }
    return null;
  };
  const pick = (i) => {
    const p = slice(i);
    if (!p) return false;
    const fire = (t) => $('hand').dispatchEvent(new PointerEvent(t, { bubbles: true, clientX: p.x, clientY: p.y, pointerId: 1, pointerType: 'mouse', button: 0 }));
    fire('pointerdown'); fire('pointerup');
    return true;
  };
`;

// One move for whoever is at this page: play the lowest single that is legal, else pass.
export const STEP = `(async () => {
  ${HELPERS}
  if (!$('overlay').hidden) return 'over';
  if ($('tableMain').hidden || $('hand').classList.contains('disabled') || !$('hand').children.length) return 'wait';
  const n = $('hand').children.length;
  for (let i = 0; i < n; i++) {
    if (!pick(i)) continue;
    if (!$('playBtn').disabled) { $('playBtn').click(); return 'play'; }
    pick(i);
  }
  if (!$('passBtn').disabled) { $('passBtn').click(); return 'pass'; }
  return 'stuck';
})()`;
export async function launch({ port, cdp, tmpPrefix }) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), tmpPrefix));
  const dbFile = path.join(tmp, 'e2e.db');
  const env = { ...process.env, PORT: String(port), DB_FILE: dbFile, AI_DELAY_MS: '90' };
  const state = { server: null, out: '' };
  state.start = async () => {
    state.out = '';
    state.server = spawn(process.execPath, ['server/index.js'], { cwd: ROOT, env });
    state.server.stdout.on('data', (d) => (state.out += d));
    state.server.stderr.on('data', (d) => (state.out += d));
    for (let i = 0; i < 100 && !state.out.includes('Big Two online'); i++) await sleep(100);
    if (!state.out.includes('Big Two online')) throw new Error('server did not start: ' + state.out);
  };
  const makeAdmin = (name, password) =>
    spawnSync(process.execPath, ['server/admin.js', 'make-admin', name], {
      cwd: ROOT,
      env: { ...env, BIG2_PASSWORD: password },
      encoding: 'utf8',
    });
  const chrome = spawn(CHROME, [
    '--headless=new',
    `--remote-debugging-port=${cdp}`,
    '--remote-allow-origins=*',
    `--user-data-dir=${path.join(tmp, 'profile')}`,
    '--no-first-run',
    '--disable-gpu',
    'about:blank',
  ]);
  const cleanup = async () => {
    chrome.kill();
    if (state.server) state.server.kill();
    await sleep(600);
    try {
      fs.rmSync(tmp, { recursive: true, force: true });
    } catch {
      /* Chrome may still hold files */
    }
  };
  return { state, makeAdmin, chrome, cleanup, env };
}

export async function newPage(cdp, name, out) {
  let info;
  for (let i = 0; i < 100; i++) {
    try {
      info = await (await fetch(`http://127.0.0.1:${cdp}/json/version`)).json();
      break;
    } catch {
      await sleep(100);
    }
  }
  const browser = new Conn(info.webSocketDebuggerUrl);
  await browser.ready;
  const { result } = await browser.send('Target.createBrowserContext');
  const created = await browser.send('Target.createTarget', {
    url: 'about:blank',
    browserContextId: result.browserContextId,
  });
  const targetId = created.result.targetId;
  let list;
  for (let i = 0; i < 50; i++) {
    list = await (await fetch(`http://127.0.0.1:${cdp}/json/list`)).json();
    if (list.find((t) => t.id === targetId)) break;
    await sleep(100);
  }
  const p = new Page(name, list.find((t) => t.id === targetId).webSocketDebuggerUrl, out);
  await p.init();
  return p;
}
