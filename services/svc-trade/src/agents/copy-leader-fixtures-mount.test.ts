import { describe, expect, it } from 'vitest';
import { COPY_LEADER_FIXTURES_PATH } from './copy-leader-fixtures-routes.js';

describe('copy leader fixtures mount', () => {
  it('exports stable path for svc-agents HTTP port', () => {
    expect(COPY_LEADER_FIXTURES_PATH).toBe('/internal/agents/copy-leader-fixtures');
  });
});
