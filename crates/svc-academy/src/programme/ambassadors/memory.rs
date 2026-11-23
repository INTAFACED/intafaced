//! The in-memory desks of `ambassadors/programme.ts` (`MemoryAmbassadorProgramme`) and `ambassadors/residency.ts`
//! (`MemoryResidencyDesk`), with the L3 read helpers their tests exercise. Nothing in production calls them (the router
//! reaches Postgres); they are kept, test-only, so each TypeScript assertion keeps its meaning.
//!
//! Ratios are `(a / b).toFixed(4)` computed on whole numbers (round half up of the exact quotient), never in floats.
//! A TypeScript `number` argument that is a count or an index is an `i64` here: the `Number.isFinite` guards on those
//! arguments have nothing to refuse in Rust.

use std::collections::BTreeSet;
use std::time::SystemTime;

use service_kit::schema::js_trim;

use super::pg::ms;
use super::programme::{
    AmbassadorBadge, AmbassadorRecord, assert_freeze_reason, assert_programme_page_limit, badge_of,
};
use super::residency::{
    ResidencyApplication, assert_cohort_slug, assert_residency_page_limit, assert_statement,
    decision_note,
};
use crate::errors::AcademyError;

fn now_ms() -> i64 {
    ms(SystemTime::now())
}

/// `Math.round((a / b) * 10000)`, half up, on whole numbers.
fn ratio_units(a: usize, b: usize) -> usize {
    (a * 20_000 + b) / (2 * b)
}

/// `(a / b).toFixed(4)`; `None` when `b` is zero (never invent a 0 ratio).
fn fixed4(a: usize, b: usize) -> Option<String> {
    (b > 0).then(|| {
        let n = ratio_units(a, b);
        format!("{}.{:04}", n / 10_000, n % 10_000)
    })
}

/// `Math.round(Number(ratio) * 100)`.
fn share_percent(a: usize, b: usize) -> Option<usize> {
    (b > 0).then(|| (ratio_units(a, b) + 50) / 100)
}

/// `Number(ratio) >= 0.5`.
fn half_or_more(a: usize, b: usize) -> bool {
    b > 0 && ratio_units(a, b) >= 5_000
}

fn count(n: usize) -> i64 {
    i64::try_from(n).unwrap_or(i64::MAX)
}

/// `all.slice(offset, offset + limit)` with the offset floored at zero.
fn page(all: &[String], offset: Option<i64>, limit: usize) -> Vec<String> {
    let o = usize::try_from(offset.unwrap_or(0).max(0)).unwrap_or(usize::MAX);
    all.iter().skip(o).take(limit).cloned().collect()
}

/// `safePage…(offset, limit)`: both clamped into the list.
fn safe_page(all: &[String], offset: i64, limit: i64) -> Vec<String> {
    let len = count(all.len());
    let o = offset.clamp(0, len);
    let l = limit.clamp(0, len - o);
    page(all, Some(o), usize::try_from(l).unwrap_or(0))
}

fn page_count(n: usize, page_size: i64) -> i64 {
    if page_size < 1 || n == 0 {
        return 0;
    }
    (count(n) + page_size - 1) / page_size
}

fn clamp_page_index(pages: i64, page_index: i64) -> i64 {
    if pages == 0 {
        0
    } else {
        page_index.clamp(0, pages - 1)
    }
}

fn sorted(mut ids: Vec<String>) -> Vec<String> {
    ids.sort();
    ids
}

/// `/^name=(\d+)( name=(\d+))*$/` for the given names in order.
fn parse_counts(line: &str, names: &[&str]) -> Option<Vec<i64>> {
    let parts: Vec<&str> = js_trim(line).split(' ').collect();
    if parts.len() != names.len() {
        return None;
    }
    parts
        .iter()
        .zip(names)
        .map(|(part, name)| {
            let digits = part.strip_prefix(name)?.strip_prefix('=')?;
            if digits.is_empty() || !digits.bytes().all(|b| b.is_ascii_digit()) {
                return None;
            }
            digits.parse().ok()
        })
        .collect()
}

fn programme_error(message: impl Into<String>, code: &str) -> AcademyError {
    AcademyError::new(message, code)
}

/// One row of the operator board (`programmeRowSummary`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RowSummary {
    pub user_id: String,
    /// `active`, `frozen` or `missing`.
    pub status: &'static str,
    pub is_active: bool,
    pub is_frozen: bool,
}

/// `{ active, frozen, total }`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Counts {
    pub active: i64,
    pub frozen: i64,
    pub total: i64,
}

/// `programmeBoardHeadline()`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Headline {
    pub total: i64,
    pub active: i64,
    pub frozen: i64,
    pub empty: bool,
    pub active_ratio: Option<String>,
}

/// `MemoryAmbassadorProgramme`: appoint, freeze and unfreeze only; it never grants host rights.
#[derive(Debug, Default)]
pub struct MemoryAmbassadorProgramme {
    /// A `Map` keyed by user id: insertion order, a re-set keeps its place.
    by_user: Vec<(String, AmbassadorRecord)>,
}

impl MemoryAmbassadorProgramme {
    pub fn new() -> Self {
        Self::default()
    }

    fn set(&mut self, row: AmbassadorRecord) {
        match self.by_user.iter_mut().find(|(k, _)| *k == row.user_id) {
            Some(slot) => slot.1 = row,
            None => self.by_user.push((row.user_id.clone(), row)),
        }
    }

    fn rows(&self) -> impl Iterator<Item = &AmbassadorRecord> {
        self.by_user.iter().map(|(_, r)| r)
    }

    pub fn get(&self, user_id: &str) -> Option<&AmbassadorRecord> {
        self.rows().find(|r| r.user_id == user_id)
    }

    pub fn badge(&self, user_id: &str) -> AmbassadorBadge {
        badge_of(user_id, self.get(user_id))
    }

    /// By appointment time, oldest first (a stable sort).
    pub fn list(&self, status: Option<&str>) -> Vec<&AmbassadorRecord> {
        let mut rows: Vec<&AmbassadorRecord> = self
            .rows()
            .filter(|r| status.is_none_or(|s| r.status == s))
            .collect();
        rows.sort_by_key(|r| r.appointed_at);
        rows
    }

    pub fn appoint(
        &mut self,
        user_id: &str,
        appointed_by: &str,
        now: Option<i64>,
    ) -> Result<AmbassadorRecord, AcademyError> {
        let user_id = js_trim(user_id);
        let appointed_by = js_trim(appointed_by);
        if user_id.is_empty() || appointed_by.is_empty() {
            return Err(programme_error(
                "userId and appointedBy required",
                "academy.ambassador_invalid",
            ));
        }
        match self.get(user_id).map(|r| r.status.as_str()) {
            Some("active") => {
                return Err(programme_error(
                    format!("User {user_id} is already an active ambassador"),
                    "academy.ambassador_already_active",
                ));
            }
            Some("frozen") => {
                return Err(programme_error(
                    format!(
                        "Ambassador {user_id} is frozen — unfreeze to restore the badge (re-appoint would erase freeze audit)"
                    ),
                    "academy.ambassador_already_frozen",
                ));
            }
            _ => {}
        }
        let row = AmbassadorRecord {
            user_id: user_id.to_owned(),
            status: "active".to_owned(),
            appointed_by: appointed_by.to_owned(),
            appointed_at: now.unwrap_or_else(now_ms),
            frozen_at: None,
            frozen_by: None,
            freeze_reason: None,
        };
        self.set(row.clone());
        Ok(row)
    }

    pub fn freeze(
        &mut self,
        user_id: &str,
        frozen_by: &str,
        reason: &str,
        now: Option<i64>,
    ) -> Result<AmbassadorRecord, AcademyError> {
        let Some(existing) = self.get(user_id) else {
            return Err(programme_error(
                format!("No ambassador programme row for {user_id}"),
                "academy.ambassador_not_found",
            ));
        };
        if existing.status == "frozen" {
            return Err(programme_error(
                format!("Ambassador {user_id} is already frozen"),
                "academy.ambassador_already_frozen",
            ));
        }
        let row = AmbassadorRecord {
            status: "frozen".to_owned(),
            frozen_at: Some(now.unwrap_or_else(now_ms)),
            frozen_by: Some(js_trim(frozen_by).to_owned()),
            freeze_reason: Some(assert_freeze_reason(reason)?),
            ..existing.clone()
        };
        self.set(row.clone());
        Ok(row)
    }

    pub fn unfreeze(&mut self, user_id: &str) -> Result<AmbassadorRecord, AcademyError> {
        let Some(existing) = self.get(user_id) else {
            return Err(programme_error(
                format!("No ambassador programme row for {user_id}"),
                "academy.ambassador_not_found",
            ));
        };
        if existing.status != "frozen" {
            return Err(programme_error(
                format!("Ambassador {user_id} is not frozen"),
                "academy.ambassador_invalid",
            ));
        }
        let row = AmbassadorRecord {
            status: "active".to_owned(),
            frozen_at: None,
            frozen_by: None,
            freeze_reason: None,
            ..existing.clone()
        };
        self.set(row.clone());
        Ok(row)
    }

    pub fn badges_of(&self, user_ids: &[&str]) -> Vec<AmbassadorBadge> {
        user_ids.iter().map(|id| self.badge(js_trim(id))).collect()
    }

    fn n_active(&self) -> usize {
        self.list(Some("active")).len()
    }

    fn n_frozen(&self) -> usize {
        self.list(Some("frozen")).len()
    }

    fn n_total(&self) -> usize {
        self.by_user.len()
    }

    pub fn active_count(&self) -> i64 {
        count(self.n_active())
    }

    pub fn status_histogram(&self) -> Counts {
        let active = count(self.rows().filter(|r| r.status == "active").count());
        let frozen = count(self.rows().filter(|r| r.status == "frozen").count());
        Counts {
            active,
            frozen,
            total: active + frozen,
        }
    }

    fn ids_with(&self, status: &str) -> Vec<String> {
        sorted(
            self.list(Some(status))
                .iter()
                .map(|r| r.user_id.clone())
                .collect(),
        )
    }

    pub fn list_active_user_ids(&self) -> Vec<String> {
        self.ids_with("active")
    }

    pub fn frozen_user_ids(&self) -> Vec<String> {
        self.ids_with("frozen")
    }

    pub fn freeze_reason_of(&self, user_id: &str) -> Option<String> {
        self.get(js_trim(user_id))
            .filter(|r| r.status == "frozen")
            .and_then(|r| r.freeze_reason.clone())
    }

    pub fn is_active_ambassador(&self, user_id: &str) -> bool {
        self.get(js_trim(user_id))
            .is_some_and(|r| r.status == "active")
    }

    pub fn appointing_operators(&self) -> Vec<String> {
        let set: BTreeSet<String> = self
            .rows()
            .filter(|r| !r.appointed_by.is_empty())
            .map(|r| r.appointed_by.clone())
            .collect();
        set.into_iter().collect()
    }

    pub fn list_frozen_user_ids(&self) -> Vec<String> {
        self.ids_with("frozen")
    }

