import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { RouteBoundary, ROUTE_BOUNDARY_COPY, type RouteBoundaryKind } from './route-boundary';
import AppError from '@/app/error';
import Loading from '@/app/loading';
import NotFound from '@/app/not-found';

/**
 * WHAT THE OPERATOR READS WHEN THE SCREEN IS MISSING OR DEAD.
 *
 * Falsifier: a bogus path paints a fake empty users table, or a throw takes
 * the operator shell with it, or an error reads as empty-success.
 */

const APP_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'app');
const KINDS: readonly RouteBoundaryKind[] = ['loading', 'not-found', 'error'];
const INVENTED_QUEUE = [
  'adm-queue-table',
  'pending KYC',
  'empty pending queue',
  'Users · pending KYC',
  'Withdrawal approvals</',
  'user-1',
  'order-1',
  '0.00 USDT',
];

function htmlOf(kind: RouteBoundaryKind, over: { digest?: string; onRetry?: () => void } = {}): string {
  return renderToStaticMarkup(<RouteBoundary kind={kind} digest={over.digest} onRetry={over.onRetry} />);
}

function OperatorShell({ children }: { children: ReactNode }) {
  return (
    <div className="adm-shell">
      <header className="adm-topbar">
        <span className="adm-brand">
          INTAFACED
          <small>Operator Console</small>
        </span>
        <nav className="adm-nav" aria-label="Operator console">
          <a href="/">Kill-switches</a>
        </nav>
      </header>
      <main className="adm-main">{children}</main>
    </div>
  );
}

describe('App Router special files — present beside the operator shell', () => {
  it('registers error.tsx, not-found.tsx and loading.tsx next to layout.tsx', () => {
    for (const name of ['layout.tsx', 'error.tsx', 'not-found.tsx', 'loading.tsx']) {
      expect(existsSync(join(APP_DIR, name)), name).toBe(true);
    }
    const errorSrc = readFileSync(join(APP_DIR, 'error.tsx'), 'utf8');
    expect(errorSrc).toMatch(/^['"]use client['"]/m);
    expect(errorSrc).toContain('kind="error"');
    expect(errorSrc).toContain('error.digest');
    expect(errorSrc).not.toMatch(/error\.message/);
  });

  it('keeps the crash probe fail-closed unless ADMIN_ROUTE_PROBE=1', () => {
    const src = readFileSync(join(APP_DIR, '(console)', 'route-probe', 'crash', 'page.tsx'), 'utf8');
    expect(src).toContain("ADMIN_ROUTE_PROBE !== '1'");
    expect(src).toContain('notFound()');
    expect(src).toContain("throw new Error('admin.route_probe.render_error')");
  });
});

describe('RouteBoundary — distinct states, no invented queues', () => {
  it('renders loading, not-found and error as different states', () => {
    const html = Object.fromEntries(KINDS.map((kind) => [kind, htmlOf(kind)])) as Record<RouteBoundaryKind, string>;

    expect(html.loading).toContain('data-route-boundary="loading"');
    expect(html['not-found']).toContain('data-route-boundary="not-found"');
    expect(html.error).toContain('data-route-boundary="error"');

    expect(html.loading).toContain(ROUTE_BOUNDARY_COPY.loading.title);
    expect(html['not-found']).toContain(ROUTE_BOUNDARY_COPY['not-found'].title);
    expect(html.error).toContain(ROUTE_BOUNDARY_COPY.error.title);

    expect(html['not-found']).not.toContain(ROUTE_BOUNDARY_COPY.error.title);
    expect(html.error).not.toContain(ROUTE_BOUNDARY_COPY['not-found'].title);
    expect(html.loading).not.toContain(ROUTE_BOUNDARY_COPY.error.title);
    expect(html.loading).not.toContain(ROUTE_BOUNDARY_COPY['not-found'].title);
  });

  it('never paints users/orders/finance/withdrawal rows', () => {
    const html = KINDS.map((kind) => htmlOf(kind)).join('\n');
    for (const needle of INVENTED_QUEUE) {
      expect(html, needle).not.toContain(needle);
    }
    expect(html).toContain('no queue authority');
    expect(html).toContain('not an empty-success queue');
  });

  it('does not offer retry on not-found or loading; error can retry', () => {
    expect(htmlOf('not-found')).not.toContain('Retry this screen');
    expect(htmlOf('loading')).not.toContain('Retry this screen');
    expect(htmlOf('loading')).not.toContain('href="/"');
    expect(htmlOf('error', { onRetry: () => undefined })).toContain('Retry this screen');
    expect(htmlOf('error', { digest: 'abc123' })).toContain('abc123');
    expect(htmlOf('error', { digest: 'abc123' })).not.toContain('secret-token');
  });
});

describe('thrown render error is isolated to the page slot', () => {
  it('keeps the operator shell when the page slot is the error view', () => {
    const html = renderToStaticMarkup(
      <OperatorShell>
        <AppError error={Object.assign(new Error('admin.route_probe.render_error'), { digest: 'dgst' })} reset={() => undefined} />
      </OperatorShell>,
    );

    expect(html).toContain('Operator Console');
    expect(html).toContain('aria-label="Operator console"');
    expect(html).toContain('data-route-boundary="error"');
    expect(html).toContain('This screen failed to render');
    expect(html).toContain('dgst');
    expect(html).not.toContain('admin.route_probe.render_error');
    expect(html).not.toContain('data-route-boundary="not-found"');
    for (const needle of INVENTED_QUEUE) {
      expect(html, needle).not.toContain(needle);
    }
  });

  it('keeps the operator shell when the page slot is not-found', () => {
    const html = renderToStaticMarkup(
      <OperatorShell>
        <NotFound />
      </OperatorShell>,
    );
    expect(html).toContain('Operator Console');
    expect(html).toContain('data-route-boundary="not-found"');
    expect(html).not.toContain('data-route-boundary="error"');
    expect(html).not.toContain('empty pending queue');
  });

  it('wires the App Router files to the same views', () => {
    expect(renderToStaticMarkup(<Loading />)).toContain('data-route-boundary="loading"');
    expect(renderToStaticMarkup(<NotFound />)).toContain('data-route-boundary="not-found"');
    expect(renderToStaticMarkup(createElement(AppError, { error: new Error('hidden'), reset: () => undefined }))).toContain(
      'data-route-boundary="error"',
    );
  });
});
