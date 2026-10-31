import { NOT_CONNECTED_CODES, ServiceOffNotice as KitServiceOffNotice, type NotConnectedCode } from '@intafaced/ui/lit/templates';
import { defineCopy } from './i18n';
import './service-off.css';

// The allowlist codes and the notice itself live in the kit (`@intafaced/ui/lit/templates`); this file holds its copy and fills the sentence in.
export { NOT_CONNECTED_CODES, type NotConnectedCode };

// The copy rule on the allowlist: name the outside dependency and state the present fact, never a promise.
export const serviceOffCopy = defineCopy(
  'service-off',
  {
    sentence: '{action} needs {dependency}. It is switched off in this build.',
    'rail.bank': 'a banking partner',
    'rail.card': 'a card issuer',
    'rail.crypto': 'a live network node or custody signer',
    'vendor.kyc': 'an identity verification provider',
    'vendor.aml': 'a sanctions screening provider',
    'feed.market': 'a live market data feed',
    'chain.go': 'the INTACHAIN launch go-ahead',
    hardware: 'physical hardware or a courier',
    licence: 'a licence INTAFACED does not hold',
    'owner.decision': 'an owner decision',
    'audit.external': 'an external security audit',
    'vendor.sms': 'an SMS delivery provider',
    'vendor.email': 'an email delivery provider',
    'vendor.tax': 'a tax calculation provider',
    'vendor.travelrule': 'a Travel Rule network',
    'vendor.cloud': 'a cloud provider account',
    'vendor.accounting': 'an accounting software connection',
    'feed.news': 'a news data feed',
    'idp.social': 'an outside sign-in provider',
    'vendor.push': 'a push delivery gateway',
  },
  {
    es: {
      sentence: '{action} necesita {dependency}. Está desactivado en esta versión.',
      'rail.bank': 'un socio bancario',
      'rail.card': 'un emisor de tarjetas',
      'rail.crypto': 'un nodo de red en vivo o un firmante de custodia',
      'vendor.kyc': 'un proveedor de verificación de identidad',
      'vendor.aml': 'un proveedor de control de sanciones',
      'feed.market': 'una fuente de datos de mercado en vivo',
      'chain.go': 'la autorización de lanzamiento de INTACHAIN',
      hardware: 'hardware físico o un servicio de mensajería',
      licence: 'una licencia que INTAFACED no tiene',
      'owner.decision': 'una decisión del propietario',
      'audit.external': 'una auditoría de seguridad externa',
      'vendor.sms': 'un proveedor de envío de SMS',
      'vendor.email': 'un proveedor de envío de correo electrónico',
      'vendor.tax': 'un proveedor de cálculo de impuestos',
      'vendor.travelrule': 'una red de la Travel Rule',
      'vendor.cloud': 'una cuenta de proveedor en la nube',
      'vendor.accounting': 'una conexión con un programa de contabilidad',
      'feed.news': 'una fuente de noticias',
      'idp.social': 'un proveedor de inicio de sesión externo',
      'vendor.push': 'una pasarela de notificaciones push',
    },
    fr: {
      sentence: '{action} nécessite {dependency}. C’est désactivé dans cette version.',
      'rail.bank': 'un partenaire bancaire',
      'rail.card': 'un émetteur de cartes',
      'rail.crypto': 'un nœud réseau actif ou un signataire de conservation',
      'vendor.kyc': 'un prestataire de vérification d’identité',
      'vendor.aml': 'un prestataire de filtrage des sanctions',
      'feed.market': 'un flux de données de marché en direct',
      'chain.go': 'le feu vert de lancement d’INTACHAIN',
      hardware: 'du matériel physique ou un transporteur',
      licence: 'une licence qu’INTAFACED ne détient pas',
      'owner.decision': 'une décision du propriétaire',
      'audit.external': 'un audit de sécurité externe',
      'vendor.sms': 'un prestataire d’envoi de SMS',
      'vendor.email': 'un prestataire d’envoi d’e-mails',
      'vendor.tax': 'un prestataire de calcul des taxes',
      'vendor.travelrule': 'un réseau Travel Rule',
      'vendor.cloud': 'un compte chez un fournisseur cloud',
      'vendor.accounting': 'une connexion à un logiciel de comptabilité',
      'feed.news': 'un flux d’actualités',
      'idp.social': 'un fournisseur de connexion externe',
      'vendor.push': 'une passerelle de notifications push',
    },
  },
);

/**
 * The one service-off notice of the shell (HM-shell-03), drawn by the kit's template state: "<Action> needs <dependency>. It is switched off in this build.", with
 * the allowlist code in the page and in `data-not-connected` for the proof crawler. `action` is the caller's own words for what
 * was pressed, already in the reader's language ("Registering this device", "Stake").
 */
export function ServiceOffNotice({
  code,
  action,
  className,
  role,
}: {
  code: NotConnectedCode;
  action: string;
  className?: string;
  /** `note` where the notice is the reason beside a disabled control, as the room's other reasons are. */
  role?: 'note' | 'status';
}) {
  const { t } = serviceOffCopy.useCopy();
  return <KitServiceOffNotice code={code} sentence={t('sentence', { action, dependency: t(code) })} className={className} role={role} />;
}