    pub fn count_appointed_by(&self, operator_id: &str) -> i64 {
        let op = js_trim(operator_id);
        if op.is_empty() {
            return 0;
        }
        count(self.rows().filter(|r| r.appointed_by == op).count())
    }

    pub fn frozen_count(&self) -> i64 {
        count(self.n_frozen())
    }

    pub fn is_ambassador_frozen(&self, user_id: &str) -> bool {
        self.get(js_trim(user_id))
            .is_some_and(|r| r.status == "frozen")
    }

    pub fn list_all_user_ids(&self) -> Vec<String> {
        sorted(self.by_user.iter().map(|(k, _)| k.clone()).collect())
    }

    pub fn total_count(&self) -> i64 {
        count(self.n_total())
    }

    pub fn is_empty(&self) -> bool {
        self.by_user.is_empty()
    }

    pub fn active_ratio(&self) -> Option<String> {
        fixed4(self.n_active(), self.n_total())
    }

    pub fn frozen_programme_ids(&self) -> Vec<String> {
        self.list_frozen_user_ids()
    }

    pub fn is_programme_active(&self, user_id: &str) -> bool {
        self.is_active_ambassador(user_id)
    }

    pub fn has_any_programme_row(&self) -> bool {
        !self.by_user.is_empty()
    }

    pub fn frozen_ratio(&self) -> Option<String> {
        fixed4(self.n_frozen(), self.n_total())
    }

    pub fn active_programme_ids(&self) -> Vec<String> {
        self.list_active_user_ids()
    }

    pub fn programme_user_count(&self) -> i64 {
        self.total_count()
    }

    pub fn frozen_programme_count(&self) -> i64 {
        self.frozen_count()
    }

    pub fn active_programme_count(&self) -> i64 {
        self.active_count()
    }

    pub fn has_frozen_ambassador(&self) -> bool {
        self.n_frozen() > 0
    }

    pub fn has_active_ambassador(&self) -> bool {
        self.n_active() > 0
    }

    pub fn list_statuses_present(&self) -> Vec<&'static str> {
        let mut out = Vec::new();
        if self.n_active() > 0 {
            out.push("active");
        }
        if self.n_frozen() > 0 {
            out.push("frozen");
        }
        out
    }

    pub fn is_fully_frozen(&self) -> bool {
        self.n_total() > 0 && self.n_active() == 0
    }

    pub fn is_fully_active(&self) -> bool {
        self.n_total() > 0 && self.n_frozen() == 0
    }

    pub fn programme_active_ratio(&self) -> Option<String> {
        self.active_ratio()
    }

    pub fn list_partitioned_user_ids(&self) -> (Vec<String>, Vec<String>) {
        (self.list_active_user_ids(), self.list_frozen_user_ids())
    }

    pub fn has_single_active(&self) -> bool {
        self.n_active() == 1
    }

    pub fn has_single_frozen(&self) -> bool {
        self.n_frozen() == 1
    }

    pub fn inactive_programme_count(&self) -> i64 {
        self.frozen_count()
    }

    pub fn first_active_user_id(&self) -> Option<String> {
        self.list_active_user_ids().into_iter().next()
    }

    pub fn first_frozen_user_id(&self) -> Option<String> {
        self.list_frozen_user_ids().into_iter().next()
    }

    pub fn majority_active(&self) -> bool {
        self.n_active() > self.n_frozen() && self.n_total() > 0
    }

    pub fn majority_frozen(&self) -> bool {
        self.n_frozen() > self.n_active() && self.n_total() > 0
    }

    pub fn last_active_user_id(&self) -> Option<String> {
        self.list_active_user_ids().pop()
    }

    pub fn active_minus_frozen(&self) -> i64 {
        self.active_count() - self.frozen_count()
    }

    pub fn is_active_frozen_balanced(&self) -> bool {
        self.n_total() > 0 && self.n_active() == self.n_frozen()
    }

    pub fn last_frozen_user_id(&self) -> Option<String> {
        self.list_frozen_user_ids().pop()
    }

    pub fn programme_density(&self) -> i64 {
        self.total_count()
    }

    pub fn has_at_least_users(&self, n: i64) -> bool {
        n >= 0 && self.total_count() >= n
    }

    pub fn active_count_label(&self) -> String {
        self.n_active().to_string()
    }

    pub fn frozen_count_label(&self) -> String {
        self.n_frozen().to_string()
    }

    pub fn has_both_statuses(&self) -> bool {
        self.n_active() > 0 && self.n_frozen() > 0
    }

    pub fn total_count_label(&self) -> String {
        self.n_total().to_string()
    }

    pub fn is_majority_active_or_tie(&self) -> bool {
        half_or_more(self.n_active(), self.n_total())
    }

    pub fn is_majority_frozen_or_tie(&self) -> bool {
        half_or_more(self.n_frozen(), self.n_total())
    }

    pub fn active_user_ids_joined(&self) -> String {
        self.list_active_user_ids().join(",")
    }

    pub fn frozen_user_ids_joined(&self) -> String {
        self.list_frozen_user_ids().join(",")
    }

    pub fn all_user_ids_joined(&self) -> String {
        self.list_all_user_ids().join(",")
    }

    pub fn statuses_present_joined(&self) -> String {
        self.list_statuses_present().join(",")
    }

    pub fn is_programme_empty_label(&self) -> bool {
        self.is_empty()
    }

    pub fn active_ratio_label(&self) -> String {
        self.active_ratio().unwrap_or_default()
    }

    pub fn frozen_ratio_label(&self) -> String {
        self.frozen_ratio().unwrap_or_default()
    }

    pub fn programme_active_ratio_label(&self) -> String {
        self.programme_active_ratio().unwrap_or_default()
    }

    pub fn has_inactive_rows(&self) -> bool {
        self.n_frozen() > 0
    }

    pub fn programme_count_snapshot(&self) -> Counts {
        Counts {
            active: self.active_count(),
            frozen: self.frozen_count(),
            total: self.total_count(),
        }
    }

    pub fn programme_counts_consistent(&self) -> bool {
        let s = self.programme_count_snapshot();
        s.total == s.active + s.frozen
    }

    pub fn active_share_percent(&self) -> Option<usize> {
        share_percent(self.n_active(), self.n_total())
    }

    pub fn frozen_share_percent(&self) -> Option<usize> {
        share_percent(self.n_frozen(), self.n_total())
    }

    pub fn programme_row_summary(&self, user_id: &str) -> RowSummary {
        let id = js_trim(user_id);
        let (status, is_active, is_frozen) = if id.is_empty() {
            ("missing", false, false)
        } else if self.is_active_ambassador(id) {
            ("active", true, false)
        } else if self.is_ambassador_frozen(id) {
            ("frozen", false, true)
        } else {
            ("missing", false, false)
        };
        RowSummary {
            user_id: id.to_owned(),
            status,
            is_active,
            is_frozen,
        }
    }

    pub fn list_programme_row_summaries(&self) -> Vec<RowSummary> {
        self.list_all_user_ids()
            .into_iter()
            .map(|user_id| {
                let frozen = self.is_ambassador_frozen(&user_id);
                RowSummary {
                    user_id,
                    status: if frozen { "frozen" } else { "active" },
                    is_active: !frozen,
                    is_frozen: frozen,
                }
            })
            .collect()
    }

    pub fn programme_board_headline(&self) -> Headline {
        Headline {
            total: self.total_count(),
            active: self.active_count(),
            frozen: self.frozen_count(),
            empty: self.is_empty(),
            active_ratio: self.active_ratio(),
        }
    }

    pub fn is_programme_missing(&self, user_id: &str) -> bool {
        self.programme_row_summary(user_id).status == "missing"
    }

    pub fn filter_programme_rows(&self, status: &str) -> Vec<RowSummary> {
        self.list_programme_row_summaries()
            .into_iter()
            .filter(|r| r.status == status)
            .collect()
    }

    pub fn search_programme_user_ids(&self, needle: &str) -> Vec<String> {
        let n = js_trim(needle);
        if n.is_empty() {
            return Vec::new();
        }
        self.list_all_user_ids()
            .into_iter()
            .filter(|id| id.contains(n))
            .collect()
    }

    pub fn programme_search_has_hits(&self, needle: &str) -> bool {
        !self.search_programme_user_ids(needle).is_empty()
    }

    pub fn programme_search_hit_count(&self, needle: &str) -> i64 {
        count(self.search_programme_user_ids(needle).len())
    }

    pub fn page_programme_user_ids(
        &self,
        offset: Option<i64>,
        limit: Option<f64>,
    ) -> Result<Vec<String>, AcademyError> {
        let all = self.list_all_user_ids();
        Ok(page(&all, offset, assert_programme_page_limit(limit)?))
    }

    pub fn page_active_user_ids(
        &self,
        offset: Option<i64>,
        limit: Option<f64>,
    ) -> Result<Vec<String>, AcademyError> {
        let all = self.list_active_user_ids();
        Ok(page(&all, offset, assert_programme_page_limit(limit)?))
    }

    pub fn page_frozen_user_ids(
        &self,
        offset: Option<i64>,
        limit: Option<f64>,
    ) -> Result<Vec<String>, AcademyError> {
        let all = self.list_frozen_user_ids();
        Ok(page(&all, offset, assert_programme_page_limit(limit)?))
    }

    pub fn programme_page_count(&self, page_size: i64) -> i64 {
        page_count(self.n_total(), page_size)
    }

    pub fn programme_ids_only_here(&self, other: &[&str]) -> Vec<String> {
        self.list_all_user_ids()
            .into_iter()
            .filter(|id| !other.contains(&id.as_str()))
            .collect()
    }

    pub fn programme_ids_in_both(&self, other: &[&str]) -> Vec<String> {
        self.list_all_user_ids()
            .into_iter()
            .filter(|id| other.contains(&id.as_str()))
            .collect()
    }

    pub fn active_ids_only_here(&self, other: &[&str]) -> Vec<String> {
        self.list_active_user_ids()
            .into_iter()
            .filter(|id| !other.contains(&id.as_str()))
            .collect()
    }

    pub fn programme_same_size(&self, other_total: i64) -> bool {
        self.total_count() == other_total
    }

    pub fn safe_page_programme_user_ids(&self, offset: i64, limit: i64) -> Vec<String> {
        safe_page(&self.list_all_user_ids(), offset, limit)
    }

    pub fn clamp_programme_page_index(&self, page_index: i64, page_size: i64) -> i64 {
        clamp_page_index(self.programme_page_count(page_size), page_index)
    }

    pub fn programme_user_ids_at_page(&self, page_index: i64, page_size: i64) -> Vec<String> {
        if page_size < 1 {
            return Vec::new();
        }
        let idx = self.clamp_programme_page_index(page_index, page_size);
        self.safe_page_programme_user_ids(idx * page_size, page_size)
    }

    pub fn is_valid_programme_page(&self, page_index: i64, page_size: i64) -> bool {
        let pages = self.programme_page_count(page_size);
        pages > 0 && page_index >= 0 && page_index < pages
    }

    pub fn programme_export_lines(&self) -> Vec<String> {
        self.list_programme_row_summaries()
            .iter()
            .map(|r| format!("{},{}", r.user_id, r.status))
            .collect()
    }

    pub fn programme_export_header(&self) -> &'static str {
        "userId,status"
    }

    pub fn programme_export_text(&self) -> String {
        let mut lines = vec![self.programme_export_header().to_owned()];
        lines.extend(self.programme_export_lines());
        lines.join("\n")
    }

    pub fn programme_export_line_count(&self) -> i64 {
        1 + self.total_count()
    }

    pub fn parse_programme_export_line(&self, line: &str) -> Option<(String, &'static str)> {
        let t = js_trim(line);
        if t.is_empty() || t == self.programme_export_header() {
            return None;
        }
        let parts: Vec<&str> = t.split(',').collect();
        let [user_id, status] = parts.as_slice() else {
            return None;
        };
        let user_id = js_trim(user_id);
        if user_id.is_empty() {
            return None;
        }
        let status = match js_trim(status) {
            "active" => "active",
            "frozen" => "frozen",
            _ => return None,
        };
        Some((user_id.to_owned(), status))
    }

    pub fn count_programme_export_data_lines(&self, text: &str) -> i64 {
        count(
            text.split('\n')
                .filter_map(|l| self.parse_programme_export_line(l))
                .count(),
        )
    }

    pub fn programme_export_has_header(&self, text: &str) -> bool {
        text.split('\n').next().map(js_trim) == Some(self.programme_export_header())
    }

    pub fn programme_export_round_trip_ok(&self) -> bool {
        self.programme_export_line_count()
            == 1 + self.count_programme_export_data_lines(&self.programme_export_text())
    }

    pub fn programme_status_line(&self) -> String {
        let h = self.programme_board_headline();
        format!("active={} frozen={} total={}", h.active, h.frozen, h.total)
    }

    pub fn programme_status_line_is_empty(&self) -> bool {
        self.programme_status_line().ends_with("total=0")
    }

    pub fn programme_status_line_with_ratio(&self) -> String {
        match self.programme_board_headline().active_ratio {
            None => self.programme_status_line(),
            Some(r) => format!("{} activeRatio={r}", self.programme_status_line()),
        }
    }

    pub fn programme_status_line_token_count(&self) -> i64 {
        count(self.programme_status_line().split_whitespace().count())
    }

    pub fn parse_programme_status_line(&self, line: &str) -> Option<Counts> {
        let v = parse_counts(line, &["active", "frozen", "total"])?;
        let [active, frozen, total] = v.as_slice() else {
            return None;
        };
        Some(Counts {
            active: *active,
            frozen: *frozen,
            total: *total,
        })
    }

    pub fn programme_status_line_matches_store(&self) -> bool {
        self.parse_programme_status_line(&self.programme_status_line())
            .is_some_and(|p| {
                p.active == self.active_count()
                    && p.frozen == self.frozen_count()
                    && p.total == self.total_count()
            })
    }

    /// `parseProgrammeStatusLineWithRatio`: the counts and the `activeRatio=d.dddd` suffix when present.
    pub fn parse_programme_status_line_with_ratio(
        &self,
        line: &str,
    ) -> Option<(Counts, Option<String>)> {
        let t = js_trim(line);
        let (head, ratio) = match t.split_once(" activeRatio=") {
            Some((head, r)) => {
                let (int, frac) = r.split_once('.')?;
                let digits = |s: &str| !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit());
                if !digits(int) || frac.len() != 4 || !digits(frac) {
                    return None;
                }
                (head, Some(r.to_owned()))
            }
            None => (t, None),
        };
        Some((self.parse_programme_status_line(head)?, ratio))
    }

    pub fn programme_status_line_consistent(&self, line: &str) -> bool {
        self.parse_programme_status_line(line)
            .is_some_and(|p| p.total == p.active + p.frozen)
    }

    pub fn active_count_in_range(&self, min: i64, max: i64) -> bool {
        min <= max && (min..=max).contains(&self.active_count())
    }

    pub fn frozen_share_at_least(&self, percent: usize) -> bool {
        self.frozen_share_percent().is_some_and(|p| p >= percent)
    }

    pub fn clamp_programme_page_size(&self, page_size: i64) -> i64 {
        page_size.clamp(1, self.total_count().max(1))
    }

    pub fn density_exceeds(&self, n: i64) -> bool {
        self.total_count() > n
    }
}

