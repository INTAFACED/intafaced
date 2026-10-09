import { defineCopy } from '../../shared/i18n';

export const loanCopy = defineCopy('customer.money.loans', {
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
} as const);
