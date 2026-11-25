// volt-room: /wallet/claim-links
import { RecordListTemplate } from '@intafaced/ui/lit/templates';
import { ClaimLinksPanel } from './ClaimLinksPanel';
import { useWalletFrame } from './wallet-frame';

/** Send by link (/wallet/claim-links): a new link and the person's own links, on the record-list template inside the wallet's sections. */
export function ClaimLinksRoom() {
  const frame = useWalletFrame('claimLinks');
  return (
    <div lang={frame.lang} data-route="wallet">
      <RecordListTemplate
        title={frame.title}
        description={frame.description}
        state={{ kind: 'ready' }}
        filters={frame.sections}
        summary={frame.banner}
        list={<ClaimLinksPanel />}
      />
    </div>
  );
}
