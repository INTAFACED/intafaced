// Builds copy.ts from every English string the Copy and Bots rooms pass to t(). Key = the English text.
import fs from 'node:fs';
const dir = new URL('./', import.meta.url).pathname;
const files = fs
  .readdirSync(dir)
  .filter((f) => (/\.(tsx|ts)$/.test(f) && !/(test|copy|api|plan|guard|live|desk|refusals)\.tsx?$/.test(f)) || f === 'desk.ts');
const keys = new Set();
const lit = /'((?:[^'\\\n]|\\.)*)'/g;
for (const f of files) {
  if (f === 'desk.ts') {
    for (const m of fs.readFileSync(dir + f, 'utf8').matchAll(lit))
      if (/^[A-Z][a-z]/.test(m[1]) && / /.test(m[1])) keys.add(m[1].replace(/\\'/g, "'"));
    continue;
  }
  const text = fs.readFileSync(dir + f, 'utf8');
  for (const m of text.matchAll(lit)) {
    const s = m[1];
    if (!/^[A-Z0-9{]/.test(s) || /^[A-Z_]+$/.test(s)) continue;
    if (/^(Active|Paused)$/.test(s)) {
      keys.add(s);
      continue;
    }
    if (/ /.test(s) || /^[A-Z][a-z]+$/.test(s)) keys.add(s);
  }
}
const esc = (s) => s.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
const body = [...keys]
  .sort()
  .map((k) => `  '${esc(k)}': '${esc(k)}',`)
  .join('\n');
fs.writeFileSync(
  dir + 'copy.ts',
  `import { defineCopy } from '../../../shared/i18n';

// English source only (UI-SPEC 4.4); other languages fall back to English. The key is the English text.
// Generated from the strings the Copy and Bots rooms pass to t(): run \`node gen-copy.mjs\` after adding one.
// Money words only: no internal terms, no raw service codes (refusals come from refusals.ts).
const messages = {
${body}
} as const;

export const roomCopy = defineCopy('trade.rooms', messages);
`,
);
console.log(keys.size, 'keys');
