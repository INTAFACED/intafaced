import { renderToString } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../../../../shared/preferences', async (original) => {
  const real = await original<typeof import('../../../../../shared/preferences')>();
  return { ...real, usePreferences: () => real.currentPreferences() };
});

import type { Access } from '../../access/resolve';
import { isTeamMember } from './rooms';
import { OwnerSetsUp } from './ui';

const ready = (role: 'owner' | 'admin' | 'viewer'): Access => ({ status: 'ready', role }) as unknown as Access;

describe('setup for a team member', () => {
  it('tells a team member that the owner sets the business up', () => {
    expect(isTeamMember(ready('admin'))).toBe(true);
    expect(isTeamMember(ready('viewer'))).toBe(true);
    expect(renderToString(<OwnerSetsUp />)).toContain('Your business is set up by its owner');
  });
  it('leaves setup to the owner, and to a person who has no business yet', () => {
    expect(isTeamMember(ready('owner'))).toBe(false);
    expect(isTeamMember({ status: 'none' } as Access)).toBe(false);
    expect(isTeamMember({ status: 'loading' } as Access)).toBe(false);
  });
});
