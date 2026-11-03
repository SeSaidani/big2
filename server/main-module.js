// True when the module whose import.meta.url is passed is the script node was
// started with. import.meta.url is symlink-free but process.argv[1] is not, so
// compare real paths: production runs /opt/big2/current/server/index.js, where
// "current" is a symlink to the release folder.

import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

export function isMain(metaUrl) {
  if (!process.argv[1]) return false;
  try {
    return fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(metaUrl));
  } catch {
    return false; // e.g. argv[1] is not a file (a REPL or a worker)
  }
}
