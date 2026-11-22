// volt-room: /wallet/session-keys
import { RecordListTemplate } from '@intafaced/ui/lit/templates';
import { SessionKeysPanel } from './SessionKeysPanel';
import { useWalletFrame } from './wallet-frame';

/** Session keys (/wallet/session-keys), on the record-list template inside the wallet's sections. */
export function SessionKeysRoom() {
  const frame = useWalletFrame('sessionKeys');
  return (
    <div lang={frame.lang} data-route="wallet">
      <RecordListTemplate
        title={frame.title}
        description={frame.description}
        state={{ kind: 'ready' }}
        filters={frame.sections}
        summary={frame.banner}
        list={<SessionKeysPanel />}
      />
    </div>
  );
}
