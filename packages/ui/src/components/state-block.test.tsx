import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { StateBlock } from './state-block.js';

const html = (el: React.ReactElement) => renderToStaticMarkup(el);

describe('StateBlock test hook', () => {
  it('puts the room’s test id on the block in every kind', () => {
    expect(html(<StateBlock kind="loading" testId="room-state" />)).toContain('data-testid="room-state"');
    expect(html(<StateBlock kind="empty" title="Nothing yet" testId="room-state" />)).toContain('data-testid="room-state"');
    expect(html(<StateBlock kind="error" onRetry={() => {}} testId="room-state" />)).toContain('data-testid="room-state"');
    expect(html(<StateBlock kind="refused" title="Not here" body="Why" testId="room-state" />)).toContain('data-testid="room-state"');
  });

  it('adds no test id when the room gives none', () => {
    expect(html(<StateBlock kind="empty" title="Nothing yet" />)).not.toContain('data-testid');
  });
});
