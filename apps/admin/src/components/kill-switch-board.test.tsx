import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { FLAG_REGISTRY } from '@intafaced/config';
import { KillSwitchBoard } from '@/components/kill-switch-board';
import type { ControlPlaneState } from '@/lib/control-plane-browser';

/**
 * DOES THE OPERATOR CONSOLE TELL THE TRUTH ABOUT WHAT IS OFF?
 *
 * ── The finding ─────────────────────────────────────────────────────────────
 *
 * `LAUNCH_DROP` defaults to `0`, so `FLAG_REGISTRY` resolves all but five flags
 * off. Nothing under `services/*` resolves a flag — there is not one import of
 * `isEnabled` / `resolveAll` / `FLAG_REGISTRY` in any service — so those
 * capabilities answered every request. This board rendered a `Dark` chip and a
 * switch for each of them, and an operator cannot distinguish "the registry says
 * off" from "the capability is off" unless a page says which it means.
 *
 * We did NOT resolve this by gating at the edge. See the branch's commit
 * message: at `LAUNCH_DROP=0` every routed module's flags are off, so a
 * flag-consulting perimeter would refuse the entire platform — including
 * `edge.gateway` itself, which is drop I. The launch flags are a plan; the
 * enforced perimeter control is the module kill-switch, which is separate,
 * live, and unchanged by this branch.
 *
 * ── Why these assertions are on markup ──────────────────────────────────────
 *
 * The bug was in what an operator READ. `renderToStaticMarkup` produces exactly
 * the string a browser was served, so every assertion below is against the
 * artefact that misled someone — not against a comment claiming it will not
 * happen again, and not against a helper that the render is free to ignore.
 *
 * The negative assertions carry the weight. "The word `Dark` does not appear in
 * the `protocol.amm` row" fails the moment someone reintroduces a capability
 * claim, however they spell the component that makes it.
 */

const CONTROL_PLANE: ControlPlaneState = {
  status: 'reachable',
  snapshot: { disabledModules: [], reasons: {}, audit: [] },
  detail: null,
};

describe('the module controls live on the board and are never a browser boolean', () => {
  it('hosts the two-founder module desk, with the current-state badge, in place of the old read-only boundary', () => {
    const html = render();
    expect(html).toContain('data-testid="kill-badge"');
    expect(html).toContain('Module controls');
    expect(html).not.toContain('Module writes unavailable');
    expect(html).not.toContain('Module write unavailable');
  });

  it('offers no per-module switch: the group header links to the controls instead', () => {
    const html = render();
    expect(html).toContain('href="#module=trade"');
  });

  it('switches the desk off, with the reason, when the console cannot send', () => {
    const html = render({ moduleWritesBlocked: 'ADMIN_OPERATOR_TOKEN is not set' });
    expect(html).toContain('This control is switched off');
    expect(html).toContain('ADMIN_OPERATOR_TOKEN is not set');
    expect(html).toContain('Kill / re-enable unavailable');
    expect(html).not.toContain('data-testid="request-form"');
  });
});

/** The drop the platform actually runs at — `LAUNCH_DROP` defaults to `'0'`. */
function render(overrides: Partial<Parameters<typeof KillSwitchBoard>[0]> = {}): string {
  return renderToStaticMarkup(
    <KillSwitchBoard
      drop="0"
      flagEnv={{}}
      initialControlPlane={CONTROL_PLANE}
      moduleWritesBlocked={null}
      userId="11111111-1111-4111-8111-111111111111"
      {...overrides}
    />,
  );
}

/**
 * The `<tr>` that carries one flag, isolated from the rest of the page.
 *
 * Row-scoped rather than page-scoped because the page legitimately contains the
 * word "Dark" elsewhere (module summary chips, the staged-diff table). An
 * assertion over the whole document would either be vacuous or wrong.
 */
