// volt-room: /token/economy
import { MonitorTemplate, SectionTabs } from '@intafaced/ui/lit/templates';
import { navigate } from '../../../app/location';
import { buybackRunsCopy } from '../buyback-runs-copy';
import { t as copyText, Text } from '../copy';
import { moreRoomRoutesCopy } from '../more-room-routes-copy';
import type { TokenTab } from '../Token';
import { TokenEconomyPanels } from '../TokenEconomy';
import { preservePaperHref } from '../trade-context';
import { Section } from '../volt-parts';

/** Each section's own address; /token itself is staking. */
const SECTION_PATHS: Readonly<Record<TokenTab, string>> = {
  Staking: '/token',
  Governance: '/token/governance',
  Economy: '/token/economy',
  Burn: '/token/burn',
};

/**
 * /token/economy on the monitor template (J-more-catalogue-20 #2 #4 #5): the emission schedule, supply and
 * distribution, and this account's real yield, each as the token service reports it, and what this economy does not
 * quote. The same reads and words as the economy tab of the old room (`../Token.tsx`); each other section's button opens
 * its own address, keeping the simulated view when this one is simulated.
 */
export function TokenEconomyRoom({ paper }: { paper: boolean }) {
  const routes = moreRoomRoutesCopy.useCopy();
  return (
    <MonitorTemplate
      title={routes.t('economy')}
      description={copyText('moreroutes.exact.stake.records.access.and.governance')}
      state={{ kind: 'ready' }}
      figures={[]}
      actions={
        <SectionTabs<TokenTab>
          items={[
            { value: 'Staking', label: copyText('token.staking') },
            { value: 'Governance', label: copyText('token.governance') },
            { value: 'Economy', label: copyText('token.economy') },
            { value: 'Burn', label: buybackRunsCopy.t('tab') },
          ]}
          value="Economy"
          onChange={(tab) => {
            if (tab !== 'Economy') navigate(preservePaperHref(SECTION_PATHS[tab], paper));
          }}
          label={copyText('token.token.sections')}
        />
      }
      panels={
        <div className="lt-grid">
          <TokenEconomyPanels />
        </div>
      }
      explain={
        <Section title={copyText('token.economy.boundaries')}>
          <p>
            <Text k="token.emission.buyback.and.revenue.distribution.windows.are" />
          </p>
          <p>
            <Text k="token.no.upcoming.distribution.is.quoted" />
          </p>
          <p>
            <Text k="token.governance.closure.depends.on.published.quorum.and" />
          </p>
        </Section>
      }
    />
  );
}
