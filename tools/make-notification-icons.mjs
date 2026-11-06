// Makes the two pictures a turn alert uses, from the three-card Big Two logo (the 3 of diamonds, the Joker and the
// 2 of spades, as drawn on the sign-in page):
//   notify-icon.png   192 x 192, the cards on the table green: the picture shown in the alert
//   notify-badge.png   96 x 96, white outlines on a transparent background: the small mark in the status bar. Android
//                      keeps only the shape (the transparency) and paints it one colour, so it cannot be a coloured
//                      picture.
//
//   node tools/make-notification-icons.mjs
//
// Needs Chrome or Chromium (CHROME_PATH if it is not in a standard place), which does the drawing. The PNGs are
// committed; run this only if the logo changes.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CHROME } from '../e2e/lib.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FONT = "Georgia, 'Times New Roman', serif";

// The cards as they are on the sign-in page, without the BIG TWO lettering. The view box is a square around them.
const VIEW = '30 -30 240 240';
const cards = (outline) => {
  const stroke = outline ? 'fill="none" stroke="#fff" stroke-width="9"' : 'stroke="#000" stroke-opacity="0.3"';
  const face = (fill) => (outline ? '' : `fill="${fill}"`);
  const marks = (inner) => (outline ? '' : inner);
  return `
    <g transform="rotate(-30 150 165)">
      <rect x="115" y="22" width="70" height="98" rx="7" ${face('#f7f3e8')} ${stroke} />
      ${marks(`<text x="124" y="44" font-family="${FONT}" font-size="22" font-weight="700" fill="#c8283c">3</text>
      <g transform="translate(150 78) scale(1.9)" fill="#c8283c"><path d="M0-10 7 0 0 10-7 0Z" /></g>`)}
    </g>
    <g transform="rotate(30 150 165)">
      <rect x="115" y="22" width="70" height="98" rx="7" ${face('#f6e7b0')} ${stroke} />
      ${marks(`<path transform="translate(150 72) scale(1.5)" fill="#e0b43c" stroke="#8a6a12" stroke-width="1.2" d="M0-18 5.3-6.2 18-5.6 8.2 2.6 11.2 15 0 8.4-11.2 15-8.2 2.6-18-5.6-5.3-6.2Z" />
      <text x="124" y="44" font-family="${FONT}" font-size="13" font-weight="700" fill="#8a6a12">JOKER</text>`)}
    </g>
    <g>
      ${outline ? '<rect x="115" y="14" width="70" height="98" rx="7" fill="#fff" stroke="none" />' : ''}
      <rect x="115" y="14" width="70" height="98" rx="7" ${face('#fffdf6')} ${stroke.replace('stroke-opacity="0.3"', 'stroke-opacity="0.35"')} />
      ${marks(`<text x="124" y="38" font-family="${FONT}" font-size="24" font-weight="700" fill="#1b1b1f">2</text>
      <g transform="translate(150 70) scale(2.1)" fill="#1b1b1f"><path d="M0-10C-14 0-10.5 8.5-3 5.2-3.2 8.2-4.2 10-6.4 10h12.8C4.2 10 3.2 8.2 3 5.2 10.5 8.5 14 0 0-10Z" /></g>`)}
    </g>`;
};

const page = (size, body) =>
  `<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;background:transparent}svg{display:block}</style></head>` +
  `<body><svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="${VIEW}">${body}</svg></body></html>`;

const jobs = [
  {
    file: 'notify-icon.png',
    size: 192,
    // The table green behind the cards, with the rounded corners of the app icon.
    html: page(192, `<rect x="30" y="-30" width="240" height="240" rx="44" fill="#0f5a3a" />${cards(false)}`),
  },
  { file: 'notify-badge.png', size: 96, html: page(96, cards(true)) },
];

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'big2-icons-'));
try {
  for (const { file, size, html } of jobs) {
    const src = path.join(tmp, `${file}.html`);
    fs.writeFileSync(src, html);
    const out = path.join(ROOT, file);
    const r = spawnSync(
      CHROME,
      [
        '--headless=new',
        '--disable-gpu',
        '--hide-scrollbars',
        `--user-data-dir=${path.join(tmp, 'profile')}`,
        '--default-background-color=00000000',
        `--window-size=${size},${size}`,
        `--screenshot=${out}`,
        `file:///${src.replace(/\\/g, '/')}`,
      ],
      { encoding: 'utf8' },
    );
    if (r.status !== 0 || !fs.existsSync(out)) throw new Error(`Chrome could not draw ${file}: ${r.stderr}`);
    console.log(`${file}: ${fs.statSync(out).size} bytes`);
  }
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
