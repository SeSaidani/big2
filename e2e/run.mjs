// Runs every end-to-end script in turn and fails if any of them does.
//   npm run e2e            (needs Chrome or Chromium; set CHROME_PATH if it is not found)
//   npm run e2e -- <dir>   screenshots go to <dir> instead of e2e/out

import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
let failed = 0;
for (const script of [
  'two-players.mjs',
  'seasons-and-phone.mjs',
  'phone-verification.mjs',
  'three-players.mjs',
  'luck-and-skill.mjs',
  'season-games.mjs',
]) {
  console.log(`\n=== ${script} ===`);
  const r = spawnSync(process.execPath, [path.join(here, script), ...process.argv.slice(2)], { stdio: 'inherit' });
  if (r.status !== 0) failed++;
}
console.log(failed ? `\n${failed} end-to-end script(s) failed` : '\nall end-to-end scripts passed');
process.exit(failed ? 1 : 0);
