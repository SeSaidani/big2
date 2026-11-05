// The command-line entry points must run when launched through a symlinked
// directory, as in production, where systemd runs /opt/big2/current/server/*.js
// and "current" is a symlink to the release folder. (When this broke, each
// script silently did nothing and exited with status 0.)

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { openDb } from '../server/db.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function linkedRoot() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'big2-entry-'));
  const link = path.join(tmp, 'current');
  fs.symlinkSync(ROOT, link, 'junction'); // a junction needs no privilege on Windows
  return { tmp, script: (name) => path.join(link, 'server', name) };
}

function run(script, args, env) {
  return spawnSync(process.execPath, [script, ...args], {
    env: { ...process.env, ...env },
    encoding: 'utf8',
    timeout: 30000,
  });
}

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
  const { tmp, script } = linkedRoot();
  const port = await freePort();
  const child = spawn(process.execPath, [script('index.js')], {
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

test('the backup tool writes a verified backup when launched through a symlink', () => {
  const { tmp, script } = linkedRoot();
  try {
    const dbFile = path.join(tmp, 'big2.db');
    openDb(dbFile).close();
    const dir = path.join(tmp, 'backups');
    const r = run(script('backup.js'), [dir, '3'], { DB_FILE: dbFile });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /Backed up to /);
    const files = fs.readdirSync(dir);
    assert.ok(files.includes('latest.db'), files.join(','));
    assert.ok(files.some((f) => /^big2-.*\.db$/.test(f)));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('the admin tool creates and lists an admin when launched through a symlink', () => {
  const { tmp, script } = linkedRoot();
  try {
    const env = {
      DB_FILE: path.join(tmp, 'big2.db'),
      BIG2_PASSWORD: 'correct-horse-battery',
    };
    const made = run(script('admin.js'), ['make-admin', 'boss'], env);
    assert.equal(made.status, 0, made.stderr);
    assert.match(made.stdout, /Created admin "boss"/);
    const listed = run(script('admin.js'), ['list-users'], env);
    assert.equal(listed.status, 0, listed.stderr);
    assert.match(listed.stdout, /boss\s+\[admin\]/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
