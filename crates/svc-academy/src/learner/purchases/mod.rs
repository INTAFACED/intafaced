//! J-academy-07 (AC-commerce-01, AC-access-grants-01): buying the certificate track of a paid course staff made, from
//! the buyer's own wallet, and a staff refund (`purchases/course-purchases.ts`, statement for statement).
//!
//! INTAFACED holds none of the buyer's money (the launch money model). The buyer's wallet signs one token transfer of
//! the price to INTAFACED's own receiving address. Academy reads the chain; once the payment has the confirmations the
//! owner set, it records it once on the ledger (`academyPurchase`, keyed `academy:purchase:<course>:<learner>:<n>`) and
//! only then writes the access grant.
//!
//! Order, every time:
//!   1. The intent and its terms are stored first; the wallet is asked to sign only on the one answer that opened it.
//!   2. The payment is found on the chain by its hash, or, when the hash was lost, by the wallet's transfer of exactly
//!      the price to the receiver since the intent's block.
//!   3. A confirmed payment is claimed for posting by one conditional UPDATE, posted with no transaction open, and the
//!      answer written. A retry is the same key. The grant is written in the transaction that marks it posted.
//!   4. A refund is stored first (its key, reason and who), then sent by the owner's refund signer under its key,
//!      confirmed on the chain, posted once as the exact reverse (`academyPurchaseRefund`), and the grant revoked.
//!
//! Nothing here signs, holds a key, or posts a customer balance; the ledger is reached only through its recipe door.

pub mod chain;
pub mod clients;

use postgres::{GenericClient, Row};
use service_kit::json::Json;
use crate::learner::sql::Pool;

use self::chain::{is_address, is_tx_hash, is_unread, to_base_units, transfer_calldata};
use super::sql::{self, cell, exec, first, iso, ms, q};
use crate::errors::{AcademyError, Refusal};
use crate::ports::{Chain, Ledger, LinkedWallets, PaymentSettings, RefundSend, Refunds, TransferFact, TxFact};

/// `POST_BUDGET.deadlineMs` (25 s) rounded up, plus 5: no post is still waiting on the ledger after this long.
pub const POST_DEADLINE_SECONDS: i64 = 30;
/// How long the reconciler keeps searching a set-aside intent for a payment sent before it was set aside.
const ABANDONED_SEARCH_DAYS: i64 = 7;

/// `DEFINITE_POST_REFUSAL_CODES`: only these prove nothing was booked.
const DEFINITE_POST_REFUSALS: [&str; 5] = [
    "ledger.insufficient_funds",
    "ledger.invalid_entry",
    "ledger.unbalanced",
    "ledger.owner_identity_space",
    "ledger.frozen",
];

/// `canonicalPrice`: a stored numeric without its trailing zeros.
pub fn canonical_price(price: &str) -> String {
    if price.contains('.') {
        let t = price.trim_end_matches('0');
        t.strip_suffix('.').unwrap_or(t).to_owned()
    } else {
        price.to_owned()
    }
}

pub fn purchase_key_of(course: &str, user_id: &str, n: i32) -> String {
    format!("academy:purchase:{course}:{user_id}:{n}")
}

pub fn refund_key_of(course: &str, user_id: &str, n: i32) -> String {
    format!("academy:refund:{course}:{user_id}:{n}")
}

/// What one post came to (`PostAnswer`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PostAnswer {
    Posted(String),
    Refused(String),
    Unknown(String),
}

/// `answer(post)`: the ledger's receipt, a definite refusal, or not known yet.
pub fn answer(result: Result<Json, Refusal>) -> PostAnswer {
    match result {
        Ok(receipt) => match receipt.get("txId") {
            Some(Json::String(id)) => PostAnswer::Posted(id.clone()),
            _ => PostAnswer::Unknown("ledger.answer_lost".to_owned()),
        },
        Err(Refusal::Internal { code: Some(code), .. }) => {
            if DEFINITE_POST_REFUSALS.contains(&code.as_str()) {
                PostAnswer::Refused(code)
            } else {
                PostAnswer::Unknown(code)
            }
        }
        Err(_) => PostAnswer::Unknown("ledger.answer_lost".to_owned()),
    }
}

/// `PurchasePost`.
pub struct PurchasePost<'a> {
    pub course: &'a str,
    pub user_id: &'a str,
    pub n: i32,
    pub asset: &'a str,
    pub amount: String,
    pub receiver: &'a str,
    pub tx_hash: &'a str,
}

/// `purchaseLedger(ledger)`: the two posts, by recipe name and inputs only.
fn post(ledger: &dyn Ledger, input: &PurchasePost<'_>, refund: bool) -> PostAnswer {
    let place = Json::obj([
        ("kind", Json::str("treasury-wallet")),
        ("walletId", Json::str(input.receiver.to_lowercase())),
    ]);
    let body = Json::obj([
        ("course", Json::str(input.course)),
        ("userId", Json::str(input.user_id)),
        ("n", Json::str(input.n.to_string())),
        ("assetId", Json::str(input.asset)),
        ("amount", Json::str(input.amount.clone())),
        ("paymentId", Json::str(input.tx_hash)),
        (if refund { "from" } else { "to" }, place),
    ]);
    let (recipe, key) = if refund {
        ("academyPurchaseRefund", refund_key_of(input.course, input.user_id, input.n))
    } else {
        ("academyPurchase", purchase_key_of(input.course, input.user_id, input.n))
    };
    answer(ledger.post_recipe(recipe, &key, &body))
}

/// `CourseRow`.
#[derive(Debug, Clone)]
pub struct CourseRow {
    pub id: String,
    pub slug: String,
    pub state: String,
    pub pricing: String,
    pub price: Option<String>,
    pub price_asset: Option<String>,
}

