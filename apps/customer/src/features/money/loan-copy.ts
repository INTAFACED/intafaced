import { defineCopy } from '../../shared/i18n';

const messages = {
  riskLabel: 'This loan LTV',
  riskFor: 'Risk for loan {loanId}',
  riskLoading: 'Checking loan risk…',
  riskUnavailable: 'Loan risk unavailable',
  riskUnavailableNote: 'No usable individual ratio is supplied by this read. Refresh the loan and risk to check again.',
  riskRange: 'Unbounded or capped LTV',
  riskNote: 'Returned loan risk. Mark time is unavailable. This ratio does not promise an allowed collateral release.',
  riskRefresh: 'Refresh loan risk',
  portfolioRange: 'Unbounded or capped',
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
    'The release must not exceed the collateral returned for this loan. Current marks and the allowed release are checked by the service.',
  repaymentOffer:
    'The amount is your repayment offer. The service takes no more than the current debt, pays interest first and releases settled collateral when the debt clears.',
  unavailableHistory:
    'This bounded list is not repayment or collateral-event history. An unknown original request remains guarded even when a refreshed loan matches.',
} as const;

const es = {
  riskLabel: 'LTV de este préstamo',
  riskFor: 'Riesgo del préstamo {loanId}',
  riskLoading: 'Comprobando el riesgo del préstamo…',
  riskUnavailable: 'Riesgo del préstamo no disponible',
  riskUnavailableNote:
    'Esta lectura no proporciona una ratio individual utilizable. Actualiza el préstamo y el riesgo para comprobarlos de nuevo.',
  riskRange: 'LTV sin límite o limitado por rango',
  riskNote:
    'Riesgo del préstamo devuelto. La hora de la cotización no está disponible. Esta ratio no promete una liberación de garantía admisible.',
  riskRefresh: 'Actualizar riesgo del préstamo',
  portfolioRange: 'Sin límite o limitado por rango',
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
    'La liberación no debe superar la garantía devuelta para este préstamo. El servicio comprueba las cotizaciones actuales y la liberación permitida.',
  repaymentOffer:
    'El importe es tu oferta de pago. El servicio no toma más que la deuda actual, paga primero los intereses y libera la garantía al saldar la deuda.',
  unavailableHistory:
    'Esta lista limitada no es un historial de pagos ni de eventos de garantía. Una solicitud original de resultado desconocido sigue protegida aunque un préstamo actualizado coincida.',
} as const;
const fr = {
  riskLabel: 'LTV de ce prêt',
  riskFor: 'Risque du prêt {loanId}',
  riskLoading: 'Vérification du risque du prêt…',
  riskUnavailable: 'Risque du prêt indisponible',
  riskUnavailableNote:
    'Cette lecture ne fournit aucun ratio individuel utilisable. Actualise le prêt et le risque pour les vérifier à nouveau.',
  riskRange: 'LTV non borné ou plafonné par la plage',
  riskNote:
    'Risque du prêt renvoyé. L’heure du prix de référence est indisponible. Ce ratio ne promet pas une libération de garantie autorisée.',
  riskRefresh: 'Actualiser le risque du prêt',
  portfolioRange: 'Non borné ou plafonné par la plage',
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
    'La libération ne doit pas dépasser la garantie renvoyée pour ce prêt. Le service vérifie les prix de référence actuels et la libération autorisée.',
  repaymentOffer:
    'Le montant est ton offre de remboursement. Le service ne prélève pas plus que la dette actuelle, paie d’abord les intérêts et libère la garantie lorsque la dette est soldée.',
  unavailableHistory:
    'Cette liste limitée n’est pas un historique de remboursements ou d’événements de garantie. Une demande originale au résultat inconnu reste protégée même si un prêt actualisé correspond.',
} as const;
export const loanCopy = defineCopy('customer.money.loans', messages, { es, fr });
