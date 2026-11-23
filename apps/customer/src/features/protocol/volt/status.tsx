import { chainReasonWords, networkLabel } from '../blockers';
import type { protocolCopy } from '../copy';
import { Answer, flag, orNone, Rows } from './answer';
import type { useProtocolTab } from './frame';
import { Panel } from './parts';

type Translate = ReturnType<typeof protocolCopy.forLocale>['t'];
type Reads = ReturnType<typeof useProtocolTab>['reads'];

/**
 * The chain's status as svc-protocol answers it, drawn only from the Volt kit, for /chain and /protocol: the network it is
 * configured for, what it observes and whether the suite is deployed. Base is named as Base, never INTACHAIN mainnet.
 */
export function ChainStatusPanel({ chain, t }: { chain: Reads['chain']; t: Translate }) {
  const label =
    chain.resource.status === 'loading'
      ? { name: t('networkChecking'), note: '' }
      : networkLabel(chain.resource.status === 'ready' ? chain.resource.data.configuredChainId : null);
  return (
    <Panel title={t('tab_status')}>
      <Answer value={chain} source={t('src_chain')} t={t} shell={{ label: t('tab_status'), headers: [t('hdr_check'), t('hdr_result')] }}>
        {(c) => (
          <Rows
            t={t}
            rows={[
              [t('network'), label.name],
              [t('networkNote'), label.note],
              [t('configuredChain'), c.configuredChainId],
              [t('observedChain'), orNone(t, c.observedChainId)],
              [t('reachable'), flag(t, c.reachable)],
              [t('latestBlock'), orNone(t, c.blockNumber)],
              [t('suiteDeployed'), flag(t, c.suiteDeployed)],
              [t('tokenFactoryDeployed'), flag(t, c.tokenFactoryDeployed)],
              [t('usable'), flag(t, c.usable)],
              [t('launchUsable'), flag(t, c.launchUsable)],
              ...(c.refusalCode || c.reason ? ([[t('refusalReason'), chainReasonWords(c.refusalCode)]] as const) : []),
            ]}
          />
        )}
      </Answer>
    </Panel>
  );
}
