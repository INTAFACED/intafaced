//! What the slice is handed (`LoanServiceOptions`): the owner's values, who buys seized collateral, where a margin
//! call is delivered, and svc-identity's affiliate doors after a house fee posts.

use service_kit::http::{Fetch, HttpRequest};
use service_kit::json::Json;
use service_kit::money::{Amount, Rounding, format_amount, mul_div};
use service_kit::s2s::CallSigner;
use service_kit::time::Instant;

use super::prices::{MarkPolicy, PriceSource};
use crate::db::Store;
use crate::spaces::ports::{Ledger, LedgerAccount};
use crate::transfers::Approvals;
use crate::transfers::ports::Bus;

/// The owner's missed-payment policy (`LoanMissedPaymentPolicy`), as `index.ts` reads it; none while blank.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MissedPaymentPolicy {
    pub grace_days: i64,
    pub catch_up_days: i64,
    pub late_fee: String,
}

/// The owner's values the slice reads, as `index.ts` hands them in.
#[derive(Debug, Clone)]
pub struct Settings {
    /// `BANK_LOANS_ENABLED`: off, a new loan, a quote and a seizure refuse `bank.loans_disabled`.
    pub module_enabled: bool,
    /// `LOAN_ACCRUAL_ENABLED`.
    pub accrual_enabled: bool,
    /// `LOAN_RISK_SWEEP_ENABLED`.
    pub risk_sweep_enabled: bool,
    /// `LOAN_SWEEP_BATCH_SIZE`: the job door's batch; none refuses.
    pub sweep_batch: Option<f64>,
    /// `BANK_LOAN_PAYOFF_FEE`, raw.
    pub payoff_fee: Option<String>,
    /// `BANK_LOAN_ORIGINATION_FEE_BPS`, raw.
    pub origination_fee_bps: Option<String>,
    /// `BANK_LOAN_PAYOFF_WINDOW_MINUTES`, raw.
    pub payoff_window_minutes: Option<String>,
    /// Signs `loans.statement` (the activity cursor secret unless the loans name their own); blank refuses.
    pub statement_secret: Option<String>,
    /// `BANK_MARGIN_WARNING_LTV_BPS`; none while blank.
    pub margin_warning_ltv_bps: Option<i64>,
    /// `BANK_LOAN_MISSED_PAYMENT_*`; none while blank.
    pub missed_payment: Option<MissedPaymentPolicy>,
    pub mark_policy: MarkPolicy,
    /// `daysPerYear`: 365 unless a test names another.
    pub days_per_year: i64,
}

impl Default for Settings {
    fn default() -> Settings {
        Settings {
            module_enabled: true,
            accrual_enabled: true,
            risk_sweep_enabled: false,
            sweep_batch: None,
            payoff_fee: None,
            origination_fee_bps: None,
            payoff_window_minutes: None,
            statement_secret: None,
            margin_warning_ltv_bps: None,
            missed_payment: None,
            mark_policy: super::prices::default_mark_policy(),
            days_per_year: super::risk::DAYS_PER_YEAR,
        }
    }
}

/// Who takes a seized tranche, and the accounts that settle it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VenueQuote {
    pub proceeds: Amount,
    pub collateral_to: LedgerAccount,
    pub proceeds_from: LedgerAccount,
}

/// What a sale asks the venue.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SaleAsk<'a> {
    pub loan_id: &'a str,
    pub collateral_asset_id: &'a str,
    pub collateral_amount: Amount,
    pub debt_asset_id: &'a str,
    pub mark_price: Amount,
}

/// `LiquidationVenue`: who buys seized collateral. `None` is nobody, and a liquidation with no buyer does not proceed.
pub trait Venue: Send + Sync {
    fn quote(&self, ask: &SaleAsk<'_>) -> Result<Option<VenueQuote>, String>;
}

/// `marketMakerVenue`: the platform's own market maker takes the other side, at the mark, with no slippage model.
pub struct MarketMaker;

/// `marketMaker(assetId)`.
pub fn market_maker(asset_id: &str) -> LedgerAccount {
    LedgerAccount {
        owner_type: "house",
        owner_id: "market-maker".to_owned(),
        asset_id: asset_id.to_owned(),
        kind: "available",
        purpose: None,
    }
}

/// One whole unit, scaled.
pub const ONE: Amount = Amount::whole(1);

impl Venue for MarketMaker {
    fn quote(&self, ask: &SaleAsk<'_>) -> Result<Option<VenueQuote>, String> {
        Ok(Some(VenueQuote {
            proceeds: mul_div(ask.collateral_amount, ask.mark_price, ONE, Rounding::Trunc),
            collateral_to: market_maker(ask.collateral_asset_id),
            proceeds_from: market_maker(ask.debt_asset_id),
        }))
    }
}

/// One margin call as it is delivered (`MarginCallSink.send`'s input).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MarginCallNotice {
    pub loan_id: String,
    pub user_id: String,
    /// Per-loan call number, from 1: half of the consumer's business key.
    pub sequence: i64,
    pub ltv_bps: i64,
    pub cure_collateral_amount: Amount,
    pub collateral_asset_id: String,
    pub called_at: Instant,
    pub grace_expires_at: Instant,
}

