import { defineCopy } from '../../shared/i18n';

const en = {
  title: 'Refund payment',
  review: 'Review refund',
  reviewBody: 'Return this amount to the customer the way they paid.',
  amount: 'Refund amount ({asset})',
  reviewAmount: 'Refund amount',
  payment: 'Payment',
  reference: 'Refund reference',
  details: 'Details',
  unavailable: 'Unavailable on this device',
  reviewAction: 'Review refund',
  confirm: 'Confirm refund',
  edit: 'Edit amount',
  back: 'Back to payment',
  continuity: 'Keep this refund’s reference',
  continuityBody: 'If we don’t get an answer, check what happened before starting another refund.',
  unknown: 'Refund outcome unknown',
  unknownBody: 'We didn’t get a clear answer. Check what happened before you send another refund.',
  check: 'Check original refund',
  noMatch: 'No sign of this refund yet',
  historyWindow: 'We checked the first {count} recorded updates (oldest first). A later refund may be beyond this window.',
  historyAll: 'We checked all {count} recorded updates on this payment.',
  noProof: 'This does not confirm or cancel the refund.',
  paused: 'New refunds stay paused until this one is sorted out.',
  recorded: 'Refund recorded',
  recordedBody: 'The payment’s history shows this refund.',
  reversed: 'Refund reversed',
  reversedBody: 'The payment method didn’t accept this refund, so it was reversed.',
  matched: 'Found in the payment’s history',
  cleanup: 'A saved note is still on this device',
  cleanupBody: 'The refund is recorded, but this device couldn’t clear its saved note. New refunds stay paused.',
  cleanupAction: 'Clear the saved note',
  cleanupOnly: 'This only clears the note. It won’t refund again.',
  newReview: 'Review a new refund',
  spent: 'A new attempt starts with a new review',
  spentBody: 'This refund is closed. A new refund needs a new review.',
  unreadable: 'Can’t read the saved refund note',
  unreadableBody: 'New refunds are paused until this device can read its saved note.',
  noSend: 'No refund can be sent',
  retry: 'Retry recovery check',
  retryBody: 'Check again. This won’t send a refund or replace the saved note.',
  conflict: 'The saved notes disagree, so both are kept. New refunds stay paused.',
  legacy: 'A refund was started here before, but we can’t tell how it ended.',
  busy: 'Another tab is checking this refund. Try again when it finishes.',
  invalidAmount: 'Enter an amount above zero that is no more than what can still be refunded.',
  checking: 'Checking the original refund…',
  loading: 'Reading the captured payment…',
  readRetry: 'Retry payment read',
  readFailed: 'This didn’t go through. Check the payment and try again.',
  notConfirmed: 'We couldn’t confirm this refund yet. Nothing new will be sent. Check again.',
  permissionMissing: 'This account can’t refund payments. Ask an owner or admin to give it the refund permission.',
  merchantInactive: 'Refunds are on hold until this business is active and verified. Contact support if this looks wrong.',
  noCaptured: 'No captured amount is available to refund.',
  unavailableBody: 'We couldn’t verify the refund. Try the check again.',
  contextChanged: 'The account or review changed. Review the current payment again.',
  failed: 'The original refund has not been confirmed.',
  stepRequired: "Confirm it's you with a passkey or authenticator code.",
  stepExpired: 'That confirmation expired. Confirm again.',
} as const;
const es: Record<keyof typeof en, string> = {
  title: 'Reembolsar pago',
  review: 'Revisar reembolso',
  reviewBody: 'Devuelve el importe capturado revisado por su vía original.',
  amount: 'Importe del reembolso ({asset})',
  reviewAmount: 'Importe del reembolso',
  payment: 'Pago',
  reference: 'Referencia original del reembolso',
  details: 'Detalles',
  unavailable: 'No disponible en este dispositivo',
  reviewAction: 'Revisar reembolso',
  confirm: 'Confirmar reembolso',
  edit: 'Editar importe',
  back: 'Volver al pago',
  continuity: 'Conserva esta referencia original',
  continuityBody: 'Si se pierde la respuesta, comprueba el resultado registrado antes de iniciar otro reembolso.',
  unknown: 'Resultado del reembolso desconocido',
  unknownBody: 'Conserva la referencia original mientras compruebas su resultado registrado.',
  check: 'Comprobar reembolso original',
  noMatch: 'Ningún resultado coincidente',
  historyWindow:
    'Se revisaron las primeras {count} novedades registradas (las más antiguas primero). Un reembolso posterior puede quedar fuera de esta ventana.',
  historyAll: 'Se revisaron las {count} novedades registradas de este pago.',
  noProof: 'Esto no confirma ni cancela el reembolso.',
  paused: 'Los nuevos reembolsos siguen pausados mientras este original esté sin resolver.',
  recorded: 'Reembolso registrado',
  recordedBody: 'El historial del pago confirma este reembolso original.',
  reversed: 'Reembolso revertido',
  reversedBody: 'La vía rechazó este reembolso original. El servicio registró su reversión.',
  matched: 'Evento coincidente del historial',
  cleanup: 'Registro local de recuperación conservado',
  cleanupBody:
    'El resultado está registrado, pero este dispositivo no pudo borrar su registro de recuperación. Los nuevos reembolsos siguen pausados.',
  cleanupAction: 'Reintentar limpieza local',
  cleanupOnly: 'Solo borra la referencia guardada. No vuelve a reembolsar.',
  newReview: 'Revisar un nuevo reembolso',
  spent: 'Un nuevo intento empieza con una nueva revisión',
  spentBody: 'No vuelvas a enviar esta referencia. Un nuevo intento necesita una nueva revisión y referencia.',
  unreadable: 'No se puede leer el reembolso guardado',
  unreadableBody: 'Los nuevos reembolsos están pausados hasta que este dispositivo pueda verificar su registro de recuperación.',
  noSend: 'No se puede enviar ningún reembolso',
  retry: 'Reintentar comprobación de recuperación',
  retryBody: 'Reintenta la comprobación local. No enviará un reembolso ni reemplazará el registro guardado.',
  conflict: 'Los registros de recuperación no coinciden. Se conservan ambos originales y los nuevos reembolsos siguen pausados.',
  legacy: 'Esta acción guardada no tiene referencia original de reembolso. Su resultado no se puede identificar ni reconstruir.',
  busy: 'Otra pestaña está comprobando este original. Conserva la referencia y reintenta cuando termine.',
  invalidAmount: 'Introduce un importe positivo exacto que no supere el importe capturado disponible para reembolso.',
  checking: 'Comprobando el reembolso original…',
  loading: 'Leyendo el pago capturado…',
  readRetry: 'Reintentar lectura del pago',
  readFailed: 'No se ha completado. Revisa el pago e inténtalo de nuevo.',
  notConfirmed: 'Todavía no se pudo confirmar este reembolso. No se enviará nada nuevo. Vuelve a comprobarlo.',
  permissionMissing: 'Esta cuenta no puede reembolsar pagos. Pide a un propietario o administrador el permiso de reembolso.',
  merchantInactive:
    'Los reembolsos están en pausa hasta que este negocio esté activo y verificado. Contacta con soporte si parece un error.',
  noCaptured: 'No hay importe capturado disponible para reembolso.',
  unavailableBody:
    'No se pudo verificar el reembolso original. Conserva su referencia y reintenta la comprobación protegida del historial.',
  contextChanged: 'La cuenta o la revisión cambió. Revisa de nuevo el pago actual.',
  failed: 'El reembolso original no se ha confirmado.',
  stepRequired: 'Confirma que eres tú con una clave de acceso o un código del autenticador.',
  stepExpired: 'Esa confirmación caducó. Vuelve a confirmar.',
};
const fr: Record<keyof typeof en, string> = {
  title: 'Rembourser le paiement',
  review: 'Vérifier le remboursement',
  reviewBody: 'Restituez le montant capturé vérifié par sa voie originale.',
  amount: 'Montant du remboursement ({asset})',
  reviewAmount: 'Montant du remboursement',
  payment: 'Paiement',
  reference: 'Référence originale du remboursement',
  details: 'Détails',
  unavailable: 'Indisponible sur cet appareil',
  reviewAction: 'Vérifier le remboursement',
  confirm: 'Confirmer le remboursement',
  edit: 'Modifier le montant',
  back: 'Retour au paiement',
  continuity: 'Conservez cette référence originale',
  continuityBody: 'Si la réponse est perdue, vérifiez le résultat enregistré avant de commencer un autre remboursement.',
  unknown: 'Résultat du remboursement inconnu',
  unknownBody: 'Conservez la référence originale pendant la vérification du résultat enregistré.',
  check: 'Vérifier le remboursement original',
  noMatch: 'Aucun résultat correspondant',
  historyWindow:
    'Nous avons examiné les {count} premières mises à jour enregistrées (les plus anciennes d’abord). Un remboursement plus récent peut être hors de cette fenêtre.',
  historyAll: 'Nous avons examiné les {count} mises à jour enregistrées de ce paiement.',
  noProof: 'Cela ne confirme ni n’annule le remboursement.',
  paused: 'Les nouveaux remboursements restent suspendus tant que cet original n’est pas résolu.',
  recorded: 'Remboursement enregistré',
  recordedBody: 'L’historique du paiement confirme ce remboursement original.',
  reversed: 'Remboursement annulé',
  reversedBody: 'La voie a refusé ce remboursement original. Le service a enregistré son annulation.',
  matched: 'Événement correspondant de l’historique',
  cleanup: 'Enregistrement local de récupération conservé',
  cleanupBody:
    'Le résultat est enregistré, mais cet appareil n’a pas pu effacer son enregistrement de récupération. Les nouveaux remboursements restent suspendus.',
  cleanupAction: 'Réessayer le nettoyage local',
  cleanupOnly: 'Cela efface uniquement la référence sauvegardée. Aucun nouveau remboursement ne sera envoyé.',
  newReview: 'Vérifier un nouveau remboursement',
  spent: 'Une nouvelle tentative commence par une nouvelle vérification',
  spentBody: 'Ne renvoyez pas cette référence. Une nouvelle tentative exige une nouvelle vérification et une nouvelle référence.',
  unreadable: 'Impossible de lire le remboursement sauvegardé',
  unreadableBody:
    'Les nouveaux remboursements sont suspendus jusqu’à ce que cet appareil puisse vérifier son enregistrement de récupération.',
  noSend: 'Aucun remboursement ne peut être envoyé',
  retry: 'Réessayer la récupération',
  retryBody: 'Réessayez la vérification locale. Elle n’envoie aucun remboursement et ne remplace pas l’enregistrement sauvegardé.',
  conflict:
    'Les enregistrements de récupération diffèrent. Les deux originaux sont conservés et les nouveaux remboursements restent suspendus.',
  legacy: 'Cette action sauvegardée n’a pas de référence originale de remboursement. Son résultat ne peut être identifié ni reconstruit.',
  busy: 'Un autre onglet vérifie cet original. Conservez la référence et réessayez après sa vérification.',
  invalidAmount: 'Saisissez un montant positif exact ne dépassant pas le montant capturé disponible pour remboursement.',
  checking: 'Vérification du remboursement original…',
  loading: 'Lecture du paiement capturé…',
  readRetry: 'Réessayer la lecture du paiement',
  readFailed: 'L’opération n’a pas abouti. Vérifiez le paiement et réessayez.',
  notConfirmed: 'Nous n’avons pas encore pu confirmer ce remboursement. Rien de nouveau ne sera envoyé. Vérifiez à nouveau.',
  permissionMissing:
    'Ce compte ne peut pas rembourser de paiements. Demandez la permission de remboursement à un propriétaire ou administrateur.',
  merchantInactive:
    'Les remboursements sont suspendus tant que cette entreprise n’est pas active et vérifiée. Contactez le support si cela semble anormal.',
  noCaptured: 'Aucun montant capturé n’est disponible pour remboursement.',
  unavailableBody:
    'Le remboursement original n’a pas pu être vérifié. Conservez sa référence et réessayez la vérification protégée de l’historique.',
  contextChanged: 'Le compte ou la vérification a changé. Vérifiez à nouveau le paiement actuel.',
  failed: 'Le remboursement original n’a pas été confirmé.',
  stepRequired: 'Confirmez que c’est vous avec une clé d’accès ou un code d’authentificateur.',
  stepExpired: 'Cette confirmation a expiré. Confirmez à nouveau.',
};
/** Window the history read can see: `payment.history` has no cursor, oldest first, 200 rows. */
export const HISTORY_WINDOW = 200;
export type RefundFailureKey =
  | 'busy'
  | 'invalidAmount'
  | 'contextChanged'
  | 'permissionMissing'
  | 'stepRequired'
  | 'stepExpired'
  | 'merchantInactive'
  | 'unavailableBody'
  | 'notConfirmed'
  | 'readFailed';
/**
 * Which plain message a refund failure shows. A held refund reference means a refund may have
 * been dispatched, so an unrecognised failure never says "didn't go through".
 */
export function refundFailureKey(input: { code?: string; busy: boolean; referenceHeld: boolean }): RefundFailureKey {
  const { code, busy, referenceHeld } = input;
  if (busy) return 'busy';
  if (code === 'pay.refund_amount_invalid' || code === 'pay.refund_input_invalid') return 'invalidAmount';
  if (code === 'pay.refund_context_changed') return 'contextChanged';
  if (code === 'pay.business_permission_missing' || code === 'pay.business_authority_missing') return 'permissionMissing';
  if (code === 'pay.business_merchant_inactive' || code === 'pay.business_merchant_mismatch') return 'merchantInactive';
  if (code === 'pay.refund_step_up_required') return 'stepRequired';
  if (code === 'pay.refund_step_up_expired') return 'stepExpired';
  if (code?.startsWith('pay.refund_')) return 'unavailableBody';
  return referenceHeld ? 'notConfirmed' : 'readFailed';
}
export const refundCopy = defineCopy('merchant-refund', en, { es, fr });