/// `applicationStatusSnapshot()` and `residencyQueueHeadline()`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct QueueCounts {
    pub total: i64,
    pub open: i64,
    pub decided: i64,
    pub accepted: i64,
    pub rejected: i64,
    pub withdrawn: i64,
}

/// `cohortSummary(slug)`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CohortSummary {
    pub cohort_slug: String,
    pub applied: i64,
    pub accepted: i64,
    pub rejected: i64,
    pub withdrawn: i64,
    pub total: i64,
}

/// `MemoryResidencyDesk`: apply, decide and withdraw; ids are `res-N`.
#[derive(Debug, Default)]
pub struct MemoryResidencyDesk {
    rows: Vec<ResidencyApplication>,
    seq: u64,
}

impl MemoryResidencyDesk {
    pub fn new() -> Self {
        Self::default()
    }

    fn set(&mut self, row: ResidencyApplication) {
        match self.rows.iter_mut().find(|r| r.id == row.id) {
            Some(slot) => *slot = row,
            None => self.rows.push(row),
        }
    }

    fn row(&self, id: &str) -> Option<&ResidencyApplication> {
        self.rows.iter().find(|r| r.id == id)
    }

    fn n(&self, status: &str) -> usize {
        self.rows.iter().filter(|r| r.status == status).count()
    }

    fn ids(&self, status: &str) -> Vec<String> {
        sorted(
            self.rows
                .iter()
                .filter(|r| r.status == status)
                .map(|r| r.id.clone())
                .collect(),
        )
    }

    pub fn apply(
        &mut self,
        user_id: &str,
        cohort_slug: &str,
        statement: &str,
        now: Option<i64>,
    ) -> Result<ResidencyApplication, AcademyError> {
        let cohort_slug = assert_cohort_slug(cohort_slug)?;
        let statement = assert_statement(statement)?;
        let user_id = js_trim(user_id);
        if user_id.is_empty() {
            return Err(AcademyError::new(
                "userId required",
                "academy.residency_invalid",
            ));
        }
        if self
            .rows
            .iter()
            .any(|r| r.user_id == user_id && r.cohort_slug == cohort_slug && r.status == "applied")
        {
            return Err(AcademyError::new(
                "Open application already exists for this cohort",
                "academy.residency_already_open",
            ));
        }
        self.seq += 1;
        let row = ResidencyApplication {
            id: format!("res-{}", self.seq),
            user_id: user_id.to_owned(),
            cohort_slug,
            statement,
            status: "applied".to_owned(),
            applied_at: now.unwrap_or_else(now_ms),
            decided_at: None,
            decided_by: None,
            decision_note: None,
        };
        self.set(row.clone());
        Ok(row)
    }

    pub fn decide(
        &mut self,
        id: &str,
        operator_id: &str,
        decision: &str,
        note: Option<&str>,
        now: Option<i64>,
    ) -> Result<ResidencyApplication, AcademyError> {
        let Some(row) = self.row(id) else {
            return Err(AcademyError::new(
                "Application not found",
                "academy.residency_not_found",
            ));
        };
        if row.status != "applied" {
            return Err(AcademyError::new(
                format!("Application is {}", row.status),
                "academy.residency_not_pending",
            ));
        }
        let operator_id = js_trim(operator_id);
        if operator_id.is_empty() {
            return Err(AcademyError::new(
                "operatorId required",
                "academy.residency_invalid",
            ));
        }
        let next = ResidencyApplication {
            status: decision.to_owned(),
            decided_at: Some(now.unwrap_or_else(now_ms)),
            decided_by: Some(operator_id.to_owned()),
            decision_note: decision_note(note),
            ..row.clone()
        };
        self.set(next.clone());
        Ok(next)
    }

    pub fn list_by_user(&self, user_id: &str) -> Vec<&ResidencyApplication> {
        self.rows.iter().filter(|r| r.user_id == user_id).collect()
    }

    pub fn list_open(&self, cohort_slug: Option<&str>) -> Vec<&ResidencyApplication> {
        self.rows
            .iter()
            .filter(|r| {
                r.status == "applied"
                    && cohort_slug
                        .filter(|s| !s.is_empty())
                        .is_none_or(|s| r.cohort_slug == s)
            })
            .collect()
    }

    pub fn list_accepted(&self, cohort_slug: Option<&str>) -> Vec<&ResidencyApplication> {
        self.rows
            .iter()
            .filter(|r| {
                r.status == "accepted"
                    && cohort_slug
                        .filter(|s| !s.is_empty())
                        .is_none_or(|s| r.cohort_slug == s)
            })
            .collect()
    }

    pub fn cohort_summary(&self, cohort_slug: &str) -> Result<CohortSummary, AcademyError> {
        let slug = assert_cohort_slug(cohort_slug)?;
        let of = |status: &str| {
            count(
                self.rows
                    .iter()
                    .filter(|r| r.cohort_slug == slug && r.status == status)
                    .count(),
            )
        };
        let (applied, accepted, rejected, withdrawn) = (
            of("applied"),
            of("accepted"),
            of("rejected"),
            of("withdrawn"),
        );
        Ok(CohortSummary {
            cohort_slug: slug.clone(),
            applied,
            accepted,
            rejected,
            withdrawn,
            total: applied + accepted + rejected + withdrawn,
        })
    }

    pub fn open_for_user(&self, user_id: &str) -> Vec<&ResidencyApplication> {
        let id = js_trim(user_id);
        if id.is_empty() {
            return Vec::new();
        }
        self.rows
            .iter()
            .filter(|r| r.user_id == id && r.status == "applied")
            .collect()
    }

    pub fn withdraw(
        &mut self,
        id: &str,
        user_id: &str,
        now: Option<i64>,
    ) -> Result<ResidencyApplication, AcademyError> {
        let user_id = js_trim(user_id);
        let row = self
            .row(id)
            .filter(|r| r.user_id == user_id)
            .ok_or_else(|| {
                AcademyError::new("Application not found", "academy.residency_not_found")
            })?;
        if row.status != "applied" {
            return Err(AcademyError::new(
                format!("Application is {}", row.status),
                "academy.residency_not_pending",
            ));
        }
        let next = ResidencyApplication {
            status: "withdrawn".to_owned(),
            decided_at: Some(now.unwrap_or_else(now_ms)),
            decided_by: Some(user_id.to_owned()),
            decision_note: Some("withdrawn by applicant".to_owned()),
            ..row.clone()
        };
        self.set(next.clone());
        Ok(next)
    }

    pub fn known_cohort_slugs(&self) -> Vec<String> {
        let set: BTreeSet<String> = self.rows.iter().map(|r| r.cohort_slug.clone()).collect();
        set.into_iter().collect()
    }