/// `MarginCallSink`: raising a call and telling the borrower stay two facts; an `Err` is a delivery that failed.
pub trait MarginCalls: Send + Sync {
    fn send(&self, n: &MarginCallNotice) -> Result<(), String>;
}

/// `recordOnlyMarginCallSink`: records the call and nothing else.
pub struct RecordOnly;

impl MarginCalls for RecordOnly {
    fn send(&self, _: &MarginCallNotice) -> Result<(), String> {
        Ok(())
    }
}

/// `eventMarginCallSink`: `bankMarginCalled` on the bus, keyed `bank.margin_call:<loanId>:<sequence>`.
pub struct BusMarginCalls<'a> {
    pub bus: &'a dyn Bus,
    pub producer: &'a str,
    pub now: Instant,
}

impl MarginCalls for BusMarginCalls<'_> {
    fn send(&self, n: &MarginCallNotice) -> Result<(), String> {
        let key = format!("bank.margin_call:{}:{}", n.loan_id, n.sequence);
        let subject = "intafaced.bank.margin_call.created";
        // The catalogue's schema (`bankMarginCalled`): a payload outside it is refused before it is sent.
        if !service_kit::tokens::is_guid(&n.loan_id)
            || n.sequence < 1
            || n.ltv_bps < 0
            || n.cure_collateral_amount < Amount::ZERO
        {
            return Err(format!(
                "bankMarginCalled payload from {} is invalid",
                self.producer
            ));
        }
        let envelope = Json::obj([
            ("id", Json::str(service_kit::approvals::random_uuid()?)),
            ("subject", Json::str(subject)),
            ("version", Json::int(1)),
            ("occurredAt", Json::str(self.now.iso())),
            ("producer", Json::str(self.producer)),
            ("idempotencyKey", Json::str(key.clone())),
            (
                "payload",
                Json::obj([
                    ("loanId", Json::str(n.loan_id.clone())),
                    ("userId", Json::str(n.user_id.clone())),
                    ("sequence", Json::int(n.sequence)),
                    ("ltvBps", Json::int(n.ltv_bps)),
                    (
                        "cureCollateralAmount",
                        Json::str(format_amount(n.cure_collateral_amount)),
                    ),
                    (
                        "collateralAssetId",
                        Json::str(n.collateral_asset_id.clone()),
                    ),
                    ("calledAt", Json::str(n.called_at.iso())),
                    ("graceExpiresAt", Json::str(n.grace_expires_at.iso())),
                ]),
            ),
        ]);
        self.bus.publish(subject, &key, &envelope)
    }
}

/// One house fee leg an affiliate may earn on (`AffiliateBankFeeLeg`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FeeLeg {
    pub user_id: String,
    pub fee_amount: Amount,
    pub fee_asset: String,
    pub fee_event_id: String,
}

/// `affiliateLegAfterLoanRepay`: the interest a repayment paid, if any.
pub fn leg_after_repay(
    loan_id: &str,
    borrower: &str,
    sequence: i64,
    interest: Amount,
    asset: &str,
) -> Vec<FeeLeg> {
    if interest <= Amount::ZERO {
        return Vec::new();
    }
    vec![FeeLeg {
        user_id: borrower.to_owned(),
        fee_amount: interest,
        fee_asset: asset.to_owned(),
        fee_event_id: format!("bank.repay:{loan_id}:{sequence}"),
    }]
}