function rowFor(html: string, key: string): string {
  const rows = html.split('<tr').map((chunk) => `<tr${chunk}`);
  const row = rows.find((chunk) => chunk.includes(`class="adm-key">${key}</td>`));
  if (!row) throw new Error(`no row rendered for flag "${key}"`);
  return row.split('</tr>')[0] ?? row;
}

/** The four the audit named, split by what is actually true of each. */
const SERVING_AND_UNGATED = ['protocol.amm', 'academy.inviteLobbies'] as const;
const GATED_BUT_UNREADABLE = ['notify.fanout', 'indexer.ingest'] as const;

describe('the board renders at the drop the platform runs at', () => {
  it('renders a row for every flag in the registry', () => {
    const html = render();
    for (const flag of FLAG_REGISTRY) {
      expect(() => rowFor(html, flag.key), `${flag.key} has no row`).not.toThrow();
    }
  });
});

describe('a capability that is serving is never drawn as off', () => {
  /**
   * The assertion the whole branch exists for. `Dark` is a word about a
   * capability; these rows know nothing about one.
   */
  it.each(SERVING_AND_UNGATED)('%s is not presented as a dark capability', (key) => {
    const row = rowFor(render(), key);

    expect(row).not.toContain('>Dark<');
    expect(row).not.toContain('>Live<');
    expect(row).toContain('Planned off');
    expect(row).toContain('Not a control');
  });

  it.each(SERVING_AND_UNGATED)('%s says out loud that it is serving', (key) => {
    expect(rowFor(render(), key)).toContain('serving');
  });

  it.each(SERVING_AND_UNGATED)('%s offers no switch to move, because there is nothing on the far end', (key) => {
    const row = rowFor(render(), key);
    // The row's own switch, not the module switch in the group subhead — group
    // subheads are their own <tr> and are excluded by the row split above.
    expect(row).toContain('disabled=""');
  });

  it('names them in a panel rather than leaving them to be found in a table', () => {
    const html = render();
    // The count is in the panel title, so the page states the size of the
    // problem instead of disclosing it one row at a time.
    expect(html).toMatch(/\d+ of \d+ flags read off — and the capability is serving/);
    for (const key of SERVING_AND_UNGATED) expect(html).toContain(key);
  });

  it('sends the operator to the control that does work', () => {
    // A page that says "this does nothing" and stops has told an operator their
    // console is broken. The module kill IS enforced, at svc-edge.
    expect(render()).toContain('kill its <strong>module</strong> above');
  });
});

describe('a flag this console cannot read is not reported as off either', () => {
  /**
   * `notify.fanout` and `indexer.ingest` DO refuse — from `NOTIFY_FANOUT_ENABLED`
   * and `INDEXER_INGEST_ENABLED`, read once at that service's boot, defaulting
   * to on. The console reads `INTAFACED_FLAG_*` off its own process and has
   * never seen either variable, so the registry's `false` was being rendered as
   * a capability state it had not checked.
   *
   * FAIL CLOSED, in both directions: an undetermined state is never drawn as on,
   * and never drawn as off.
   */
  it.each(GATED_BUT_UNREADABLE)('%s reports a registry value, labelled as one', (key) => {
    const row = rowFor(render(), key);

    expect(row).not.toContain('>Dark<');
    expect(row).not.toContain('>Live<');
    expect(row).toContain('Registry off');
    expect(row).toContain('not read from the service');
  });

  it.each(GATED_BUT_UNREADABLE)('%s names the variable that actually decides', (key) => {
    const expected = key === 'notify.fanout' ? 'NOTIFY_FANOUT_ENABLED' : 'INDEXER_INGEST_ENABLED';
    expect(rowFor(render(), key)).toContain(expected);
  });

  it.each(GATED_BUT_UNREADABLE)('%s is not filed with the flags that gate nothing', (key) => {
    // The distinction is the actionable part: one list means "this will never
    // stop from here", the other means "ask the service". Collapsing them would
    // lose the half an operator can do something about.
    expect(rowFor(render(), key)).not.toContain('Not a control');
  });

  it('lists them under a heading that says the console cannot read them', () => {
    expect(render()).toMatch(/\d+ flags whose real state this console cannot read/);
  });
});