    pub fn open_count(&self) -> i64 {
        count(self.n("applied"))
    }

    pub fn accepted_count(&self) -> i64 {
        count(self.n("accepted"))
    }

    pub fn open_application_ids(&self) -> Vec<String> {
        self.ids("applied")
    }

    pub fn rejected_count(&self) -> i64 {
        count(self.n("rejected"))
    }

    pub fn withdrawn_count(&self) -> i64 {
        count(self.n("withdrawn"))
    }

    pub fn rejected_application_ids(&self) -> Vec<String> {
        self.ids("rejected")
    }

    pub fn accepted_application_ids(&self) -> Vec<String> {
        self.ids("accepted")
    }

    pub fn withdrawn_application_ids(&self) -> Vec<String> {
        self.ids("withdrawn")
    }

    pub fn application_count(&self) -> i64 {
        count(self.rows.len())
    }

    pub fn has_open_application(&self, user_id: &str) -> bool {
        !self.open_for_user(user_id).is_empty()
    }

    pub fn open_application_count(&self, user_id: &str) -> i64 {
        count(self.open_for_user(user_id).len())
    }

    pub fn rejected_application_count(&self) -> i64 {
        self.rejected_count()
    }

    pub fn accepted_application_count(&self) -> i64 {
        self.accepted_count()
    }

    pub fn withdrawn_application_count(&self) -> i64 {
        self.withdrawn_count()
    }

    pub fn applied_application_count(&self) -> i64 {
        self.open_count()
    }

    pub fn applied_application_ids(&self) -> Vec<String> {
        self.open_application_ids()
    }

    pub fn open_application_ratio(&self) -> Option<String> {
        fixed4(self.n("applied"), self.rows.len())
    }

    pub fn has_any_application(&self) -> bool {
        !self.rows.is_empty()
    }

    pub fn has_no_open_applications(&self) -> bool {
        self.n("applied") == 0
    }

    pub fn accepted_application_ratio(&self) -> Option<String> {
        fixed4(self.n("accepted"), self.rows.len())
    }

    pub fn rejected_application_ratio(&self) -> Option<String> {
        fixed4(self.n("rejected"), self.rows.len())
    }

    pub fn known_cohort_slugs_sorted(&self) -> Vec<String> {
        self.known_cohort_slugs()
    }

    pub fn has_accepted_application(&self) -> bool {
        self.n("accepted") > 0
    }

    pub fn has_rejected_application(&self) -> bool {
        self.n("rejected") > 0
    }

    pub fn withdrawn_application_ratio(&self) -> Option<String> {
        fixed4(self.n("withdrawn"), self.rows.len())
    }

    fn n_decided(&self) -> usize {
        self.n("accepted") + self.n("rejected") + self.n("withdrawn")
    }

    pub fn decided_application_count(&self) -> i64 {
        count(self.n_decided())
    }

    pub fn has_withdrawn_application(&self) -> bool {
        self.n("withdrawn") > 0
    }

    pub fn decided_application_ratio(&self) -> Option<String> {
        fixed4(self.n_decided(), self.rows.len())
    }

    pub fn is_all_open(&self) -> bool {
        !self.rows.is_empty() && self.n("applied") == self.rows.len()
    }

    pub fn first_open_application_id(&self) -> Option<String> {
        self.open_application_ids().into_iter().next()
    }

    pub fn is_all_decided(&self) -> bool {
        !self.rows.is_empty() && self.n("applied") == 0
    }

    pub fn first_accepted_application_id(&self) -> Option<String> {
        self.accepted_application_ids().into_iter().next()
    }

    pub fn first_rejected_application_id(&self) -> Option<String> {
        self.rejected_application_ids().into_iter().next()
    }

    pub fn cohort_count(&self) -> i64 {
        count(self.known_cohort_slugs_sorted().len())
    }

    pub fn last_open_application_id(&self) -> Option<String> {
        self.open_application_ids().pop()
    }

    pub fn last_accepted_application_id(&self) -> Option<String> {
        self.accepted_application_ids().pop()
    }

    pub fn has_at_least_applications(&self, n: i64) -> bool {
        n >= 0 && self.application_count() >= n
    }

    pub fn open_minus_decided(&self) -> i64 {
        self.open_count() - self.decided_application_count()
    }

    pub fn application_count_label(&self) -> String {
        self.rows.len().to_string()
    }

    pub fn open_count_label(&self) -> String {
        self.n("applied").to_string()
    }

    pub fn is_majority_open_or_tie(&self) -> bool {
        half_or_more(self.n("applied"), self.rows.len())
    }

    pub fn open_application_ids_joined(&self) -> String {
        self.open_application_ids().join(",")
    }

    pub fn accepted_application_ids_joined(&self) -> String {
        self.accepted_application_ids().join(",")
    }

    pub fn rejected_application_ids_joined(&self) -> String {
        self.rejected_application_ids().join(",")
    }

    pub fn withdrawn_application_ids_joined(&self) -> String {
        self.withdrawn_application_ids().join(",")
    }

    pub fn known_cohorts_joined(&self) -> String {
        self.known_cohort_slugs_sorted().join(",")
    }

    pub fn open_application_ratio_label(&self) -> String {
        self.open_application_ratio().unwrap_or_default()
    }

    pub fn accepted_application_ratio_label(&self) -> String {
        self.accepted_application_ratio().unwrap_or_default()
    }

    pub fn rejected_application_ratio_label(&self) -> String {
        self.rejected_application_ratio().unwrap_or_default()
    }

    pub fn withdrawn_application_ratio_label(&self) -> String {
        self.withdrawn_application_ratio().unwrap_or_default()
    }

    pub fn residency_queue_headline(&self) -> QueueCounts {
        QueueCounts {
            total: self.application_count(),
            open: self.open_count(),
            decided: self.decided_application_count(),
            accepted: self.accepted_count(),
            rejected: self.rejected_count(),
            withdrawn: self.withdrawn_count(),
        }
    }

    /// `applicationStatusSnapshot()`: its `total` against its four parts.
    pub fn application_counts_consistent(&self) -> bool {
        let s = self.residency_queue_headline();
        s.total == s.open + s.accepted + s.rejected + s.withdrawn
    }

    pub fn open_share_percent(&self) -> Option<usize> {
        share_percent(self.n("applied"), self.rows.len())
    }

    pub fn decided_share_percent(&self) -> Option<usize> {
        share_percent(self.n_decided(), self.rows.len())
    }

    pub fn application_status_of(&self, id: &str) -> Option<&str> {
        self.row(id).map(|r| r.status.as_str())
    }

    pub fn is_application_open(&self, id: &str) -> bool {
        self.application_status_of(id) == Some("applied")
    }

    pub fn is_application_decided(&self, id: &str) -> bool {
        self.application_status_of(id)
            .is_some_and(|s| s != "applied")
    }

    pub fn filter_application_ids_by_status(&self, status: &str) -> Vec<String> {
        self.ids(status)
    }

    pub fn search_application_ids(&self, needle: &str) -> Vec<String> {
        let n = js_trim(needle);
        if n.is_empty() {
            return Vec::new();
        }
        sorted(
            self.rows
                .iter()
                .filter(|r| r.id.contains(n))
                .map(|r| r.id.clone())
                .collect(),
        )
    }

    pub fn list_application_ids_for_cohort(&self, cohort_slug: &str) -> Vec<String> {
        let slug = js_trim(cohort_slug).to_lowercase();
        if slug.is_empty() {
            return Vec::new();
        }
        sorted(
            self.rows
                .iter()
                .filter(|r| r.cohort_slug == slug)
                .map(|r| r.id.clone())
                .collect(),
        )
    }

    pub fn open_count_for_cohort(&self, cohort_slug: &str) -> i64 {
        let slug = js_trim(cohort_slug).to_lowercase();
        if slug.is_empty() {
            return 0;
        }
        count(self.list_open(Some(&slug)).len())
    }

    fn all_ids(&self) -> Vec<String> {
        sorted(self.rows.iter().map(|r| r.id.clone()).collect())
    }

    pub fn page_open_application_ids(
        &self,
        offset: Option<i64>,
        limit: Option<f64>,
    ) -> Result<Vec<String>, AcademyError> {
        Ok(page(
            &self.open_application_ids(),
            offset,
            assert_residency_page_limit(limit)?,
        ))
    }

    pub fn page_accepted_application_ids(
        &self,
        offset: Option<i64>,
        limit: Option<f64>,
    ) -> Result<Vec<String>, AcademyError> {
        Ok(page(
            &self.accepted_application_ids(),
            offset,
            assert_residency_page_limit(limit)?,
        ))
    }

    pub fn page_all_application_ids(
        &self,
        offset: Option<i64>,
        limit: Option<f64>,
    ) -> Result<Vec<String>, AcademyError> {
        Ok(page(
            &self.all_ids(),
            offset,
            assert_residency_page_limit(limit)?,
        ))
    }

    pub fn open_queue_page_count(&self, page_size: i64) -> i64 {
        page_count(self.n("applied"), page_size)
    }

    pub fn application_ids_only_here(&self, other: &[&str]) -> Vec<String> {
        self.all_ids()
            .into_iter()
            .filter(|id| !other.contains(&id.as_str()))
            .collect()
    }

    pub fn open_ids_only_here(&self, other: &[&str]) -> Vec<String> {
        self.open_application_ids()
            .into_iter()
            .filter(|id| !other.contains(&id.as_str()))
            .collect()
    }

    pub fn open_count_equals(&self, other_open_count: i64) -> bool {
        self.open_count() == other_open_count
    }

    pub fn cohorts_only_here(&self, other: &[&str]) -> Vec<String> {
        self.known_cohort_slugs_sorted()
            .into_iter()
            .filter(|c| !other.contains(&c.as_str()))
            .collect()
    }

    pub fn safe_page_open_application_ids(&self, offset: i64, limit: i64) -> Vec<String> {
        safe_page(&self.open_application_ids(), offset, limit)
    }

    pub fn clamp_open_queue_page_index(&self, page_index: i64, page_size: i64) -> i64 {
        clamp_page_index(self.open_queue_page_count(page_size), page_index)
    }

    pub fn open_application_ids_at_page(&self, page_index: i64, page_size: i64) -> Vec<String> {
        if page_size < 1 {
            return Vec::new();
        }
        let idx = self.clamp_open_queue_page_index(page_index, page_size);
        self.safe_page_open_application_ids(idx * page_size, page_size)
    }

    pub fn is_valid_open_queue_page(&self, page_index: i64, page_size: i64) -> bool {
        let pages = self.open_queue_page_count(page_size);
        pages > 0 && page_index >= 0 && page_index < pages
    }

    pub fn residency_export_lines(&self) -> Vec<String> {
        sorted(
            self.rows
                .iter()
                .map(|r| format!("{},{},{}", r.id, r.status, r.cohort_slug))
                .collect(),
        )
    }

