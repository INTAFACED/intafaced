import { useResource } from '../../shared/resource';
import { defineCopy } from '../../shared/i18n';
import type { PersonalPayApi } from './pay-api';

const en = {
  localTest:
    'Payment details on this stack are sealed with a TEST key. Live ads need the owner’s instrument encryption provider, which is not connected.',
  none: 'New payment details and new ads need the owner’s instrument encryption provider, which is not connected.',
} as const;
const es = {
  localTest:
    'Los datos de pago de este entorno se sellan con una clave TEST. Los anuncios reales necesitan el proveedor de cifrado de instrumentos del propietario, que no está conectado.',
  none: 'Los nuevos datos de pago y los nuevos anuncios necesitan el proveedor de cifrado de instrumentos del propietario, que no está conectado.',
} satisfies Record<keyof typeof en, string>;
const fr = {
  localTest:
    'Sur cet environnement, les coordonnées de paiement sont scellées avec une clé TEST. Les annonces réelles nécessitent le fournisseur de chiffrement des instruments du propriétaire, qui n’est pas connecté.',
  none: 'Les nouvelles coordonnées de paiement et les nouvelles annonces nécessitent le fournisseur de chiffrement des instruments du propriétaire, qui n’est pas connecté.',
} satisfies Record<keyof typeof en, string>;
const blockerCopy = defineCopy('pay.p2p.blocker', en, { es, fr });

/**
 * The P2P rooms' registry blocker (`feature-registry.ts`, row `p2p`), named where the person sees it: svc-p2p has no
 * owner instrument encryption provider. On the test stack payment details are sealed with a TEST key; anywhere else new
 * details and ads refuse. Read from svc-p2p `health`, so the line follows the service, not a guess.
 */
export function P2PBlocker({ pay }: { pay: PersonalPayApi }) {
  const { Copy } = blockerCopy.useCopy();
  const health = useResource((signal) => pay.health(signal), 'pay:p2p-health');
  const data = health.resource.status === 'ready' ? health.resource.data : null;
  if (!data || data.instrumentKmsConfigured) return null;
  return (
    <p className="muted" role="note" data-testid="p2p-blocker">
      <Copy k={data.instrumentKeyProvider === 'local-test' ? 'localTest' : 'none'} />
    </p>
  );
}
