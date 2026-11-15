import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// HM-shell-03 (1): one shared service-off notice. Each shell control may end in success, a typed refusal or this notice
// (3), so no shell file has to import it; what has to hold is that there is one notice, the kit's, and that no customer
// room draws its own copy of it (ruling by D, 2026-10-31). J-home-ia-06 #5 checks the same sentence in the running app;
// this is its source half, moved here from the journey's former blocked-steps file.
const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '../../../..');

/** Source files (tests left out) under `dir` that name `word`; none is an empty list. */
function filesNaming(word: string, dir: string): string[] {
  const named = new RegExp(`\\b${word}\\b`);
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && /\.tsx?$/.test(entry.name) && !/\.test\./.test(entry.name))
    .map((entry) => join(entry.parentPath, entry.name))
    .filter((file) => named.test(readFileSync(file, 'utf8')));
}

describe("the one service-off notice is the kit's (HM-shell-03)", () => {
  it('packages/ui declares and exports ServiceOffNotice from its templates', () => {
    const templates = join(root, 'packages/ui/src/lit/templates');
    const declared = filesNaming('ServiceOffNotice', templates).some((file) =>
      /^export function ServiceOffNotice\b/m.test(readFileSync(file, 'utf8')),
    );
    expect(declared, 'packages/ui/src/lit/templates declares no ServiceOffNotice').toBe(true);
    expect(readFileSync(join(templates, 'index.ts'), 'utf8'), 'the templates entry does not export ServiceOffNotice').toMatch(
      /\bServiceOffNotice\b/,
    );
  });

  it("the customer's shared notice draws the kit's", () => {
    expect(readFileSync(join(here, 'service-off.tsx'), 'utf8')).toMatch(
      /import \{[^}]*\bServiceOffNotice\b[^}]*\} from '@intafaced\/ui\/lit\/templates'/,
    );
  });

  it('no customer source writes the notice markup itself: data-not-connected comes only from the kit', () => {
    const ownMarkup = filesNaming('data-not-connected', join(here, '..')).filter((file) =>
      /data-not-connected=/.test(readFileSync(file, 'utf8')),
    );
    expect(ownMarkup).toEqual([]);
  });
});
