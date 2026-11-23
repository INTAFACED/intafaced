//! The TEST partner's compliance record of each person's bank account (`partner/partner-compliance.ts`, J-bank-17):
//! onboarding, information requests, periodic reviews, closure and data requests. A real partner opens requests and
//! reviews itself; on the TEST stack the person's own `testPartner.openCompliance` stands in for it. TEST words only.
//!
//! A closure's payout is the raw partner's move, as the TypeScript's host hands it `bank`: it is the partner paying out
//! an account it is closing, not an instruction of ours.

use std::collections::HashMap;

use service_kit::money::Amount;
use service_kit::time::Instant;
use sha2::{Digest, Sha256};

use super::{AccountRef, CLOSURE_PAYOUT_KEY, LABEL, MoveRequest, State, payouts_account, refuse};
use crate::errors::Refusal;

/// What the TEST partner asks of everyone it onboards (`TEST_PARTNER_REQUIREMENTS`).
pub const REQUIREMENTS: [&str; 2] = [
    "TEST: be 18 or older",
    "TEST: live in a country the partner bank serves",
];
const REQUEST_TITLE: &str = "TEST: show where the money you pay in comes from";
const REQUEST_DETAIL: &str =
    "TEST request from the partner bank: upload one document, such as a payslip or a contract.";
const REVIEW_TITLE: &str = "TEST: confirm your account details are still accurate";
const REVIEW_MISSED: &str = "TEST: if this review is not answered by its due date, the partner bank restricts the account to incoming payments until it is.";
const MAX_PER_PERSON: usize = 50;
const DAY_MS: i64 = 86_400_000;

/// An uploaded answer (`UploadedFile`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UploadedFile {
    pub name: String,
    pub kind: String,
    pub size: usize,
    pub sha256: String,
}

/// An information request (`InfoRequest`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InfoRequest {
    pub id: String,
    pub title: &'static str,
    pub detail: &'static str,
    pub opened_at: Instant,
    pub due_at: Instant,
    /// `open` or `under_review`.
    pub status: &'static str,
    pub answered_at: Option<Instant>,
    pub file: Option<UploadedFile>,
    pub label: &'static str,
}

/// A periodic review (`PeriodicReview`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Review {
    pub id: String,
    pub title: &'static str,
    pub due_at: Instant,
    pub missed_effect: &'static str,
    /// `open` or `answered`.
    pub status: &'static str,
    pub answered_at: Option<Instant>,
    pub label: &'static str,
}

/// Where a closure pays out (`ClosureDestination`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Destination {
    pub name: String,
    pub account_ref: String,
}

/// One balance a closure pays out (`ClosureBalance`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ClosureBalance {
    pub asset_id: String,
    pub space_id: Option<String>,
    pub amount: Amount,
}

/// One closure of the account (`PartnerClosure`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Closure {
    pub id: String,
    /// `pending`, `closed` or `reopened`.
    pub state: &'static str,
    pub requested_at: Instant,
    pub balances: Vec<ClosureBalance>,
    pub destination: Option<Destination>,
    pub payout_move_ids: Vec<String>,
    pub paid_out_at: Option<Instant>,
    pub closed_at: Option<Instant>,
    pub reopened_at: Option<Instant>,
    pub label: &'static str,
}

/// A data request (`DataRequest`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DataRequest {
    pub id: String,
    /// `access` or `portability`.
    pub kind: String,
    pub requested_at: Instant,
    pub partner_ref: String,
    pub label: &'static str,
}

/// One onboarding step (`OnboardingStep`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Step {
    pub id: &'static str,
    pub title: &'static str,
    pub done: bool,
    pub done_with_case: bool,
}

/// Onboarding at the partner (`PartnerOnboarding`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Onboarding {
    pub steps: Vec<Step>,
    pub tier: String,
    pub accepted: bool,
    pub complete: bool,
}

#[derive(Debug, Default)]
pub struct Compliance {
    requests: HashMap<String, Vec<InfoRequest>>,
    reviews: HashMap<String, Vec<Review>>,
    closures: HashMap<String, Vec<Closure>>,
    data: HashMap<String, Vec<DataRequest>>,
    seq: u64,
}

fn capped<T>(list: &[T]) -> Result<(), Refusal> {
    if list.len() >= MAX_PER_PERSON {
        return Err(refuse(
            "bank.partner_unavailable",
            "The TEST partner keeps no more of these for this person.",
        ));
    }
    Ok(())
}

fn days(n: i64) -> i64 {
    n.saturating_mul(DAY_MS)
}

