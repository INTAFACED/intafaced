import { describe, expect, it } from 'vitest';
import {
  AGENT_ERROR_CODES,
  agentErrorCodeCount,
  isAgentErrorCode,
  agentProviderErrorCodes,
  agentErrorCatalogBoardCard,
  parseAgentErrorCatalogStatusLine,
  agentErrorCatalogStatusLineMatches,
  agentErrorCatalogExportHeader,
  agentErrorCatalogExportLines,
  agentErrorCatalogExportText,
  agentErrorCodeCountInRange,
  ProviderError,
  providerErrorBoardCard,
  providerErrorStatusLine,
} from './errors.js';

describe('L3 wave61 agent error catalog honesty', () => {
  it('catalog boards and provider error board', () => {
    expect(agentErrorCodeCount()).toBe(AGENT_ERROR_CODES.length);
    expect(isAgentErrorCode('agents.refused')).toBe(true);
    expect(isAgentErrorCode('agents.nope')).toBe(false);
    expect(agentProviderErrorCodes().length).toBeGreaterThan(0);
    expect(agentErrorCatalogBoardCard().total).toBe(AGENT_ERROR_CODES.length);
    expect(agentErrorCatalogStatusLineMatches()).toBe(true);
    expect(parseAgentErrorCatalogStatusLine('nope')).toBeNull();
    expect(agentErrorCatalogExportText().startsWith(agentErrorCatalogExportHeader())).toBe(true);
    expect(agentErrorCatalogExportLines()).toHaveLength(AGENT_ERROR_CODES.length);
    expect(agentErrorCodeCountInRange(1, 50)).toBe(true);
    expect(agentErrorCodeCountInRange(50, 1)).toBe(false);

    const pe = new ProviderError('outage', 'primary', true, 503);
    expect(providerErrorBoardCard(pe).retryable).toBe(true);
    expect(providerErrorStatusLine(pe)).toBe('provider=primary retryable=1 status=503');
  });
});
