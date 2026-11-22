import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import * as kit from '@intafaced/ui/lit/templates';

// The kit's notice, counted, so a customer notice that draws its own copy is seen.
vi.mock('@intafaced/ui/lit/templates', async (original) => {
  const real = await original<typeof import('@intafaced/ui/lit/templates')>();
  return { ...real, ServiceOffNotice: vi.fn(real.ServiceOffNotice) };
});
// Server rendering has no browser store to subscribe to, so the preferences hook answers with the stored defaults.
vi.mock('./preferences', async (original) => {
  const real = await original<typeof import('./preferences')>();
  return { ...real, usePreferences: () => real.currentPreferences() };
});

import { ServiceOffNotice } from './service-off';

// HM-shell-03 (1): one shared service-off notice. Each shell control may end in success, a typed refusal or this notice
// (3), so no shell file has to import it; what has to hold is that there is one notice, the kit's, and that no customer
// room draws its own copy of it (ruling by D, 2026-10-31). J-home-ia-06 #5 checks the same sentence in the running app;
// this is its source half, moved here from the journey's former blocked-steps file.
const here = dirname(fileURLToPath(import.meta.url));

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
    expect(kit.ServiceOffNotice, 'the templates entry does not export ServiceOffNotice').toBeTypeOf('function');
    const html = renderToString(createElement(kit.ServiceOffNotice, { code: 'vendor.push', sentence: 'TEST sentence.' }));
    expect(html).toContain('data-not-connected="vendor.push"');
  });

  it("the customer's shared notice draws the kit's", () => {
    vi.mocked(kit.ServiceOffNotice).mockClear();
    const html = renderToString(createElement(ServiceOffNotice, { code: 'vendor.push', action: 'Registering this device' }));
    expect(vi.mocked(kit.ServiceOffNotice)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(kit.ServiceOffNotice).mock.calls[0]![0]).toMatchObject({ code: 'vendor.push' });
    expect(html).toContain('data-not-connected="vendor.push"');
  });

  it('no customer source writes the notice markup itself: data-not-connected comes only from the kit', () => {
    const ownMarkup = filesNaming('data-not-connected', join(here, '..')).filter((file) =>
      /data-not-connected=/.test(readFileSync(file, 'utf8')),
    );
    expect(ownMarkup).toEqual([]);
  });
});
