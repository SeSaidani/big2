// The server must start when launched through a symlinked directory, as in
// production, where systemd runs /opt/big2/current/server/index.js and "current"
// is a symlink to the release folder.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

test('the server starts when launched through a symlinked directory', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'big2-entry-'));
  const link = path.join(tmp, 'current');
  fs.symlinkSync(ROOT, link, 'junction'); // a junction needs no privilege on Windows
  const port = await freePort();
  const child = spawn(process.execPath, [path.join(link, 'server', 'index.js')], {
    env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', DB_FILE: path.join(tmp, 'big2.db') },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (d) => (output += d));
  child.stderr.on('data', (d) => (output += d));
  const exited = new Promise((resolve) => child.once('exit', (code) => resolve(code)));
  try {
    const deadline = Date.now() + 10000;
    let config = null;
    while (Date.now() < deadline && !config) {
      const early = await Promise.race([exited, new Promise((r) => setTimeout(r, 100, 'running'))]);
      assert.equal(early, 'running', `the server exited early (code ${early}): ${output}`);
      config = await fetch(`http://127.0.0.1:${port}/api/config`)
        .then((r) => r.json())
        .catch(() => null);
    }
    assert.ok(config, `the server never answered: ${output}`);
    assert.equal(typeof config.registrationOpen, 'boolean');
  } finally {
    child.kill();
    await exited;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
