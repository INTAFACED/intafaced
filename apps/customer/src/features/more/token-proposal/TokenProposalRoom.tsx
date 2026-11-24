// volt-room: /token/governance/:proposalId
import { ReadingTemplate } from '@intafaced/ui/lit/templates';
import { copy } from '../copy';
import { moreRoomRoutesCopy } from '../more-room-routes-copy';
import { preservePaperHref } from '../trade-context';

/**
 * /token/governance/:proposalId, one governance proposal, on the reading template. No read for a proposal is wired to
 * this page, so it says so and links back to the Token room; an id that is not an id this room uses is refused before
 * anything is looked up.
 */
export function TokenProposalRoom({ invalid, paper }: { invalid: boolean; paper: boolean }) {
  const { t } = moreRoomRoutesCopy.useCopy();
  const more = copy.useCopy();
  return (
    <div data-room="token-proposal">
      <ReadingTemplate
        title={t('proposal')}
        description={more.t('moreroutes.exact.stake.records.access.and.governance')}
        state={{
          kind: 'empty',
          title: t(invalid ? 'badIdTitle' : 'detailTitle'),
          body: t(invalid ? 'badIdBody' : 'detailBody'),
          action: { label: t('open'), href: preservePaperHref('/token', paper) },
        }}
        body={null}
      />
    </div>
  );
}
