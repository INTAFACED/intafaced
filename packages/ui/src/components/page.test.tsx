// Tests for Page, PageHeader, Breadcrumbs, PageSection and PageBody, rendered to static markup.
import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { Breadcrumbs, Page, PageBody, PageHeader, PageSection } from './page.js';

const html = (el: React.ReactElement) => renderToStaticMarkup(el);
const count = (s: string, re: RegExp) => (s.match(re) ?? []).length;

describe('Page', () => {
  it('is a main landmark by default, a div without one', () => {
    expect(html(<Page>x</Page>)).toMatch(/^<main data-slot="page"/);
    expect(html(<Page landmark={false}>x</Page>)).toMatch(/^<div data-slot="page"/);
  });

  it('content width is the default: container-max, centred, with the gutter', () => {
    const out = html(<Page>x</Page>);
    expect(out).toContain('data-width="content"');
    expect(out).toContain('max-w-(--if-container-max)');
    expect(out).toContain('mx-auto');
    expect(out).toContain('px-(--if-gutter)');
  });

  it('narrow is a 672 px lane, still centred with the gutter', () => {
    const out = html(<Page width="narrow">x</Page>);
    expect(out).toContain('data-width="narrow"');
    expect(out).toContain('672px');
    expect(out).toContain('mx-auto');
    expect(out).toContain('px-(--if-gutter)');
  });

  it('full is full bleed with the gutter and no max width lane', () => {
    const out = html(<Page width="full">x</Page>);
    expect(out).toContain('data-width="full"');
    expect(out).toContain('max-w-none');
    expect(out).toContain('px-(--if-gutter)');
    expect(out).not.toContain('mx-auto');
  });

  it('density changes vertical padding and is exposed as data-density', () => {
    expect(html(<Page>x</Page>)).toContain('data-density="comfortable"');
    expect(html(<Page>x</Page>)).toContain('py-6');
    expect(html(<Page density="dense">x</Page>)).toContain('data-density="dense"');
    expect(html(<Page density="dense">x</Page>)).toContain('py-4');
  });

  it('children inherit the page density unless they set their own', () => {
    const out = html(
      <Page density="dense" landmark={false}>
        <PageSection title="A">a</PageSection>
        <PageSection title="B" density="comfortable">
          b
        </PageSection>
      </Page>,
    );
    expect(count(out, /data-slot="page-section" data-density="dense"/g)).toBe(1);
    expect(count(out, /data-slot="page-section" data-density="comfortable"/g)).toBe(1);
  });
});

describe('Breadcrumbs', () => {
  const items = [{ label: 'Home', href: '/' }, { label: 'Wallet', href: '/wallet' }, { label: 'Deposit' }];
  const out = html(<Breadcrumbs items={items} />);

  it('is a nav named Breadcrumb with an ordered list', () => {
    expect(out).toMatch(/<nav[^>]*aria-label="Breadcrumb"/);
    expect(out).toContain('<ol');
    expect(count(out, /<li/g)).toBe(3);
  });

  it('the name can be replaced', () => {
    expect(html(<Breadcrumbs items={items} label="Navigationspfad" />)).toContain('aria-label="Navigationspfad"');
  });

  it('marks only the last item as the current page', () => {
    expect(count(out, /aria-current="page"/g)).toBe(1);
    expect(out).toMatch(/aria-current="page"[^>]*>Deposit</);
  });

  it('earlier items with an href are links; the last is never a link', () => {
    expect(count(out, /<a /g)).toBe(2);
    const lastHref = html(
      <Breadcrumbs
        items={[
          { label: 'Home', href: '/' },
          { label: 'Here', href: '/here' },
        ]}
      />,
    );
    expect(count(lastHref, /<a /g)).toBe(1);
  });

  it('links carry the focus ring', () => {
    expect(out).toContain('focus-visible:outline-focus');
  });

  it('separators are hidden from screen readers and there is one fewer than items', () => {
    expect(count(out, /data-slot="breadcrumbs-separator" aria-hidden="true"/g)).toBe(2);
  });

  it('truncates long labels and keeps the full text in title', () => {
    const long = 'A very long account name that would otherwise break the line';
    const o = html(<Breadcrumbs items={[{ label: long, href: '/a' }, { label: 'x' }]} />);
    expect(o).toContain('truncate');
    expect(o).toContain(`title="${long}"`);
  });
});

