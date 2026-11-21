import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { DECLARED_TOOL_SHAPES, declaredToolShape } from './catalog.js';

/**
 * The Rust port's `agent.get` shows each tool's declared shape from `crates/svc-agents/src/tool_shapes.json`. It is this
 * catalogue's table; a shape that changes here makes that file stale, and this test fails until
 * `scripts/record-door.mjs` writes it again.
 */
describe('declared tool shapes', () => {
  it('crates/svc-agents/src/tool_shapes.json is DECLARED_TOOL_SHAPES', () => {
    const file = new URL('../../../../crates/svc-agents/src/tool_shapes.json', import.meta.url);
    expect(
      JSON.parse(readFileSync(file, 'utf8')),
      'crates/svc-agents/src/tool_shapes.json is stale: run `TZ=UTC node --import tsx crates/svc-agents/scripts/record-door.mjs` from the repository root',
    ).toEqual(DECLARED_TOOL_SHAPES);
  });

  it('a tool with a declared shape answers it; one without answers null, never a guess', () => {
    expect(declaredToolShape('trade.quote')).toEqual({
      input: { marketId: 'text, up to 64 characters' },
      output: { marketId: 'text', last: 'decimal string', asOf: 'time' },
    });
    expect(declaredToolShape('identity.session.read')).toBeNull();
    expect(declaredToolShape('ledger.transfer')).toBeNull();
    expect(declaredToolShape('toString')).toBeNull();
  });
});