/// `PurchaseRow` (times in epoch milliseconds).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PurchaseRow {
    pub id: String,
    pub course_id: String,
    pub course_slug: String,
    pub user_id: String,
    pub n: i32,
    pub purchase_key: String,
    pub price: String,
    pub asset: String,
    pub chain_id: i32,
    pub token: String,
    pub token_decimals: i32,
    pub receiver: String,
    pub payer: String,
    pub from_block: i64,
    pub state: String,
    pub tx_hash: Option<String>,
    pub failure: Option<String>,
    pub post_state: Option<String>,
    pub post_reason: Option<String>,
    pub ledger_tx_id: Option<String>,
    pub refund_key: Option<String>,
    pub refund_reason: Option<String>,
    pub refund_actor: Option<String>,
    pub refund_tx_hash: Option<String>,
    pub refund_send_at: Option<i64>,
    pub refund_ledger_tx_id: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
    pub posted_at: Option<i64>,
    pub refunded_at: Option<i64>,
}

/// The columns of `SELECT *` / `RETURNING *`, in the order [`row_of`] reads them.
pub fn columns() -> String {
    format!(
        "id::text, course_id::text, course_slug, user_id::text, n, purchase_key, price::text, asset, chain_id, token, \
         token_decimals, receiver, payer, from_block, state, tx_hash, failure, post_state, post_reason, ledger_tx_id, \
         refund_key, refund_reason, refund_actor::text, refund_tx_hash, {}, refund_ledger_tx_id, {}, {}, {}, {}",
        ms("refund_send_at"),
        ms("created_at"),
        ms("updated_at"),
        ms("posted_at"),
        ms("refunded_at")
    )
}

pub fn row_of(r: &Row) -> Result<PurchaseRow, Refusal> {
    Ok(PurchaseRow {
        id: cell(r, 0)?,
        course_id: cell(r, 1)?,
        course_slug: cell(r, 2)?,
        user_id: cell(r, 3)?,
        n: cell(r, 4)?,
        purchase_key: cell(r, 5)?,
        price: cell(r, 6)?,
        asset: cell(r, 7)?,
        chain_id: cell(r, 8)?,
        token: cell(r, 9)?,
        token_decimals: cell(r, 10)?,
        receiver: cell(r, 11)?,
        payer: cell(r, 12)?,
        from_block: cell(r, 13)?,
        state: cell(r, 14)?,
        tx_hash: cell(r, 15)?,
        failure: cell(r, 16)?,
        post_state: cell(r, 17)?,
        post_reason: cell(r, 18)?,
        ledger_tx_id: cell(r, 19)?,
        refund_key: cell(r, 20)?,
        refund_reason: cell(r, 21)?,
        refund_actor: cell(r, 22)?,
        refund_tx_hash: cell(r, 23)?,
        refund_send_at: cell(r, 24)?,
        refund_ledger_tx_id: cell(r, 25)?,
        created_at: cell(r, 26)?,
        updated_at: cell(r, 27)?,
        posted_at: cell(r, 28)?,
        refunded_at: cell(r, 29)?,
    })
}

fn one(c: &mut impl GenericClient, sql: &str, params: &[sql::P<'_>]) -> Result<Option<PurchaseRow>, Refusal> {
    first(c, sql, params)?.as_ref().map(row_of).transpose()
}

fn not_found(slug: &str) -> Refusal {
    AcademyError::new(
        format!("no published course has the address \"{slug}\""),
        "academy.course_not_found",
    )
    .into()
}

fn purchase_not_found() -> Refusal {
    AcademyError::new("no purchase with that key", "academy.purchase_not_found").into()
}

fn err(message: impl Into<String>, code: &str) -> Refusal {
    AcademyError::new(message, code).into()
}

fn plain(message: String) -> Refusal {
    Refusal::Internal { message, code: None }
}

/// `holdsPurchase(db, courseId, userId)`: a recorded, unrefunded purchase, what the certificate track needs.
pub fn holds_purchase(c: &mut impl GenericClient, course_id: &str, user_id: &str) -> Result<bool, Refusal> {
    Ok(first(
        c,
        "SELECT 1 AS n FROM academy.course_purchases \
         WHERE course_id = $1::text::uuid AND user_id = $2::text::uuid AND state = 'posted' LIMIT 1",
        &[&course_id, &user_id],
    )?
    .is_some())
}

/// `CoursePurchaseDeps`.
pub struct Deps<'a> {
    pub settings: Option<&'a PaymentSettings>,
    pub chain: Option<&'a dyn Chain>,
    pub ledger: Option<&'a dyn Ledger>,
    pub refunds: Option<&'a dyn Refunds>,
    pub wallets: Option<&'a dyn LinkedWallets>,
}

impl<'a> Deps<'a> {
    /// The deps as the service wires them from its ports.
    pub fn of(ports: &'a crate::ports::Ports) -> Deps<'a> {
        Deps {
            settings: ports.payment_settings.as_ref(),
            chain: ports.chain.as_deref(),
            ledger: ports.ledger.as_deref(),
            refunds: ports.refunds.as_deref(),
            wallets: ports.wallets.wired().then_some(ports.wallets.as_ref()),
        }
    }
}

pub struct CoursePurchases<'a> {
    pub pool: &'a Pool,
    pub deps: Deps<'a>,
}

