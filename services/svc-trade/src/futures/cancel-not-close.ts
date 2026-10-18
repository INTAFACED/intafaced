/**
 * DELETE /api/v1/positions/:id is a cancel-shaped call. It is not a close.
 * Margin release runs only on a close route (`closeAtomically` / the partial close).
 */
export const CANCEL_NOT_CLOSE = 'trade.cancel_not_close' as const;
