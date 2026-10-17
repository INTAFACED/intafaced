// Tests for EmptyState: roles, reason line, actions, sizes, and the rule that nothing ever says "coming soon".
import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { EmptyState, resolveActionVariant, type EmptyStateAction, type EmptyStateSize, type EmptyStateVariant } from './empty-state.js';

const html = (el: React.ReactElement) => renderToStaticMarkup(el);
const variants: EmptyStateVariant[] = ['empty', 'refused', 'unavailable'];
const sizes: EmptyStateSize[] = ['inline', 'panel', 'page'];

function make(variant: EmptyStateVariant, size: EmptyStateSize = 'panel', extra: { code?: string; action?: EmptyStateAction } = {}) {
  const base = { title: 'Title here', size, ...extra };
  if (variant === 'empty') return <EmptyState {...base} />;
  return <EmptyState {...base} variant={variant} reason="Reason here" />;
}

describe('roles and data attributes', () => {
  it('empty has no role; refused and unavailable are status', () => {
    expect(html(make('empty'))).not.toContain('role=');
    expect(html(make('refused'))).toContain('role="status"');
    expect(html(make('unavailable'))).toContain('role="status"');
  });

  it('exposes data-variant and data-size', () => {
    for (const v of variants)
      for (const s of sizes) {
        const out = html(make(v, s));
        expect(out).toContain('data-slot="empty-state"');
        expect(out).toContain(`data-variant="${v}"`);
        expect(out).toContain(`data-size="${s}"`);
      }
  });

  it('defaults to empty and panel', () => {
    const out = html(<EmptyState title="T" />);
    expect(out).toContain('data-variant="empty"');
    expect(out).toContain('data-size="panel"');
  });
});

describe('reason', () => {
  it('is its own fg-2 line when given', () => {
    const out = html(make('refused'));
    expect(out).toMatch(/<p data-slot="empty-state-reason" class="[^"]*text-fg-2[^"]*">Reason here<\/p>/);
  });

  it('is optional for empty and absent when not given', () => {
    expect(html(<EmptyState title="T" />)).not.toContain('empty-state-reason');
    expect(html(<EmptyState title="T" reason="No orders yet" />)).toContain('empty-state-reason');
  });

  it('is required by the types for refused and unavailable', () => {
    // @ts-expect-error reason is required when the state is refused
    void (<EmptyState title="T" variant="refused" />);
    // @ts-expect-error reason is required when the state is unavailable
    void (<EmptyState title="T" variant="unavailable" />);
    expect(true).toBe(true);
  });

  it('a blank reason is not drawn as an empty line', () => {
    // Types forbid leaving it out; a blank string at runtime must not draw an empty paragraph either.
    expect(html(<EmptyState title="T" variant="refused" reason="  " />)).not.toContain('empty-state-reason');
  });
});

describe('icon', () => {
  it('has a default icon per variant, hidden from screen readers', () => {
    const svgs = variants.map((v) => /<svg[^>]*class="lucide lucide-([a-z-]+)/.exec(html(make(v)))?.[1]);
    expect(new Set(svgs).size).toBe(3);
    for (const v of variants) expect(html(make(v))).toContain('data-slot="empty-state-icon" aria-hidden="true"');
  });

  it('a custom icon replaces the default', () => {
    const out = html(<EmptyState title="T" icon={<i data-testid="mine" />} />);
    expect(out).toContain('data-testid="mine"');
    expect(out).not.toContain('<svg');
  });
});

describe('actions', () => {
  it('renders a link when href is given', () => {
    const out = html(<EmptyState title="T" action={{ label: 'Go', href: '/go' }} />);
    expect(out).toMatch(/<a [^>]*href="\/go"[^>]*>Go<\/a>/);
    expect(out).not.toContain('<button');
  });

  it('renders a button otherwise', () => {
    const out = html(<EmptyState title="T" action={{ label: 'Go', onClick: () => {} }} />);
    expect(out).toMatch(/<button[^>]*>Go<\/button>/);
    expect(out).not.toContain('<a ');
  });

  it('primary (lime) only for empty; quieter for refused and unavailable', () => {
    const action = { label: 'Go', onClick: () => {} };
    expect(html(<EmptyState title="T" action={action} />)).toContain('bg-lime');
    expect(html(<EmptyState title="T" variant="refused" reason="r" action={action} />)).not.toContain('bg-lime');
    expect(html(<EmptyState title="T" variant="unavailable" reason="r" action={action} />)).toContain('bg-field');
    expect(html(<EmptyState title="T" variant="refused" reason="r" action={{ ...action, variant: 'primary' }} />)).not.toContain('bg-lime');
  });

  it('resolveActionVariant clamps primary outside empty', () => {
    expect(resolveActionVariant('empty', undefined, 'primary')).toBe('primary');
    expect(resolveActionVariant('refused', undefined, 'primary')).toBe('secondary');
    expect(resolveActionVariant('unavailable', 'primary', 'ghost')).toBe('secondary');
    expect(resolveActionVariant('refused', 'ghost', 'primary')).toBe('ghost');
  });

  it('renders a secondary action after the main one', () => {
    const out = html(
      <EmptyState title="T" action={{ label: 'First', onClick: () => {} }} secondaryAction={{ label: 'Second', href: '/s' }} />,
    );
    expect(out.indexOf('First')).toBeLessThan(out.indexOf('Second'));
  });

  it('renders no actions wrapper without actions', () => {
    expect(html(<EmptyState title="T" />)).not.toContain('empty-state-actions');
  });
});

describe('code', () => {
  it('shows a small support code only when given', () => {
    expect(html(<EmptyState title="T" />)).not.toContain('empty-state-code');
    const out = html(make('refused', 'panel', { code: 'E-4031' }));
    expect(out).toMatch(/data-slot="empty-state-code" class="[^"]*text-2xs[^"]*text-fg-2[^"]*">E-4031</);
  });
});

describe('sizes', () => {
  it('inline is one row, panel and page are centred columns', () => {
    expect(html(make('empty', 'inline'))).toContain('flex-row');
    expect(html(make('empty', 'panel'))).toContain('flex-col');
    expect(html(make('empty', 'panel'))).toContain('text-center');
    expect(html(make('empty', 'page'))).toContain('min-h-80');
    expect(html(make('empty', 'page'))).toContain('text-center');
  });

  it('inline uses smaller buttons', () => {
    const a = { label: 'Go', onClick: () => {} };
    expect(html(<EmptyState title="T" size="inline" action={a} />)).toContain('h-8');
    expect(html(<EmptyState title="T" size="panel" action={a} />)).toContain('h-10');
  });
});

describe('no placeholder promises', () => {
  it('no variant at any size produces "coming soon" on its own', () => {
    for (const v of variants)
      for (const s of sizes) {
        const out = html(make(v, s, { action: { label: 'Go', onClick: () => {} }, code: 'X-1' }));
        expect(out.toLowerCase()).not.toContain('coming soon');
        expect(out.toLowerCase()).not.toContain('coming-soon');
      }
  });

  it('renders no text that the caller did not pass', () => {
    for (const v of variants)
      for (const s of sizes) {
        const text = html(make(v, s)).replace(/<[^>]*>/g, '');
        expect(text.replace('Title here', '').replace('Reason here', '')).toBe('');
      }
  });
});