    pub fn residency_export_header(&self) -> &'static str {
        "id,status,cohortSlug"
    }

    pub fn residency_export_text(&self) -> String {
        let mut lines = vec![self.residency_export_header().to_owned()];
        lines.extend(self.residency_export_lines());
        lines.join("\n")
    }

    pub fn residency_export_line_count(&self) -> i64 {
        1 + self.application_count()
    }

    pub fn parse_residency_export_line(
        &self,
        line: &str,
    ) -> Option<(String, &'static str, String)> {
        let t = js_trim(line);
        if t.is_empty() || t == self.residency_export_header() {
            return None;
        }
        let parts: Vec<&str> = t.split(',').collect();
        let [id, status, cohort] = parts.as_slice() else {
            return None;
        };
        let (id, cohort) = (js_trim(id), js_trim(cohort));
        if id.is_empty() || cohort.is_empty() {
            return None;
        }
        let status = match js_trim(status) {
            "applied" => "applied",
            "accepted" => "accepted",
            "rejected" => "rejected",
            "withdrawn" => "withdrawn",
            _ => return None,
        };
        Some((id.to_owned(), status, cohort.to_owned()))
    }

    pub fn count_residency_export_data_lines(&self, text: &str) -> i64 {
        count(
            text.split('\n')
                .filter_map(|l| self.parse_residency_export_line(l))
                .count(),
        )
    }

    pub fn residency_export_has_header(&self, text: &str) -> bool {
        text.split('\n').next().map(js_trim) == Some(self.residency_export_header())
    }

    pub fn residency_export_round_trip_ok(&self) -> bool {
        self.residency_export_line_count()
            == 1 + self.count_residency_export_data_lines(&self.residency_export_text())
    }

    pub fn residency_status_line(&self) -> String {
        let h = self.residency_queue_headline();
        format!("open={} decided={} total={}", h.open, h.decided, h.total)
    }

    pub fn residency_status_line_is_empty(&self) -> bool {
        self.residency_status_line().ends_with("total=0")
    }

    pub fn residency_status_line_detailed(&self) -> String {
        let h = self.residency_queue_headline();
        format!(
            "open={} accepted={} rejected={} withdrawn={} total={}",
            h.open, h.accepted, h.rejected, h.withdrawn, h.total
        )
    }

    pub fn residency_status_line_token_count(&self) -> i64 {
        count(
            self.residency_status_line_detailed()
                .split_whitespace()
                .count(),
        )
    }

    /// `parseResidencyStatusLine`: `(open, decided, total)`.
    pub fn parse_residency_status_line(&self, line: &str) -> Option<(i64, i64, i64)> {
        let v = parse_counts(line, &["open", "decided", "total"])?;
        let [open, decided, total] = v.as_slice() else {
            return None;
        };
        Some((*open, *decided, *total))
    }

    pub fn residency_status_line_matches_store(&self) -> bool {
        self.parse_residency_status_line(&self.residency_status_line())
            .is_some_and(|(open, decided, total)| {
                open == self.open_count()
                    && decided == self.decided_application_count()
                    && total == self.application_count()
            })
    }

    /// `parseResidencyStatusLineDetailed`: `[open, accepted, rejected, withdrawn, total]`.
    pub fn parse_residency_status_line_detailed(&self, line: &str) -> Option<Vec<i64>> {
        parse_counts(
            line,
            &["open", "accepted", "rejected", "withdrawn", "total"],
        )
    }

    pub fn residency_status_line_detailed_consistent(&self, line: &str) -> bool {
        match self.parse_residency_status_line_detailed(line).as_deref() {
            Some([open, accepted, rejected, withdrawn, total]) => {
                *total == open + accepted + rejected + withdrawn
            }
            _ => false,
        }
    }

    pub fn open_count_in_range(&self, min: i64, max: i64) -> bool {
        min <= max && (min..=max).contains(&self.open_count())
    }

    pub fn open_share_at_least(&self, percent: usize) -> bool {
        self.open_share_percent().is_some_and(|p| p >= percent)
    }

    pub fn clamp_open_queue_page_size(&self, page_size: i64) -> i64 {
        page_size.clamp(1, self.open_count().max(1))
    }

    pub fn application_density_exceeds(&self, n: i64) -> bool {
        self.application_count() > n
    }
}

#[cfg(test)]
mod tests {
    //! `programme.test.ts`, `unfreeze.test.ts`, `residency.test.ts` and the programme and residency `it`s of
    //! `list-limit-unset.test.ts`, against the in-memory desks.
    #![allow(clippy::unwrap_used, reason = "a test")]

    use service_kit::json::Json;

    use super::*;
    use crate::programme::ambassadors::ifc_pay::{
        decide_public_residency_pay_quote, pay_looks_payable,
    };
    use crate::programme::ambassadors::rate_law::UNPUBLISHED_IFC_PAY_LAW;

    const U1: &str = "11111111-1111-4111-8111-111111111111";
    const U2: &str = "33333333-3333-4333-8333-333333333333";
    const U3: &str = "44444444-4444-4444-8444-444444444444";
    const OP: &str = "22222222-2222-4222-8222-222222222222";
    const OP_B: &str = "44444444-4444-4444-8444-444444444444";
    const STATEMENT: &str = "I host weekly risk-first lobbies and can commit six hours a week.";
    /// `2026-08-05T00:00:00Z`.
    const AUG5: i64 = 1_785_888_000_000;
    /// `2026-08-05T12:00:00.000Z`.
    const NOW: i64 = 1_785_931_200_000;

    fn two_one_frozen() -> MemoryAmbassadorProgramme {
        let mut d = MemoryAmbassadorProgramme::new();
        d.appoint(U1, OP, None).unwrap();
        d.appoint(U2, OP, None).unwrap();
        d.freeze(U2, OP, "hold", None).unwrap();
        d
    }

    fn applied(d: &mut MemoryResidencyDesk, user: &str) -> ResidencyApplication {
        d.apply(user, "bali-2026", STATEMENT, Some(NOW)).unwrap()
    }

    #[test]
    fn the_test_clock_constants_are_the_typescript_dates() {
        assert_eq!(
            service_kit::time::Instant(AUG5).iso(),
            "2026-08-05T00:00:00.000Z"
        );
        assert_eq!(
            service_kit::time::Instant(NOW).iso(),
            "2026-08-05T12:00:00.000Z"
        );
    }

    #[test]
    fn appoint_freeze_unfreeze_and_the_badge_tracks_active_only() {
        let mut d = MemoryAmbassadorProgramme::new();
        d.appoint(U1, OP, Some(AUG5)).unwrap();
        assert!(d.badge(U1).is_ambassador);
        d.freeze(U1, OP, "policy hold", None).unwrap();
        assert!(!d.badge(U1).is_ambassador);
        assert_eq!(d.list(Some("frozen")).len(), 1);
        d.unfreeze(U1).unwrap();
        assert!(d.badge(U1).is_ambassador);
        assert!(d.appoint(U1, OP, None).is_err());
    }

    #[test]
    fn re_appoint_of_a_frozen_row_refuses_and_keeps_the_freeze_audit() {
        let mut d = MemoryAmbassadorProgramme::new();
        d.appoint(U1, OP, Some(AUG5)).unwrap();
        d.freeze(U1, OP, "policy hold", None).unwrap();
        let frozen = d.get(U1).unwrap().clone();
        assert_eq!(frozen.freeze_reason.as_deref(), Some("policy hold"));
        assert_eq!(frozen.frozen_by.as_deref(), Some(OP));
        let e = d.appoint(U1, U2, None).unwrap_err();
        assert_eq!(e.code, "academy.ambassador_already_frozen");
        assert!(e.message.to_lowercase().contains("unfreeze"));
        let still = d.get(U1).unwrap();
        assert_eq!(still.status, "frozen");
        assert_eq!(still.freeze_reason.as_deref(), Some("policy hold"));
        assert_eq!(still.frozen_by.as_deref(), Some(OP));
        assert_eq!(still.frozen_at, frozen.frozen_at);
    }

    #[test]
    fn badges_of_and_active_count() {
        let mut d = MemoryAmbassadorProgramme::new();
        d.appoint(U1, OP, None).unwrap();
        let badges = d.badges_of(&[U1, U2]);
        assert!(badges.first().unwrap().is_ambassador);
        assert!(!badges.get(1).unwrap().is_ambassador);
        assert_eq!(d.active_count(), 1);
    }

    #[test]
    fn status_histogram_counts_only_stored_rows() {
        let empty = MemoryAmbassadorProgramme::new();
        assert_eq!(
            empty.status_histogram(),
            Counts {
                active: 0,
                frozen: 0,
                total: 0
            }
        );
        assert_eq!(
            two_one_frozen().status_histogram(),
            Counts {
                active: 1,
                frozen: 1,
                total: 2
            }
        );
    }

    #[test]
    fn active_and_frozen_ids_are_sorted_and_reasons_never_invented() {
        let mut d = MemoryAmbassadorProgramme::new();
        assert!(d.list_active_user_ids().is_empty());
        assert!(d.frozen_user_ids().is_empty());
        assert_eq!(d.freeze_reason_of(U1), None);
        d.appoint(U2, OP, None).unwrap();
        d.appoint(U1, OP, None).unwrap();
        assert_eq!(d.list_active_user_ids(), [U1, U2]);
        d.freeze(U2, OP, "policy hold", None).unwrap();
        assert_eq!(d.frozen_user_ids(), [U2]);
        assert_eq!(d.freeze_reason_of(U2).as_deref(), Some("policy hold"));
        assert_eq!(d.freeze_reason_of(U1), None);
        d.freeze(U1, OP, "hold", None).unwrap();
        assert_eq!(d.list_frozen_user_ids(), [U1, U2]);
    }

    #[test]
    fn is_active_ambassador_appointing_operators_and_count_appointed_by() {
        let mut d = MemoryAmbassadorProgramme::new();
        assert!(!d.is_active_ambassador(U1));
        assert_eq!(d.count_appointed_by(OP), 0);
        d.appoint(U1, OP_B, None).unwrap();
        d.appoint(U2, OP, None).unwrap();
        assert!(d.is_active_ambassador(U1));
        d.freeze(U1, OP_B, "pause", None).unwrap();
        assert!(!d.is_active_ambassador(U1));
        assert_eq!(d.appointing_operators(), [OP, OP_B]);
        assert_eq!(d.count_appointed_by(OP), 1);
        assert_eq!(d.count_appointed_by(OP_B), 1);
        assert_eq!(d.count_appointed_by(""), 0);
    }

