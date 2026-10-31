import { defineCopy } from '../../shared/i18n';
const en = {
  scope: 'Listed questions, result sources and outcome instruments',
  questions: 'Listed questions',
  publishAction: 'Publishing a prediction market',
  publishWhy:
    'Who determines a result, from which sources, how long it can be challenged and how a dispute is settled is an owner decision that has not been made. Publishing a question needs it.',
  empty: 'No questions are listed',
  emptyBody: 'No questions are listed. This is not an account position or settlement record.',
  failedBody: 'A failed catalogue read does not establish that no questions are listed.',
  refresh: 'Refresh questions',
  closes: 'Closes',
  source: 'Result source',
  openEvent: 'Open event',
  review: 'Order review unavailable',
  reviewBody: 'An outcome-specific review and ledger-backed order path are required. This room cannot confirm or send an outcome order.',
  support: 'Contact Support →',
  requirements: 'Review requirements',
  unavailable: 'Unavailable',
  admission: 'Outcome admission',
  admissionBody: 'An outcome-specific preview and permission check are unavailable.',
  pricing: 'Fees and precision',
  pricingBody: 'Confirmed fees and price precision are unavailable.',
  placement: 'Order placement',
  placementBody: 'Ledger-backed outcome order placement is not connected. A listing or indicative book is not permission to order.',
  reviewBoundary:
    'A spot-order quote uses a different hold and cannot establish consent for an outcome order. Results and settlement require the published source and authorised settlement service.',
  planning: 'Collateral planning',
  quantityError: 'Enter a positive exact decimal quantity.',
  planningBody:
    'Calculate the published one-unit collateral rule for a positive contract quantity. Fees, admission and the final hold remain unavailable.',
  more: 'Explore More →',
} as const;
const es = {
  scope: 'Preguntas publicadas, fuentes de resultados e instrumentos de resultados',
  questions: 'Preguntas publicadas',
  publishAction: 'Publicar un mercado de predicción',
  publishWhy:
    'Quién determina un resultado, con qué fuentes, durante cuánto tiempo puede impugnarse y cómo se resuelve una disputa es una decisión del propietario que no se ha tomado. Publicar una pregunta la necesita.',
  empty: 'No hay preguntas publicadas',
  emptyBody: 'No hay preguntas listadas. Esto no es una posición de la cuenta ni un registro de liquidación.',
  failedBody: 'Un fallo al leer el catálogo no demuestra que no haya preguntas publicadas.',
  refresh: 'Actualizar las preguntas',
  closes: 'Cierre',
  source: 'Fuente del resultado',
  openEvent: 'Abrir evento',
  review: 'La revisión de órdenes no está disponible',
  reviewBody:
    'Se requieren una revisión específica del resultado y una vía de órdenes respaldada por el libro mayor. Esta sala no puede confirmar ni enviar una orden de resultados.',
  support: 'Contactar con Soporte →',
  requirements: 'Requisitos de revisión',
  unavailable: 'No disponible',
  admission: 'Admisión de resultados',
  admissionBody: 'No están disponibles una vista previa específica del resultado ni una comprobación de permisos.',
  pricing: 'Comisiones y precisión',
  pricingBody: 'Las comisiones confirmadas y la precisión de precios no están disponibles.',
  placement: 'Envío de órdenes',
  placementBody:
    'El envío de órdenes de resultados respaldado por el libro mayor no está conectado. Una publicación o un libro indicativo no autorizan una orden.',
  reviewBoundary:
    'Una cotización al contado usa una retención diferente y no permite confirmar una orden de resultados. Los resultados y la liquidación requieren la fuente publicada y el servicio de liquidación autorizado.',
  planning: 'Planificar garantías',
  quantityError: 'Introduce una cantidad decimal exacta positiva.',
  planningBody:
    'Calcula la regla publicada de garantía de una unidad para una cantidad positiva de contratos. Las comisiones, la admisión y la retención final siguen sin estar disponibles.',
  more: 'Explorar More →',
} satisfies Record<keyof typeof en, string>;
const fr = {
  scope: 'Questions publiées, sources des résultats et instruments de résultat',
  questions: 'Questions publiées',
  publishAction: 'Publier un marché de prédiction',
  publishWhy:
    'Qui détermine un résultat, à partir de quelles sources, pendant combien de temps il peut être contesté et comment un litige est réglé est une décision du propriétaire qui n’a pas été prise. La publication d’une question en a besoin.',
  empty: 'Aucune question n’est publiée',
  emptyBody: 'Aucune question n’est listée. Ce n’est ni une position du compte ni un enregistrement de règlement.',
  failedBody: 'Une lecture échouée du catalogue ne prouve pas qu’aucune question n’est publiée.',
  refresh: 'Actualiser les questions',
  closes: 'Clôture',
  source: 'Source du résultat',
  openEvent: 'Ouvrir l’événement',
  review: 'La revue des ordres est indisponible',
  reviewBody:
    'Une revue propre au résultat et une voie d’ordres adossée au grand livre sont requises. Cette salle ne peut pas confirmer ni envoyer d’ordre de résultat.',
  support: 'Contacter le support →',
  requirements: 'Exigences de revue',
  unavailable: 'Indisponible',
  admission: 'Admission des résultats',
  admissionBody: 'Un aperçu propre au résultat et une vérification des permissions sont indisponibles.',
  pricing: 'Frais et précision',
  pricingBody: 'Les frais confirmés et la précision des prix ne sont pas disponibles.',
  placement: 'Placement d’ordres',
  placementBody:
    'Le placement d’ordres de résultat adossé au grand livre n’est pas connecté. Une publication ou un carnet indicatif n’autorisent pas un ordre.',
  reviewBoundary:
    'Une cotation au comptant utilise une retenue différente et ne permet pas de consentir à un ordre de résultat. Les résultats et le règlement requièrent la source publiée et le service de règlement autorisé.',
  planning: 'Planifier la garantie',
  quantityError: 'Saisissez une quantité décimale exacte positive.',
  planningBody:
    'Calcule la règle publiée d’une unité de garantie pour une quantité positive de contrats. Les frais, l’admission et la retenue finale restent indisponibles.',
  more: 'Explorer More →',
} satisfies Record<keyof typeof en, string>;
export const predictionCatalogueCopy = defineCopy('more.prediction.catalogue', en, { es, fr });
