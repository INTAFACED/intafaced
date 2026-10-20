#!/usr/bin/env node
/** Prints one row per declared locale: translated, total, missing, provenance. Needs a build (`pnpm --filter @intafaced/i18n build`). */
import { localeCoverage, localeProvenance } from '../dist/index.js';

const rows = localeCoverage().map((row) => ({
  code: row.code,
  translated: row.translated,
  total: row.total,
  missing: row.missing.length,
  provenance: localeProvenance(row.code) ?? (row.hasCatalog ? 'source' : 'none'),
}));
const only = process.argv.includes('--written') ? rows.filter((row) => row.translated > 0) : rows;
console.table(only);