describe('PageHeader', () => {
  it('renders one h1 with the title and weight 600 xl text', () => {
    const out = html(<PageHeader title="Wallet" />);
    expect(count(out, /<h1/g)).toBe(1);
    expect(out).toMatch(/<h1[^>]*>Wallet<\/h1>/);
    expect(out).toContain('text-xl');
    expect(out).toContain('font-semibold');
    expect(out).not.toContain('font-bold');
  });

  it('title level can be changed', () => {
    const out = html(<PageHeader title="Wallet" headingLevel={2} />);
    expect(out).toContain('<h2');
    expect(out).not.toContain('<h1');
  });

  it('renders breadcrumbs above the title, description, meta and actions', () => {
    const out = html(
      <PageHeader
        title="Wallet"
        description="Your balances"
        meta={<span>Updated just now</span>}
        actions={<button>Deposit</button>}
        breadcrumbs={<Breadcrumbs items={[{ label: 'Home', href: '/' }, { label: 'Wallet' }]} />}
      />,
    );
    expect(out.indexOf('<nav')).toBeLessThan(out.indexOf('<h1'));
    expect(out).toContain('data-slot="page-header-description"');
    expect(out).toContain('Updated just now');
    expect(out).toContain('data-slot="page-header-actions"');
    expect(out).toContain('flex-wrap');
    expect(out).toContain('sm:justify-end');
  });

  it('omits empty slots', () => {
    const out = html(<PageHeader title="Wallet" />);
    for (const slot of ['description', 'meta', 'actions', 'breadcrumbs']) expect(out).not.toContain(`page-header-${slot}`);
  });

  it('has a divider only when asked', () => {
    expect(html(<PageHeader title="x" />)).not.toContain('border-b');
    expect(html(<PageHeader title="x" divider />)).toContain('border-b border-line');
  });

  it('loading: aria-busy, a skeleton of the final 28 px height, and no title text', () => {
    const out = html(<PageHeader title="Secret title" description="Secret description" loading actions={<button>Go</button>} />);
    expect(out).toContain('aria-busy="true"');
    expect(out).toContain('data-slot="skeleton"');
    expect(out).toContain('height:28px');
    expect(out).not.toContain('Secret title');
    expect(out).not.toContain('Secret description');
    expect(out).not.toContain('<button');
  });

  it('is not busy when loaded', () => {
    expect(html(<PageHeader title="x" />)).not.toContain('aria-busy');
  });

  it('density changes the gap', () => {
    expect(html(<PageHeader title="x" density="dense" />)).toContain('gap-2 pb-3');
    expect(html(<PageHeader title="x" />)).toContain('gap-3 pb-4');
  });
});

describe('PageSection and PageBody', () => {
  it('a section has an h2 that names it', () => {
    const out = html(<PageSection title="Holdings">rows</PageSection>);
    expect(count(out, /<h2/g)).toBe(1);
    const id = /<h2 id="([^"]+)"/.exec(out)?.[1];
    expect(id).toBeTruthy();
    expect(out).toContain(`aria-labelledby="${id}"`);
    expect(out).toContain('border-b border-line');
  });

  it('a section renders actions only when given', () => {
    expect(html(<PageSection title="x">c</PageSection>)).not.toContain('page-section-actions');
    expect(
      html(
        <PageSection title="x" actions={<a href="/all">All</a>}>
          c
        </PageSection>,
      ),
    ).toContain('page-section-actions');
  });

  it('section gap: 12 px dense, 24 px comfortable', () => {
    expect(
      html(
        <PageSection title="x" density="dense">
          c
        </PageSection>,
      ),
    ).toContain('gap-3');
    expect(html(<PageSection title="x">c</PageSection>)).toContain('gap-6');
  });

  it('section heading level can change', () => {
    expect(
      html(
        <PageSection title="x" headingLevel={3}>
          c
        </PageSection>,
      ),
    ).toContain('<h3');
  });

  it('a whole page has exactly one h1', () => {
    const out = html(
      <Page>
        <PageHeader title="Wallet" />
        <PageBody>
          <PageSection title="A">a</PageSection>
          <PageSection title="B">b</PageSection>
        </PageBody>
      </Page>,
    );
    expect(count(out, /<h1/g)).toBe(1);
    expect(count(out, /<h2/g)).toBe(2);
  });

  it('body spaces sections by density', () => {
    expect(html(<PageBody>x</PageBody>)).toContain('gap-8');
    expect(html(<PageBody density="dense">x</PageBody>)).toContain('gap-4');
  });
});
