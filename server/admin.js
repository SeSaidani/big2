// Command-line admin tool: the way the first admin is made, and the way back in
// if every admin forgets their password. It opens the database file directly,
// so it needs shell access to the machine, which is the trust boundary.
//
//   node server/admin.js make-admin <name>        create the user, or promote an existing one
//   node server/admin.js reset-password <name>
//   node server/admin.js list-users
//
// The password is asked for with hidden input, or taken from BIG2_PASSWORD
// (for scripts). DB_FILE selects the database (default data/big2.db).

import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { openDb, listUsers, audit } from './db.js';
import { createUser, setPassword, validatePassword } from './auth.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Creates the user as an admin, or promotes (and re-enables) an existing one.
export async function makeAdmin(db, name, password) {
  const row = db.prepare('SELECT id FROM users WHERE name = ?').get(name);
  if (!row) {
    const user = await createUser(db, name, password, { isAdmin: true });
    audit(db, null, 'cli_make_admin', name, 'created');
    return { ...user, created: true };
  }
  db.prepare('UPDATE users SET is_admin = 1, disabled = 0 WHERE id = ?').run(row.id);
  audit(db, null, 'cli_make_admin', name, 'promoted');
  return { id: row.id, name, isAdmin: true, created: false };
}

export async function resetPassword(db, name, password) {
  const row = db.prepare('SELECT id FROM users WHERE name = ?').get(name);
  if (!row) throw new Error(`No such user: ${name}`);
  await setPassword(db, row.id, password);
  audit(db, null, 'cli_reset_password', name);
}

function readSecret(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    const write = rl._writeToOutput;
    process.stdout.write(question);
    rl._writeToOutput = (s) => {
      if (s.includes('\n') || s.includes('\r')) write.call(rl, s); // keep the typed characters hidden
    };
    rl.question('', (answer) => {
      rl.close();
      process.stdout.write('\n');
      resolve(answer);
    });
  });
}

async function askPassword() {
  if (process.env.BIG2_PASSWORD) return process.env.BIG2_PASSWORD;
  const a = await readSecret('Password (min 10 characters): ');
  const b = await readSecret('Again: ');
  if (a !== b) throw new Error('The passwords do not match.');
  return a;
}

async function main(argv) {
  const [cmd, name] = argv;
  const db = openDb(process.env.DB_FILE || path.join(ROOT, 'data', 'big2.db'));
  try {
    if (cmd === 'list-users') {
      for (const u of listUsers(db)) {
        console.log(`${u.name}${u.isAdmin ? '  [admin]' : ''}${u.disabled ? '  [disabled]' : ''}  games=${u.games}`);
      }
    } else if ((cmd === 'make-admin' || cmd === 'reset-password') && name) {
      const exists = db.prepare('SELECT 1 FROM users WHERE name = ?').get(name);
      let password = null;
      if (cmd === 'reset-password' || !exists) {
        password = await askPassword();
        const err = validatePassword(password);
        if (err) throw new Error(err);
      }
      if (cmd === 'make-admin') {
        const r = await makeAdmin(db, name, password);
        console.log(r.created ? `Created admin "${name}".` : `"${name}" is now an admin.`);
      } else {
        await resetPassword(db, name, password);
        console.log(`Password reset for "${name}"; all their sessions were signed out.`);
      }
    } else {
      console.log('Usage: node server/admin.js make-admin <name> | reset-password <name> | list-users');
      process.exitCode = 1;
    }
  } finally {
    db.close();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}
