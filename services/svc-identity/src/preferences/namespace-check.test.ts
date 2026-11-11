import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { PREFERENCE_NAMESPACES } from './preferences.js';

const DRIZZLE = fileURLToPath(new URL('../../drizzle/', import.meta.url));

/** The namespaces the newest migration that sets `user_preferences_namespace_check` allows. */
function allowedByDatabase(): string[] {
  const latest = readdirSync(DRIZZLE)
    .filter((name) => name.endsWith('.sql') && !name.endsWith('.down.sql'))
    .sort()
    .filter((name) => /ADD CONSTRAINT "user_preferences_namespace_check"/.test(readFileSync(DRIZZLE + name, 'utf8')))
    .at(-1);
  expect(latest, 'a migration sets the namespace check').toBeTruthy();
  const sql = readFileSync(DRIZZLE + latest!, 'utf8');
  const list = /CHECK \("namespace" IN \(([^)]*)\)\)/.exec(sql)?.[1] ?? '';
  return [...list.matchAll(/'([^']+)'/g)].map((match) => match[1]!);
}

describe('user_preferences namespace check', () => {
  // A namespace the door accepts but the database refuses is a 500 on the first write (J-charts-desk-14 #6, run 42542864829).
  it('allows exactly the namespaces the preferences door stores', () => {
    expect([...allowedByDatabase()].sort()).toEqual([...PREFERENCE_NAMESPACES].sort());
  });
});
