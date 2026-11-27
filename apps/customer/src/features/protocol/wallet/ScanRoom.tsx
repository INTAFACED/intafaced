// volt-room: /wallet/scan
import { FlowTemplate } from '@intafaced/ui/lit/templates';
import { ScanPanel } from './ScanPanel';
import { useWalletFrame } from './wallet-frame';

/** Scan (/wallet/scan) on the flow template, inside the wallet's sections. */
export function ScanRoom() {
  const frame = useWalletFrame('scan');
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
            <ScanPanel />
          </div>
        }
      />
    </div>
  );
}
