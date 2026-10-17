/**
 * Gallery section for Page, PageHeader, Breadcrumbs, PageSection (the titled block, shown here as
 * PageSectionBlock) and EmptyState. Everything on screen is TEST DATA for layout only.
 */
import * as React from 'react';
import { Button } from '../../button.js';
import { EmptyState, type EmptyStateSize, type EmptyStateVariant } from '../../empty-state.js';
import { Breadcrumbs, Page, PageBody, PageHeader, PageSection as PageSectionBlock, type PageWidth } from '../../page.js';
import { StatusTag } from '../../status-tag.js';

function Caption({ children }: { children: React.ReactNode }) {
  return <p className="mb-2 text-xs text-fg-2">{children}</p>;
}

const crumbs = [{ label: 'Home', href: '#' }, { label: 'Wallet', href: '#' }, { label: 'Deposit (TEST DATA)' }];

function DemoHeader({ density, loading }: { density?: 'dense' | 'comfortable'; loading?: boolean }) {
  return (
    <PageHeader
      density={density}
      loading={loading}
      divider
      breadcrumbs={<Breadcrumbs items={crumbs} />}
      title="Wallet (TEST DATA)"
      description="Sample description line for layout."
      meta={<StatusTag status="working" label="Updated 2 min ago (TEST)" />}
      actions={
        <>
          <Button variant="secondary" size={density === 'dense' ? 32 : 40}>
            Export
          </Button>
          <Button size={density === 'dense' ? 32 : 40}>Deposit</Button>
        </>
      }
    />
  );
}

/** A page at a fixed 1440 px viewport, scaled to fit a frame, so the three widths can be compared. */
function ScaledPage({ width }: { width: PageWidth }) {
  const scale = 0.27;
  return (
    <div>
      <Caption>
        width="{width}" (1440 px viewport, scaled to {Math.round(scale * 100)}%)
      </Caption>
      <div className="relative overflow-hidden border border-line bg-bg" style={{ width: 1440 * scale, height: 560 * scale }}>
        <div
          className="origin-top-left bg-bg outline outline-1 -outline-offset-1 outline-line"
          style={{ width: 1440, height: 560, transform: `scale(${scale})` }}
        >
          <div className="h-full bg-field/40">
            <Page width={width} landmark={false} className="h-full bg-bg">
              <DemoHeader />
              <PageBody>
                <PageSectionBlock title="Section (TEST DATA)">
                  <div className="h-24 rounded-sm bg-panel" />
                </PageSectionBlock>
              </PageBody>
            </Page>
          </div>
        </div>
      </div>
    </div>
  );
}

const variants: EmptyStateVariant[] = ['empty', 'refused', 'unavailable'];
const sizes: EmptyStateSize[] = ['inline', 'panel', 'page'];

const sample: Record<EmptyStateVariant, { title: string; reason?: string; code?: string }> = {
  empty: { title: 'No orders yet (TEST)', reason: 'Orders you place will show up here.' },
  refused: { title: 'Withdrawals are blocked (TEST)', reason: 'Identity check is not finished for this account.', code: 'TEST-4031' },
  unavailable: { title: 'Card top-up is parked (TEST)', reason: 'The card processor has not approved our account yet.', code: 'TEST-5030' },
};

export function PageSection() {
  return (
    <section className="flex flex-col gap-8 px-6 py-8">
      <div>
        <h2 className="text-lg font-semibold">Page, PageHeader, Breadcrumbs, PageSection, EmptyState</h2>
        <p className="mt-1 text-sm text-fg-2">TEST DATA: every label and figure here is made up for layout.</p>
      </div>

      <div>
        <Caption>Breadcrumbs: links, then the current page (aria-current), long label truncated with its full text in title.</Caption>
        <Breadcrumbs
          items={[
            ...crumbs.slice(0, 2),
            { label: 'An account name that is much too long to fit on one line (TEST)', href: '#' },
            { label: 'Now' },
          ]}
        />
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        {(['comfortable', 'dense'] as const).map((density) => (
          <div key={density}>
            <Caption>PageHeader, {density}</Caption>
            <Page landmark={false} density={density} className="border border-line">
              <DemoHeader density={density} />
              <PageBody>
                <PageSectionBlock
                  title="Holdings (TEST DATA)"
                  actions={
                    <Button variant="ghost" size={density === 'dense' ? 28 : 32}>
                      See all
                    </Button>
                  }
                >
                  <div className="h-12 rounded-sm bg-panel" />
                </PageSectionBlock>
                <PageSectionBlock title="Activity (TEST DATA)">
                  <div className="h-12 rounded-sm bg-panel" />
                </PageSectionBlock>
              </PageBody>
            </Page>
          </div>
        ))}
      </div>

      <div>
        <Caption>PageHeader, loading (aria-busy, title skeleton keeps the 28 px height)</Caption>
        <div className="border border-line px-6 py-4">
          <DemoHeader loading />
        </div>
      </div>

      <div className="flex flex-wrap gap-6">
        {(['narrow', 'content', 'full'] as const).map((w) => (
          <ScaledPage key={w} width={w} />
        ))}
      </div>

      <div className="flex flex-col gap-6">
        <h3 className="text-md font-semibold">EmptyState, variants by sizes (TEST DATA)</h3>
        {sizes.map((size) => (
          <div key={size}>
            <Caption>size="{size}"</Caption>
            <div className={size === 'inline' ? 'flex flex-col gap-2' : 'grid gap-4 lg:grid-cols-3'}>
              {variants.map((variant) => {
                const s = sample[variant];
                const common = {
                  title: s.title,
                  code: s.code,
                  size,
                  action: { label: variant === 'empty' ? 'Place an order' : 'See what is needed', href: '#' },
                  secondaryAction: variant === 'empty' ? { label: 'Learn more', onClick: () => {} } : undefined,
                  className: 'border border-line',
                };
                return variant === 'empty' ? (
                  <EmptyState key={variant} {...common} reason={s.reason} />
                ) : (
                  <EmptyState key={variant} {...common} variant={variant} reason={s.reason ?? ''} />
                );
              })}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}
