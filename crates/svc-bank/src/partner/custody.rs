//! Who holds each person's bank money, and the guarded partner every move goes through (`bank-root.ts`:
//! `stopGuardedCustody(freezeGuardedCustody(testPartnerCustody(...)))`).
//!
//! A person the TEST partner holds money for (`custody: 'off'`) reads and moves it at the partner; everyone else has
//! no partner bank. Before each move or payment the guarded partner asks, in this order, the operator's partner stop
//! (`bank.partner_stops`; a stopped kind refuses `bank.partner_stopped`, an unreadable state
//! `bank.partner_stop_unreadable`) and then svc-ledger's posting freeze (`GET <LEDGER_URL>/health`; frozen, unreadable
//! or not wired refuses `bank.posting_frozen`). Each refusal by either is counted for the desk
//! (`bank.partner_refusal_counts`), and a count that cannot be written never changes the refusal. Reads stay open.

use service_kit::http::{Fetch, HttpRequest};
use service_kit::json::{self, Json};
use service_kit::time::Instant;

use super::{
    AccountRef, Balance, Move, MoveRequest, MovesQuery, PARTNER_ID, Payment, PaymentRequest,
    TestPartner, refuse,
};
use crate::db::{Store, StoreError, with_client};
use crate::errors::Refusal;

/// Why posting is frozen (`FreezeCause`).
pub const LEDGER_CAUSES: [&str; 4] = ["person", "mismatch", "unfinished_proofs", "startup_setting"];

/// svc-ledger's posting freeze as svc-bank reads it (`FreezeReading`): posting enabled, or the cause it is not.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FreezeReading {
    pub posting_enabled: bool,
    pub cause: Option<String>,
}

/// How the freeze is read.
pub trait Freeze: Send + Sync {
    /// The reading, or why it could not be read.
    fn read(&self) -> Result<FreezeReading, String>;
}

/// `FREEZE_NOT_WIRED`: no freeze wired reads as frozen, so a partner move is refused, never made unguarded.
pub struct NotWired;

impl Freeze for NotWired {
    fn read(&self) -> Result<FreezeReading, String> {
        Ok(FreezeReading {
            posting_enabled: false,
            cause: Some("not_wired".to_owned()),
        })
    }
}

/// `ledgerPostingFreeze`: svc-ledger's `/health`, two seconds a read.
pub struct LedgerFreeze {
    pub url: String,
    pub fetch: Box<dyn Fetch>,
}

impl Freeze for LedgerFreeze {
    fn read(&self) -> Result<FreezeReading, String> {
        let base = url::Url::parse(&self.url).map_err(|e| e.to_string())?;
        let health = base.join("/health").map_err(|e| e.to_string())?;
        let res = self
            .fetch
            .fetch(&HttpRequest {
                method: "GET".to_owned(),
                url: health.to_string(),
                headers: Vec::new(),
                body: None,
                timeout_ms: Some(2_000),
                refuse_redirect: false,
            })
            .map_err(|e| e.message)?;
        if !res.ok() {
            return Err(format!("svc-ledger /health answered {}", res.status));
        }
        let body = json::parse(&res.body).map_err(|e| e.message)?;
        if matches!(body.get("postingEnabled"), Some(Json::Bool(true))) {
            return Ok(FreezeReading {
                posting_enabled: true,
                cause: None,
            });
        }
        let cause = match body.get("frozenCause") {
            Some(Json::String(c)) if LEDGER_CAUSES.contains(&c.as_str()) => c.clone(),
            _ => "not_reported".to_owned(),
        };
        Ok(FreezeReading {
            posting_enabled: false,
            cause: Some(cause),
        })
    }
}

/// `readFreeze`: a reading that fails is `unreadable`, never "enabled".
pub fn read_freeze(freeze: &dyn Freeze) -> FreezeReading {
    freeze.read().unwrap_or(FreezeReading {
        posting_enabled: false,
        cause: Some("unreadable".to_owned()),
    })
}

/// `postingFrozen`.
pub fn posting_frozen() -> Refusal {
    refuse(
        "bank.posting_frozen",
        "Money moves are paused across the platform right now. Nothing was sent or changed.",
    )
}

