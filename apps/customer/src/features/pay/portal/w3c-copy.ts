import { defineCopy } from '../../../shared/i18n';

export const w3cCopy = defineCopy('pay.portal.w3c', {
  destinationVisit: 'Destination saved for this visit',
  activationUnknown: 'Activation has not been checked',
  refundsTitle: 'Refunds',
  refundsPurpose: 'Find refunds by their original payment and check what was returned.',
  issueRefund: 'Issue a refund',
  issuePurpose: 'Return all or part of a captured payment after reviewing its effect.',
  refundTitle: 'Refund detail',
  refundPurpose: 'The recorded outcome and history of one refund.',
  refundListGap:
    'The account-wide refund list, refund rate and date filters are not connected yet. Look up an original payment below to inspect its recorded refunds. No account totals are estimated.',
  refundAuditGap:
    'Refund reason, requesting actor, fee treatment and ledger lines are not available in this read. The timeline shows only events returned for the original payment.',
  refundAuthorityGap:
    'Refund submission needs verified company membership and the refund permission. That membership read is not connected to this app yet. No refund has been sent. You can still inspect the original payment.',
  refundIdGap:
    'A refund cannot be looked up by its ID alone yet. Open it from its original payment so the account-scoped history can be checked.',
  paymentId: 'Original payment ID',
  paymentHint: 'Use the ID from your payments list. This only reads a payment belonging to your account.',
  paymentInvalid: 'Enter a complete payment ID from your payments list.',
  lookup: 'Look up payment',
  choosePayment: 'Choose an original payment',
  chooseBody: 'Refunds are recorded in the history of the payment they return. Open Payments to find the ID, or enter it above.',
  openPayments: 'Open payments',
  backRefunds: 'Back to refunds',
  originalPayment: 'Open original payment',
  noRefunds: 'No refunds in this history',
  noRefundsBody:
    'No refund events were returned for this payment. A new refund appears here after it is recorded. This history read is limited to 200 events.',
  notFound: 'Refund not found',
  notFoundBody:
    'This refund could not be found in the payment history available to your account. Check the original payment, or contact support with the reference.',
  limitedHistory:
    'Showing refunds from up to 200 payment events. This is not an account-wide list; older events may be outside this window.',
  filterStatus: 'Refund status',
  allStatuses: 'All statuses',
  completed: 'Completed',
  in_progress: 'In progress',
  reversed: 'Reversed',
  completedTip: 'The payment rail confirmed the refund.',
  in_progressTip: 'The refund was booked; rail confirmation has not appeared in this history.',
  reversedTip: 'The refund was reversed. Do not assume the customer received it.',
  refundId: 'Refund ID',
  amount: 'Amount',
  status: 'Status',
  recorded: 'First recorded',
  count: 'Recorded refunds',
  countShown: '{count} refunds shown for this payment.',
  returned: 'Completed amount',
  pending: 'In progress',
  reversedCount: 'Reversed',
  historyPeriod: 'Loaded payment history',
  downloadRefunds: 'Download shown refunds (CSV)',
  refundHistory: 'Refund history',
  refundPosted: 'Refund booked',
  refundConfirmed: 'Refund confirmed',
  refundReversed: 'Refund reversed',
  sort: 'Sort refunds',
  newest: 'Newest first',
  oldest: 'Oldest first',
  noMatches: 'No refunds match this status. Choose All statuses to see the available history.',
  backMerchant: 'Back to merchant dashboard',
  serverProgress:
    'Business and verification progress comes from your account. Saving a destination does not activate payments or live mode.',
  nextBackend: 'Arrives with the next backend update',
  draftGap:
    'Saving a business draft is not connected yet. Keep this page open until you can create the account. No draft is saved on this device.',
  verificationGap:
    'Document uploads, withdrawal of a submission and a separate screening result are not connected yet. Verification status above is the account status; it is not a screening clearance.',
  goLiveGap:
    'Saved destinations, terms acceptance and activation checks are not readable here yet. Saving a destination below does not complete go-live. Review your published pricing and limits; live activation waits for INTAFACED.',
  reviewPricing: 'Review pricing',
  reviewLimits: 'Review limits',
  continueDestination: 'Continue to payout destination',
  unsaved: 'Leave this page? Your unsaved entries will be lost.',
});
