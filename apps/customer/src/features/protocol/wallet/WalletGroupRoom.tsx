import { RecordListTemplate } from '@intafaced/ui/lit/templates';
import { WalletGroupPanel } from './WalletGroupPanel';
import { useWalletFrame } from './wallet-frame';

/** One wallet group's page under the address book (/wallet/groups/:groupId), on the record-list template inside the wallet's sections. */
export function WalletGroupRoom({ groupId }: { groupId: string }) {
  const frame = useWalletFrame('addressBook');
  return (
    <div lang={frame.lang} data-route="wallet">
      <RecordListTemplate
        title={frame.title}
        description={frame.description}
        state={{ kind: 'ready' }}
        filters={frame.sections}
        summary={frame.banner}
        list={<WalletGroupPanel groupId={groupId} />}
      />
    </div>
  );
}
