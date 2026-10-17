import { defineCopy } from '../../shared/i18n';

// English source only. Business verification already exists in the merchant set-up; this page explains and links, it does not repeat it.
export const businessCopy = defineCopy('account-business-verification', {
  title: 'Business verification',
  intro:
    'A company is verified when you open a merchant account. That is where the checks, documents and status live, so this page points you there.',
  whereTitle: 'Where it happens',
  whereBody: 'The merchant set-up has three steps. Each opens in Pay, and you can leave and come back.',
  step1: 'Business details',
  step1Body: 'Save your legal business and contact details.',
  step2: 'Business verification',
  step2Body: 'Submit your verification and follow its status.',
  step3: 'Payout destination',
  step3Body: 'Review where payouts go and what is needed to go live.',
  open: 'Open',
  startTitle: 'Start from the beginning',
  startBody: 'The set-up page shows which steps are done and which come next.',
  startAction: 'Open merchant set-up',
  personalTitle: 'Your own identity',
  personalBody: 'Verifying you as a person is separate from verifying a company.',
  personalAction: 'Open personal verification',
  boundary: 'Verification is decided by the verification service. A step that is not available there shows its reason on that page.',
});
