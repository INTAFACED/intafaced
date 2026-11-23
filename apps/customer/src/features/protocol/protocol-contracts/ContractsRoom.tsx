// volt-room: /protocol/contracts
import { RecordListTemplate } from '@intafaced/ui/lit/templates';
import { ContractsPanel } from '../NetworkPanels';
import { AssetLinkReview, VenueReadDocs } from '../venue/AssetLink';
import { Banner, useProtocolTab } from '../volt/frame';

/**
 * /protocol/contracts on the record-list template: the deployed contracts read from the service for the configured chain,
 * the lookup that opens any contract's page, the asset-link review and the venue's read docs, then the launch action with
 * its blocker. Nothing here is called audited.
 */
export function ContractsRoom() {
  const tab = useProtocolTab('protocol', 'contracts');
  const { t, chain, api } = tab.room;
  return (
    <div lang={tab.lang}>
      <RecordListTemplate
        title={tab.title}
        description={tab.description}
        state={{ kind: 'ready' }}
        filters={tab.sections}
        summary={<Banner />}
        list={
          <>
            <ContractsPanel chain={chain} t={t} />
            <AssetLinkReview api={api} t={t} />
            <VenueReadDocs api={api} t={t} />
            {tab.actions}
          </>
        }
      />
    </div>
  );
}
