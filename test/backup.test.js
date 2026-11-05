import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { backupDatabase } from '../server/backup.js';
import { openDb } from '../server/db.js';

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'big2-backup-'));
}

function makeDb(file, rows = 3) {
  const db = openDb(file);
  const ins = db.prepare('INSERT INTO users (name, pw_hash, created) VALUES (?, ?, ?)');
  for (let i = 0; i < rows; i++) ins.run(`user${i}`, 'x', 1);
  return db;
}

test('a backup is a complete, readable copy, with latest.db alongside', async () => {
  const dir = tmp();
  try {
    const file = path.join(dir, 'live.db');
    const live = makeDb(file, 5);
    const { file: out } = await backupDatabase(file, path.join(dir, 'backups'), {
      now: new Date('2026-11-03T03:30:00Z'),
    });
    live.close();
    assert.equal(path.basename(out), 'big2-2026-11-03T03-30-00-000Z.db');
    for (const f of [out, path.join(dir, 'backups', 'latest.db')]) {
      const copy = new DatabaseSync(f);
      assert.equal(copy.prepare('SELECT COUNT(*) AS n FROM users').get().n, 5);
      assert.equal(copy.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
      copy.close();
    }
    assert.deepEqual(
      fs.readdirSync(path.join(dir, 'backups')).filter((f) => f.endsWith('.partial')),
      [],
      'no temporary files left behind',
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('only the newest `keep` timestamped backups are kept; unrelated files are never touched', async () => {
  const dir = tmp();
  try {
    const file = path.join(dir, 'live.db');
    makeDb(file).close();
    const out = path.join(dir, 'backups');
    fs.mkdirSync(out);
    fs.writeFileSync(path.join(out, 'notes.txt'), 'keep me');
    for (let day = 1; day <= 5; day++) {
      await backupDatabase(file, out, { keep: 3, now: new Date(Date.UTC(2026, 10, day, 3, 30)) });
    }
    const names = fs.readdirSync(out).sort();
    assert.deepEqual(names, [
      'big2-2026-11-03T03-30-00-000Z.db',
      'big2-2026-11-04T03-30-00-000Z.db',
      'big2-2026-11-05T03-30-00-000Z.db',
      'latest.db',
      'notes.txt',
    ]);
    // latest.db is the newest one.
    assert.equal(
      fs
        .readFileSync(path.join(out, 'latest.db'))
        .equals(fs.readFileSync(path.join(out, 'big2-2026-11-05T03-30-00-000Z.db'))),
      true,
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a backup taken while the game is writing is consistent', async () => {
  const dir = tmp();
  try {
    const file = path.join(dir, 'live.db');
    const live = makeDb(file, 1);
    let stop = false;
    let n = 0;
    const writer = (async () => {
      const ins = live.prepare('INSERT INTO audit (ts, action) VALUES (?, ?)');
      while (!stop) {
        ins.run(Date.now(), `write-${n++}`);
        await new Promise((r) => setImmediate(r));
      }
    })();
    const results = [];
    for (let i = 0; i < 4; i++) {
      results.push(
        await backupDatabase(path.join(dir, 'live.db'), path.join(dir, 'b'), {
          now: new Date(Date.UTC(2026, 0, 1 + i)),
        }),
      );
    }
    stop = true;
    await writer;
    live.close();
    assert.ok(n > 0, 'the writer really ran');
    for (const r of results) {
      const copy = new DatabaseSync(r.file);
      assert.equal(copy.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
      assert.equal(copy.prepare('SELECT COUNT(*) AS n FROM users').get().n, 1);
      copy.close();
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('it fails loudly instead of writing nothing quietly', async () => {
  const dir = tmp();
  try {
    await assert.rejects(backupDatabase(path.join(dir, 'missing.db'), path.join(dir, 'b')), /No database/);
    const file = path.join(dir, 'live.db');
    makeDb(file).close();
    for (const keep of [0, -1, 1.5, NaN]) {
      await assert.rejects(backupDatabase(file, path.join(dir, 'b'), { keep }), /keep must be/);
    }
    // A file that is not a database is rejected, and nothing is left behind as a "backup".
    fs.writeFileSync(path.join(dir, 'garbage.db'), 'this is not sqlite at all, just text '.repeat(20));
    await assert.rejects(backupDatabase(path.join(dir, 'garbage.db'), path.join(dir, 'g')));
    const left = fs.existsSync(path.join(dir, 'g'))
      ? fs.readdirSync(path.join(dir, 'g')).filter((f) => f.endsWith('.db'))
      : [];
    assert.deepEqual(left, []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
