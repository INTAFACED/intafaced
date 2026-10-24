import { defineCopy } from '../../shared/i18n';

const messages = {
  statusPending: 'Pending',
  statusActive: 'Active',
  statusMarginCall: 'Margin call',
  statusLiquidating: 'Liquidation in progress',
  statusRepaid: 'Repaid',
  statusLiquidated: 'Liquidated',
  statusUnavailable: 'Status unavailable',
  riskLabel: 'This loan LTV',
  riskFor: 'Risk for loan {loanId}',
  riskLoading: 'Checking loan risk…',
  riskUnavailable: 'Loan risk unavailable',
  riskUnavailableNote: 'No usable ratio is available for this loan. Refresh the loan and risk to check again.',
  riskRange: 'LTV, uncapped or capped',
  riskNote:
    "Loan risk as last reported. The time of the price used isn't available, so it may not be current. This ratio doesn't promise any collateral can be released.",
  riskRefresh: 'Refresh loan risk',
  portfolioRange: 'Uncapped or capped',
  pendingPrincipal: 'Principal in pending record',
  pending: 'Principal credit is unconfirmed while this loan is pending. Adding collateral does not complete the draw.',
  marginCall: 'Adding collateral does not itself clear this margin call.',
  liquidating: 'Repayment is unavailable during liquidation. Collateral actions still depend on current service checks.',
  closed: 'No new repayment or collateral top-up is available. Remaining collateral can be released only if nothing is owed.',
  unsupported: 'This loan status does not support a new request. Refresh the loan before continuing.',
  status: 'Status at review',
  loan: 'Original loan reference',
  debtAsset: 'Repayment asset',
  collateralAsset: 'Collateral asset',
  readFailed: 'Current owned loan {loanId} could not be checked. No request was sent. Close this review and refresh the original loan.',
  changed:
    'Original loan {loanId} is missing, changed or no longer supports this action. No request was sent. Close this review and refresh.',
  releaseTooLarge:
    'The release can’t be more than the collateral held for this loan. The service checks current prices and the release allowed.',
  repaymentOffer:
    'The amount is your repayment offer. The service takes no more than the current debt, pays interest first and releases settled collateral when the debt clears.',
  unavailableHistory:
    'This list isn’t your repayment or collateral history. If an earlier request never got a clear answer, new requests stay blocked until you check it, even if a refreshed loan looks the same.',
  releasableNow: 'Most you can release now',
  releasableChecking: 'Checking how much collateral the bank would release now…',
  releasableOver: 'That is more than the bank would release now. Release {releasable} or less.',
  releasableNone: 'The bank would release no collateral from this loan now.',
  releasableFailed: 'The bank could not say how much it would release now, so nothing was sent.',
} as const;

