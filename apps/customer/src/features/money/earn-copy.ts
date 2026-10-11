import { defineCopy } from '../../shared/i18n';
const messages = {
  description: 'Your principal, maturity and configured pools. Accrued interest and complete position history are unavailable.',
  locked: 'Fixed-term principal cannot be withdrawn before maturity.',
  maturityMissing: 'Maturity is unavailable. Withdrawal remains unavailable until a valid maturity is returned.',
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
  unavailableHistory: 'This bounded list contains active positions only. Pending/closed history and earned interest are unavailable.',
  refresh: 'Refresh',
} as const;

const es = {
  description:
    'Tu capital, vencimiento y fondos configurados. Los intereses devengados y el historial completo de posiciones no están disponibles.',
  locked: 'El capital a plazo fijo no puede retirarse antes del vencimiento.',
  maturityMissing: 'El vencimiento no está disponible. El retiro seguirá sin estar disponible hasta que se devuelva un vencimiento válido.',
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
    'Esta lista limitada solo contiene posiciones activas. El historial de posiciones pendientes o cerradas y los intereses obtenidos no están disponibles.',
  refresh: 'Actualizar',
} as const;
const fr = {
  description:
    'Ton capital, l’échéance et les fonds configurés. Les intérêts courus et l’historique complet des positions sont indisponibles.',
  locked: 'Le capital à durée fixe ne peut pas être retiré avant l’échéance.',
  maturityMissing: 'L’échéance est indisponible. Le retrait reste indisponible jusqu’à ce qu’une échéance valide soit renvoyée.',
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
    'Cette liste limitée contient uniquement des positions actives. L’historique des positions en attente ou clôturées et les intérêts gagnés sont indisponibles.',
  refresh: 'Actualiser',
} as const;
export const earnCopy = defineCopy('customer.money.earn', messages, { es, fr });