impl CoursePurchases<'_> {
    /// Whether course payments are set up: every owner value, the chain node, the ledger and identity's wallets.
    pub fn payments_on(&self) -> bool {
        self.deps.settings.is_some()
            && self.deps.chain.is_some()
            && self.deps.ledger.is_some()
            && self.deps.wallets.is_some()
    }

    /// Whether a priced course can be sold (its price is in the payment token's asset).
    pub fn sells(&self, pricing: &str, price: Option<&str>, price_asset: Option<&str>) -> bool {
        self.payments_on()
            && pricing == "paid"
            && price.is_some()
            && price_asset.is_some()
            && self.deps.settings.map(|s| s.asset.as_str()) == price_asset
    }

    fn sells_course(&self, c: &CourseRow) -> bool {
        self.sells(&c.pricing, c.price.as_deref(), c.price_asset.as_deref())
    }

    /// The course's price, how it can be paid, and the caller's latest purchase, read against the chain first.
    pub fn view(&self, user_id: &str, slug: &str) -> Result<Json, Refusal> {
        let course = sql::on_pool(self.pool, |c| published_course(c, slug))?;
        let latest = sql::on_pool(self.pool, |c| latest(c, &course.id, user_id))?;
        let settled = match latest {
            Some(r) => Some(self.reconcile_row(r)?),
            None => None,
        };
        self.view_of(&course, settled.as_ref(), None)
    }

    /// Buy: store the intent (or find it) and answer with the one transaction to sign, only when this call opened it.
    pub fn buy(&self, user_id: &str, slug: &str, wallet: &str, now: i64) -> Result<Json, Refusal> {
        let wallet = wallet.to_lowercase();
        if !is_address(&wallet) {
            return Err(err(
                "academy.wallet_invalid the wallet address is not a 0x address",
                "academy.wallet_invalid",
            ));
        }
        let course = sql::on_pool(self.pool, |c| published_course(c, slug))?;
        if course.pricing != "paid" {
            return Err(err(format!("academy.payments_off \"{}\" is free", course.slug), "academy.payments_off"));
        }
        let Some(price) = course.price.clone() else {
            return Err(err(format!("academy.price_unset \"{}\" has no price", course.slug), "academy.price_unset"));
        };
        if !self.sells_course(&course) {
            return Err(err(
                "academy.payments_off course payments are not set up, so nothing is sold",
                "academy.payments_off",
            ));
        }
        let (Some(settings), Some(chain)) = (self.deps.settings, self.deps.chain) else {
            unreachable!("sells() holds both");
        };
        self.assert_own_wallet(user_id, &wallet)?;

        let mut latest_row = sql::on_pool(self.pool, |c| latest(c, &course.id, user_id))?;
        if let Some(r) = latest_row.take() {
            latest_row = Some(self.reconcile_row(r)?);
        }
        if let Some(l) = &latest_row
            && !matches!(l.state.as_str(), "abandoned" | "failed" | "refunded")
        {
            return self.view_of(&course, Some(l), None);
        }

        let from_block = match chain.block_number() {
            Ok(b) => b,
            Err(e) if is_unread(&e) => {
                let Refusal::Internal { message, .. } = e else { unreachable!() };
                return Err(err(
                    format!("academy.payments_off the payment network cannot be read: {message}"),
                    "academy.payments_off",
                ));
            }
            Err(e) => return Err(e),
        };
        let amount = to_base_units(&canonical_price(&price), settings.decimals).map_err(plain)?;
        let at = iso(now);
        let asset = course.price_asset.clone().unwrap_or_default();
        let chain_id = i32::try_from(settings.chain_id).unwrap_or(i32::MAX);
        let decimals = i32::try_from(settings.decimals).unwrap_or(i32::MAX);

        let opened = match &latest_row {
            Some(l) if l.state == "abandoned" || l.state == "failed" => sql::on_pool(self.pool, |c| {
                one(
                    c,
                    &format!(
                        "UPDATE academy.course_purchases \
                         SET state = 'awaiting_signature', payer = $1, tx_hash = NULL, \
                             price = $2::text::numeric, asset = $3, chain_id = $4, token = $5, \
                             token_decimals = $6, receiver = $7, updated_at = $8::text::timestamptz \
                         WHERE id = $9::text::uuid AND state = $10 RETURNING {}",
                        columns()
                    ),
                    &[
                        &wallet,
                        &price,
                        &asset,
                        &chain_id,
                        &settings.token,
                        &decimals,
                        &settings.receiver,
                        &at,
                        &l.id,
                        &l.state,
                    ],
                )
            })?,
            _ => {
                let n = latest_row.as_ref().map_or(1, |l| l.n + 1);
                let key = purchase_key_of(&course.slug, user_id, n);
                let block = i64::try_from(from_block).unwrap_or(i64::MAX);
                sql::on_pool(self.pool, |c| {
                    one(
                        c,
                        &format!(
                            "INSERT INTO academy.course_purchases \
                               (course_id, course_slug, user_id, n, purchase_key, price, asset, chain_id, token, \
                                token_decimals, receiver, payer, from_block, state, created_at, updated_at) \
                             VALUES ($1::text::uuid, $2, $3::text::uuid, $4, $5, $6::text::numeric, $7, $8, $9, $10, \
                                     $11, $12, $13, 'awaiting_signature', $14::text::timestamptz, \
                                     $14::text::timestamptz) \
                             ON CONFLICT DO NOTHING RETURNING {}",
                            columns()
                        ),
                        &[
                            &course.id,
                            &course.slug,
                            &user_id,
                            &n,
                            &key,
                            &price,
                            &asset,
                            &chain_id,
                            &settings.token,
                            &decimals,
                            &settings.receiver,
                            &wallet,
                            &block,
                            &at,
                        ],
                    )
                })?
            }
        };
        let Some(opened) = opened else {
            let now_latest = sql::on_pool(self.pool, |c| latest(c, &course.id, user_id))?;
            return self.view_of(&course, now_latest.as_ref(), None);
        };
        let data = transfer_calldata(&settings.receiver, amount).map_err(plain)?;
        let request = Json::obj([
            ("chainId", Json::int(settings.chain_id)),
            ("to", Json::str(settings.token.clone())),
            ("data", Json::str(data)),
        ]);
        self.view_of(&course, Some(&opened), Some(request))
    }

    /// The payer is the buyer's own wallet, one linked to their account at identity. Unread, nothing is opened.
    fn assert_own_wallet(&self, user_id: &str, wallet: &str) -> Result<(), Refusal> {
        let Some(wallets) = self.deps.wallets else {
            unreachable!("payments_on() holds wallets");
        };
        let Some(linked) = wallets.read(user_id) else {
            return Err(err(
                "academy.wallet_unread the wallets linked to this account cannot be read now",
                "academy.wallet_unread",
            ));
        };
        let usable = matches!(linked.get("state"), Some(Json::String(s)) if s == "usable");
        let has = matches!(linked.get("wallets"), Some(Json::Array(ws)) if ws.iter().any(|w| {
            matches!(w.get("address"), Some(Json::String(a)) if a == wallet)
        }));
        if !usable || !has {
            return Err(err(
                "academy.wallet_not_linked pay from a wallet linked to your own account",
                "academy.wallet_not_linked",
            ));
        }
        Ok(())
    }

    /// The wallet sent the payment: its hash is stored on the intent, then read against the chain.
    pub fn submit_payment(&self, user_id: &str, key: &str, tx_hash: &str, now: i64) -> Result<Json, Refusal> {
        let hash = tx_hash.to_lowercase();
        if !is_tx_hash(&hash) {
            return Err(err("academy.wallet_invalid not a transaction hash", "academy.wallet_invalid"));
        }
        let row = self.own(user_id, key)?;
        if row.state == "awaiting_signature" || row.state == "abandoned" {
            let at = iso(now);
            let done = sql::on_pool(self.pool, |c| {
                exec(
                    c,
                    "UPDATE academy.course_purchases SET state = 'submitted', tx_hash = $1, \
                     updated_at = $2::text::timestamptz \
                     WHERE id = $3::text::uuid AND state IN ('awaiting_signature', 'abandoned')",
                    &[&hash, &at, &row.id],
                )
            });
            match done {
                Err(e) if sql::has_code(&e, "23505") => {
                    return Err(err(
                        "academy.wallet_invalid that transaction already paid for a purchase",
                        "academy.wallet_invalid",
                    ));
                }
                other => {
                    other?;
                }
            }
        }
        self.view(user_id, &row.course_slug)
    }

    /// The wallet refused to sign: the intent is set aside. Read against the chain first.
    pub fn abandon(&self, user_id: &str, key: &str, now: i64) -> Result<Json, Refusal> {
        let row = self.reconcile_row(self.own(user_id, key)?)?;
        if row.state == "awaiting_signature" {
            let at = iso(now);
            sql::on_pool(self.pool, |c| {
                exec(
                    c,
                    "UPDATE academy.course_purchases SET state = 'abandoned', updated_at = $1::text::timestamptz \
                     WHERE id = $2::text::uuid AND state = 'awaiting_signature'",
                    &[&at, &row.id],
                )
            })?;
        }
        self.view(user_id, &row.course_slug)
    }

    /// Staff: one purchase by its key, read against the chain and the ledger first.
    pub fn staff_read(&self, key: &str) -> Result<Json, Refusal> {
        let row = sql::on_pool(self.pool, |c| by_key(c, key))?.ok_or_else(purchase_not_found)?;
        let row = self.reconcile_row(row)?;
        self.staff_of(&row)
    }

    /// Staff refund: stored first with its key, reason and who; then advanced by the reconciler, run once here.
    pub fn refund(&self, key: &str, reason: &str, actor_id: &str, now: i64) -> Result<Json, Refusal> {
        let reason = service_kit::schema::js_trim(reason).to_owned();
        if reason.is_empty() {
            return Err(err("academy.reason_required a refund needs a reason", "academy.reason_required"));
        }
        if self.deps.refunds.is_none() {
            return Err(err(
                "academy.refund_sender_unset no refund signer is set, so nothing is sent",
                "academy.refund_sender_unset",
            ));
        }
        if !self.payments_on() {
            return Err(err("academy.payments_off course payments are not set up", "academy.payments_off"));
        }
        let row = sql::on_pool(self.pool, |c| by_key(c, key))?.ok_or_else(purchase_not_found)?;
        let current = self.reconcile_row(row)?;
        if current.state == "posted" {
            let refund_key = refund_key_of(&current.course_slug, &current.user_id, current.n);
            let at = iso(now);
            sql::on_pool(self.pool, |c| {
                exec(
                    c,
                    "UPDATE academy.course_purchases \
                     SET state = 'refunding', refund_key = $1, refund_reason = $2, refund_actor = $3::text::uuid, \
                         updated_at = $4::text::timestamptz \
                     WHERE id = $5::text::uuid AND state = 'posted'",
                    &[&refund_key, &reason, &actor_id, &at, &current.id],
                )
            })?;
        } else if current.state != "refunding" && current.state != "refunded" {
            return Err(err(
                format!(
                    "academy.purchase_state a {} purchase is not recorded, so there is nothing to refund",
                    current.state
                ),
                "academy.purchase_state",
            ));
        }
        self.staff_read(key)
    }

    /// Every open purchase, read against the chain and the ledger once; one row's error goes to `on_error`.
    pub fn reconcile(&self, limit: i64, on_error: &mut dyn FnMut(&str, &Refusal)) -> Result<usize, Refusal> {
        let open = sql::on_pool(self.pool, |c| {
            q(
                c,
                &format!(
                    "SELECT {} FROM academy.course_purchases \
                     WHERE state IN ('awaiting_signature', 'submitted', 'confirmed', 'refunding') \
                     ORDER BY updated_at LIMIT $1",
                    columns()
                ),
                &[&limit],
            )
        })?;
        let set_aside = sql::on_pool(self.pool, |c| {
            q(
                c,
                &format!(
                    "SELECT {} FROM academy.course_purchases \
                     WHERE state = 'abandoned' AND updated_at > now() - make_interval(days => {ABANDONED_SEARCH_DAYS}) \
                     ORDER BY updated_at LIMIT $1",
                    columns()
                ),
                &[&limit],
            )
        })?;
        let total = open.len() + set_aside.len();
        for r in open.iter().chain(set_aside.iter()) {
            let row = row_of(r)?;
            let key = row.purchase_key.clone();
            if let Err(e) = self.reconcile_row(row) {
                on_error(&key, &e);
            }
        }
        Ok(total)
    }

    // ── The state machine ─────────────────────────────────────────────────────────────────────────────────────────

    /// Moves one purchase as far as the chain and the ledger allow now, and answers with it as stored.
    pub fn reconcile_row(&self, start: PurchaseRow) -> Result<PurchaseRow, Refusal> {
        let mut row = start;
        if self.deps.chain.is_none() || self.deps.ledger.is_none() {
            return Ok(row);
        }
        for _ in 0..6 {
            let next = match self.step(&row) {
                Ok(n) => n,
                // An unreadable node leaves the row where it is: unknown is not "no payment".
                Err(e) if is_unread(&e) => return Ok(row),
                Err(e) => return Err(e),
            };
            if next.state == row.state {
                return Ok(next);
            }
            row = next;
        }
        Ok(row)
    }

    fn step(&self, row: &PurchaseRow) -> Result<PurchaseRow, Refusal> {
        match row.state.as_str() {
            "awaiting_signature" | "abandoned" => self.find_lost_payment(row),
            "submitted" => self.confirm_payment(row),
            "confirmed" => self.post_purchase(row),
            "refunding" => self.advance_refund(row),
            _ => Ok(row.clone()),
        }
    }

    fn amount_of(row: &PurchaseRow) -> Result<u128, Refusal> {
        to_base_units(&canonical_price(&row.price), i64::from(row.token_decimals)).map_err(plain)
    }

    fn chain(&self) -> Result<&dyn Chain, Refusal> {
        self.deps.chain.ok_or_else(|| plain("no payment chain".to_owned()))
    }

    fn ledger(&self) -> Result<&dyn Ledger, Refusal> {
        self.deps.ledger.ok_or_else(|| plain("no ledger".to_owned()))
    }

    fn confirmations(&self) -> u64 {
        self.deps
            .settings
            .map_or(u64::MAX, |s| u64::try_from(s.confirmations).unwrap_or(0))
    }

    /// The hash was lost: the wallet's own transfer of exactly the price to the receiver since the intent, not yet
    /// counted, and not one another open intent of this wallet could equally have paid.
    fn find_lost_payment(&self, row: &PurchaseRow) -> Result<PurchaseRow, Refusal> {
        let transfers = self.chain()?.transfers(
            &row.token,
            &row.payer,
            &row.receiver,
            u64::try_from(row.from_block).unwrap_or(0),
        )?;
        let amount = Self::amount_of(row)?;
        for transfer in transfers.iter().filter(|t| t.amount == amount) {
            let used = sql::on_pool(self.pool, |c| {
                first(
                    c,
                    "SELECT id FROM academy.course_purchases WHERE chain_id = $1 AND tx_hash = $2",
                    &[&row.chain_id, &transfer.tx_hash],
                )
            })?;
            if used.is_some() {
                continue;
            }
            let block = transfer.block_number.to_string();
            let rival = sql::on_pool(self.pool, |c| {
                first(
                    c,
                    "SELECT id FROM academy.course_purchases \
                     WHERE id <> $1::text::uuid AND state IN ('awaiting_signature', 'abandoned') AND chain_id = $2 \
                       AND payer = $3 AND receiver = $4 AND token = $5 AND price = $6::text::numeric \
                       AND token_decimals = $7 AND from_block::numeric <= $8::text::numeric \
                     LIMIT 1",
                    &[
                        &row.id,
                        &row.chain_id,
                        &row.payer,
                        &row.receiver,
                        &row.token,
                        &row.price,
                        &row.token_decimals,
                        &block,
                    ],
                )
            })?;
            if rival.is_some() {
                continue;
            }
            let moved = sql::on_pool(self.pool, |c| {
                one(
                    c,
                    &format!(
                        "UPDATE academy.course_purchases SET state = 'submitted', tx_hash = $1, updated_at = now() \
                         WHERE id = $2::text::uuid AND state IN ('awaiting_signature', 'abandoned') RETURNING {}",
                        columns()
                    ),
                    &[&transfer.tx_hash, &row.id],
                )
            });
            let moved = match moved {
                // Another purchase took this hash between the read and the write: it is not this payment.
                Err(e) if sql::has_code(&e, "23505") => None,
                other => other?,
            };
            return match moved {
                Some(m) => Ok(m),
                None => self.reread(row),
            };
        }
        Ok(row.clone())
    }

    fn matches(t: &TransferFact, from: &str, to: &str, amount: u128) -> bool {
        t.from == from.to_lowercase() && t.to == to.to_lowercase() && t.amount == amount
    }

    /// The payment as the chain shows it: reverted or paying something else fails; enough confirmations confirm.
    fn confirm_payment(&self, row: &PurchaseRow) -> Result<PurchaseRow, Refusal> {
        let hash = row.tx_hash.clone().unwrap_or_default();
        let fact = self.chain()?.transaction(&hash, &row.token)?;
        let failure = match &fact {
            TxFact::Unseen => return Ok(row.clone()),
            TxFact::Reverted { .. } => Some("payment_reverted"),
            TxFact::Mined { transfers, .. } => {
                let amount = Self::amount_of(row)?;
                if transfers.iter().any(|t| Self::matches(t, &row.payer, &row.receiver, amount)) {
                    None
                } else {
                    Some("payment_mismatch")
                }
            }
        };
        if let Some(failure) = failure {
            let failed = sql::on_pool(self.pool, |c| {
                one(
                    c,
                    &format!(
                        "UPDATE academy.course_purchases SET state = 'failed', failure = $1, updated_at = now() \
                         WHERE id = $2::text::uuid AND state = 'submitted' RETURNING {}",
                        columns()
                    ),
                    &[&failure, &row.id],
                )
            })?;
            return failed.map_or_else(|| self.reread(row), Ok);
        }
        let TxFact::Mined { confirmations, .. } = fact else {
            return Ok(row.clone());
        };
        if confirmations < self.confirmations() {
            return Ok(row.clone());
        }
        let confirmed = sql::on_pool(self.pool, |c| {
            one(
                c,
                &format!(
                    "UPDATE academy.course_purchases SET state = 'confirmed', updated_at = now() \
                     WHERE id = $1::text::uuid AND state = 'submitted' RETURNING {}",
                    columns()
                ),
                &[&row.id],
            )
        })?;
        confirmed.map_or_else(|| self.reread(row), Ok)
    }

    fn post_of<'r>(row: &'r PurchaseRow, tx_hash: &'r str) -> PurchasePost<'r> {
        PurchasePost {
            course: &row.course_slug,
            user_id: &row.user_id,
            n: row.n,
            asset: &row.asset,
            amount: canonical_price(&row.price),
            receiver: &row.receiver,
            tx_hash,
        }
    }

    /// Claims the post: of two at once only one posts; a `posting` or `refused` claim older than the deadline is taken
    /// again on the same key.
    fn claim_post(&self, row: &PurchaseRow, state: &str) -> Result<bool, Refusal> {
        let claimed = sql::on_pool(self.pool, |c| {
            first(
                c,
                &format!(
                    "UPDATE academy.course_purchases SET post_state = 'posting', updated_at = now() \
                     WHERE id = $1::text::uuid AND state = $2 \
                       AND (post_state IS NULL OR post_state = 'unknown' \
                            OR (post_state IN ('posting', 'refused') \
                                AND updated_at < now() - make_interval(secs => {POST_DEADLINE_SECONDS}))) \
                     RETURNING id"
                ),
                &[&row.id, &state],
            )
        })?;
        Ok(claimed.is_some())
    }

    fn record_failed_post(&self, row: &PurchaseRow, state: &str, reason: &str) -> Result<PurchaseRow, Refusal> {
        let after = sql::on_pool(self.pool, |c| {
            one(
                c,
                &format!(
                    "UPDATE academy.course_purchases SET post_state = $1, post_reason = $2, updated_at = now() \
                     WHERE id = $3::text::uuid RETURNING {}",
                    columns()
                ),
                &[&state, &reason, &row.id],
            )
        })?;
        Ok(after.unwrap_or_else(|| row.clone()))
    }

    fn failed_answer(&self, row: &PurchaseRow, a: &PostAnswer) -> Option<Result<PurchaseRow, Refusal>> {
        match a {
            PostAnswer::Posted(_) => None,
            PostAnswer::Refused(r) => Some(self.record_failed_post(row, "refused", r)),
            PostAnswer::Unknown(r) => Some(self.record_failed_post(row, "unknown", r)),
        }
    }

    fn post_purchase(&self, row: &PurchaseRow) -> Result<PurchaseRow, Refusal> {
        if !self.claim_post(row, "confirmed")? {
            return self.reread(row);
        }
        let hash = row.tx_hash.clone().unwrap_or_default();
        let a = post(self.ledger()?, &Self::post_of(row, &hash), false);
        if let Some(failed) = self.failed_answer(row, &a) {
            return failed;
        }
        let PostAnswer::Posted(tx_id) = a else { unreachable!() };
        sql::begin(self.pool, |tx| {
            let posted = one(
                tx,
                &format!(
                    "UPDATE academy.course_purchases \
                     SET state = 'posted', post_state = NULL, post_reason = NULL, ledger_tx_id = $1, \
                         posted_at = now(), updated_at = now() \
                     WHERE id = $2::text::uuid AND state = 'confirmed' RETURNING {}",
                    columns()
                ),
                &[&tx_id, &row.id],
            )?;
            let Some(posted) = posted else {
                return by_key(tx, &row.purchase_key)?.ok_or_else(purchase_not_found);
            };
            grant(tx, &posted)?;
            Ok(posted)
        })
    }

    /// A refund: sent once under its key, confirmed on the chain, posted once, and the grant revoked with its reason.
    fn advance_refund(&self, row: &PurchaseRow) -> Result<PurchaseRow, Refusal> {
        let Some(refund_hash) = row.refund_tx_hash.clone() else {
            let Some(refunds) = self.deps.refunds else {
                return Ok(row.clone());
            };
            let claimed = sql::on_pool(self.pool, |c| {
                first(
                    c,
                    &format!(
                        "UPDATE academy.course_purchases SET refund_send_at = now() \
                         WHERE id = $1::text::uuid AND state = 'refunding' AND refund_tx_hash IS NULL \
                           AND (refund_send_at IS NULL \
                                OR refund_send_at < now() - make_interval(secs => {POST_DEADLINE_SECONDS})) \
                         RETURNING id"
                    ),
                    &[&row.id],
                )
            })?;
            if claimed.is_none() {
                return self.reread(row);
            }
            let release = || {
                sql::on_pool(self.pool, |c| {
                    exec(
                        c,
                        "UPDATE academy.course_purchases SET refund_send_at = NULL \
                         WHERE id = $1::text::uuid AND state = 'refunding' AND refund_tx_hash IS NULL",
                        &[&row.id],
                    )
                })
            };
            let sent = Self::amount_of(row).and_then(|amount| {
                refunds.send(&RefundSend {
                    key: row.refund_key.clone().unwrap_or_default(),
                    chain_id: u64::try_from(row.chain_id).unwrap_or(0),
                    token: row.token.clone(),
                    to: row.payer.clone(),
                    amount,
                })
            });
            let hash = match sent {
                Err(e) => {
                    release()?;
                    return Err(e);
                }
                Ok(h) => h,
            };
            // A lost answer frees the claim: the next try asks the signer again under the same key.
            let Some(hash) = hash else {
                release()?;
                return Ok(row.clone());
            };
            let stored = sql::on_pool(self.pool, |c| {
                one(
                    c,
                    &format!(
                        "UPDATE academy.course_purchases SET refund_tx_hash = $1, updated_at = now() \
                         WHERE id = $2::text::uuid AND state = 'refunding' AND refund_tx_hash IS NULL RETURNING {}",
                        columns()
                    ),
                    &[&hash, &row.id],
                )
            })?;
            return stored.map_or_else(|| self.reread(row), Ok);
        };
        let fact = self.chain()?.transaction(&refund_hash, &row.token)?;
        let TxFact::Mined { confirmations, transfers, .. } = fact else {
            return Ok(row.clone());
        };
        if confirmations < self.confirmations() {
            return Ok(row.clone());
        }
        let amount = Self::amount_of(row)?;
        // The signer answered a transaction that does not send this refund: stop and show it, never send again.
        if !transfers.iter().any(|t| Self::matches(t, &row.receiver, &row.payer, amount)) {
            if row.post_state.as_deref() == Some("refused") && row.post_reason.as_deref() == Some("refund_mismatch") {
                return Ok(row.clone());
            }
            return self.record_failed_post(row, "refused", "refund_mismatch");
        }
        if !self.claim_post(row, "refunding")? {
            return self.reread(row);
        }
        let a = post(self.ledger()?, &Self::post_of(row, &refund_hash), true);
        if let Some(failed) = self.failed_answer(row, &a) {
            return failed;
        }
        let PostAnswer::Posted(tx_id) = a else { unreachable!() };
        sql::begin(self.pool, |tx| {
            let refunded = one(
                tx,
                &format!(
                    "UPDATE academy.course_purchases \
                     SET state = 'refunded', post_state = NULL, post_reason = NULL, refund_ledger_tx_id = $1, \
                         refunded_at = now(), updated_at = now() \
                     WHERE id = $2::text::uuid AND state = 'refunding' RETURNING {}",
                    columns()
                ),
                &[&tx_id, &row.id],
            )?;
            let Some(refunded) = refunded else {
                return by_key(tx, &row.purchase_key)?.ok_or_else(purchase_not_found);
            };
            revoke(tx, &refunded)?;
            Ok(refunded)
        })
    }

    // ── Reads ─────────────────────────────────────────────────────────────────────────────────────────────────────

    fn reread(&self, row: &PurchaseRow) -> Result<PurchaseRow, Refusal> {
        Ok(sql::on_pool(self.pool, |c| by_key(c, &row.purchase_key))?.unwrap_or_else(|| row.clone()))
    }

    /// The caller's own purchase; someone else's is the same not-found as a missing one.
    fn own(&self, user_id: &str, key: &str) -> Result<PurchaseRow, Refusal> {
        match sql::on_pool(self.pool, |c| by_key(c, key))? {
            Some(r) if r.user_id == user_id => Ok(r),
            _ => Err(purchase_not_found()),
        }
    }

    fn grant_of(&self, row: &PurchaseRow) -> Result<Json, Refusal> {
        if !matches!(row.state.as_str(), "posted" | "refunding" | "refunded") {
            return Ok(Json::Null);
        }
        let g = sql::on_pool(self.pool, |c| {
            first(
                c,
                "SELECT state FROM academy.access_grants WHERE path_slug = $1 AND user_id = $2::text::uuid",
                &[&row.course_slug, &row.user_id],
            )
        })?;
        Ok(match g {
            None => Json::Null,
            Some(g) if cell::<String>(&g, 0)? == "granted" => Json::str("granted"),
            Some(_) => Json::str("revoked"),
        })
    }

    fn purchase_fields(&self, row: &PurchaseRow) -> Result<Vec<(String, Json)>, Refusal> {
        let opt = |v: &Option<String>| v.clone().map_or(Json::Null, Json::String);
        let at = |v: Option<i64>| v.map_or(Json::Null, |t| Json::str(iso(t)));
        let failure = row.failure.clone().or_else(|| {
            matches!(row.post_state.as_deref(), Some("refused" | "unknown"))
                .then(|| row.post_reason.clone())
                .flatten()
        });
        let refund = match &row.refund_key {
            Some(_) => Json::obj([
                ("txHash", opt(&row.refund_tx_hash)),
                ("reason", Json::str(row.refund_reason.clone().unwrap_or_default())),
            ]),
            None => Json::Null,
        };
        let state = if row.state == "abandoned" { "awaiting_signature" } else { row.state.as_str() };
        let Json::Object(fields) = Json::obj([
            ("key", Json::str(row.purchase_key.clone())),
            ("state", Json::str(state)),
            ("amount", Json::str(canonical_price(&row.price))),
            ("asset", Json::str(row.asset.clone())),
            ("chainId", Json::int(i64::from(row.chain_id))),
            ("token", Json::str(row.token.to_lowercase())),
            ("receiver", Json::str(row.receiver.to_lowercase())),
            ("payer", Json::str(row.payer.to_lowercase())),
            ("txHash", opt(&row.tx_hash)),
            ("failure", failure.map_or(Json::Null, Json::String)),
            ("grant", self.grant_of(row)?),
            ("refund", refund),
            ("createdAt", Json::str(iso(row.created_at))),
            ("postedAt", at(row.posted_at)),
            ("refundedAt", at(row.refunded_at)),
        ]) else {
            unreachable!()
        };
        Ok(fields)
    }

    fn view_of(&self, course: &CourseRow, row: Option<&PurchaseRow>, request: Option<Json>) -> Result<Json, Refusal> {
        let wallet = if course.pricing == "paid" && course.price.is_none() {
            Json::obj([("state", Json::str("off")), ("code", Json::str("academy.price_unset"))])
        } else if let (true, Some(s)) = (self.sells_course(course), self.deps.settings) {
            Json::obj([
                ("state", Json::str("on")),
                ("chainId", Json::int(s.chain_id)),
                ("token", Json::str(s.token.to_lowercase())),
                ("receiver", Json::str(s.receiver.to_lowercase())),
            ])
        } else {
            Json::obj([("state", Json::str("off")), ("code", Json::str("academy.payments_off"))])
        };
        let purchase = match row {
            Some(r) if r.state != "abandoned" => Json::Object(self.purchase_fields(r)?),
            _ => Json::Null,
        };
        Ok(Json::obj([
            ("slug", Json::str(course.slug.clone())),
            ("pricing", Json::str(course.pricing.clone())),
            ("price", course.price.as_deref().map_or(Json::Null, |p| Json::str(canonical_price(p)))),
            (
                "asset",
                match &course.price {
                    None => Json::Null,
                    Some(_) => course.price_asset.clone().map_or(Json::Null, Json::String),
                },
            ),
            ("wallet", wallet),
            ("card", Json::obj([("state", Json::str("off")), ("code", Json::str("rail.card"))])),
            ("purchase", purchase),
            ("request", request.unwrap_or(Json::Null)),
        ]))
    }

    fn staff_of(&self, row: &PurchaseRow) -> Result<Json, Refusal> {
        let mut fields = self.purchase_fields(row)?;
        let opt = |v: &Option<String>| v.clone().map_or(Json::Null, Json::String);
        fields.push(("course".to_owned(), Json::str(row.course_slug.clone())));
        fields.push(("userId".to_owned(), Json::str(row.user_id.clone())));
        fields.push(("ledgerTxId".to_owned(), opt(&row.ledger_tx_id)));
        fields.push(("refundLedgerTxId".to_owned(), opt(&row.refund_ledger_tx_id)));
        Ok(Json::Object(fields))
    }
}

