//! The `venue` slice's engine calls: the switches of each market mode (`halt`, `resume`, `reduceOnly`, `postOnly`,
//! `prelaunch`, `open`, `expire`, `delist` and their reverses), the venue halt (`haltAll`, `resumeAll`), a dead session
//! (`sessionDead`), and the open surveillance evidence (`surveillance-persist.ts`).
//!
//! The TypeScript layers up to three modules over each switch. As `index.ts` composes them, outermost first:
//! `cod-fence.ts` on the four halts (two distinct operators; it installs last, its import-time install deferred by its
//! import cycle with `engine.ts`), `rulebook-refuse.ts` on the halts, the expiry and the delisting (an emergency action
//! names its operator and its evidence; a delisting names an owner policy), and the base engine (two distinct operators
//! on every market switch, one operator on the venue halt). [`MatchingEngine::switch`] runs the same gates in the same
//! order and answers what the first that refuses answers.

use std::collections::HashSet;

use service_kit::json::Json;
use service_kit::schema::js_trim;

use super::{EngineError, MatchingEngine, cancelled_event};
use crate::approval::{dual_control_refuse, operator_refuse, read_operator_id};
use crate::book::rules::read_session_id;
use crate::book::types::{CancelledRef, Reject, SurveillanceCase};
use crate::journal::record::JournalRecord;
use crate::rulebook::refuse;

pub use crate::rulebook::refuse::{DELIST_POLICY_MISSING, MISSING_EVIDENCE};

/// One switch a venue door makes.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Switch {
    Halt,
    Resume,
    HaltAll,
    ResumeAll,
    ReduceOnly,
    ResumeReduceOnly,
    PostOnly,
    ResumePostOnly,
    Prelaunch,
    Open,
    Expire,
    Delist,
}

impl Switch {
    /// The journal record's kind.
    pub fn kind(self) -> &'static str {
        match self {
            Switch::Halt => "halt",
            Switch::Resume => "resume",
            Switch::HaltAll => "halt_all",
            Switch::ResumeAll => "resume_all",
            Switch::ReduceOnly => "reduce_only",
            Switch::ResumeReduceOnly => "resume_reduce_only",
            Switch::PostOnly => "post_only",
            Switch::ResumePostOnly => "resume_post_only",
            Switch::Prelaunch => "prelaunch",
            Switch::Open => "open",
            Switch::Expire => "expire",
            Switch::Delist => "delist",
        }
    }

    /// Whether it switches one market (`false`: the whole venue).
    pub fn per_market(self) -> bool {
        !matches!(self, Switch::HaltAll | Switch::ResumeAll)
    }

    /// The answer's field for the mode it switches: `halted`, `reduceOnly`, `postOnly`, `prelaunch`, `expired`,
    /// `delisted`.
    pub fn field(self) -> &'static str {
        match self {
            Switch::Halt | Switch::Resume | Switch::HaltAll | Switch::ResumeAll => "halted",
            Switch::ReduceOnly | Switch::ResumeReduceOnly => "reduceOnly",
            Switch::PostOnly | Switch::ResumePostOnly => "postOnly",
            Switch::Prelaunch | Switch::Open => "prelaunch",
            Switch::Expire => "expired",
            Switch::Delist => "delisted",
        }
    }

    /// `rulebook-refuse.ts`'s emergency gate: the operator, then the evidence.
    fn emergency(self) -> bool {
        matches!(
            self,
            Switch::Halt | Switch::Resume | Switch::HaltAll | Switch::ResumeAll | Switch::Expire
        )
    }
}

/// What the door hands a switch (`EmergencyCmd`, `DelistCmd`): the two operators, the evidence of the approval they
/// spent, and a delisting's owner policy.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct SwitchCmd {
    pub operator_id: Option<String>,
    pub confirm_operator_id: Option<String>,
    pub evidence: Option<String>,
    pub evidence_refs: Vec<String>,
    pub policy_id: Option<String>,
    pub policy_version: Option<String>,
}

/// What a switch answers (`MarketHaltResult` and its kin).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SwitchResult {
    pub accepted: bool,
    /// The mode as it stands after the call.
    pub state: bool,
    pub operator_id: Option<String>,
    /// `None` where the TypeScript result has no `confirmOperatorId` (the rulebook gate's refusal).
    pub confirm_operator_id: Option<Option<String>>,
    pub rejected: Option<Reject>,
}

