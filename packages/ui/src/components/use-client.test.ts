import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * A Next.js App Router server component that imports the kit barrel crashes the build if a part that uses
 * hooks, context, refs or event handlers is not marked 'use client'. This scans the kit sources for that.
 */
const dir = import.meta.dirname;
const CLIENT_FEATURES =
  /\buse(State|Effect|Context|Ref|Reducer|Callback|Memo|Id|LayoutEffect|Transition|SyncExternalStore|FreshnessClock)\b|\buse[A-Z][A-Za-z0-9]*\s*\(|createContext|\bon[A-Z][A-Za-z]*=|forwardRef|from ['"]@base-ui/;

const sources = readdirSync(dir).filter((f) => /\.tsx?$/.test(f) && !/\.test\.tsx?$/.test(f) && f !== 'index.ts');

describe("kit sources that need 'use client'", () => {
  it.each(sources)('%s', (file) => {
    const text = readFileSync(join(dir, file), 'utf8');
    const marked = /^(['"])use client\1;?\s*$/m.test(text.split('\n').slice(0, 1).join('\n'));
    if (CLIENT_FEATURES.test(text)) expect(marked, `${file} uses client features`).toBe(true);
  });
});