    #[test]
    fn counts_flags_and_ratios() {
        let mut d = MemoryAmbassadorProgramme::new();
        assert_eq!(d.frozen_count(), 0);
        assert!(!d.is_ambassador_frozen(U1));
        assert!(d.is_empty());
        assert_eq!(d.active_ratio(), None);
        assert_eq!(d.frozen_ratio(), None);
        assert!(!d.has_any_programme_row());
        assert_eq!(d.programme_user_count(), 0);
        assert_eq!(d.frozen_programme_count(), 0);
        assert!(d.frozen_programme_ids().is_empty());
        assert!(d.active_programme_ids().is_empty());
        assert!(!d.is_programme_active(U1));
        d.appoint(U1, OP, None).unwrap();
        assert!(!d.is_ambassador_frozen(U1));
        assert!(d.is_programme_active(U1));
        assert!(!d.is_empty());
        assert_eq!(d.active_ratio().as_deref(), Some("1.0000"));
        assert_eq!(d.active_programme_ids(), [U1]);
        d.freeze(U1, OP, "policy hold", None).unwrap();
        assert!(d.is_ambassador_frozen(U1));
        assert_eq!(d.frozen_count(), 1);
        assert_eq!(d.active_ratio().as_deref(), Some("0.0000"));
        assert_eq!(d.frozen_programme_ids(), [U1]);
        let two = two_one_frozen();
        assert!(two.has_any_programme_row());
        assert_eq!(two.frozen_ratio().as_deref(), Some("0.5000"));
    }

    #[test]
    fn all_ids_and_total_count() {
        let mut d = MemoryAmbassadorProgramme::new();
        assert!(d.list_all_user_ids().is_empty());
        assert_eq!(d.total_count(), 0);
        d.appoint(U2, OP, None).unwrap();
        d.appoint(U1, OP, None).unwrap();
        assert_eq!(d.total_count(), 2);
        assert_eq!(d.list_all_user_ids(), [U1, U2]);
    }

    #[test]
    fn statuses_present_partitions_singles_and_majorities() {
        let mut d = MemoryAmbassadorProgramme::new();
        assert_eq!(d.active_programme_count(), 0);
        assert!(!d.has_frozen_ambassador() && !d.has_active_ambassador());
        assert!(d.list_statuses_present().is_empty());
        assert!(!d.is_fully_frozen() && !d.is_fully_active());
        assert_eq!(d.programme_active_ratio(), None);
        assert_eq!(d.list_partitioned_user_ids(), (vec![], vec![]));
        assert!(!d.has_single_active() && !d.has_single_frozen());
        assert_eq!(d.first_active_user_id(), None);
        assert_eq!(d.first_frozen_user_id(), None);
        assert_eq!(d.last_active_user_id(), None);
        assert_eq!(d.last_frozen_user_id(), None);
        assert_eq!(d.inactive_programme_count(), 0);
        assert!(!d.majority_active() && !d.majority_frozen());
        assert_eq!(d.active_minus_frozen(), 0);
        assert!(!d.is_active_frozen_balanced());
        assert_eq!(d.programme_density(), 0);
        d.appoint(U1, OP, None).unwrap();
        assert!(d.has_single_active());
        assert_eq!(d.first_active_user_id().as_deref(), Some(U1));
        d.appoint(U2, OP, None).unwrap();
        assert!(d.is_fully_active());
        assert!(d.majority_active());
        assert_eq!(d.last_active_user_id().as_deref(), Some(U2));
        d.freeze(U2, OP, "hold", None).unwrap();
        assert_eq!(d.active_programme_count(), 1);
        assert!(d.has_frozen_ambassador() && d.has_active_ambassador());
        assert_eq!(d.list_statuses_present(), ["active", "frozen"]);
        assert!(!d.is_fully_frozen());
        assert_eq!(d.programme_active_ratio().as_deref(), Some("0.5000"));
        assert_eq!(
            d.list_partitioned_user_ids(),
            (vec![U1.to_owned()], vec![U2.to_owned()])
        );
        assert!(d.has_single_active() && d.has_single_frozen());
        assert_eq!(d.inactive_programme_count(), 1);
        assert_eq!(d.active_minus_frozen(), 0);
        assert!(d.is_active_frozen_balanced());
        assert_eq!(d.last_frozen_user_id().as_deref(), Some(U2));
        assert_eq!(d.programme_density(), 2);
        d.freeze(U1, OP, "hold", None).unwrap();
        assert!(d.majority_frozen());
        assert_eq!(d.first_frozen_user_id().as_deref(), Some(U1));
    }

    #[test]
    fn labels_ties_joins_and_shares() {
        let d = MemoryAmbassadorProgramme::new();
        assert!(!d.has_at_least_users(1));
        assert_eq!(
            (
                d.active_count_label(),
                d.frozen_count_label(),
                d.total_count_label()
            ),
            ("0".into(), "0".into(), "0".into())
        );
        assert!(!d.has_both_statuses());
        assert!(!d.is_majority_active_or_tie());
        assert_eq!(d.active_user_ids_joined(), "");
        assert_eq!(d.frozen_user_ids_joined(), "");
        assert_eq!(d.all_user_ids_joined(), "");
        assert_eq!(d.statuses_present_joined(), "");
        assert!(d.is_programme_empty_label());
        assert_eq!(d.active_ratio_label(), "");
        assert_eq!(d.frozen_ratio_label(), "");
        assert!(!d.has_inactive_rows());
        assert_eq!(
            d.programme_count_snapshot(),
            Counts {
                active: 0,
                frozen: 0,
                total: 0
            }
        );
        assert!(d.programme_counts_consistent());
        assert_eq!(d.active_share_percent(), None);
        let d = two_one_frozen();
        assert!(d.has_at_least_users(2));
        assert_eq!(
            (
                d.active_count_label(),
                d.frozen_count_label(),
                d.total_count_label()
            ),
            ("1".into(), "1".into(), "2".into())
        );
        assert!(d.has_both_statuses());
        assert!(d.is_majority_active_or_tie() && d.is_majority_frozen_or_tie());
        assert_eq!(d.active_user_ids_joined(), U1);
        assert_eq!(d.frozen_user_ids_joined(), U2);
        let joined = d.all_user_ids_joined();
        let mut all: Vec<&str> = joined.split(',').collect();
        all.sort_unstable();
        assert_eq!(all, [U1, U2]);
        assert_eq!(d.statuses_present_joined(), "active,frozen");
        assert!(!d.is_programme_empty_label());
        assert_eq!(d.active_ratio_label(), "0.5000");
        assert_eq!(d.frozen_ratio_label(), "0.5000");
        assert_eq!(d.programme_active_ratio_label(), "0.5000");
        assert!(d.has_inactive_rows());
        assert_eq!(
            d.programme_count_snapshot(),
            Counts {
                active: 1,
                frozen: 1,
                total: 2
            }
        );
        assert!(d.programme_counts_consistent());
        assert_eq!(d.active_share_percent(), Some(50));
        assert_eq!(d.frozen_share_percent(), Some(50));
    }

    #[test]
    fn board_headline_rows_filters_and_search() {
        let d = MemoryAmbassadorProgramme::new();
        assert!(d.programme_board_headline().empty);
        assert!(d.is_programme_missing(U1));
        assert!(d.list_programme_row_summaries().is_empty());
        assert!(d.filter_programme_rows("active").is_empty());
        assert!(d.search_programme_user_ids("").is_empty());
        assert!(!d.programme_search_has_hits("1111"));
        let d = two_one_frozen();
        let h = d.programme_board_headline();
        assert_eq!((h.total, h.active, h.frozen, h.empty), (2, 1, 1, false));
        assert_eq!(d.programme_row_summary(U1).status, "active");
        assert_eq!(d.programme_row_summary(U2).status, "frozen");
        assert_eq!(d.list_programme_row_summaries().len(), 2);
        assert!(!d.is_programme_missing(U1));
        assert_eq!(d.filter_programme_rows("active").len(), 1);
        assert_eq!(d.filter_programme_rows("frozen").len(), 1);
        assert_eq!(d.programme_search_hit_count("1111"), 1);
        assert!(d.programme_search_has_hits("3333"));
    }

    #[test]
    fn pages_diffs_and_clamps() {
        let d = MemoryAmbassadorProgramme::new();
        assert!(
            d.page_programme_user_ids(Some(0), Some(1.0))
                .unwrap()
                .is_empty()
        );
        assert_eq!(d.programme_page_count(10), 0);
        assert!(d.safe_page_programme_user_ids(-1, 5).is_empty());
        assert!(!d.is_valid_programme_page(0, 1));
        let d = two_one_frozen();
        assert_eq!(
            d.page_programme_user_ids(Some(0), Some(1.0)).unwrap().len(),
            1
        );
        assert_eq!(d.page_active_user_ids(None, Some(10.0)).unwrap(), [U1]);
        assert_eq!(d.page_frozen_user_ids(None, Some(10.0)).unwrap(), [U2]);
        assert_eq!(d.programme_page_count(1), 2);
        assert_eq!(d.programme_ids_only_here(&[U1]), [U2]);
        assert_eq!(d.programme_ids_in_both(&[U1, U2]), [U1, U2]);
        assert!(d.programme_same_size(2));
        assert_eq!(d.safe_page_programme_user_ids(0, 1).len(), 1);
        assert_eq!(d.clamp_programme_page_index(99, 1), 1);
        assert_eq!(d.programme_user_ids_at_page(0, 1).len(), 1);
        assert!(d.is_valid_programme_page(0, 1));
        assert!(!d.is_valid_programme_page(5, 1));
        let mut both = MemoryAmbassadorProgramme::new();
        both.appoint(U1, OP, None).unwrap();
        both.appoint(U2, OP, None).unwrap();
        assert_eq!(both.active_ids_only_here(&[]), [U1, U2]);
    }

    #[test]
    fn export_lines_parse_and_round_trip() {
        let mut d = MemoryAmbassadorProgramme::new();
        assert!(d.programme_export_lines().is_empty());
        assert_eq!(d.programme_export_header(), "userId,status");
        assert_eq!(d.programme_export_line_count(), 1);
        assert_eq!(d.parse_programme_export_line("userId,status"), None);
        assert_eq!(d.parse_programme_export_line("bad"), None);
        assert!(d.programme_export_has_header(&d.programme_export_text()));
        assert!(d.programme_export_round_trip_ok());
        d.appoint(U1, OP, None).unwrap();
        assert_eq!(d.programme_export_lines(), [format!("{U1},active")]);
        assert!(d.programme_export_text().contains(U1));
        assert_eq!(d.programme_export_line_count(), 2);
        assert_eq!(
            d.parse_programme_export_line(&format!("{U1},active")),
            Some((U1.to_owned(), "active"))
        );
        assert_eq!(
            d.count_programme_export_data_lines(&d.programme_export_text()),
            1
        );
        assert!(d.programme_export_round_trip_ok());
    }

    #[test]
    fn status_lines_parse_and_match() {
        let mut d = MemoryAmbassadorProgramme::new();
        assert!(d.programme_status_line_is_empty());
        assert_eq!(d.programme_status_line_token_count(), 3);
        assert_eq!(
            d.parse_programme_status_line("active=0 frozen=0 total=0"),
            Some(Counts {
                active: 0,
                frozen: 0,
                total: 0
            })
        );
        assert_eq!(d.parse_programme_status_line("bad"), None);
        assert!(d.programme_status_line_matches_store());
        assert!(d.programme_status_line_consistent(&d.programme_status_line()));
        d.appoint(U1, OP, None).unwrap();
        assert!(d.programme_status_line().contains("active=1"));
        assert!(
            d.programme_status_line_with_ratio()
                .contains("activeRatio=")
        );
        let (_, ratio) = d
            .parse_programme_status_line_with_ratio(&d.programme_status_line_with_ratio())
            .unwrap();
        assert_eq!(ratio.as_deref(), Some("1.0000"));
    }

