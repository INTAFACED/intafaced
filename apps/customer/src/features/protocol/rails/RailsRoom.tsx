// volt-room: /protocol/rails
import { MonitorTemplate } from '@intafaced/ui/lit/templates';
import { Banner, useProtocolTab } from '../volt/frame';
import { Panel } from '../volt/parts';
import { BridgeRoutes } from './BridgeRoutes';

/**
 * /protocol/rails on the monitor template: where each rail stands (Base Sepolia on testnet, INTACHAIN approved to build and
 * not running, the bridge), the bridge's routes and the person's transfers, then the tab's actions, each disabled with its
 * first blocker. Custody stays on the one ledger; nothing here reads as INTACHAIN mainnet or audited.
 */
export function RailsRoom() {
  const tab = useProtocolTab('protocol', 'rails');
  const { t, transport } = tab.room;
  const rails = [
    [t('railBase'), t('railBaseState')],
    [t('railIntachain'), t('railIntachainState')],
    [t('railBridge'), t('railBridgeState')],
  ] as const;
  return (
    <div lang={tab.lang}>
      <MonitorTemplate
        title={tab.title}
        description={tab.description}
        state={{ kind: 'ready' }}
        figures={[]}
        panels={
          <>
            <Banner />
            {tab.sections}
            <Panel title={t('railsTitle')}>
              <p className="lt-hint">{t('railsNote')}</p>
              <dl className="lt-kv">
                {rails.map(([label, value]) => (
                  <div key={label}>
                    <dt>{label}</dt>
                    <dd>{value}</dd>
                  </div>
                ))}
              </dl>
            </Panel>
            <BridgeRoutes api={transport} t={t} />
            {tab.actions}
          </>
        }
      />
    </div>
  );
}
