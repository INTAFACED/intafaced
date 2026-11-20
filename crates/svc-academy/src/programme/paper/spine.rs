//! The one fact a paper drill reads from the curriculum spine: whether a slug is in the day-one spine and its kind
//! (`getCurriculumItem(slug)?.kind`, `services/svc-academy/src/curriculum/catalog.ts`, `SPINE_SEED`).
//!
//! A stand-in until the curriculum slice ports the spine: the curriculum slice replaces [`kind_of`] with its own
//! lookup. The table is every `slug` / `kind` pair of `SPINE_SEED`, in its order, read with
//! `awk 'NR>=102 && NR<=337' services/svc-academy/src/curriculum/catalog.ts | grep -oP "(slug|kind): '[^']+'" | paste - -`.

/// `(slug, kind)` for every spine item.
pub const SPINE_KINDS: [(&str, &str); 25] = [
    ("foundations-risk-first", "playbook"),
    ("foundations-order-types", "lesson"),
    ("markets-reading-the-book", "playbook"),
    ("builder-first-automation", "playbook"),
    ("sovereign-self-custody-posture", "lesson"),
    ("foundations-paper-workbook", "workbook"),
    ("foundations-position-sizing", "playbook"),
    ("foundations-journal-discipline", "playbook"),
    ("markets-spread-and-slippage", "playbook"),
    ("markets-session-structure", "playbook"),
    ("builder-kill-switch-drill", "playbook"),
    ("builder-logs-not-vibes", "playbook"),
    ("sovereign-rail-map", "playbook"),
    ("sovereign-withdrawal-hygiene", "playbook"),
    ("markets-tape-reading-workbook", "workbook"),
    ("builder-automation-workbook", "workbook"),
    ("foundations-invalidation-first", "playbook"),
    ("foundations-fees-are-real", "playbook"),
    ("markets-order-types-honest", "playbook"),
    ("markets-correlation-caution", "playbook"),
    ("builder-preflight-checklist", "playbook"),
    ("builder-failure-modes", "playbook"),
    ("sovereign-custody-posture", "playbook"),
    ("sovereign-limits-and-tiers", "playbook"),
    ("sovereign-incident-hygiene", "playbook"),
];

/// The spine item's kind, or `None` when the slug is not in the day-one spine (`BY_SLUG.get(slug)`: exact match).
pub fn kind_of(slug: &str) -> Option<&'static str> {
    SPINE_KINDS
        .iter()
        .find(|(s, _)| *s == slug)
        .map(|(_, kind)| *kind)
}
