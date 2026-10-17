/**
 * THE ONE OPERATOR COMMAND WITH NO WIRE: ledger reconcile.
 *
 * ── What used to be here, and why it is gone ────────────────────────────────
 *
 * `freezeLedger` and `unfreezeLedger` returned `{ postingEnabled: false }` and `{ postingEnabled: true }` without
 * calling anything, and `/ledger` rendered those results, so pressing "Freeze ledger" turned the posting panel to
 * HALTED while the platform kept posting. They were deleted; `/ledger` now runs a two-founder request through the
 * real route.
 *
 * `reconcileLedger` followed them. It returned zeros labelled "simulated". A labelled zero is still a number on a
 * money screen, and the label is the first thing a rushed reader drops, so the function and its numbers are gone.
 *
 * ── Why reconcile still cannot be wired ─────────────────────────────────────
 *
 * `svc-ledger` exposes `POST /operator/reconcile` and a `ledger.reconcile` procedure, both behind `admin:treasury`
 * and a founder-audience approval. `svc-edge` mounts neither (`services/svc-edge/src/control-plane.ts` has only
 * `/admin/ledger/freeze` and `/admin/ledger/:action` for freeze and unfreeze). Nothing this console can reach
 * terminates at reconcile, and there is no read of the last result either, so there is nothing true to show.
 * Adding the route is a change to `services/svc-edge`, filed in admin-BACKEND-NEEDS.md.
 *
 * Until then the console says so and shows NO figure: not zero, not "0 accounts", not a placeholder.
 */

export interface ReconcileAvailability {
  readonly available: false;
  /** Why, in one sentence an operator can repeat to engineering. */
  readonly reason: string;
}

export const RECONCILE_AVAILABILITY: ReconcileAvailability = {
  available: false,
  reason:
    'svc-edge exposes no reconcile route and no read of the last reconciliation, so this console can neither start one nor show a result.',
};
