// The agent builder's save answer, found apart from every other status the form holds. While an attached tool's shape
// is still loading, the "Tool shapes" group shows its own "Loading information…" status inside the same form, so the
// form's one status is ambiguous: J-agents-02 #6 failed on main in run 45279452197 with a strict-mode violation there.

/** The builder's "Draft saved." status: a status in the form whose whole text is the save answer. */
export const draftSaved = (builder) => builder.getByRole('status').filter({ hasText: /^Draft saved\.$/ });