impl Compliance {
    /// `closure.state`: the last closure's, or `open`.
    pub fn state_of(&self, user_id: &str) -> &'static str {
        match self.closures.get(user_id).and_then(|l| l.last()) {
            None => "open",
            Some(c) if c.state == "reopened" => "open",
            Some(c) => c.state,
        }
    }

    /// Requests, newest first.
    pub fn requests(&self, user_id: &str) -> Vec<InfoRequest> {
        self.requests
            .get(user_id)
            .map(|l| l.iter().rev().cloned().collect())
            .unwrap_or_default()
    }

    /// Reviews, newest first.
    pub fn reviews(&self, user_id: &str) -> Vec<Review> {
        self.reviews
            .get(user_id)
            .map(|l| l.iter().rev().cloned().collect())
            .unwrap_or_default()
    }

    /// Closures, newest first.
    pub fn closures(&self, user_id: &str) -> Vec<Closure> {
        self.closures
            .get(user_id)
            .map(|l| l.iter().rev().cloned().collect())
            .unwrap_or_default()
    }

    /// Data requests, newest first.
    pub fn data_requests(&self, user_id: &str) -> Vec<DataRequest> {
        self.data
            .get(user_id)
            .map(|l| l.iter().rev().cloned().collect())
            .unwrap_or_default()
    }

    /// `openRequest`: once per id, due in `due_days`.
    pub fn open_request(
        &mut self,
        user_id: &str,
        id: &str,
        due_days: i64,
        now: Instant,
    ) -> Result<InfoRequest, Refusal> {
        let list = self.requests.entry(user_id.to_owned()).or_default();
        if let Some(prior) = list.iter().find(|r| r.id == id) {
            return Ok(prior.clone());
        }
        capped(list)?;
        let row = InfoRequest {
            id: id.to_owned(),
            title: REQUEST_TITLE,
            detail: REQUEST_DETAIL,
            opened_at: now,
            due_at: Instant(now.0.saturating_add(days(due_days))),
            status: "open",
            answered_at: None,
            file: None,
            label: LABEL,
        };
        list.push(row.clone());
        Ok(row)
    }

    /// `openReview`: once per id, due in `due_days`.
    pub fn open_review(
        &mut self,
        user_id: &str,
        id: &str,
        due_days: i64,
        now: Instant,
    ) -> Result<Review, Refusal> {
        let list = self.reviews.entry(user_id.to_owned()).or_default();
        if let Some(prior) = list.iter().find(|r| r.id == id) {
            return Ok(prior.clone());
        }
        capped(list)?;
        let row = Review {
            id: id.to_owned(),
            title: REVIEW_TITLE,
            due_at: Instant(now.0.saturating_add(days(due_days))),
            missed_effect: REVIEW_MISSED,
            status: "open",
            answered_at: None,
            label: LABEL,
        };
        list.push(row.clone());
        Ok(row)
    }

    /// `answerRequest`: one answer, before its deadline.
    pub fn answer_request(
        &mut self,
        user_id: &str,
        request_id: &str,
        file: (&str, &str, &[u8]),
        now: Instant,
    ) -> Result<InfoRequest, Refusal> {
        let Some(row) = self
            .requests
            .get_mut(user_id)
            .and_then(|l| l.iter_mut().find(|r| r.id == request_id))
        else {
            return Err(refuse(
                "bank.info_request_not_found",
                "The partner bank has no such request for you.",
            ));
        };
        let sha256 = hex(&Sha256::digest(file.2));
        if row.status != "open" {
            return Err(refuse(
                "bank.info_request_not_open",
                "This request has been answered and is under review; it takes one answer.",
            ));
        }
        if now.0 > row.due_at.0 {
            return Err(refuse(
                "bank.info_request_past_deadline",
                "This request is past its deadline, so the partner bank takes no answer to it here.",
            ));
        }
        row.status = "under_review";
        row.answered_at = Some(now);
        row.file = Some(UploadedFile {
            name: file.0.to_owned(),
            kind: file.1.to_owned(),
            size: file.2.len(),
            sha256,
        });
        Ok(row.clone())
    }

    /// `answerReview`.
    pub fn answer_review(
        &mut self,
        user_id: &str,
        review_id: &str,
        now: Instant,
    ) -> Result<Review, Refusal> {
        let Some(row) = self
            .reviews
            .get_mut(user_id)
            .and_then(|l| l.iter_mut().find(|r| r.id == review_id))
        else {
            return Err(refuse(
                "bank.review_not_found",
                "The partner bank has no such review for you.",
            ));
        };
        if row.status != "open" {
            return Err(refuse(
                "bank.review_not_open",
                "This review is already answered.",
            ));
        }
        row.status = "answered";
        row.answered_at = Some(now);
        Ok(row.clone())
    }

    /// `reopen`: a closed account within `window_days` of closing.
    pub fn reopen_closed(
        &mut self,
        user_id: &str,
        window_days: i64,
        now: Instant,
    ) -> Result<Closure, Refusal> {
        let Some(last) = self
            .closures
            .get_mut(user_id)
            .and_then(|l| l.last_mut())
            .filter(|c| c.state == "closed")
        else {
            return Err(refuse(
                "bank.account_not_closed",
                "This account is not closed.",
            ));
        };
        let Some(closed_at) = last.closed_at else {
            return Err(refuse(
                "bank.account_not_closed",
                "This account is not closed.",
            ));
        };
        if now.0 > closed_at.0.saturating_add(days(window_days)) {
            return Err(refuse(
                "bank.reopen_window_passed",
                format!(
                    "This account closed more than {window_days} days ago, so it can no longer be reopened."
                ),
            ));
        }
        last.state = "reopened";
        last.reopened_at = Some(now);
        Ok(last.clone())
    }

    /// `requestData`: once per id.
    pub fn request_data(
        &mut self,
        user_id: &str,
        request_id: &str,
        kind: &str,
        now: Instant,
    ) -> Result<DataRequest, Refusal> {
        let list = self.data.entry(user_id.to_owned()).or_default();
        if let Some(prior) = list.iter().find(|r| r.id == request_id) {
            if prior.kind != kind {
                return Err(refuse(
                    "bank.data_request_conflict",
                    "Another data request already has this id.",
                ));
            }
            return Ok(prior.clone());
        }
        capped(list)?;
        self.seq = self.seq.saturating_add(1);
        let row = DataRequest {
            id: request_id.to_owned(),
            kind: kind.to_owned(),
            requested_at: now,
            partner_ref: format!("test-partner-data-{:08}", self.seq),
            label: LABEL,
        };
        list.push(row.clone());
        Ok(row)
    }
}

