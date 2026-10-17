import { defineCopy } from '../../shared/i18n';
const en = {
  scope: 'Asset launch tasks and participation records',
  nav: 'Launch sections',
  overview: 'Launch overview',
  participation: 'My participation',
  launchUnavailable: 'Asset launches are unavailable',
  launchBody:
    'Issuance, a trading-market listing and sale participation need their own connected capabilities. This room cannot launch an asset or accept a sale order yet.',
  ordersUnavailable: 'Your launch orders are unavailable',
  ordersBody: 'Your participation records cannot be read in this room. Unavailable records do not mean you have no orders.',
  support: 'Contact Support',
  required: 'What this room needs',
  unavailable: 'Unavailable',
  issuance: 'Issuance',
  issuanceBody: 'Issuing an asset is unavailable. This room cannot start one.',
  listing: 'Trading-market listing',
  listingBody: 'A customer asset-listing request and its resulting trading-market record are unavailable.',
  sale: 'Sale participation',
  saleBody: 'Sale rounds, published terms, admission and subscription outcomes are unavailable.',
  history: 'Your participation',
  historyBody: 'Your order history and allocation results are unavailable. No order count or position is guessed.',
  historyLink: 'View launch participation →',
  returnTitle: 'Return to Launch',
  returnBody: 'Review the separate issuance, listing and sale requirements. No unsupported order action is sent.',
  returnLink: 'View required launch capabilities →',
  market: 'Sell a service or strategy access',
  marketBody: 'Market has its own seller catalogue. These listings do not issue an asset, create a trading market or open a sale round.',
  marketLink: 'Market service listings →',
  details: 'Availability details',
  detailsBody:
    'The issuance template has not been audited, and a successful build is not an audit or permission to launch. Issuance is on hold. This room starts nothing on any chain.',
} as const;
const es = {
  scope: 'Tareas de lanzamiento de activos y registros de participación',
  nav: 'Secciones de Launch',
  overview: 'Resumen de Launch',
  participation: 'Mi participación',
  launchUnavailable: 'Los lanzamientos de activos no están disponibles',
  launchBody:
    'La emisión, el listado en un mercado de negociación y la participación en ventas requieren sus propias funciones conectadas. Esta sala aún no puede lanzar un activo ni aceptar una orden de venta.',
  ordersUnavailable: 'Tus órdenes de lanzamiento no están disponibles',
  ordersBody: 'Esta sala no puede leer tus registros de participación. Que no estén disponibles no significa que no tengas órdenes.',
  support: 'Contactar con Soporte',
  required: 'Lo que necesita esta sala',
  unavailable: 'No disponible',
  issuance: 'Emisión',
  issuanceBody: 'La emisión de activos no está disponible. Esta sala no puede iniciar ninguna.',
  listing: 'Listado para negociación',
  listingBody: 'No están disponibles una solicitud de listado de activos por parte del cliente ni su registro de mercado resultante.',
  sale: 'Participación en ventas',
  saleBody: 'Las rondas de venta, las condiciones publicadas, la admisión y los resultados de suscripción no están disponibles.',
  history: 'Tu participación',
  historyBody:
    'El historial de órdenes y los resultados de asignación de tu cuenta no están disponibles. No se adivina ningún número de órdenes ni posición.',
  historyLink: 'Ver participación en lanzamientos →',
  returnTitle: 'Volver a Launch',
  returnBody: 'Revisa los requisitos independientes de emisión, listado y venta. No se envía ninguna acción de orden no admitida.',
  returnLink: 'Ver funciones de lanzamiento necesarias →',
  market: 'Vender un servicio o acceso a estrategias',
  marketBody:
    'Market tiene su propio catálogo de vendedores. Estos listados no emiten activos, crean mercados de negociación ni abren rondas de venta.',
  marketLink: 'Listados de servicios de Market →',
  details: 'Detalles de disponibilidad',
  detailsBody:
    'La plantilla de emisión no ha sido auditada, y una compilación correcta no es una auditoría ni un permiso de lanzamiento. La emisión está en pausa. Esta sala no inicia nada en ninguna cadena.',
} satisfies Record<keyof typeof en, string>;
const fr = {
  scope: 'Tâches de lancement d’actifs et dossiers de participation',
  nav: 'Sections de Launch',
  overview: 'Aperçu de Launch',
  participation: 'Ma participation',
  launchUnavailable: 'Les lancements d’actifs sont indisponibles',
  launchBody:
    'L’émission, la cotation sur un marché de négociation et la participation aux ventes nécessitent leurs propres fonctions connectées. Cette salle ne peut pas encore lancer un actif ni accepter un ordre de vente.',
  ordersUnavailable: 'Tes ordres de lancement sont indisponibles',
  ordersBody:
    'Tes dossiers de participation ne peuvent pas être consultés dans cette salle. Leur indisponibilité ne signifie pas que tu n’as aucun ordre.',
  support: 'Contacter le support',
  required: 'Ce dont cette salle a besoin',
  unavailable: 'Indisponible',
  issuance: 'Émission',
  issuanceBody: 'L’émission d’actifs est indisponible. Cette salle ne peut pas en lancer.',
  listing: 'Cotation pour négociation',
  listingBody: 'Une demande de cotation d’actif par le client et le dossier de marché résultant sont indisponibles.',
  sale: 'Participation aux ventes',
  saleBody: 'Les tours de vente, les conditions publiées, l’admission et les résultats de souscription sont indisponibles.',
  history: 'Ta participation',
  historyBody:
    'L’historique des ordres de ton compte et les résultats d’allocation sont indisponibles. Aucun nombre d’ordres ni position n’est deviné.',
  historyLink: 'Voir la participation aux lancements →',
  returnTitle: 'Retour à Launch',
  returnBody:
    'Consulte les exigences distinctes d’émission, de cotation et de vente. Aucune action d’ordre non prise en charge n’est envoyée.',
  returnLink: 'Voir les fonctions de lancement requises →',
  market: 'Vendre un service ou l’accès à des stratégies',
  marketBody:
    'Market possède son propre catalogue de vendeurs. Ces offres n’émettent pas d’actif, ne créent pas de marché de négociation et n’ouvrent pas de tour de vente.',
  marketLink: 'Offres de services de Market →',
  details: 'Détails de disponibilité',
  detailsBody:
    'Le modèle d’émission n’a pas été audité, et une compilation réussie n’est ni un audit ni une autorisation de lancement. L’émission est en pause. Cette salle ne lance rien sur aucune chaîne.',
} satisfies Record<keyof typeof en, string>;
export const launchCopy = defineCopy('more.launch.availability', en, { es, fr });
