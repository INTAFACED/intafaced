/**
 * Password recovery, as a journey: ask for a code, enter it, choose a new password. The identity service has sign-in, refresh,
 * step-up and change-password procedures but no way to start or finish a reset for someone who cannot sign in, so the journey is
 * built whole and switched off. When the service gains those two calls, `RECOVERY_BLOCKER` goes away and the steps work in order.
 * The needs are filed in /Users/Nitro/.codex/context/work/tasks/support-notify-more-BACKEND-NEEDS.md.
 */

export const RECOVERY_STEPS = ['request', 'code', 'password'] as const;
export type RecoveryStep = (typeof RECOVERY_STEPS)[number];

/** The named reason the journey is off. `null` means every step may be used. */
export const RECOVERY_BLOCKER: { id: string; needs: readonly string[] } | null = {
  id: 'identity.password_reset_unwired',
  needs: ['identity.auth.requestPasswordReset', 'identity.auth.completePasswordReset'],
};

export function recoveryAvailable(blocker: typeof RECOVERY_BLOCKER = RECOVERY_BLOCKER): boolean {
  return blocker === null;
}

export type StepState = 'current' | 'upcoming' | 'done';

/** Which step is current, which are behind it and which are ahead. */
export function stepStates(current: RecoveryStep): Record<RecoveryStep, StepState> {
  const at = RECOVERY_STEPS.indexOf(current);
  return Object.fromEntries(
    RECOVERY_STEPS.map((step, index) => [step, index < at ? 'done' : index === at ? 'current' : 'upcoming']),
  ) as Record<RecoveryStep, StepState>;
}

/** Every control stays disabled while the journey is blocked, whatever step it belongs to. */
export function controlsDisabled(blocker: typeof RECOVERY_BLOCKER = RECOVERY_BLOCKER): boolean {
  return blocker !== null;
}

/** Minimum length shown next to the new-password field. It matches the sign-up form's rule. */
export const MIN_PASSWORD_LENGTH = 12;
export const CODE_LENGTH = 6;