fn hex(bytes: &[u8]) -> String {
    use std::fmt::Write as _;
    bytes.iter().fold(String::new(), |mut s, b| {
        let _ = write!(s, "{b:02x}");
        s
    })
}

impl State {
    /// `onboarding`: identity done with our case when the partner accepts it and the person is verified.
    pub fn onboarding(&self, user_id: &str, tier: &str) -> Onboarding {
        let accepted = self.board.read(user_id, |s| s.identity_case == "accepted");
        let identity_done = accepted && tier != "none";
        let information_done = self
            .compliance
            .requests
            .get(user_id)
            .is_none_or(|l| l.iter().all(|r| r.status != "open"));
        let steps = vec![
            Step {
                id: "identity",
                title: if accepted {
                    "TEST: confirm who you are (the partner bank accepts your INTAFACED verification)"
                } else {
                    "TEST: confirm who you are with the partner bank’s own check"
                },
                done: identity_done,
                done_with_case: identity_done,
            },
            Step {
                id: "information",
                title: "TEST: answer the partner bank’s information requests",
                done: information_done,
                done_with_case: false,
            },
        ];
        Onboarding {
            complete: steps.iter().all(|s| s.done),
            steps,
            tier: tier.to_owned(),
            accepted,
        }
    }

    /// `balancesOf`: every non-zero balance, refused when the partner does not say what one holds.
    fn closure_balances(
        &mut self,
        user_id: &str,
        now: Instant,
    ) -> Result<Vec<ClosureBalance>, Refusal> {
        let mut out = Vec::new();
        for row in self.balances(user_id, now) {
            let Some(amount) = row.amount.filter(|_| !row.unavailable) else {
                return Err(refuse(
                    "bank.partner_unavailable",
                    "The partner bank does not say what this account holds right now, so it cannot be closed yet.",
                ));
            };
            if amount > 0 {
                out.push(ClosureBalance {
                    asset_id: row.account.asset_id,
                    space_id: row.account.space_id,
                    amount,
                });
            }
        }
        // `localeCompare` over `<asset>|<space>`: the ids are capitals, digits and lower-case hex, which it orders as
        // code units do, and its `|` sorts before any of them; so the asset decides first, then the space (main first).
        out.sort_by(|a, b| {
            (a.asset_id.as_str(), a.space_id.as_deref().unwrap_or(""))
                .cmp(&(b.asset_id.as_str(), b.space_id.as_deref().unwrap_or("")))
        });
        Ok(out)
    }

