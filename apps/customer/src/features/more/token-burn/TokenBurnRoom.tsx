// volt-room: /token/burn
import { RecordListTemplate, SectionTabs } from '@intafaced/ui/lit/templates';
import { navigate } from '../../../app/location';
import { displayAmount } from '../../../shared/money';
import { BuybackRuns } from '../BuybackRuns';
import { buybackRunsCopy } from '../buyback-runs-copy';
import { Details } from '../catalogue-parts';
import { t as copyText } from '../copy';
import { moreRoomRoutesCopy } from '../more-room-routes-copy';
import { useTokenBurned, type TokenTab } from '../Token';
import { preservePaperHref } from '../trade-context';
import { KitRead, Section } from '../volt-parts';

/** Each section's own address; /token itself is staking. */
const SECTION_PATHS: Readonly<Record<TokenTab, string>> = {
  Staking: '/token',
  Governance: '/token/governance',
  Economy: '/token/economy',
  Burn: '/token/burn',
};

/**
 * `/token/burn` on the record-list template (J-more-catalogue-20 #3, J-dex-protocol-17 #9): recorded burned supply and
 * the settled buyback and burn runs log, with its job state and rate disclosure.
 */
export function TokenBurnRoom({ paper }: { paper: boolean }) {
  const routes = moreRoomRoutesCopy.useCopy();
  const burned = useTokenBurned();
  return (
    <RecordListTemplate
      title={routes.t('burn')}
      description={copyText('moreroutes.exact.stake.records.access.and.governance')}
      state={{ kind: 'ready' }}
      filters={
        <SectionTabs<TokenTab>
          items={[
            { value: 'Staking', label: copyText('token.staking') },
            { value: 'Governance', label: copyText('token.governance') },
            { value: 'Economy', label: copyText('token.economy') },
            { value: 'Burn', label: buybackRunsCopy.t('tab') },
          ]}
          value="Burn"
          onChange={(tab) => {
            if (tab !== 'Burn') navigate(preservePaperHref(SECTION_PATHS[tab], paper));
          }}
          label={copyText('token.token.sections')}
        />
      }
      summary={
        <Section title={copyText('token.recorded.burn')} className="lt-stack">
          <KitRead resource={burned.resource} retry={burned.reload}>
            {(b) => (
              <Details
                items={[
                  [copyText('token.burned.supply'), copyText('token.asset.identity.unavailable.2', { amount: displayAmount(b.burned) })],
                ]}
              />
            )}
          </KitRead>
        </Section>
      }
      list={<BuybackRuns />}
    />
  );
}