/// The access grant, written with the post: one record per course and learner, its event keyed by the purchase.
fn grant(tx: &mut impl GenericClient, row: &PurchaseRow) -> Result<(), Refusal> {
    let g = first(
        tx,
        "INSERT INTO academy.access_grants (user_id, path_slug, source, reason, starts_at, expires_at, state, created_at, \
           updated_at) \
         VALUES ($1::text::uuid, $2, 'purchase', null, now(), null, 'granted', now(), now()) \
         ON CONFLICT (path_slug, user_id) DO UPDATE SET source = 'purchase', state = 'granted', expires_at = null, \
           updated_at = now() \
         RETURNING id::text",
        &[&row.user_id, &row.course_slug],
    )?
    .ok_or_else(|| Refusal::db("INSERT returned no row", None))?;
    let grant_id: String = cell(&g, 0)?;
    let next = next_event(tx, &grant_id)?;
    let key = format!("purchase:{}", row.purchase_key);
    exec(
        tx,
        "INSERT INTO academy.access_grant_events (grant_id, n, kind, key, reason, actor_id, expires_at, at) \
         VALUES ($1::text::uuid, $2, 'granted', $3, null, $4::text::uuid, null, now()) ON CONFLICT (key) DO NOTHING",
        &[&grant_id, &next, &key, &row.user_id],
    )?;
    Ok(())
}

