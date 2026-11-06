// Consistent SQLite backups, safe to take while the server is running (it uses
// SQLite's own backup API, not a file copy: a plain copy of a live WAL
// database can be torn or miss recent writes).
//
//   node server/backup.js <directory> [keep]        DB_FILE selects the database
//
// Each run writes <directory>/big2-<timestamp>.db, checks the copy with
// SQLite's integrity check BEFORE it is kept, refreshes <directory>/latest.db,
// and deletes all but the newest `keep` (default 14) timestamped backups.
// Backups hold password hashes and the keys that sign turn alerts: the directory is private.

import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync, backup } from 'node:sqlite';
import { isMain } from './main-module.js';

const NAME = /^big2-\d{4}-\d{2}-\d{2}T[\d-]+Z\.db$/;

export async function backupDatabase(sourceFile, dir, { keep = 14, now = new Date() } = {}) {
  if (!Number.isInteger(keep) || keep < 1) throw new Error('keep must be a whole number of at least 1');
  if (!fs.existsSync(sourceFile)) throw new Error(`No database at ${sourceFile}`);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const stamp = now.toISOString().replace(/[:.]/g, '-'); // 2026-11-03T03-30-00-000Z
  const dest = path.join(dir, `big2-${stamp}.db`);
  const partial = `${dest}.partial`;

  const source = new DatabaseSync(sourceFile);
  try {
    await backup(source, partial);
  } finally {
    source.close();
  }
  // Never keep a copy we have not proved is sound.
  const copy = new DatabaseSync(partial);
  let verdict;
  try {
    verdict = copy.prepare('PRAGMA integrity_check').get().integrity_check;
  } finally {
    copy.close();
  }
  if (verdict !== 'ok') {
    fs.rmSync(partial, { force: true });
    throw new Error(`The backup failed SQLite's integrity check: ${verdict}`);
  }
  fs.renameSync(partial, dest);
  // latest.db is replaced atomically, so a reader never sees half a file.
  fs.copyFileSync(dest, path.join(dir, 'latest.db.partial'));
  fs.renameSync(path.join(dir, 'latest.db.partial'), path.join(dir, 'latest.db'));

  const old = fs
    .readdirSync(dir)
    .filter((f) => NAME.test(f))
    .sort()
    .reverse()
    .slice(keep);
  for (const f of old) fs.rmSync(path.join(dir, f), { force: true });
  return { file: dest, removed: old.length };
}

if (isMain(import.meta.url)) {
  const [dir, keepArg] = process.argv.slice(2);
  const file = process.env.DB_FILE;
  if (!dir || !file) {
    console.error('Usage: DB_FILE=/path/to/big2.db node server/backup.js <directory> [keep]');
    process.exit(1);
  }
  backupDatabase(file, dir, { keep: keepArg ? Number(keepArg) : 14 })
    .then((r) => console.log(`Backed up to ${r.file}${r.removed ? ` (removed ${r.removed} old)` : ''}`))
    .catch((err) => {
      console.error(`Backup failed: ${err.message}`);
      process.exit(1);
    });
}
