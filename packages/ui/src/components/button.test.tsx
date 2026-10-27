import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { Button } from './button.js';

const html = (el: React.ReactElement) => renderToStaticMarkup(el);

describe('Button variant hook', () => {
  it('names its variant, so a test can find the primary action without reading its colour classes', () => {
    expect(html(<Button>Buy</Button>)).toContain('data-variant="primary"');
    expect(html(<Button variant="primary">Buy</Button>)).toContain('data-variant="primary"');
    expect(html(<Button variant="secondary">Sell</Button>)).toContain('data-variant="secondary"');
  });

  it('a primary and a secondary button are styled apart, so the hook names a real difference', () => {
    const classOf = (out: string) => /class="([^"]*)"/.exec(out)?.[1];
    expect(classOf(html(<Button variant="primary">Buy</Button>))).not.toBe(classOf(html(<Button variant="secondary">Sell</Button>)));
  });
});
