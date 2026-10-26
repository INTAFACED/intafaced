import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { roleNames } from '../contracts.js';
import { ActionKey, Button, Change, Dock, Figure, Logo, RefusalBox, Surface, type DoorLink } from './index.js';

const here = fileURLToPath(new URL('.', import.meta.url));
const css = readFileSync(join(here, 'components.css'), 'utf8');
const html = (el: React.ReactElement) => renderToStaticMarkup(el);

describe('the component sheet reads only lit roles', () => {
  it('holds no raw colour of its own outside hairline white/black alphas', () => {
    const hex = css.match(/#[0-9a-f]{3,8}\b/gi) ?? [];
    expect(hex.filter((h) => h !== '#000')).toEqual([]);
  });

  it('every --lit-* it reads is a declared role or type role', () => {
    const declared = new Set<string>(roleNames.map((r) => `--lit-${r}`));
    const used = new Set([...css.matchAll(/var\((--lit-[a-z0-9-]+)/g)].map((m) => m[1]!));
    // local knobs a component sets for itself (light angle, corner), never colours
    const local = new Set(['--lit-light-angle', '--lit-corner-x', '--lit-corner-y', '--lit-tag-c']);
    for (const u of used) if (!u.startsWith('--lit-type-') && !local.has(u)) expect(declared.has(u), u).toBe(true);
  });

  it('uses no backdrop blur except through the nav and sheet layers', () => {
    const blocks = css.split('}').filter((b) => /backdrop-filter/.test(b));
    for (const b of blocks) expect(b, b).toMatch(/data-layer='(nav|sheet)'/);
  });
});

describe('components', () => {
  it('Surface is solid on the content layer by default, and glass only on nav or sheet', () => {
    expect(html(<Surface />)).toContain('data-layer="content"');
    expect(html(<Surface />)).toContain('data-material="solid"');
    const nav = html(<Surface layer="nav" />);
    expect(nav).toContain('data-layer="nav"');
    expect(nav).not.toContain('data-material');
  });

  it('Button defaults to secondary so a primary is always a choice', () => {
    expect(html(<Button>Go</Button>)).toContain('data-tone="secondary"');
    expect(html(<Button tone="primary">Go</Button>)).toContain('data-tone="primary"');
  });

  it('ActionKey keeps its label as text and hides the icon from assistive tech', () => {
    const out = html(<ActionKey icon={<svg />} label="Send" />);
    expect(out).toContain('>Send<');
    expect(out).toContain('aria-hidden="true"');
  });

  it('Figure splits the minor part, labels TEST, and reads as one value', () => {
    const out = html(<Figure text="12,480.36" unit="£" test size="hero" />);
    expect(out).toContain('>12,480<');
    expect(out).toContain('>.36<');
    expect(out).toContain('>TEST<');
    expect(out).toContain('aria-label="£12,480.36"');
  });

  it('Change says the direction in words, not only colour', () => {
    expect(html(<Change text="£84.10" dir="up" />)).toContain('up');
    expect(html(<Change text="£6.40" dir="down" />)).toContain('down');
  });

  it('RefusalBox names the blocker, keeps the code small, and draws hold and pause apart', () => {
    const hold = html(
      <RefusalBox
        refusal={{ variant: 'account-hold', title: 'Your account is on hold', body: 'Checks are running.', reference: 'identity.hold' }}
      />,
    );
    expect(hold).toContain('data-variant="account-hold"');
    expect(hold).toContain('identity.hold');
    expect(html(<RefusalBox refusal={{ variant: 'platform-pause', title: 'Payments are paused', body: 'For everyone.' }} />)).toContain(
      'data-variant="platform-pause"',
    );
  });

  it('Dock shows all five doors in order and refuses a missing one', () => {
    const links: DoorLink[] = [
      { door: 'more', label: 'More', href: '/more', icon: null },
      { door: 'home', label: 'Home', href: '/home', icon: null },
      { door: 'money', label: 'Money', href: '/money', icon: null },
      { door: 'trade', label: 'Trade', href: '/trade', icon: null },
      { door: 'pay', label: 'Pay', href: '/pay', icon: null },
    ];
    const out = html(<Dock links={links} current="home" />);
    const order = [...out.matchAll(/href="\/([a-z]+)"/g)].map((m) => m[1]);
    expect(order).toEqual(['home', 'money', 'trade', 'pay', 'more']);
    expect(out).toContain('aria-current="page"');
    expect(() => html(<Dock links={links.slice(1)} current="home" />)).toThrow(/more door/);
  });

  it('Logo mark has an accessible name when it stands alone', () => {
    expect(html(<Logo variant="mark" />)).toContain('aria-label="INTAFACED"');
  });
});