const es = {
  statusPending: 'Pendiente',
  statusActive: 'Activo',
  statusMarginCall: 'Llamada de margen',
  statusLiquidating: 'Liquidación en curso',
  statusRepaid: 'Pagado',
  statusLiquidated: 'Liquidado',
  statusUnavailable: 'Estado no disponible',
  riskLabel: 'LTV de este préstamo',
  riskFor: 'Riesgo del préstamo {loanId}',
  riskLoading: 'Comprobando el riesgo del préstamo…',
  riskUnavailable: 'Riesgo del préstamo no disponible',
  riskUnavailableNote: 'No hay una proporción utilizable para este préstamo. Actualiza el préstamo y el riesgo para comprobarlo de nuevo.',
  riskRange: 'LTV, sin tope o con tope',
  riskNote:
    'Riesgo del préstamo según el último informe. No se dispone de la hora del precio usado, así que puede no estar al día. Esta proporción no garantiza que se pueda liberar garantía.',
  riskRefresh: 'Actualizar riesgo del préstamo',
  portfolioRange: 'Sin tope o con tope',
  pendingPrincipal: 'Capital en el registro pendiente',
  pending: 'El abono del capital no está confirmado mientras este préstamo siga pendiente. Añadir garantía no completa el desembolso.',
  marginCall: 'Añadir garantía no resuelve por sí solo esta llamada de margen.',
  liquidating:
    'El pago no está disponible durante la liquidación. Las acciones sobre la garantía siguen dependiendo de las comprobaciones actuales del servicio.',
  closed: 'No hay disponibles nuevos pagos ni aportaciones de garantía. La garantía restante solo puede liberarse si no se debe nada.',
  unsupported: 'Este estado del préstamo no admite una solicitud nueva. Actualiza el préstamo antes de continuar.',
  status: 'Estado en la revisión',
  loan: 'Referencia del préstamo original',
  debtAsset: 'Activo de pago',
  collateralAsset: 'Activo de garantía',
  readFailed:
    'No se pudo comprobar el préstamo actual de tu titularidad {loanId}. No se ha enviado ninguna solicitud. Cierra esta revisión y actualiza el préstamo original.',
  changed:
    'El préstamo original {loanId} no aparece, ha cambiado o ya no admite esta acción. No se ha enviado ninguna solicitud. Cierra esta revisión y actualiza.',
  releaseTooLarge:
    'La liberación no puede superar la garantía retenida para este préstamo. El servicio comprueba los precios actuales y la liberación permitida.',
  repaymentOffer:
    'El importe es tu oferta de pago. El servicio no toma más que la deuda actual, paga primero los intereses y libera la garantía al saldar la deuda.',
  unavailableHistory:
    'Esta lista no es tu historial de pagos ni de garantía. Si una solicitud anterior no recibió una respuesta clara, las nuevas solicitudes quedan bloqueadas hasta que la revises, aunque un préstamo actualizado parezca igual.',
  releasableNow: 'Lo máximo que puedes liberar ahora',
  releasableChecking: 'Comprobando cuánta garantía liberaría el banco ahora…',
  releasableOver: 'Es más de lo que el banco liberaría ahora. Libera {releasable} o menos.',
  releasableNone: 'El banco no liberaría ninguna garantía de este préstamo ahora.',
  releasableFailed: 'El banco no pudo decir cuánto liberaría ahora, así que no se envió nada.',
} as const;
const fr = {
  statusPending: 'En attente',
  statusActive: 'Actif',
  statusMarginCall: 'Appel de marge',
  statusLiquidating: 'Liquidation en cours',
  statusRepaid: 'Remboursé',
  statusLiquidated: 'Liquidé',
  statusUnavailable: 'Statut indisponible',
  riskLabel: 'LTV de ce prêt',
  riskFor: 'Risque du prêt {loanId}',
  riskLoading: 'Vérification du risque du prêt…',
  riskUnavailable: 'Risque du prêt indisponible',
  riskUnavailableNote: 'Aucun ratio exploitable n’est disponible pour ce prêt. Actualise le prêt et le risque pour vérifier à nouveau.',
  riskRange: 'LTV, sans plafond ou plafonné',
  riskNote:
    'Risque du prêt selon le dernier relevé. L’heure du prix utilisé n’est pas disponible, il peut donc ne pas être à jour. Ce ratio ne promet pas qu’une garantie pourra être libérée.',
  riskRefresh: 'Actualiser le risque du prêt',
  portfolioRange: 'Sans plafond ou plafonné',
  pendingPrincipal: 'Capital dans l’enregistrement en attente',
  pending: 'Le crédit du capital n’est pas confirmé tant que ce prêt est en attente. Ajouter une garantie n’effectue pas le décaissement.',
  marginCall: 'Ajouter une garantie ne résout pas à lui seul cet appel de marge.',
  liquidating:
    'Le remboursement est indisponible pendant la liquidation. Les actions sur la garantie dépendent toujours des vérifications actuelles du service.',
  closed:
    'Aucun nouveau remboursement ni apport de garantie n’est disponible. La garantie restante ne peut être libérée que si aucune somme n’est due.',
  unsupported: 'Ce statut du prêt ne prend pas en charge une nouvelle demande. Actualise le prêt avant de continuer.',
  status: 'Statut lors de la vérification',
  loan: 'Référence du prêt original',
  debtAsset: 'Actif de remboursement',
  collateralAsset: 'Actif de garantie',
  readFailed:
    'Le prêt actuel {loanId} qui t’appartient n’a pas pu être vérifié. Aucune demande n’a été envoyée. Ferme cette vérification et actualise le prêt original.',
  changed:
    'Le prêt original {loanId} est absent, a changé ou ne prend plus en charge cette action. Aucune demande n’a été envoyée. Ferme cette vérification et actualise.',
  releaseTooLarge:
    'La libération ne peut pas dépasser la garantie détenue pour ce prêt. Le service vérifie les prix actuels et la libération autorisée.',
  repaymentOffer:
    'Le montant est ton offre de remboursement. Le service ne prélève pas plus que la dette actuelle, paie d’abord les intérêts et libère la garantie lorsque la dette est soldée.',
  unavailableHistory:
    'Cette liste n’est pas ton historique de remboursements ni de garantie. Si une demande précédente n’a pas reçu de réponse claire, les nouvelles demandes restent bloquées tant que tu ne l’as pas vérifiée, même si un prêt actualisé semble identique.',
  releasableNow: 'Le maximum que tu peux libérer maintenant',
  releasableChecking: 'Vérification de la garantie que la banque libérerait maintenant…',
  releasableOver: 'C’est plus que ce que la banque libérerait maintenant. Libère {releasable} ou moins.',
  releasableNone: 'La banque ne libérerait aucune garantie de ce prêt maintenant.',
  releasableFailed: 'La banque n’a pas pu dire combien elle libérerait maintenant, donc rien n’a été envoyé.',
} as const;
export const loanCopy = defineCopy('customer.money.loans', messages, { es, fr });

/** Presentation only: raw statuses still govern service/action admission. */
export function loanStatusLabel(status: string, copy: Pick<ReturnType<typeof loanCopy.forLocale>, 't'> = loanCopy): string {
  switch (status) {
    case 'pending':
      return copy.t('statusPending');
    case 'active':
      return copy.t('statusActive');
    case 'margin_call':
      return copy.t('statusMarginCall');
    case 'liquidating':
      return copy.t('statusLiquidating');
    case 'repaid':
      return copy.t('statusRepaid');
    case 'liquidated':
      return copy.t('statusLiquidated');
    default:
      return copy.t('statusUnavailable');
  }
}