/// The surveillance reasons a case may name (`SURVEILLANCE_REASONS`).
pub const SURVEILLANCE_REASONS: [&str; 3] = ["self_trade", "spoofing", "layering"];

/// `openSurveillanceCase`: the account, market and a known reason, each trimmed; else the refusal.
pub fn open_surveillance_case(
    account_id: Option<&str>,
    market_id: Option<&str>,
    reason: Option<&str>,
) -> Result<SurveillanceCase, Reject> {
    let read = |raw: Option<&str>| {
        raw.map(js_trim)
            .filter(|s| !s.is_empty())
            .map(str::to_owned)
    };
    let account_id = read(account_id).ok_or_else(|| {
        Reject::new(
            "missing_account",
            "a surveillance case requires accountId; the engine does not invent an owner",
        )
    })?;
    let market_id = read(market_id).ok_or_else(|| {
        Reject::new(
            "missing_market",
            "a surveillance case requires marketId; the engine does not invent a book",
        )
    })?;
    let reason = read(reason).ok_or_else(|| {
        Reject::new(
            "missing_reason",
            "a surveillance case requires a reason; blank does not open a case",
        )
    })?;
    if !SURVEILLANCE_REASONS.contains(&reason.as_str()) {
        return Err(Reject::new(
            "unknown_pattern",
            format!("pattern {reason} is unknown — refused rather than auto-adjudicated"),
        ));
    }
    Ok(SurveillanceCase {
        account_id,
        market_id,
        reason,
    })
}

/// The key one case is kept under: its account, market and reason.
fn case_key(c: &SurveillanceCase) -> (String, String, String) {
    (c.account_id.clone(), c.market_id.clone(), c.reason.clone())
}

/// The open cases kept as evidence (`surveillance-persist.ts`'s store) and those already journalled.
#[derive(Debug, Default)]
pub(super) struct Evidence {
    cases: Vec<SurveillanceCase>,
    journalled: HashSet<(String, String, String)>,
}

impl Evidence {
    fn put(&mut self, c: &SurveillanceCase) {
        let key = case_key(c);
        if let Some(slot) = self.cases.iter_mut().find(|k| case_key(k) == key) {
            *slot = c.clone();
        } else {
            self.cases.push(c.clone());
        }
    }

    /// `putCase` for each, in order: what a cold start adds from the replayed books.
    pub(super) fn keep_all(&mut self, cases: &[SurveillanceCase]) {
        cases.iter().for_each(|c| self.put(c));
    }

    /// `hydrateFromJournal`: every `open_surveillance` record that reads as a case.
    pub(super) fn from_journal(records: &[JournalRecord]) -> Evidence {
        let mut e = Evidence::default();
        let text = |r: &JournalRecord, k: &str| match r.field(k) {
            Some(Json::String(s)) => Some(s.clone()),
            _ => None,
        };
        for r in records {
            if r.kind() != Some("open_surveillance") {
                continue;
            }
            let (account, market, reason) =
                (text(r, "accountId"), text(r, "marketId"), text(r, "reason"));
            // `alreadyJournalled` compares the record's own fields, untrimmed.
            if let (Some(a), Some(m), Some(why)) = (&account, &market, &reason) {
                e.journalled.insert((a.clone(), m.clone(), why.clone()));
            }
            if let Ok(c) =
                open_surveillance_case(account.as_deref(), market.as_deref(), reason.as_deref())
            {
                e.put(&c);
            }
        }
        e
    }
}

/// The cases ordered as `unionCases` sorts them: market, reason, then account.
fn sorted(mut cases: Vec<SurveillanceCase>) -> Vec<SurveillanceCase> {
    cases.sort_by(|a, b| {
        a.market_id
            .cmp(&b.market_id)
            .then_with(|| a.reason.cmp(&b.reason))
            .then_with(|| a.account_id.cmp(&b.account_id))
    });
    cases
}

/// What a dead session answers (`SessionDeadResult`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SessionDeadResult {
    pub accepted: bool,
    pub session_id: Option<String>,
    pub cancellations: Vec<CancelledRef>,
    pub rejected: Option<Reject>,
}