/// `NoteRefusal`'s row: who refused, why, and for which kind of instruction.
fn note(store: &Store, refused_by: &str, cause: &str, kind: &str) {
    // The refusal stands whatever happens here: a dropped count is an undercount, never a move.
    if let Ok(pool) = store.pool() {
        let _ = with_client(pool, |c| {
            c.execute(
                "INSERT INTO bank.partner_refusal_counts (day, refused_by, cause, kind, count) \
                 VALUES ((now() AT TIME ZONE 'UTC')::date, $1, $2, $3, 1) \
                 ON CONFLICT (day, refused_by, cause, kind) DO UPDATE SET count = bank.partner_refusal_counts.count + 1",
                &[&refused_by, &cause, &kind],
            )?;
            Ok(())
        });
    }
}

/// `assertPostingEnabled(freeze, kind, note)`; `count` false is a caller that passes no note.
pub fn assert_posting_enabled(
    freeze: &dyn Freeze,
    store: &Store,
    kind: &str,
    count: bool,
) -> Result<(), Refusal> {
    let reading = read_freeze(freeze);
    if reading.posting_enabled {
        return Ok(());
    }
    let cause = reading.cause.unwrap_or_else(|| "not_reported".to_owned());
    if count {
        note(store, "posting_freeze", &cause, kind);
    }
    Err(posting_frozen())
}

/// `PartnerStopService.assertOpen` with `assertOpenCounted`'s count.
pub fn assert_stop_open(store: &Store, partner_id: &str, kind: &str) -> Result<(), Refusal> {
    let read = store.pool().and_then(|pool| {
        with_client(pool, |c| {
            let rows = c.query(
                "SELECT stopped_kinds FROM bank.partner_stops WHERE partner_id = $1",
                &[&partner_id],
            )?;
            match rows.first() {
                None => Ok(Vec::new()),
                Some(r) => r
                    .try_get::<_, Vec<String>>(0)
                    .map_err(|e| StoreError::from(&e)),
            }
        })
    });
    let (refusal, cause) = match read {
        Ok(kinds) if kinds.iter().any(|k| k == kind) => (
            refuse(
                "bank.partner_stopped",
                format!(
                    "Operations have stopped this kind of move ({kind}) at the partner for now. Nothing was sent or changed."
                ),
            ),
            "stopped",
        ),
        Ok(_) => return Ok(()),
        Err(_) => (
            refuse(
                "bank.partner_stop_unreadable",
                "Whether moves at the partner are stopped could not be read, so nothing was sent.",
            ),
            "unreadable",
        ),
    };
    note(store, "partner_stop", cause, kind);
    Err(refusal)
}

/// Who holds bank money, and the guards every move asks (`BankRoot.custody` with its freeze and stop).
pub struct Custody<'a> {
    pub partner: Option<&'a TestPartner>,
    pub freeze: &'a dyn Freeze,
    pub store: &'a Store,
}

/// The guarded TEST partner for one person whose money it holds.
pub struct Held<'a> {
    custody: &'a Custody<'a>,
    partner: &'a TestPartner,
}

