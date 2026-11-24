// volt-room: /wallet/send
import { FlowTemplate } from '@intafaced/ui/lit/templates';
import { ConnectPanel } from './ConnectPanel';
import { SendPanel } from './SendPanel';
import { useWalletFrame } from './wallet-frame';

/** Send (/wallet/send) on the flow template, inside the wallet's sections: a link that opens Send filled in may land here before a wallet is connected. */
export function SendRoom() {
  const frame = useWalletFrame('send');
  const query = new URLSearchParams(typeof window === 'undefined' ? '' : window.location.search);
  return (
    <div lang={frame.lang} data-route="wallet">
      <FlowTemplate
        title={frame.title}
        description={frame.description}
        state={{ kind: 'ready' }}
        section={frame.sections}
        step={
          <div className="lt-stack">
            {frame.banner}
            <SendPanel to={query.get('to') ?? ''} token={query.get('token') ?? ''} />
          </div>
        }
        summary={<ConnectPanel />}
      />
    </div>
  );
}