fn next_event(tx: &mut impl GenericClient, grant_id: &str) -> Result<i32, Refusal> {
    let r = first(
        tx,
        "SELECT COALESCE(MAX(n), 0)::int + 1 AS n FROM academy.access_grant_events WHERE grant_id = $1::text::uuid",
        &[&grant_id],
    )?
    .ok_or_else(|| Refusal::db("SELECT returned no row", None))?;
    cell(&r, 0)
}

/// The grant ends with the refund's reason and who refunded, and a certificate-track enrolment it opened closes.
fn revoke(tx: &mut impl GenericClient, row: &PurchaseRow) -> Result<(), Refusal> {
    let g = first(
        tx,
        "UPDATE academy.access_grants SET state = 'revoked', updated_at = now() \
         WHERE path_slug = $1 AND user_id = $2::text::uuid AND source = 'purchase' RETURNING id::text",
        &[&row.course_slug, &row.user_id],
    )?;
    if let Some(g) = g {
        let grant_id: String = cell(&g, 0)?;
        let next = next_event(tx, &grant_id)?;
        let key = format!("refund:{}", row.refund_key.clone().unwrap_or_default());
        exec(
            tx,
            "INSERT INTO academy.access_grant_events (grant_id, n, kind, key, reason, actor_id, expires_at, at) \
             VALUES ($1::text::uuid, $2, 'revoked', $3, $4, $5::text::uuid, null, now()) ON CONFLICT (key) DO NOTHING",
            &[&grant_id, &next, &key, &row.refund_reason, &row.refund_actor],
        )?;
    }
    exec(
        tx,
        "UPDATE academy.course_enrolments SET left_at = now() \
         WHERE course_id = $1::text::uuid AND user_id = $2::text::uuid AND track = 'certificate' AND left_at IS NULL",
        &[&row.course_id, &row.user_id],
    )?;
    Ok(())
}

