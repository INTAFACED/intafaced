// Payee: the person found, drawn only from what the lookup gave.
import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { Payee } from './payee.js';

const html = (el: React.ReactElement) => renderToStaticMarkup(el);

describe('Payee', () => {
  it('draws the face from the first letter, then name over handle, the badge and the tick', () => {
    const out = html(<Payee face="mika Tan" name="Mika Tan" handle="@mika" badge="Member since Nov 2026" confirmed />);
    expect(out).toMatch(/^<span class="lit-payee" data-slot="payee" data-confirmed="">/);
    expect(out).toContain('<span data-part="face" aria-hidden="true">M</span>');
    expect(out).toContain('<span data-part="who"><span data-part="name">Mika Tan</span><span data-part="handle">@mika</span></span>');
    expect(out).toContain('<span data-part="badge">Member since Nov 2026</span>');
    expect(out).toMatch(/<svg data-part="tick"[^>]*aria-hidden="true"/);
  });

  it('shows only what the lookup gave: no name, no badge and no tick are drawn as nothing, never guessed', () => {
    const out = html(<Payee face="@ana" handle="@ana" />);
    expect(out).toContain('<span data-part="face" aria-hidden="true">A</span>');
    expect(out).not.toContain('data-part="name"');
    expect(out).not.toContain('data-part="badge"');
    expect(out).not.toContain('data-part="tick"');
    expect(out).not.toContain('data-confirmed');
  });

  it('an empty face is a neutral mark, and a test id reaches the row', () => {
    const out = html(<Payee face="" name="Account ID ready" data-testid="found" />);
    expect(out).toContain('data-testid="found"');
    expect(out).toContain('<span data-part="face" aria-hidden="true">#</span>');
  });
});