    #[test]
    fn thresholds_and_clamps() {
        let d = MemoryAmbassadorProgramme::new();
        assert!(d.active_count_in_range(0, 0));
        assert!(!d.frozen_share_at_least(50));
        assert_eq!(d.clamp_programme_page_size(99), 1);
        assert!(!d.density_exceeds(0));
        let d = two_one_frozen();
        assert!(d.active_count_in_range(1, 1));
        assert!(d.frozen_share_at_least(50));
        assert_eq!(d.clamp_programme_page_size(99), 2);
        assert!(d.density_exceeds(1));
    }

    #[test]
    fn unfreeze_restores_the_badge_and_clears_the_freeze() {
        let (op, user) = (
            "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
            "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
        );
        let mut d = MemoryAmbassadorProgramme::new();
        d.appoint(user, op, None).unwrap();
        d.freeze(user, op, "policy review", None).unwrap();
        assert!(!d.badge(user).is_ambassador);
        assert_eq!(d.badge(user).status.as_deref(), Some("frozen"));
        let row = d.unfreeze(user).unwrap();
        assert_eq!(row.status, "active");
        assert_eq!(
            (row.freeze_reason, row.frozen_at, row.frozen_by),
            (None, None, None)
        );
        let badge = d.badge(user);
        assert!(badge.is_ambassador);
        assert_eq!(badge.status.as_deref(), Some("active"));
    }

    #[test]
    fn unfreeze_refuses_when_not_frozen_or_missing() {
        let (op, user) = (
            "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
            "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
        );
        let mut d = MemoryAmbassadorProgramme::new();
        assert!(
            d.unfreeze(user)
                .unwrap_err()
                .message
                .contains("No ambassador programme row")
        );
        d.appoint(user, op, None).unwrap();
        assert!(
            d.unfreeze(user)
                .unwrap_err()
                .message
                .to_lowercase()
                .contains("not frozen")
        );
    }

    #[test]
    fn programme_pages_refuse_an_unset_limit_and_slice_a_published_one() {
        let mut d = MemoryAmbassadorProgramme::new();
        for u in [U1, U2, U3] {
            d.appoint(u, OP, None).unwrap();
        }
        for limit in [None, Some(0.0), Some(-1.0), Some(f64::NAN)] {
            for r in [
                d.page_programme_user_ids(None, limit),
                d.page_active_user_ids(None, limit),
                d.page_frozen_user_ids(None, limit),
            ] {
                assert_eq!(r.unwrap_err().code, "academy.programme_list_limit_unset");
            }
        }
        let all = d.page_programme_user_ids(None, Some(10.0)).unwrap();
        assert_eq!(all.len(), 3);
        assert_eq!(
            d.page_programme_user_ids(Some(0), Some(2.0)).unwrap(),
            all.get(..2).unwrap()
        );
        assert_eq!(d.page_active_user_ids(None, Some(1.0)).unwrap().len(), 1);
    }

    #[test]
    fn residency_pages_refuse_an_unset_limit_and_slice_a_published_one() {
        let mut d = MemoryResidencyDesk::new();
        for u in ["u1", "u2", "u3"] {
            d.apply(u, "bali-2026", STATEMENT, None).unwrap();
        }
        for limit in [None, Some(0.0), Some(-1.0), Some(f64::NAN)] {
            for r in [
                d.page_open_application_ids(None, limit),
                d.page_accepted_application_ids(None, limit),
                d.page_all_application_ids(None, limit),
            ] {
                assert_eq!(r.unwrap_err().code, "academy.residency_list_limit_unset");
            }
        }
        let all = d.page_all_application_ids(None, Some(10.0)).unwrap();
        assert_eq!(all.len(), 3);
        assert_eq!(
            d.page_open_application_ids(Some(0), Some(2.0)).unwrap(),
            all.get(..2).unwrap()
        );
    }

    #[test]
    fn apply_then_accept_and_a_second_open_application_refuses() {
        let mut d = MemoryResidencyDesk::new();
        let a = applied(&mut d, "u1");
        assert_eq!(a.status, "applied");
        assert_eq!(
            d.apply("u1", "bali-2026", STATEMENT, Some(NOW))
                .unwrap_err()
                .code,
            "academy.residency_already_open"
        );
        let decided = d
            .decide(&a.id, "op1", "accepted", Some("strong host"), Some(NOW))
            .unwrap();
        assert_eq!(decided.status, "accepted");
        assert_eq!(decided.decided_by.as_deref(), Some("op1"));
    }

    #[test]
    fn decide_needs_a_non_blank_operator_kept_trimmed_with_its_case() {
        let mut d = MemoryResidencyDesk::new();
        let a = applied(&mut d, "u1");
        for op in ["", " ", "   ", "\t", "\n", " \t\n "] {
            for decision in ["accepted", "rejected"] {
                assert_eq!(
                    d.decide(&a.id, op, decision, None, Some(NOW))
                        .unwrap_err()
                        .code,
                    "academy.residency_invalid"
                );
            }
            let still = d
                .list_by_user("u1")
                .into_iter()
                .find(|r| r.id == a.id)
                .unwrap();
            assert_eq!(
                (
                    still.status.as_str(),
                    &still.decided_by,
                    still.decided_at,
                    &still.decision_note
                ),
                ("applied", &None, None, &None)
            );
        }
        let accepted = d
            .decide(
                &a.id,
                "  OpMix  ",
                "accepted",
                Some("strong host"),
                Some(NOW),
            )
            .unwrap();
        assert_eq!(accepted.decided_by.as_deref(), Some("OpMix"));
        let pending = applied(&mut d, "u2");
        let rejected = d
            .decide(&pending.id, "  ReJectOp  ", "rejected", None, Some(NOW))
            .unwrap();
        assert_eq!(rejected.status, "rejected");
        assert_eq!(rejected.decided_by.as_deref(), Some("ReJectOp"));
        assert_eq!(
            d.decide(&accepted.id, "OpMix", "rejected", None, Some(NOW))
                .unwrap_err()
                .code,
            "academy.residency_not_pending"
        );
        let kept = d
            .list_by_user("u1")
            .into_iter()
            .find(|r| r.id == accepted.id)
            .unwrap();
        assert_eq!(kept.decided_by.as_deref(), Some("OpMix"));
    }

    #[test]
    fn a_short_statement_refuses() {
        let mut d = MemoryResidencyDesk::new();
        assert_eq!(
            d.apply("u1", "xx", "hi", None).unwrap_err().code,
            "academy.residency_invalid"
        );
    }

    #[test]
    fn withdraw_while_applied_and_list_accepted() {
        let mut d = MemoryResidencyDesk::new();
        let a = d.apply("u1", "bali-2026", STATEMENT, None).unwrap();
        assert_eq!(d.withdraw(&a.id, "u1", None).unwrap().status, "withdrawn");
        let b = d.apply("u2", "bali-2026", STATEMENT, None).unwrap();
        d.decide(&b.id, "op", "accepted", None, None).unwrap();
        assert_eq!(d.list_accepted(Some("bali-2026")).len(), 1);
    }

    #[test]
    fn cohort_summary_open_for_user_and_known_cohorts() {
        let mut d = MemoryResidencyDesk::new();
        assert_eq!(d.cohort_summary("empty-2026").unwrap().total, 0);
        assert!(d.open_for_user("u1").is_empty());
        assert!(d.known_cohort_slugs().is_empty());
        assert_eq!(d.open_count(), 0);
        let a = d.apply("u1", "bali-2026", STATEMENT, None).unwrap();
        assert_eq!(
            d.open_for_user("u1")
                .iter()
                .map(|r| r.id.as_str())
                .collect::<Vec<_>>(),
            [a.id.as_str()]
        );
        d.decide(&a.id, "op", "accepted", None, None).unwrap();
        assert!(d.open_for_user("u1").is_empty());
        d.apply("u2", "bali-2026", STATEMENT, None).unwrap();
        let s = d.cohort_summary("bali-2026").unwrap();
        assert_eq!(
            (s.accepted, s.applied, s.total, s.rejected, s.withdrawn),
            (1, 1, 2, 0, 0)
        );
        d.apply("u3", "lisbon-2026", STATEMENT, None).unwrap();
        assert_eq!(d.known_cohort_slugs(), ["bali-2026", "lisbon-2026"]);
        assert_eq!(d.open_count(), 2);
    }

    #[test]
    fn counts_and_ids_by_status() {
        let mut d = MemoryResidencyDesk::new();
        assert_eq!(
            (
                d.accepted_count(),
                d.rejected_count(),
                d.withdrawn_count(),
                d.application_count()
            ),
            (0, 0, 0, 0)
        );
        assert!(d.open_application_ids().is_empty());
        assert!(d.rejected_application_ids().is_empty());
        assert!(d.accepted_application_ids().is_empty());
        assert!(d.withdrawn_application_ids().is_empty());
        assert!(!d.has_open_application("u1"));
        assert_eq!(d.open_application_count("u1"), 0);
        assert_eq!(
            (
                d.rejected_application_count(),
                d.accepted_application_count(),
                d.withdrawn_application_count()
            ),
            (0, 0, 0)
        );
        let a = d.apply("u1", "bali-2026", STATEMENT, None).unwrap();
        assert_eq!(d.application_count(), 1);
        assert!(d.has_open_application("u1"));
        assert_eq!(d.open_application_count("u1"), 1);
        assert_eq!(d.open_application_ids(), [a.id.as_str()]);
        d.decide(&a.id, "op", "accepted", None, None).unwrap();
        assert_eq!(d.accepted_count(), 1);
        assert_eq!(d.accepted_application_ids(), [a.id.as_str()]);
        assert!(d.open_application_ids().is_empty());
        let b = d.apply("u2", "bali-2026", STATEMENT, None).unwrap();
        d.decide(&b.id, "op", "rejected", None, None).unwrap();
        assert_eq!(d.rejected_count(), 1);
        assert_eq!(d.rejected_application_ids(), [b.id.as_str()]);
        let c = d.apply("u3", "bali-2026", STATEMENT, None).unwrap();
        d.withdraw(&c.id, "u3", None).unwrap();
        assert_eq!(d.withdrawn_count(), 1);
        assert_eq!(d.withdrawn_application_ids(), [c.id]);
    }

