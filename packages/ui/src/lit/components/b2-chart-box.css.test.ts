// ChartCanvas's own clip: square, so a library's axis and marker labels drawn into the corners stay whole. A rounded
// clip (Volt's control radius is a pill) cuts a chart's first and last time labels and its corner price labels.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const css = readFileSync(fileURLToPath(new URL('../templates/templates.css', import.meta.url)), 'utf8');
const rule = (selector: string) => {
  const found = new RegExp(`(?:^|\\n)${selector.replace('.', '\\.')}\\s*\\{([^}]*)\\}`).exec(css);
  if (!found) throw new Error(`${selector} is not in templates.css`);
  return found[1]!;
};

describe('ChartCanvas', () => {
  it('clips the drawing to its box without rounding the corners', () => {
    expect(rule('.lt-chart-canvas')).toMatch(/overflow:\s*hidden/);
    expect(rule('.lt-chart-canvas')).not.toMatch(/border-radius|clip-path|mask/);
  });
});
