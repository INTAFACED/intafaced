import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { Badge, type BadgeTone } from './badge.js';

const html = (el: React.ReactElement) => renderToStaticMarkup(el);

describe('Badge default', () => {
  it('renders the label, soft neutral, comfortable', () => {
    const out = html(<Badge>Beta</Badge>);
    expect(out).toContain('data-slot="badge"');
    expect(out).toContain('data-tone="neutral"');
    expect(out).toContain('data-variant="soft"');
    expect(out).toContain('data-density="comfortable"');
    expect(out).toContain('>Beta<');
    expect(out).toContain('whitespace-nowrap');
    expect(out).toContain('rounded-xs');
  });
});

describe('Badge tones', () => {
  const soft: Record<BadgeTone, string> = {
    neutral: 'bg-hover',
    lime: 'bg-lime-soft',
    warn: 'bg-warn/15',
    error: 'bg-error/15',
    up: 'bg-up-bg',
    down: 'bg-down-bg',
  };
  it.each(Object.keys(soft) as BadgeTone[])('%s soft has its tint and keeps its label', (tone) => {
    const out = html(<Badge tone={tone}>Word</Badge>);
    expect(out).toContain(`data-tone="${tone}"`);
    expect(out).toContain(soft[tone]);
    expect(out).toContain('>Word<');
  });
  it.each(Object.keys(soft) as BadgeTone[])('%s outline uses a border in the text colour and no tint', (tone) => {
    const out = html(
      <Badge tone={tone} variant="outline">
        Word
      </Badge>,
    );
    expect(out).toContain('data-variant="outline"');
    expect(out).toContain('border-current/40');
    expect(out).not.toContain(soft[tone]);
  });
});

describe('Badge density and icon', () => {
  it('dense is h-5 text-2xs, comfortable is h-6 text-xs', () => {
    const dense = html(<Badge density="dense">x</Badge>);
    expect(dense).toContain('h-5');
    expect(dense).toContain('text-2xs');
    const comfy = html(<Badge density="comfortable">x</Badge>);
    expect(comfy).toContain('h-6');
    expect(comfy).toContain('text-xs');
  });
  it('draws the icon decorative before the label', () => {
    const out = html(<Badge icon={<svg data-testid="i" />}>Label</Badge>);
    expect(out).toContain('aria-hidden="true"');
    expect(out.indexOf('data-testid="i"')).toBeLessThan(out.indexOf('Label'));
  });
  it('uses no bold weight', () => {
    expect(html(<Badge>x</Badge>)).not.toMatch(/font-bold|font-extrabold/);
  });
});