    /// `requestClosure`: once per id; with money left it pays out to `destination` when the partner reports it.
    pub fn request_closure(
        &mut self,
        user_id: &str,
        closure_id: &str,
        destination: Option<Destination>,
        now: Instant,
    ) -> Result<Closure, Refusal> {
        if let Some(prior) = self
            .compliance
            .closures
            .get(user_id)
            .and_then(|l| l.iter().find(|c| c.id == closure_id))
        {
            if prior.destination != destination {
                return Err(refuse(
                    "bank.closure_conflict",
                    "Another closure request already has this id, so this one was not made.",
                ));
            }
            return Ok(prior.clone());
        }
        match self.compliance.state_of(user_id) {
            "pending" => {
                return Err(refuse(
                    "bank.closure_pending",
                    "Closing this account is already under way.",
                ));
            }
            "closed" => {
                return Err(refuse(
                    "bank.account_closed",
                    "This account is already closed.",
                ));
            }
            _ => {}
        }
        if self.board.read(user_id, |s| s.legal_hold == "held") {
            return Err(refuse(
                "bank.closure_legal_hold",
                "The partner bank holds this account under a legal hold, so it cannot be closed while the hold stands.",
            ));
        }
        let balances = self.closure_balances(user_id, now)?;
        if !balances.is_empty() && destination.is_none() {
            return Err(refuse(
                "bank.closure_destination_required",
                "This account still holds money: name where the partner bank should pay it out before it closes.",
            ));
        }
        capped(
            self.compliance
                .closures
                .get(user_id)
                .map_or(&[][..], Vec::as_slice),
        )?;
        let pending = !balances.is_empty();
        let closing = Closure {
            id: closure_id.to_owned(),
            state: if pending { "pending" } else { "closed" },
            requested_at: now,
            balances,
            destination: if pending { destination } else { None },
            payout_move_ids: Vec::new(),
            paid_out_at: None,
            closed_at: (!pending).then_some(now),
            reopened_at: None,
            label: LABEL,
        };
        self.compliance
            .closures
            .entry(user_id.to_owned())
            .or_default()
            .push(closing.clone());
        self.restrict(user_id, true);
        Ok(closing)
    }

    /// `reopen`: and the account takes moves again.
    pub fn reopen(
        &mut self,
        user_id: &str,
        window_days: i64,
        now: Instant,
    ) -> Result<Closure, Refusal> {
        let reopened = self.compliance.reopen_closed(user_id, window_days, now)?;
        self.restrict(user_id, false);
        Ok(reopened)
    }

    /// `reportPaidOut`: the pending closure's balances paid out, one move each under its own key, and it closes.
    pub fn report_paid_out(&mut self, user_id: &str, now: Instant) -> Result<Closure, Refusal> {
        let Some(last) = self
            .compliance
            .closures
            .get(user_id)
            .and_then(|l| l.last())
            .filter(|c| c.state == "pending")
            .cloned()
        else {
            return Err(refuse(
                "bank.closure_not_found",
                "No closure of this account is waiting for its payout.",
            ));
        };
        if self.board.read(user_id, |s| s.legal_hold == "held") {
            return Err(refuse(
                "bank.closure_legal_hold",
                "The partner bank holds this account under a legal hold, so the payout waits for the hold to end.",
            ));
        }
        let mut move_ids = Vec::new();
        for b in &last.balances {
            let from = AccountRef {
                user_id: user_id.to_owned(),
                asset_id: b.asset_id.clone(),
                space_id: b.space_id.clone(),
            };
            let moved = self.move_raw(
                &MoveRequest {
                    key: format!(
                        "{CLOSURE_PAYOUT_KEY}{user_id}:{}:{}:{}",
                        last.id,
                        b.asset_id,
                        b.space_id.as_deref().unwrap_or("main")
                    ),
                    from,
                    to: payouts_account(&b.asset_id),
                    amount: b.amount,
                    payees: None,
                },
                now,
            )?;
            move_ids.push(moved.id);
        }
        let Some(row) = self
            .compliance
            .closures
            .get_mut(user_id)
            .and_then(|l| l.iter_mut().find(|c| c.id == last.id))
        else {
            return Err(refuse(
                "bank.closure_not_found",
                "No closure of this account is waiting for its payout.",
            ));
        };
        row.state = "closed";
        row.payout_move_ids = move_ids;
        row.paid_out_at = Some(now);
        row.closed_at = Some(now);
        Ok(row.clone())
    }
}
