// volt-room: /wallet/activity
import { RecordListTemplate } from '@intafaced/ui/lit/templates';
import { ActivityPanel } from './ActivityPanel';
import { useWalletFrame } from './wallet-frame';

/** The wallet's activity (/wallet/activity), on the record-list template inside the wallet's sections. */
export function ActivityRoom() {
  const frame = useWalletFrame('activity');
  return (
    <div lang={frame.lang} data-route="wallet">
      <RecordListTemplate
        title={frame.title}
        description={frame.description}
        state={{ kind: 'ready' }}
        filters={frame.sections}
        summary={frame.banner}
        list={<ActivityPanel />}
      />
    </div>
  );
}
