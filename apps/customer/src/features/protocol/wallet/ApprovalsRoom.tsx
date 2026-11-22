// volt-room: /wallet/approvals
import { RecordListTemplate } from '@intafaced/ui/lit/templates';
import { ApprovalsPanel } from './ApprovalsPanel';
import { PermitForm } from './PermitForm';
import { useWalletFrame } from './wallet-frame';

/** Token approvals and permits (/wallet/approvals), on the record-list template inside the wallet's sections. */
export function ApprovalsRoom() {
  const frame = useWalletFrame('approvals');
  return (
    <div lang={frame.lang} data-route="wallet">
      <RecordListTemplate
        title={frame.title}
        description={frame.description}
        state={{ kind: 'ready' }}
        filters={frame.sections}
        summary={frame.banner}
        list={
          <>
            <ApprovalsPanel />
            <PermitForm />
          </>
        }
      />
    </div>
  );
}
