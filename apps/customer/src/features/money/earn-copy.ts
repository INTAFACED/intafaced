import { defineCopy } from '../../shared/i18n';
const messages = {
  description: 'Your principal, maturity and configured pools. Accrued interest and complete position history are unavailable.',
  locked: 'Fixed-term principal cannot be withdrawn before maturity.',
  maturityMissing: 'Maturity date unavailable. Withdrawal stays unavailable until a valid date is shown.',
  noFixed: 'No fixed maturity supplied',
  position: 'Position reference',
  readFailed: 'Current {subject} could not be checked. No request was sent. Close this review and refresh before trying again.',
  subjectPosition: 'owned position and maturity',
  subjectPool: 'configured pool terms',
  subjectPolicy: 'automation configuration',
  changed: 'The reviewed position, pool or configuration has changed. No request was sent. Close this review and refresh.',
  thresholdHint: 'Keep this exact positive quantity in your main account. This instruction reserves no funds.',
  keepAvailable: 'Keep available',
  withdrawalOutcome:
    'A confirmed response is required. An unknown withdrawal remains guarded; refreshing positions cannot establish its outcome.',
  automationDisabled: 'Automated deposits are disabled by current Bank configuration. Existing instructions remain available below.',
  unavailableHistory: 'This list shows active positions only. Pending and closed positions and earned interest aren’t available here.',
  refresh: 'Refresh',
  stakingOnPool: 'This pool is staking-style: taking it back starts unbonding, so it is done on the pool’s own page.',
  unbondingOnPool: 'Unbonding: it comes back to your main balance on {date}. The pool’s own page shows where it stands.',
  openPool: 'Open the pool',
} as const;

const es = {
  description:
    'Tu capital, vencimiento y fondos configurados. Los intereses devengados y el historial completo de posiciones no están disponibles.',
  locked: 'El capital a plazo fijo no puede retirarse antes del vencimiento.',
  maturityMissing: 'Fecha de vencimiento no disponible. El retiro sigue sin estar disponible hasta que se muestre una fecha válida.',
  noFixed: 'No se ha proporcionado vencimiento fijo',
  position: 'Referencia de la posición',
  readFailed:
    'No se pudo comprobar el estado actual de {subject}. No se ha enviado ninguna solicitud. Cierra esta revisión y actualiza antes de volver a intentarlo.',
  subjectPosition: 'posición de tu titularidad y su vencimiento',
  subjectPool: 'condiciones del fondo configurado',
  subjectPolicy: 'configuración de automatización',
  changed:
    'La posición, el fondo o la configuración revisados han cambiado. No se ha enviado ninguna solicitud. Cierra esta revisión y actualiza.',
  thresholdHint: 'Conserva esta cantidad positiva exacta en tu cuenta principal. Esta instrucción no reserva fondos.',
  keepAvailable: 'Mantener disponible',
  withdrawalOutcome:
    'Se requiere una respuesta confirmada. Un retiro de resultado desconocido sigue protegido; actualizar las posiciones no permite determinar su resultado.',
  automationDisabled:
    'La configuración bancaria actual desactiva los depósitos automáticos. Las instrucciones existentes siguen disponibles abajo.',
  unavailableHistory:
    'Esta lista solo muestra posiciones activas. Las posiciones pendientes y cerradas y los intereses ganados no están disponibles aquí.',
  refresh: 'Actualizar',
  stakingOnPool: 'Este fondo es tipo staking: retirarlo inicia la desvinculación, así que se hace en la página del fondo.',
  unbondingOnPool: 'Desvinculando: vuelve a tu saldo principal el {date}. La página del fondo muestra en qué punto está.',
  openPool: 'Abrir el fondo',
} as const;
const fr = {
  description:
    'Ton capital, l’échéance et les fonds configurés. Les intérêts courus et l’historique complet des positions sont indisponibles.',
  locked: 'Le capital à durée fixe ne peut pas être retiré avant l’échéance.',
  maturityMissing: 'Date d’échéance indisponible. Le retrait reste indisponible tant qu’une date valide n’est pas affichée.',
  noFixed: 'Aucune échéance fixe fournie',
  position: 'Référence de la position',
  readFailed:
    'Vérification actuelle impossible : {subject}. Aucune demande n’a été envoyée. Ferme cette vérification et actualise avant de réessayer.',
  subjectPosition: 'position qui t’appartient et son échéance',
  subjectPool: 'conditions du fonds configuré',
  subjectPolicy: 'configuration d’automatisation',
  changed:
    'La position, le fonds ou la configuration vérifiés ont changé. Aucune demande n’a été envoyée. Ferme cette vérification et actualise.',
  thresholdHint: 'Conserve cette quantité positive exacte dans ton compte principal. Cette instruction ne réserve aucun fonds.',
  keepAvailable: 'Garder disponible',
  withdrawalOutcome:
    'Une réponse confirmée est requise. Un retrait dont le résultat est inconnu reste protégé ; actualiser les positions ne permet pas d’établir son résultat.',
  automationDisabled:
    'La configuration bancaire actuelle désactive les dépôts automatiques. Les instructions existantes restent disponibles ci-dessous.',
  unavailableHistory:
    'Cette liste ne montre que les positions actives. Les positions en attente ou clôturées et les intérêts gagnés ne sont pas disponibles ici.',
  refresh: 'Actualiser',
  stakingOnPool: 'Ce fonds est de type staking : reprendre lance le déblocage, cela se fait donc sur la page du fonds.',
  unbondingOnPool: 'En déblocage : revient sur ton solde principal le {date}. La page du fonds montre où elle en est.',
  openPool: 'Ouvrir le fonds',
} as const;
export const earnCopy = defineCopy('customer.money.earn', messages, { es, fr });