impl MatchingEngine {
    /// Whether a switch's mode stands for `market_id` now.
    pub fn mode_state(&self, switch: Switch, market_id: &str) -> bool {
        let m = &self.modes;
        match switch {
            Switch::Halt | Switch::Resume => m.halted.contains(market_id),
            Switch::HaltAll | Switch::ResumeAll => m.venue_halted,
            Switch::ReduceOnly | Switch::ResumeReduceOnly => m.reduce_only.contains(market_id),
            Switch::PostOnly | Switch::ResumePostOnly => m.post_only.contains(market_id),
            Switch::Prelaunch | Switch::Open => m.prelaunch.contains(market_id),
            Switch::Expire => m.expired.contains(market_id),
            Switch::Delist => m.delisted.contains(market_id),
        }
    }

    fn refused_switch(
        &self,
        switch: Switch,
        market_id: &str,
        operator_id: Option<String>,
        confirm: Option<Option<String>>,
        rejected: Reject,
    ) -> SwitchResult {
        SwitchResult {
            accepted: false,
            state: self.mode_state(switch, market_id),
            operator_id,
            confirm_operator_id: confirm,
            rejected: Some(rejected),
        }
    }

    /// Switch one mode, journalled before it applies. `market_id` is ignored by the venue halt.
    pub fn switch(
        &mut self,
        switch: Switch,
        market_id: &str,
        cmd: &SwitchCmd,
    ) -> Result<SwitchResult, EngineError> {
        let operator = read_operator_id(cmd.operator_id.as_deref());
        let confirm = read_operator_id(cmd.confirm_operator_id.as_deref());
        let dual = || {
            let refused = dual_control_refuse(operator.as_deref(), confirm.as_deref());
            refused.map(|r| {
                self.refused_switch(
                    switch,
                    market_id,
                    operator.clone(),
                    Some(confirm.clone()),
                    r,
                )
            })
        };
        // cod-fence.ts, on the four halts: two distinct operators.
        let halts = matches!(
            switch,
            Switch::Halt | Switch::Resume | Switch::HaltAll | Switch::ResumeAll
        );
        if halts && let Some(r) = dual() {
            return Ok(r);
        }
        // rulebook-refuse.ts: the operator, then the evidence or the delisting's policy.
        if switch.emergency() || switch == Switch::Delist {
            let gate_cmd = refuse::Cmd {
                operator_id: cmd.operator_id.clone(),
                evidence: cmd.evidence.clone(),
                evidence_refs: Some(cmd.evidence_refs.iter().map(Json::str).collect()),
                policy_id: cmd.policy_id.clone(),
                policy_version: cmd.policy_version.clone(),
            };
            let gated = if switch == Switch::Delist {
                refuse::delist_gate(&gate_cmd)
            } else {
                refuse::emergency_gate(&gate_cmd)
            };
            if let Err(g) = gated {
                return Ok(self.refused_switch(switch, market_id, g.operator_id, None, g.rejected));
            }
        }
        // The base engine: two distinct operators on every market switch (the venue halt's base asks one, but
        // cod-fence asked two before it).
        if let Some(r) = dual() {
            return Ok(r);
        }
        // Past the dual-control gate the operator is named.
        let Some(operator) = operator else {
            return Ok(self.refused_switch(
                switch,
                market_id,
                None,
                Some(confirm),
                operator_refuse(),
            ));
        };
        let at = self.now_iso((self.clock)());
        let mut record: Vec<(String, Json)> = vec![("kind".into(), Json::str(switch.kind()))];
        if switch.per_market() {
            record.push(("marketId".into(), Json::str(market_id)));
        }
        record.push(("at".into(), Json::str(at.clone())));
        record.push(("operatorId".into(), Json::str(operator.clone())));
        if let Some(c) = &confirm {
            record.push(("confirmOperatorId".into(), Json::str(c.clone())));
        }
        self.append(Json::Object(record))?;
        self.apply_switch(switch, market_id, at);
        Ok(SwitchResult {
            accepted: true,
            state: self.mode_state(switch, market_id),
            operator_id: Some(operator),
            confirm_operator_id: Some(confirm),
            rejected: None,
        })
    }

