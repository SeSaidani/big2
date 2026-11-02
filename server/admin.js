// Command-line admin tool: the way the first admin is made, and the way back in
// if every admin forgets their password. It opens the database file directly,
// so it needs shell access to the machine, which is the trust boundary.
//
//   node server/admin.js make-admin <name>        create the user, or promote an existing one
//   node server/admin.js reset-password <name>
//   node server/admin.js set-phone <name>
//   node server/admin.js list-users
//
// The password is asked for with hidden input, or taken from BIG2_PASSWORD
// (for scripts); the phone number (international format, e.g. +447700900123)
// is asked for, or taken from BIG2_PHONE. Numbers set here count as verified,
// because whoever has shell access vouches for them. DB_FILE selects the
// database (default data/big2.db).

import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { openDb, listUsers, audit } from './db.js';
import { createUser, setPassword, validatePassword } from './auth.js';
import { normalizePhone } from './phone-format.js';
import { setUserPhone } from './phones.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Creates the user as an admin, or promotes (and re-enables) an existing one.
// A user with no phone number on file needs one supplied.
export async function makeAdmin(db, name, password, phone) {
  const row = db.prepare('SELECT id, phone FROM users WHERE name = ?').get(name);
  if (!row) {
    const user = await createUser(db, name, password, { isAdmin: true, phone, verified: true });
    audit(db, null, 'cli_make_admin', name, 'created');
    return { ...user, created: true };
  }
  if (!row.phone) {
    if (!phone) throw new Error(`"${name}" has no phone number yet; supply one.`);
    setUserPhone(db, row.id, normalizePhone(phone), { verified: true });
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

export function setPhone(db, name, phone) {
  const row = db.prepare('SELECT id FROM users WHERE name = ?').get(name);
  if (!row) throw new Error(`No such user: ${name}`);
  setUserPhone(db, row.id, normalizePhone(phone), { verified: true });
  audit(db, null, 'cli_set_phone', name); // never the number
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

function readLine(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, (answer) => {
      rl.close();
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

async function askPhone() {
  const phone = process.env.BIG2_PHONE || (await readLine('Mobile number with country code (e.g. +447700900123): '));
  return normalizePhone(phone);
}

async function main(argv) {
  const [cmd, name] = argv;
  const db = openDb(process.env.DB_FILE || path.join(ROOT, 'data', 'big2.db'));
  try {
    if (cmd === 'list-users') {
      for (const u of listUsers(db)) {
        const flags = `${u.isAdmin ? '  [admin]' : ''}${u.disabled ? '  [disabled]' : ''}${u.phone ? '' : '  [no phone]'}`;
        console.log(`${u.name}${flags}  games=${u.games}`);
      }
    } else if (cmd === 'make-admin' && name) {
      const exists = db.prepare('SELECT phone FROM users WHERE name = ?').get(name);
      let password = null;
      if (!exists) {
        password = await askPassword();
        const err = validatePassword(password);
        if (err) throw new Error(err);
      }
      const phone = !exists || !exists.phone ? await askPhone() : undefined;
      const r = await makeAdmin(db, name, password, phone);
      console.log(r.created ? `Created admin "${name}".` : `"${name}" is now an admin.`);
    } else if (cmd === 'reset-password' && name) {
      const password = await askPassword();
      const err = validatePassword(password);
      if (err) throw new Error(err);
      await resetPassword(db, name, password);
      console.log(`Password reset for "${name}"; all their sessions were signed out.`);
    } else if (cmd === 'set-phone' && name) {
      setPhone(db, name, await askPhone());
      console.log(`Phone number set for "${name}" (marked verified).`);
    } else {
      console.log(
        'Usage: node server/admin.js make-admin <name> | reset-password <name> | set-phone <name> | list-users',
      );
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
