import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { PYTHON_TEMPLATE } from '../../quant/python-template';
import { QUANT_PYTHON_CLIENT } from './python-client';

// The download on /developers/quant is the package's own module, and its starter is the sandbox's template.
const CLIENT = new URL('../../../../../../sdks/python/intafaced_quant/client.py', import.meta.url);

describe('the Python client download', () => {
  it('is sdks/python/intafaced_quant/client.py, byte for byte', () => {
    expect(QUANT_PYTHON_CLIENT).toBe(readFileSync(CLIENT, 'utf8'));
  });

  it('hands out the sandbox’s Python template as strategy_template()', () => {
    const quoted = /_TEMPLATE = """([\s\S]*?)"""/.exec(QUANT_PYTHON_CLIENT)?.[1];
    expect(quoted).toBe(PYTHON_TEMPLATE);
  });
});