fn published_course(c: &mut impl GenericClient, slug: &str) -> Result<CourseRow, Refusal> {
    let r = first(
        c,
        "SELECT id::text, slug, state, pricing, price::text AS price, price_asset FROM academy.courses WHERE slug = $1",
        &[&slug],
    )?;
    let Some(r) = r else {
        return Err(not_found(slug));
    };
    let course = CourseRow {
        id: cell(&r, 0)?,
        slug: cell(&r, 1)?,
        state: cell(&r, 2)?,
        pricing: cell(&r, 3)?,
        price: cell(&r, 4)?,
        price_asset: cell(&r, 5)?,
    };
    if course.state != "published" {
        return Err(not_found(slug));
    }
    Ok(course)
}

fn latest(c: &mut impl GenericClient, course_id: &str, user_id: &str) -> Result<Option<PurchaseRow>, Refusal> {
    one(
        c,
        &format!(
            "SELECT {} FROM academy.course_purchases \
             WHERE course_id = $1::text::uuid AND user_id = $2::text::uuid ORDER BY n DESC LIMIT 1",
            columns()
        ),
        &[&course_id, &user_id],
    )
}

pub fn by_key(c: &mut impl GenericClient, key: &str) -> Result<Option<PurchaseRow>, Refusal> {
    one(
        c,
        &format!("SELECT {} FROM academy.course_purchases WHERE purchase_key = $1", columns()),
        &[&key],
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_stored_price_loses_only_its_trailing_zeros() {
        assert_eq!(canonical_price("20.000000000000000000"), "20");
        assert_eq!(canonical_price("2.500000000000000000"), "2.5");
        assert_eq!(canonical_price("100"), "100");
    }

    #[test]
    fn only_a_named_engine_refusal_is_refused() {
        let e = |c: &str| Err(Refusal::Internal { message: String::new(), code: Some(c.to_owned()) });
        assert_eq!(answer(e("ledger.frozen")), PostAnswer::Refused("ledger.frozen".to_owned()));
        assert_eq!(answer(e("ledger.custody_layer_off")), PostAnswer::Unknown("ledger.custody_layer_off".to_owned()));
        assert_eq!(
            answer(Err(Refusal::Internal { message: String::new(), code: None })),
            PostAnswer::Unknown("ledger.answer_lost".to_owned())
        );
        assert_eq!(answer(Ok(Json::obj([("txId", Json::str("t"))]))), PostAnswer::Posted("t".to_owned()));
    }
}
