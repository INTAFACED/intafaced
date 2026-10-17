import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { DisabledAction, Journey, StatRow } from './depth-kit';

describe('depth kit', () => {
  it('renders each journey step with its state and its named blocker', () => {
    const html = renderToStaticMarkup(
      <Journey
        label="Steps"
        steps={[
          { id: 'a', title: 'First', body: 'Do it', state: 'ready', stateLabel: 'Available now' },
          { id: 'b', title: 'Second', body: 'Then this', state: 'blocked', stateLabel: 'Blocked', reason: 'Blocked: no endpoint' },
        ]}
      />,
    );
    expect(html).toContain('depth-step--ready');
    expect(html).toContain('depth-step--blocked');
    expect(html).toContain('Blocked: no endpoint');
    expect((html.match(/<li /g) ?? []).length).toBe(2);
  });
  it('renders a control that cannot run as disabled, with its reason beside it', () => {
    const html = renderToStaticMarkup(<DisabledAction label="Register" reason="No endpoint exists" />);
    expect(html).toContain('disabled=""');
    expect(html).toContain('aria-disabled="true"');
    expect(html).toContain('No endpoint exists');
  });
  it('renders stated absences, not zeros', () => {
    const html = renderToStaticMarkup(<StatRow items={[{ label: 'Shares', value: 'Unknown', note: 'Not checked' }]} />);
    expect(html).toContain('Unknown');
    expect(html).toContain('Not checked');
    expect(html).not.toContain('>0<');
  });
});