/// `affiliateLegAfterLoanLiquidate`: the interest and penalty a sale paid the house, if any.
pub fn leg_after_liquidate(
    loan_id: &str,
    borrower: &str,
    tranche: i64,
    interest: Amount,
    penalty: Amount,
    asset: &str,
) -> Vec<FeeLeg> {
    let cut = interest + penalty;
    if cut <= Amount::ZERO {
        return Vec::new();
    }
    vec![FeeLeg {
        user_id: borrower.to_owned(),
        fee_amount: cut,
        fee_asset: asset.to_owned(),
        fee_event_id: format!("bank.liquidate:{loan_id}:{tranche}"),
    }]
}

/// svc-identity's affiliate doors (`AffiliateAccruePort`, `AffiliatePayoutPort`). Best effort: a failure never unwinds
/// the post that already happened.
pub trait Affiliates: Send + Sync {
    fn accrue(&self, leg: &FeeLeg) -> Result<(), String>;
    fn payout(&self, fee_event_id: &str) -> Result<(), String>;
}

/// No `IDENTITY_URL`: nothing is told.
pub struct NoAffiliates;

impl Affiliates for NoAffiliates {
    fn accrue(&self, _: &FeeLeg) -> Result<(), String> {
        Ok(())
    }
    fn payout(&self, _: &str) -> Result<(), String> {
        Ok(())
    }
}

/// `fireAffiliateAccrue` then `fireAffiliatePayout`: every failure swallowed.
pub fn tell_affiliates(a: &dyn Affiliates, legs: &[FeeLeg]) {
    for leg in legs {
        let _ = a.accrue(leg);
    }
    for leg in legs {
        let _ = a.payout(&leg.fee_event_id);
    }
}

/// `createAffiliateAccrueClient` / `createAffiliatePayoutClient`: signed POSTs to svc-identity, 2 s each; 2xx and 412
/// are fine.
pub struct AffiliatesHttp {
    base: String,
    signer: CallSigner,
    fetch: Box<dyn Fetch>,
}

impl AffiliatesHttp {
    pub fn new(base: &str, signer: CallSigner, fetch: Box<dyn Fetch>) -> AffiliatesHttp {
        AffiliatesHttp {
            base: base.trim_end_matches('/').to_owned(),
            signer,
            fetch,
        }
    }

    fn post(&self, path: &str, body: &Json, what: &str) -> Result<(), String> {
        let text = body.compact();
        let mut headers = self
            .signer
            .sign(&text, "POST", path, "application/json")
            .map_err(|e| e.to_string())?;
        headers.push(("content-type".to_owned(), "application/json".to_owned()));
        let res = self
            .fetch
            .fetch(&HttpRequest {
                method: "POST".to_owned(),
                url: format!("{}{path}", self.base),
                headers,
                body: Some(text),
                timeout_ms: Some(2_000),
                refuse_redirect: false,
            })
            .map_err(|e| e.message)?;
        if res.ok() || res.status == 412 {
            return Ok(());
        }
        Err(format!("affiliate {what} refused ({})", res.status))
    }
}

impl Affiliates for AffiliatesHttp {
    fn accrue(&self, leg: &FeeLeg) -> Result<(), String> {
        self.post(
            "/internal/affiliates/accrue",
            &Json::obj([
                ("feeEventId", Json::str(leg.fee_event_id.clone())),
                ("userId", Json::str(leg.user_id.clone())),
                ("feeAmount", Json::str(format_amount(leg.fee_amount))),
                ("asset", Json::str(leg.fee_asset.clone())),
                ("sourceModule", Json::str("bank")),
            ]),
            "accrue",
        )
    }

    fn payout(&self, fee_event_id: &str) -> Result<(), String> {
        self.post(
            "/internal/affiliates/payout",
            &Json::obj([("feeEventId", Json::str(fee_event_id))]),
            "payout",
        )
    }
}

/// What every part of the slice is handed for one call or one pass.
pub struct Deps<'a> {
    pub store: &'a Store,
    pub ledger: &'a dyn Ledger,
    /// `LEDGER_CUSTODY_LAYER`: `on`, or anything else for off.
    pub custody_layer: &'a str,
    /// svc-identity's consume of an operator's approval.
    pub approvals: &'a dyn Approvals,
    pub prices: &'a dyn PriceSource,
    pub venue: &'a dyn Venue,
    pub margin_calls: &'a dyn MarginCalls,
    pub affiliates: &'a dyn Affiliates,
    pub settings: &'a Settings,
    pub now: Instant,
}