describe('the flags that DO have a real gate keep saying so', () => {
  /**
   * The other direction. A fix that made every row say "we do not know" would
   * be honest and useless — `trade.spot` and `matching.engine` genuinely refuse,
   * and an operator has to be able to find that.
   */
  it('trade.spot names its enforcement and the service that holds it', () => {
    const row = rowFor(render(), 'trade.spot');
    expect(row).toContain('Restart to apply');
    expect(row).toContain('TRADE_SPOT_ENABLED');
  });

  it('ledger.posting is marked a live control, because it alone is reachable while running', () => {
    expect(rowFor(render(), 'ledger.posting')).toContain('Live control');
  });

  it('every enforced row states what enforces it', () => {
    const html = render();
    for (const flag of FLAG_REGISTRY) {
      if (flag.enforcement.kind === 'none') continue;
      expect(rowFor(html, flag.key), `${flag.key} is enforced but names no mechanism`).toContain(flag.enforcement.envVar);
    }
  });

  it('every unenforced row states that it is not a control', () => {
    const html = render();
    for (const flag of FLAG_REGISTRY) {
      if (flag.enforcement.kind !== 'none') continue;
      expect(rowFor(html, flag.key), `${flag.key} gates nothing and does not say so`).toContain('Not a control');
    }
  });
});

describe('the page-level numbers are not capability counts', () => {
  it('does not offer a bare "Flags live" figure', () => {
    // It was the first number on the page and read as live CAPABILITIES, which
    // is what made every panel under it plausible.
    const html = render();
    expect(html).not.toContain('>Flags live<');
    expect(html).toContain('Flags on in registry');
    expect(html).toContain('not a capability count');
  });

  it('reports how many states were actually read from the platform', () => {
    // Zero, with no module killed: nothing on this page has asked a service.
    const html = render();
    expect(html).toContain('States read from the platform');
    expect(html).toContain('the rest are registry values');
  });
});

describe('a module killed at the edge is the one state the board may assert', () => {
  /**
   * The exception that keeps the rule from being nihilism. `disabledModules`
   * comes back from svc-edge, so when a module is killed the perimeter really
   * is refusing new commitments and the board may say so.
   */
  const KILLED: ControlPlaneState = {
    status: 'reachable',
    snapshot: { disabledModules: ['protocol'], reasons: { protocol: 'incident (by ops)' }, audit: [] },
    detail: null,
  };

  it('marks protocol.amm dark when the operator has actually killed the module', () => {
    const row = rowFor(render({ initialControlPlane: KILLED }), 'protocol.amm');
    expect(row).toContain('>Dark<');
    expect(row).toContain('read from svc-edge');
  });

  it('stops counting it as serving, because it is not', () => {
    const html = render({ initialControlPlane: KILLED });
    const panel = /(\d+) of \d+ flags read off — and the capability is serving/.exec(html);
    const withKill = panel ? Number(panel[1]) : 0;

    const before = /(\d+) of \d+ flags read off — and the capability is serving/.exec(render());
    expect(before).not.toBeNull();
    expect(withKill).toBeLessThan(Number(before?.[1]));
  });
});

describe('an unconfigured control plane never paints Platform state as live', () => {
  it('clears the live bloom when EDGE_URL / operator token are absent', () => {
    const html = render({
      initialControlPlane: {
        status: 'unconfigured',
        snapshot: { disabledModules: [], reasons: {}, audit: [] },
        detail: 'This console cannot halt a module — EDGE_URL and ADMIN_OPERATOR_TOKEN are not set on this app.',
      },
    });
    const titleAt = html.indexOf('Platform state');
    expect(titleAt).toBeGreaterThan(-1);
    const panelHead = html.slice(Math.max(0, titleAt - 240), titleAt);
    expect(panelHead).toContain('data-live="false"');
    expect(html).toContain('Control plane: not configured');
  });
});
