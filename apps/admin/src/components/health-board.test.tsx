import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { moduleForPage } from '@/lib/modules';
import { buildBoard } from '@/lib/module-health/board';
import { HealthBoard } from './health-board';

describe('HealthBoard', () => {
  it('draws every module, names no-source and refused rows with their codes, and never prints a zero for them', () => {
    const html = renderToStaticMarkup(<HealthBoard rows={buildBoard({})} startedAt="2026-10-22T23:30:00.000Z" />);
    expect(html).toContain('data-testid="health-academy"');
    expect(html).toContain('ops.health_source_unwired');
    expect(html).toContain('ops.health_source_unavailable');
    expect(html).toMatch(/0 read · 4 refused · \d+ no source/);
  });
  it('belongs to the module board, so a console with kill switches off does not show it', () => {
    expect(moduleForPage('/health')).toBe('killswitches');
  });
});
