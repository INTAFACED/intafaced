import { RecordListTemplate } from '@intafaced/ui/lit/templates';
import { AddressBookPanel } from './AddressBookPanel';
import { useWalletFrame } from './wallet-frame';

/** The address book (/wallet/address-book), on the record-list template inside the wallet's sections. */
export function AddressBookRoom() {
  const frame = useWalletFrame('addressBook');
  return (
    <div lang={frame.lang} data-route="wallet">
      <RecordListTemplate
        title={frame.title}
        description={frame.description}
        state={{ kind: 'ready' }}
        filters={frame.sections}
        summary={frame.banner}
        list={<AddressBookPanel />}
      />
    </div>
  );
}