impl<'a> Custody<'a> {
    /// `bankFor`: the guarded partner when it holds this person's money (`custody: 'off'`), else none.
    pub fn bank_for(&'a self, user_id: &str) -> Option<Held<'a>> {
        let partner = self.partner?;
        partner
            .lock()
            .board
            .read(user_id, |s| s.custody == "off")
            .then_some(Held {
                custody: self,
                partner,
            })
    }
}

impl Held<'_> {
    /// The partner's name on every figure.
    pub fn label(&self) -> &'static str {
        super::LABEL
    }

    /// The guarded `move`: the stop, then the freeze, then the partner.
    pub fn move_(&self, req: &MoveRequest, now: Instant) -> Result<Move, Refusal> {
        assert_stop_open(self.custody.store, PARTNER_ID, "bank_move")?;
        assert_posting_enabled(self.custody.freeze, self.custody.store, "bank_move", true)?;
        self.partner.lock().move_raw(req, now)
    }

    /// The guarded `payments.pay`.
    pub fn pay(&self, req: &PaymentRequest, now: Instant) -> Result<Payment, Refusal> {
        assert_stop_open(self.custody.store, PARTNER_ID, "bank_move")?;
        assert_posting_enabled(self.custody.freeze, self.custody.store, "bank_move", true)?;
        self.partner.lock().pay(req, now)
    }

    /// `balance`: reads stay open under the freeze and a stop.
    pub fn balance(&self, account: &AccountRef, now: Instant) -> Balance {
        self.partner.lock().report(account, now)
    }

    /// `balances`: every figure the partner gives for the person's accounts.
    pub fn balances(&self, user_id: &str, now: Instant) -> Vec<Balance> {
        self.partner.lock().balances(user_id, now)
    }

    /// `limits`.
    pub fn limits(
        &self,
        user_id: &str,
        asset_id: &str,
        now: Instant,
    ) -> Result<super::SendLimits, Refusal> {
        self.partner.lock().limits(user_id, asset_id, now)
    }

    /// `purchases.holds`.
    pub fn purchase_holds(
        &self,
        user_id: &str,
        now: Instant,
    ) -> Result<Option<super::desks::Holds>, Refusal> {
        self.partner.lock().purchase_holds(user_id, now)
    }

    /// `openCurrency`: the partner opens the person's currency account. Moves nothing, so it asks no guard.
    pub fn open_currency(
        &self,
        user_id: &str,
        asset_id: &str,
        now: Instant,
    ) -> Result<Balance, Refusal> {
        self.partner.lock().open_currency(user_id, asset_id, now)
    }

    /// `openOrders`.
    pub fn open_orders(&self, user_id: &str) -> Vec<super::OpenOrder> {
        self.partner.lock().open_orders(user_id)
    }

    /// `quoteMove`: the partner's quote for a move between the person's own accounts; asks no guard, as it moves
    /// nothing.
    pub fn quote_move(
        &self,
        from: &AccountRef,
        to: &AccountRef,
        amount: service_kit::money::Amount,
        now: Instant,
    ) -> Result<super::MoveQuote, Refusal> {
        self.partner.lock().quote_move(from, to, amount, now)
    }

    /// `payments.paymentByKey`: a payment as the partner holds it now.
    pub fn payment_by_key(&self, key: &str) -> Option<Payment> {
        self.partner.lock().payment_by_key(key)
    }

    /// `moveByKey`.
    pub fn move_by_key(&self, key: &str) -> Option<Move> {
        self.partner.lock().book.by_key(key).cloned()
    }

    /// `moves`.
    pub fn moves(&self, user_id: &str, q: &MovesQuery) -> Vec<Move> {
        self.partner.lock().moves(user_id, q)
    }

    /// `statement`.
    pub fn statement(
        &self,
        account: &AccountRef,
        from: Instant,
        to: Instant,
        now: Instant,
    ) -> Result<super::Statement, Refusal> {
        self.partner.lock().statement(account, from, to, now)
    }
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used, reason = "a test")]
    use super::*;
    use service_kit::http::{FetchError, HttpResponse};

    struct Answer(Result<(u16, &'static str), &'static str>);

    impl Fetch for Answer {
        fn fetch(&self, req: &HttpRequest) -> Result<HttpResponse, FetchError> {
            assert_eq!(req.url, "http://ledger:4001/health");
            assert_eq!(req.timeout_ms, Some(2_000));
            self.0
                .map(|(status, body)| HttpResponse {
                    status,
                    body: body.to_owned(),
                })
                .map_err(|m| FetchError {
                    message: m.to_owned(),
                })
        }
    }

    fn reading(answer: Result<(u16, &'static str), &'static str>) -> FreezeReading {
        read_freeze(&LedgerFreeze {
            url: "http://ledger:4001/some/path".to_owned(),
            fetch: Box::new(Answer(answer)),
        })
    }

    #[test]
    fn the_freeze_reads_svc_ledgers_health_and_anything_else_is_frozen() {
        assert!(reading(Ok((200, r#"{"postingEnabled":true}"#))).posting_enabled);
        let frozen = |a| reading(a).cause.unwrap();
        assert_eq!(
            frozen(Ok((
                200,
                r#"{"postingEnabled":false,"frozenCause":"mismatch"}"#
            ))),
            "mismatch"
        );
        assert_eq!(
            frozen(Ok((
                200,
                r#"{"postingEnabled":false,"frozenCause":"made_up"}"#
            ))),
            "not_reported"
        );
        assert_eq!(
            frozen(Ok((200, r#"{"postingEnabled":"yes"}"#))),
            "not_reported"
        );
        assert_eq!(
            frozen(Ok((503, r#"{"postingEnabled":true}"#))),
            "unreadable"
        );
        assert_eq!(frozen(Ok((200, "not json"))), "unreadable");
        assert_eq!(frozen(Err("fetch failed")), "unreadable");
        assert_eq!(read_freeze(&NotWired).cause.as_deref(), Some("not_wired"));
    }

    #[test]
    fn a_stop_that_cannot_be_read_refuses_rather_than_reading_as_open() {
        let store = Store::Down("no database".to_owned());
        let Err(Refusal::Bank(e)) = assert_stop_open(&store, PARTNER_ID, "bank_move") else {
            unreachable!("refused")
        };
        assert_eq!(e.row.code, "bank.partner_stop_unreadable");
    }
}
