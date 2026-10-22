import { describe, expect, it } from 'vitest';
import { merchantDescriptorProblem } from '@intafaced/contracts';
import { parseProfilePatch } from './fields.js';
import { PortalError } from './errors.js';

function code(fn: () => unknown): string {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(PortalError);
    return (e as PortalError).code;
  }
  throw new Error('expected a refusal');
}

describe('M-plat-org-09 statement descriptor on profile submit', () => {
  it('a valid descriptor passes unchanged as a sensitive (reviewed) change', () => {
    expect(parseProfilePatch({ statementDescriptor: 'ACME SHOP' })).toEqual({
      immediate: {},
      sensitive: { statementDescriptor: 'ACME SHOP' },
    });
  });

  it('refuses what the shared contracts rule refuses: 4 characters, a banned character, too long, no letter, edge space', () => {
    for (const bad of ['SHOP', 'ACME*SHOP', 'A'.repeat(23), '12345', ' ACME SHOP']) {
      expect(merchantDescriptorProblem(bad)).not.toBeNull();
      expect(code(() => parseProfilePatch({ statementDescriptor: bad }))).toBe('pay.profile_descriptor_invalid');
    }
  });

  it('null or an empty string clears the descriptor', () => {
    expect(parseProfilePatch({ statementDescriptor: null }).sensitive).toEqual({ statementDescriptor: null });
    expect(parseProfilePatch({ statementDescriptor: '' }).sensitive).toEqual({ statementDescriptor: null });
  });

  it('server and contracts agree on every sample', () => {
    for (const v of ['ACME SHOP', 'SHOP', 'Café Bar', 'GOOD-CO #12', 'x'.repeat(22), 'abc<d>e']) {
      const server = (() => {
        try {
          parseProfilePatch({ statementDescriptor: v });
          return true;
        } catch {
          return false;
        }
      })();
      expect(server).toBe(merchantDescriptorProblem(v) === null);
    }
  });
});
