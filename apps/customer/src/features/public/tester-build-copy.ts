import { defineCopy } from '../../shared/i18n';

// Shown only on a test build, to the person running it; command names and file names stay as typed.
const messages = {
  title: 'Tester build',
  intro: 'This is a local test build. Every balance and price in it is TEST, not real money.',
  vault:
    'The local test founders’ sign-in details are in founders.json in the stack’s state folder (~/.intafaced/local-test-stack unless you chose another). This page never shows them.',
  stepsHeading: 'To sign in as a founder',
  stepPassword: 'Enter the founder’s handle and password from founders.json.',
  stepCode: 'For the one-time code, run node tooling/scripts/local-test-entry.mjs code a (or b) just before you sign in.',
  stepDevice:
    'If the founder console asks you to authorise this browser, run node tooling/scripts/local-test-entry.mjs device a and enter the device code it prints.',
} as const;

export const testerBuildCopy = defineCopy('public-tester-build', messages);