    #[test]
    fn ratios_flags_and_firsts() {
        let mut d = MemoryResidencyDesk::new();
        assert_eq!(
            (d.applied_application_count(), d.decided_application_count()),
            (0, 0)
        );
        assert!(d.applied_application_ids().is_empty());
        for r in [
            d.open_application_ratio(),
            d.accepted_application_ratio(),
            d.rejected_application_ratio(),
            d.withdrawn_application_ratio(),
            d.decided_application_ratio(),
        ] {
            assert_eq!(r, None);
        }
        assert!(!d.has_any_application());
        assert!(d.has_no_open_applications());
        assert!(d.known_cohort_slugs_sorted().is_empty());
        assert!(
            !d.has_accepted_application()
                && !d.has_rejected_application()
                && !d.has_withdrawn_application()
        );
        assert!(!d.is_all_open() && !d.is_all_decided());
        assert_eq!(d.first_open_application_id(), None);
        assert_eq!(d.first_accepted_application_id(), None);
        assert_eq!(d.first_rejected_application_id(), None);
        assert_eq!(d.cohort_count(), 0);
        let a = applied(&mut d, "u-w25");
        assert_eq!(d.applied_application_count(), 1);
        assert_eq!(d.applied_application_ids(), [a.id.as_str()]);
        assert_eq!(d.open_application_ratio().as_deref(), Some("1.0000"));
        assert!(d.has_any_application() && !d.has_no_open_applications());
        assert!(d.is_all_open());
        assert_eq!(d.first_open_application_id(), Some(a.id.clone()));
        d.decide(&a.id, "op1", "accepted", None, Some(NOW)).unwrap();
        assert_eq!(d.accepted_application_ratio().as_deref(), Some("1.0000"));
        assert_eq!(d.rejected_application_ratio().as_deref(), Some("0.0000"));
        assert_eq!(d.withdrawn_application_ratio().as_deref(), Some("0.0000"));
        assert_eq!(d.known_cohort_slugs_sorted(), ["bali-2026"]);
        assert!(d.has_accepted_application());
        assert_eq!(d.decided_application_count(), 1);
        let b = applied(&mut d, "u-w29b");
        d.decide(&b.id, "op1", "rejected", None, Some(NOW)).unwrap();
        assert!(d.is_all_decided());
        assert_eq!(d.first_accepted_application_id(), Some(a.id));
        assert_eq!(d.first_rejected_application_id(), Some(b.id));
        assert_eq!(d.cohort_count(), 1);
        let mut w = MemoryResidencyDesk::new();
        let c = applied(&mut w, "u-w28");
        w.withdraw(&c.id, "u-w28", None).unwrap();
        assert!(w.has_withdrawn_application());
        assert_eq!(w.decided_application_ratio().as_deref(), Some("1.0000"));
    }

    #[test]
    fn lasts_at_least_labels_and_joins() {
        let mut d = MemoryResidencyDesk::new();
        assert_eq!(d.last_open_application_id(), None);
        assert_eq!(d.last_accepted_application_id(), None);
        assert!(!d.has_at_least_applications(1));
        assert_eq!(d.open_minus_decided(), 0);
        assert_eq!(
            (d.application_count_label(), d.open_count_label()),
            ("0".into(), "0".into())
        );
        assert!(!d.is_majority_open_or_tie());
        for j in [
            d.open_application_ids_joined(),
            d.accepted_application_ids_joined(),
            d.rejected_application_ids_joined(),
            d.withdrawn_application_ids_joined(),
            d.known_cohorts_joined(),
        ] {
            assert_eq!(j, "");
        }
        for l in [
            d.open_application_ratio_label(),
            d.accepted_application_ratio_label(),
            d.rejected_application_ratio_label(),
            d.withdrawn_application_ratio_label(),
        ] {
            assert_eq!(l, "");
        }
        let a = applied(&mut d, "u-w30a");
        assert_eq!(
            (d.application_count_label(), d.open_count_label()),
            ("1".into(), "1".into())
        );
        assert!(d.is_majority_open_or_tie());
        assert_eq!(d.open_application_ids_joined(), a.id);
        assert_eq!(d.open_application_ratio_label(), "1.0000");
        let b = applied(&mut d, "u-w30b");
        assert!(d.has_at_least_applications(2));
        assert_eq!(d.open_minus_decided(), 2);
        assert_eq!(d.last_open_application_id(), Some(b.id.clone()));
        d.decide(&a.id, "op1", "accepted", None, Some(NOW)).unwrap();
        assert_eq!(d.last_accepted_application_id(), Some(a.id.clone()));
        assert_eq!(d.open_minus_decided(), 0);
        d.decide(&b.id, "op1", "rejected", None, Some(NOW)).unwrap();
        assert_eq!(d.accepted_application_ids_joined(), a.id);
        assert_eq!(d.rejected_application_ids_joined(), b.id);
        assert_eq!(d.known_cohorts_joined(), "bali-2026");
        assert_eq!(d.accepted_application_ratio_label(), "0.5000");
        assert_eq!(d.open_application_ratio_label(), "0.0000");
    }

    #[test]
    fn snapshot_shares_headline_and_status_of() {
        let mut d = MemoryResidencyDesk::new();
        assert_eq!(d.residency_queue_headline().total, 0);
        assert!(d.application_counts_consistent());
        assert_eq!(d.open_share_percent(), None);
        assert_eq!(d.application_status_of("x"), None);
        let a = applied(&mut d, "u-w34");
        assert_eq!(d.open_share_percent(), Some(100));
        assert_eq!(d.residency_queue_headline().open, 1);
        assert!(d.is_application_open(&a.id) && !d.is_application_decided(&a.id));
        d.decide(&a.id, "op1", "accepted", None, Some(NOW)).unwrap();
        assert!(d.application_counts_consistent());
        assert_eq!(d.decided_share_percent(), Some(100));
        assert!(d.is_application_decided(&a.id));
        assert_eq!(d.application_status_of(&a.id), Some("accepted"));
    }

    #[test]
    fn filters_search_pages_and_diffs() {
        let mut d = MemoryResidencyDesk::new();
        assert!(d.filter_application_ids_by_status("applied").is_empty());
        assert!(d.search_application_ids("").is_empty());
        assert_eq!(d.open_count_for_cohort("bali-2026"), 0);
        assert!(
            d.page_open_application_ids(None, Some(5.0))
                .unwrap()
                .is_empty()
        );
        assert_eq!(d.open_queue_page_count(5), 0);
        assert!(d.safe_page_open_application_ids(0, 1).is_empty());
        assert!(!d.is_valid_open_queue_page(0, 1));
        let a = applied(&mut d, "u-w37");
        assert_eq!(
            d.filter_application_ids_by_status("applied"),
            [a.id.as_str()]
        );
        assert_eq!(
            d.list_application_ids_for_cohort("bali-2026"),
            [a.id.as_str()]
        );
        assert_eq!(d.open_count_for_cohort("bali-2026"), 1);
        assert!(d.search_application_ids("res-").contains(&a.id));
        assert_eq!(d.application_ids_only_here(&[]), [a.id.as_str()]);
        assert_eq!(d.open_ids_only_here(&[]), [a.id.as_str()]);
        assert!(d.open_count_equals(1));
        assert_eq!(d.cohorts_only_here(&[]), ["bali-2026"]);
        let b = applied(&mut d, "u-w38b");
        assert_eq!(
            d.page_open_application_ids(Some(0), Some(1.0))
                .unwrap()
                .len(),
            1
        );
        assert_eq!(
            d.page_all_application_ids(None, Some(10.0)).unwrap().len(),
            2
        );
        assert_eq!(d.safe_page_open_application_ids(0, 1).len(), 1);
        assert_eq!(d.clamp_open_queue_page_index(99, 1), 1);
        assert_eq!(d.open_application_ids_at_page(1, 1).len(), 1);
        assert!(d.is_valid_open_queue_page(0, 1));
        d.decide(&a.id, "op1", "accepted", None, Some(NOW)).unwrap();
        assert_eq!(
            d.page_accepted_application_ids(None, Some(10.0)).unwrap(),
            [a.id]
        );
        assert_eq!(d.open_queue_page_count(1), 1);
        assert_eq!(d.open_application_ids(), [b.id]);
    }

    #[test]
    fn residency_export_and_status_lines() {
        let mut d = MemoryResidencyDesk::new();
        assert!(d.residency_export_lines().is_empty());
        assert_eq!(d.residency_export_header(), "id,status,cohortSlug");
        assert_eq!(d.parse_residency_export_line("id,status,cohortSlug"), None);
        assert!(d.residency_export_round_trip_ok());
        assert!(d.residency_status_line_is_empty());
        assert_eq!(
            d.parse_residency_status_line("open=0 decided=0 total=0"),
            Some((0, 0, 0))
        );
        assert!(d.residency_status_line_matches_store());
        assert!(d.open_count_in_range(0, 0));
        assert!(!d.open_share_at_least(1));
        assert_eq!(d.clamp_open_queue_page_size(5), 1);
        let a = applied(&mut d, "u-w41");
        assert!(d.residency_export_lines().first().unwrap().contains(&a.id));
        assert_eq!(d.residency_export_line_count(), 2);
        assert!(d.residency_export_text().contains("bali-2026"));
        assert_eq!(
            d.parse_residency_export_line(&format!("{},applied,bali-2026", a.id)),
            Some((a.id.clone(), "applied", "bali-2026".to_owned()))
        );
        assert_eq!(
            d.count_residency_export_data_lines(&d.residency_export_text()),
            1
        );
        assert!(d.residency_export_has_header(&d.residency_export_text()));
        assert!(d.residency_status_line().contains("open=1"));
        assert!(d.residency_status_line_detailed().contains("accepted=0"));
        assert_eq!(d.residency_status_line_token_count(), 5);
        assert!(d.residency_status_line_matches_store());
        assert!(d.residency_status_line_detailed_consistent(&d.residency_status_line_detailed()));
        assert!(d.open_count_in_range(1, 1));
        assert!(d.open_share_at_least(100));
        assert_eq!(d.clamp_open_queue_page_size(99), 1);
        assert!(d.application_density_exceeds(0));
    }

    #[test]
    fn an_accepted_residency_is_not_payable_while_the_ifc_rate_authority_is_unset() {
        let mut d = MemoryResidencyDesk::new();
        let a = applied(&mut d, "u-pay");
        d.decide(&a.id, "op", "accepted", None, Some(NOW)).unwrap();
        assert_eq!(d.list_accepted(Some("bali-2026")).len(), 1);
        let quote =
            decide_public_residency_pay_quote(&UNPUBLISHED_IFC_PAY_LAW, Some("accepted"), None)
                .to_json();
        assert_eq!(quote.get("status"), Some(&Json::str("refuse")));
        assert_eq!(
            quote.get("code"),
            Some(&Json::str("academy.ambassador_pay.rates_unset"))
        );
        assert!(!pay_looks_payable(&quote));
    }

    #[test]
    fn ratios_round_half_up_on_whole_numbers() {
        assert_eq!(fixed4(1, 3).as_deref(), Some("0.3333"));
        assert_eq!(fixed4(2, 3).as_deref(), Some("0.6667"));
        assert_eq!(fixed4(1, 32).as_deref(), Some("0.0313"));
        assert_eq!(fixed4(0, 0), None);
        assert_eq!(share_percent(1, 3), Some(33));
        assert_eq!(share_percent(1, 200), Some(1));
        assert!(half_or_more(1, 2) && !half_or_more(1, 3));
    }
}
