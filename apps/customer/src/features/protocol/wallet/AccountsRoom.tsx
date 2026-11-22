// volt-room: /wallet/accounts
import { RecordListTemplate } from '@intafaced/ui/lit/templates';
import { AccountsPanel } from './AccountsPanel';
import { useWalletFrame } from './wallet-frame';

/** The wallet's accounts (/wallet/accounts), on the record-list template inside the wallet's sections. */
export function AccountsRoom() {
  const frame = useWalletFrame('accounts');
  return (
    <div lang={frame.lang} data-route="wallet">
      <RecordListTemplate
        title={frame.title}
        description={frame.description}
        state={{ kind: 'ready' }}
        filters={frame.sections}
        summary={frame.banner}
        list={<AccountsPanel />}
      />
    </div>
  );
}
