import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ConsoleStatusBanner } from './console-status-banner';
import { readConsoleStatus } from '@/lib/console-status';
const TOKEN = 'isolated-operator-secret',
  TREASURY = 'isolated-treasury-secret',
  PROXY = 'isolated-proxy-secret';
const render = (env: Record<string, string> = {}, locale: 'en' | 'es' | 'fr' = 'en') =>
  renderToStaticMarkup(<ConsoleStatusBanner status={readConsoleStatus({ NODE_ENV: 'test', ...env })} locale={locale} />);
describe('the actual banner never declares env-only halt authority', () => {
  it('keeps the authority boundary visible while deployment facts use a closed native disclosure', () => {
    const html = render();
    const boundary = html.slice(0, html.indexOf('<details'));
    expect(boundary).toContain('Module writes unavailable');
    expect(boundary).toContain(
      'Personal operator session and identity-issued approval with original operation context are unavailable here.',
    );
    expect(boundary).not.toContain('EDGE_URL');
    expect(html).toContain('<details class="mi-deployment"><summary>Deployment configuration</summary>');
    expect(html).not.toContain('<details class="mi-deployment" open');
    expect(html).toContain('ADMIN_TREASURY_TOKEN');
    expect(html).toContain('reachability and command readiness are unverified');
  });
  it('all transport fields present still shows the module action prerequisite refusal', () => {
    const html = render({
      EDGE_URL: 'http://isolated-edge:4000',
      ADMIN_OPERATOR_TOKEN: TOKEN,
      ADMIN_TREASURY_TOKEN: TREASURY,
      ADMIN_BFF_SHARED_SECRET: PROXY,
    });
    expect(html).toContain('Module writes unavailable');
    expect(html).toContain('Module transport');
    expect(html).toContain('Treasury transport');
    expect(html).toContain('not a personal operator session');
    expect(html).toContain('identity-issued approval');
    expect(html).not.toContain('data-tone="live"');
    expect(html).not.toContain('this console can freeze');
    expect(html).not.toContain('can halt');
    expect(html).not.toContain(TOKEN);
    expect(html).not.toContain(TREASURY);
    expect(html).not.toContain(PROXY);
    expect(html).not.toContain('http://isolated-edge:4000');
  });
  it('blank transport names only actual missing fields without claiming every tool inert', () => {
    const html = render();
    for (const name of ['EDGE_URL', 'ADMIN_OPERATOR_TOKEN', 'ADMIN_TREASURY_TOKEN', 'ADMIN_BFF_SHARED_SECRET'])
      expect(html).toContain(name);
    expect(html).toContain('reachability and command readiness are unverified');
    expect(html).toContain('role="status"');
    expect(html).not.toContain('Every switch below is inert');
  });
  it('module-only transport cannot hide the boundary or imply treasury readiness', () => {
    const html = render({ EDGE_URL: 'http://isolated-edge:4000', ADMIN_OPERATOR_TOKEN: TOKEN });
    expect(html).toContain('ADMIN_TREASURY_TOKEN');
    expect(html).not.toContain('>ADMIN_OPERATOR_TOKEN<');
    expect(html).toContain('Ledger freeze and unfreeze retain treasury');
    expect(html).toContain('original operation guards');
  });
  it.each([
    ['es', 'Cambios de módulos no disponibles', 'Configuración del despliegue'],
    ['fr', 'Modification des modules indisponible', 'Configuration du déploiement'],
  ] as const)('local%s copy preserves the same authority refusal', (locale, title, details) => {
    const html = render({ EDGE_URL: 'http://isolated-edge:4000', ADMIN_OPERATOR_TOKEN: TOKEN, ADMIN_TREASURY_TOKEN: TREASURY }, locale);
    expect(html).toContain(title);
    expect(html).toContain(`<summary>${details}</summary>`);
    expect(html).not.toContain('Personal operator session');
    expect(html).not.toContain('Module writes unavailable');
    expect(html).not.toContain(TOKEN);
    expect(html).not.toContain(TREASURY);
    expect(html).toContain('ADMIN_BFF_SHARED_SECRET');
  });
});
