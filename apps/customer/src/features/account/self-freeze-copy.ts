import { defineCopy } from '../../shared/i18n';

const messages = {
  title: 'Freeze your account',
  body: 'Use this if you think someone else has access, or you want to stop everything for a while. Freezing applies at once: every device is signed out, every API key and every permission you gave an agent or app is revoked, and your scheduled agent orders stop. Your funds stay in your own wallet and venue account, which only your wallet controls.',
  consequences:
    'While frozen, INTAFACED places no order for you, and no agent permission or API key can be given. You can lift the freeze yourself after a waiting time, with your authenticator code or a passkey. A freeze set by our staff is lifted only by our staff.',
  reasonLabel: 'Why are you freezing it?',
  reasonCompromise: 'Someone else may have access',
  reasonTemporary: 'I want to pause for a while',
  reasonPersonal: 'Another reason',
  passwordField: 'Your password',
  passwordNeeded: 'Enter your password to confirm.',
  freezeAsk: 'Freeze my account',
  working: 'Working…',
  frozenTitle: 'You froze this account',
  frozenBody:
    'Frozen on {date} ({reason}). Every device was signed out, every API key and agent permission was revoked, and your scheduled agent orders stopped.',
  frozenNote: 'Your account is frozen. You will be signed out.',
  refusedPassword: 'That password is not right.',
  refusedDelegated: 'Sign in on this device. An API key or a sub-account cannot freeze this account.',
  refusedClosed: 'This account is closed and cannot be frozen.',
  liftTitle: 'Reactivate your account',
  liftBody:
    'Once the waiting time after your freeze has passed, you can lift it yourself. You confirm it with your authenticator code or a passkey.',
  liftAsk: 'Reactivate my account',
  liftWhy: 'Enter a fresh code from your authenticator app, or use a passkey, to lift the freeze.',
  liftCode: 'Authenticator code',
  liftCodeHint: 'The 6-digit code your app shows now.',
  liftCodeShort: 'Enter all 6 digits.',
  liftNoFactor: 'Lifting a freeze needs an authenticator app or a passkey, and this account has neither.',
  liftSendWithout: 'Ask without one',
  liftTooSoonOneSecond: 'Too soon. You can reactivate in 1 second.',
  liftTooSoonSeconds: 'Too soon. You can reactivate in {n} seconds.',
  liftTooSoonMinutes: 'Too soon. You can reactivate in {n} minutes.',
  liftTooSoonHours: 'Too soon. You can reactivate in {n} hours.',
  liftTooSoon: 'Too soon. The waiting time after your freeze has not passed.',
  liftWaitUnset: 'Reactivation is refused: no waiting time is set for lifting a freeze, so it cannot open.',
  liftApprovalRefused: 'That confirmation was not accepted. Enter a new code to try again.',
  liftNeedsFactor: 'Turn on an authenticator app or add a passkey first. Lifting a freeze needs one.',
  liftedNote:
    'Your account is active again. Your other devices stay signed out; sign in there again to use them. Revoked agent permissions and API keys stay revoked: sign a new permission for any agent you want back.',
  walletTitle: 'Your account is frozen',
  walletBody:
    'Your funds stay in your own wallet and venue account, which only your wallet controls. INTAFACED takes no action for you while the freeze holds.',
  walletLift: 'Reactivate in Security',
} as const;

export const selfFreezeCopy = defineCopy('account.freeze', messages);
export type FreezeCopyKey = keyof typeof messages;
