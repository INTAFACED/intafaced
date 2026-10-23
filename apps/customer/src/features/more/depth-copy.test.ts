import { describe, expect, it } from 'vitest';
import { agentsCatalogueCopy } from './agents-catalogue-copy';
import { campaignsDepthCopy } from './campaigns-depth-copy';
import { launchDepthCopy } from './launch-depth-copy';
import { marketExplorerCopy } from './market-explorer-copy';
import { miningDepthCopy } from './mining-depth-copy';
import { tokenHoldingsCopy } from './token-holdings-copy';

const catalogs = {
  agents: agentsCatalogueCopy,
  campaigns: campaignsDepthCopy,
  launch: launchDepthCopy,
  market: marketExplorerCopy,
  mining: miningDepthCopy,
  token: tokenHoldingsCopy,
};

describe('More depth copy', () => {
  for (const [name, catalog] of Object.entries(catalogs)) {
    it(`${name} is fully written in Spanish and French`, () => {
      expect(catalog.coverage('es').missing).toEqual([]);
      expect(catalog.coverage('fr').missing).toEqual([]);
    });
  }
  it('states blockers and limits plainly', () => {
    expect(launchDepthCopy.forLocale('en').t('step_issuance_reason')).toMatch(/^Blocked:/);
    expect(miningDepthCopy.forLocale('en').t('verdict_configured')).toMatch(/not proof/);
    expect(tokenHoldingsCopy.forLocale('en').t('ticketBlocked')).toMatch(/No return or yield is promised/);
    expect(agentsCatalogueCopy.forLocale('en').t('costNotice')).toMatch(/provider/);
  });
});