    fn apply_switch(&mut self, switch: Switch, market_id: &str, at: String) {
        let m = &mut self.modes;
        let id = market_id.to_owned();
        match switch {
            Switch::Halt => {
                if !m.halted.contains(market_id) {
                    m.halted_since.insert(id.clone(), Some(at));
                }
                m.halted.insert(id);
            }
            Switch::Resume => {
                m.halted.remove(market_id);
                m.halted_since.remove(market_id);
            }
            Switch::HaltAll => {
                if !m.venue_halted {
                    m.venue_halted_at = Some(at);
                }
                m.venue_halted = true;
            }
            Switch::ResumeAll => {
                m.venue_halted = false;
                m.venue_halted_at = None;
            }
            Switch::ReduceOnly => {
                m.reduce_only.insert(id);
            }
            Switch::ResumeReduceOnly => {
                m.reduce_only.remove(market_id);
            }
            Switch::PostOnly => {
                m.post_only.insert(id);
            }
            Switch::ResumePostOnly => {
                m.post_only.remove(market_id);
            }
            Switch::Prelaunch => {
                m.prelaunch.insert(id);
            }
            Switch::Open => {
                m.prelaunch.remove(market_id);
                m.listed.insert(id);
            }
            Switch::Expire => {
                m.expired.insert(id);
            }
            Switch::Delist => {
                m.delisted.insert(id);
            }
        }
    }

    /// Pull every live order tagged with this session in every market, and refuse its later submits (cod-fence's
    /// `sessionDead`). The record is journalled first; one book's refusal does not stop the others.
    pub fn session_dead(
        &mut self,
        session_id: Option<&str>,
    ) -> Result<SessionDeadResult, EngineError> {
        let Some(session) = read_session_id(session_id) else {
            return Ok(SessionDeadResult {
                accepted: false,
                session_id: None,
                cancellations: Vec::new(),
                rejected: Some(Reject::new(
                    "missing_session",
                    "session identity is required; the engine does not invent a session",
                )),
            });
        };
        let at = self.now_iso((self.clock)());
        self.append(Json::obj([
            ("kind", Json::str("session_dead")),
            ("at", Json::str(at)),
            ("sessionId", Json::str(session.clone())),
        ]))?;
        self.modes.dead_sessions.insert(session.clone());
        let mut cancellations = Vec::new();
        let mut events = Vec::new();
        for market in self.markets() {
            let Some(book) = self.books.get_mut(&market) else {
                continue;
            };
            for c in book.cancel_session(&session) {
                events.push(cancelled_event(&market, &c));
                cancellations.push(c);
            }
            self.drop_if_never_traded(&market);
        }
        self.emit(events)?;
        self.maybe_snapshot();
        Ok(SessionDeadResult {
            accepted: true,
            session_id: Some(session),
            cancellations,
            rejected: None,
        })
    }

    /// Keep each case a submit opened, and each its book holds, as evidence: in memory and once on the journal
    /// (`snapshotBook`). A journal that refuses the record leaves the accepted submit as it is.
    pub(super) fn keep_cases(&mut self, market_id: &str, opened: &[SurveillanceCase]) {
        let mut cases: Vec<SurveillanceCase> = self
            .books
            .get(market_id)
            .map(|b| b.open_surveillance_cases().to_vec())
            .unwrap_or_default();
        cases.extend(opened.iter().cloned());
        for c in cases {
            self.evidence.put(&c);
            let key = case_key(&c);
            if self.evidence.journalled.contains(&key) {
                continue;
            }
            let at = self.now_iso((self.clock)());
            let record = Json::obj([
                ("kind", Json::str("open_surveillance")),
                ("marketId", Json::str(c.market_id.clone())),
                ("at", Json::str(at)),
                ("accountId", Json::str(c.account_id.clone())),
                ("reason", Json::str(c.reason.clone())),
            ]);
            if self.append(record).is_ok() {
                self.evidence.journalled.insert(key);
            }
        }
    }

    /// Every open case: those kept as evidence and those the live books hold, once each, sorted.
    pub fn open_surveillance_cases(&self) -> Vec<SurveillanceCase> {
        let mut merged = Evidence::default();
        for c in &self.evidence.cases {
            merged.put(c);
        }
        for market in self.markets() {
            if let Some(book) = self.books.get(&market) {
                for c in book.open_surveillance_cases() {
                    merged.put(c);
                }
            }
        }
        sorted(merged.cases)
    }
}
