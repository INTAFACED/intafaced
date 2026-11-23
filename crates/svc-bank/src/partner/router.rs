//! The slice's calls (`partner/test-partner.router.ts` and `router.ts`'s `convertCash`), and what the door holds for
//! them ([`Wiring`]).
//!
//! `testPartner.*` is the person's own TEST partner: off the TEST stack every call refuses `bank.test_partner_off`,
//! because there is no TEST partner to switch. Two of them are another slice's work: `settlePayment` records a bank API
//! payment's state change and its webhooks, and the door answers it in slice `bank-api` (`bank_api::router`); `cardRefund`
//! gives back a partner-held card capture (`card-ops`, whose refund it is) and answers "not ported" until that slice is.
//! `fundBusiness` and `businessStatement` read the business account's owner here (`bank.business_accounts`).

use service_kit::json::Json;
use service_kit::money::{format_amount, parse_amount};
use service_kit::schema::Value;
use service_kit::time::{Instant, js_date};
use service_kit::trpc::TrpcError;

use super::cash_leg::{self, Ask, CashLegs, VenueAccount};
use super::custody::{Custody, Freeze, NotWired};
use super::pay_in::PayInRail;
use super::{
    AccountRef, Funding, MERCHANT, MoveRequest, TestPartner, fees_account, payouts_account, refuse,
};
use crate::db::{Store, StoreError, with_client};
use crate::door::{Ctx, Slice, not_ported};
use crate::errors::{Refusal, to_trpc};

/// What the door holds for the slice, built once at start-up (`index.ts`: `testPartnerFor`, `ledgerPostingFreeze`,
/// `testCashLegFor`, `testPayInRailFor`).
pub struct Wiring {
    /// The TEST partner (`BANK_TEST_PARTNER=test`, dev or test only); `None` elsewhere.
    pub partner: Option<TestPartner>,
    /// svc-ledger's posting freeze.
    pub freeze: Box<dyn Freeze>,
    /// `LEDGER_CUSTODY_LAYER`: `on` or `off`.
    pub custody_layer: String,
    /// The TEST partner's cash leg, when the stack gives one.
    pub cash_legs: Option<CashLegs>,
    /// The TEST partner's USDC pay-in, when the TEST chain is given.
    pub pay_in: Option<PayInRail>,
}

impl Wiring {
    /// No TEST partner, no freeze wired, the custodial layer off: what a door built without the environment holds.
    pub fn none() -> Wiring {
        Wiring {
            partner: None,
            freeze: Box::new(NotWired),
            custody_layer: "off".to_owned(),
            cash_legs: None,
            pay_in: None,
        }
    }

    /// The custody every move goes through.
    pub fn custody<'a>(&'a self, store: &'a Store) -> Custody<'a> {
        Custody {
            partner: self.partner.as_ref(),
            freeze: self.freeze.as_ref(),
            store,
        }
    }
}

/// `NO_PARTNER_BANK_CODE`.
fn no_partner_bank(message: &str) -> Refusal {
    refuse("bank.no_partner_bank", message)
}

fn on(w: &Wiring) -> Result<&TestPartner, Refusal> {
    w.partner.as_ref().ok_or_else(|| {
        refuse(
            "bank.test_partner_off",
            "The TEST partner switches exist only on a stack that runs the TEST partner bank.",
        )
    })
}

fn text(v: &Value, key: &str) -> String {
    v.get(key).as_str().unwrap_or_default().to_owned()
}

/// An amount the call's schema already held to `amountString`.
fn amount(v: &Value, key: &str) -> Result<service_kit::money::Amount, Refusal> {
    parse_amount(v.get(key).as_str().unwrap_or_default()).map_err(Refusal::Other)
}

/// `new Date(<a zod datetime>)`.
fn date(v: &Value, key: &str) -> Result<Instant, Refusal> {
    js_date(v.get(key).as_str().unwrap_or_default())
        .ok_or_else(|| Refusal::Other(format!("{key} is no date")))
}

/// `businessTeam.assertOwner`: the business's currency, when the caller owns it.
fn assert_owner(store: &Store, account_id: &str, user_id: &str) -> Result<String, Refusal> {
    let row = store
        .pool()
        .and_then(|pool| {
            with_client(pool, |c| {
                let rows = c.query(
                    "SELECT asset_id, owner_user_id::text FROM bank.business_accounts WHERE id = $1::text::uuid",
                    &[&account_id],
                )?;
                rows.first()
                    .map(|r| {
                        Ok::<_, StoreError>((
                            r.try_get::<_, String>(0).map_err(|e| StoreError::from(&e))?,
                            r.try_get::<_, String>(1).map_err(|e| StoreError::from(&e))?,
                        ))
                    })
                    .transpose()
            })
        })
        .map_err(|e| Refusal::Other(e.message))?;
    let Some((asset, owner)) = row else {
        return Err(refuse(
            "bank.business_not_found",
            "No business account has this id.",
        ));
    };
    if owner != user_id {
        return Err(refuse(
            "bank.business_owner_only",
            "Only the owner of this business can do this.",
        ));
    }
    Ok(asset)
}

/// `businessPartnerAccount`.
fn business_account(account_id: &str, asset_id: &str) -> AccountRef {
    AccountRef::main(&format!("business:{account_id}"), asset_id)
}

/// `switches` and `set`'s view: the switches, then the label, then the reserve the partner reports.
fn view(now: &super::switches::Switches) -> Json {
    let mut fields = now.fields();
    fields.push(("label".to_owned(), Json::str(super::LABEL)));
    let reserve = if now.reserve == "required" {
        Json::obj([("required", Json::Bool(true)), ("amount", Json::Null)])
    } else {
        Json::obj([("required", Json::Bool(false))])
    };
    fields.push(("partnerReserve".to_owned(), reserve));
    Json::Object(fields)
}

fn balance_out(label: &str, asset_id: &str, b: &super::Balance) -> Result<Json, Refusal> {
    let (Some(amount), Some(as_of)) = (b.amount, b.as_of) else {
        return Err(Refusal::Other("a funding gave no figure".to_owned()));
    };
    Ok(Json::obj([
        ("label", Json::str(label)),
        ("assetId", Json::str(asset_id)),
        ("balance", Json::str(format_amount(amount))),
        ("asOf", Json::str(as_of.iso())),
    ]))
}

/// The answer of one of the slice's calls, by its path; `None` for a path outside it.
pub fn answer(w: &Wiring, store: &Store, ctx: &Ctx<'_>) -> Option<Result<Option<Json>, TrpcError>> {
    if !ctx.call.path.starts_with("testPartner.") && !ctx.call.path.starts_with("convertCash.") {
        return None;
    }
    let user = ctx
        .principal
        .map(|p| p.user_id.as_str())
        .unwrap_or_default();
    let input = &ctx.input;
    let now = ctx.now;
    let custody = w.custody(store);
    let out: Result<Json, Refusal> = (|| match ctx.call.path {
        "testPartner.switches" => {
            let p = on(w)?;
            Ok(view(&p.switches(user)))
        }
        "testPartner.set" => {
            let p = on(w)?;
            let mut state = p.lock();
            let next = state.board.get(user).with(input);
            let set = state.board.set(user, next);
            drop(state);
            Ok(view(&set))
        }
        "testPartner.fund" => {
            let p = on(w)?;
            let asset = text(input, "assetId");
            let funded = p.lock().fund(
                user,
                &Funding {
                    fund_id: text(input, "fundId"),
                    asset_id: asset.clone(),
                    amount: amount(input, "amount")?,
                },
                now,
            )?;
            balance_out(funded.label, &asset, &funded)
        }
        "testPartner.fundBusiness" => {
            let p = on(w)?;
            let account_id = text(input, "accountId");
            let asset = assert_owner(store, &account_id, user)?;
            if custody.bank_for(user).is_none() {
                return Err(no_partner_bank(
                    "This business’s money is not held at the TEST partner bank.",
                ));
            }
            let account = business_account(&account_id, &asset);
            let funded = p.lock().fund(
                &account.user_id,
                &Funding {
                    fund_id: text(input, "fundId"),
                    asset_id: asset.clone(),
                    amount: amount(input, "amount")?,
                },
                now,
            )?;
            balance_out(funded.label, &asset, &funded)
        }
        "testPartner.businessStatement" => {
            on(w)?;
            let account_id = text(input, "accountId");
            let asset = assert_owner(store, &account_id, user)?;
            // Read through the guarded partner, like every door here: reads stay open under the freeze and a stop.
            let Some(held) = custody.bank_for(user) else {
                return Err(no_partner_bank(
                    "This business’s money is not held at the TEST partner bank.",
                ));
            };
            let st = held.statement(
                &business_account(&account_id, &asset),
                date(input, "from")?,
                date(input, "to")?,
                now,
            )?;
            Ok(Json::obj([
                ("label", Json::str(st.label)),
                ("opening", Json::str(format_amount(st.opening))),
                ("closing", Json::str(format_amount(st.closing))),
                (
                    "lines",
                    Json::int(i64::try_from(st.lines).unwrap_or(i64::MAX)),
                ),
            ]))
        }
        "testPartner.spend" => {
            on(w)?;
            let Some(held) = custody.bank_for(user) else {
                return Err(no_partner_bank(
                    "This person has no money at the TEST partner bank, so nothing can leave it.",
                ));
            };
            let asset = text(input, "assetId");
            let to = match text(input, "kind").as_str() {
                "payout" => payouts_account(&asset),
                "fee" => fees_account(&asset),
                _ => AccountRef::main(MERCHANT, &asset),
            };
            let moved = held.move_(
                &MoveRequest {
                    key: format!("test-spend:{user}:{}", text(input, "spendId")),
                    from: AccountRef::main(user, &asset),
                    to,
                    amount: amount(input, "amount")?,
                    payees: None,
                },
                now,
            )?;
            Ok(Json::obj([
                ("label", Json::str(moved.label)),
                ("moveId", Json::str(moved.id)),
                ("amount", Json::str(format_amount(moved.amount))),
            ]))
        }
        "testPartner.openCompliance" => {
            let p = on(w)?;
            let id = format!("{user}:{}", text(input, "id"));
            #[allow(
                clippy::cast_possible_truncation,
                reason = "the schema holds dueDays to an integer in 1..=365"
            )]
            let due_days = input.get("dueDays").as_number().unwrap_or(0.0) as i64;
            let mut state = p.lock();
            let (label, id, due_at) = if text(input, "kind") == "request" {
                let r = state.compliance.open_request(user, &id, due_days, now)?;
                (r.label, r.id, r.due_at)
            } else {
                let r = state.compliance.open_review(user, &id, due_days, now)?;
                (r.label, r.id, r.due_at)
            };
            Ok(Json::obj([
                ("label", Json::str(label)),
                ("id", Json::str(id)),
                ("dueAt", Json::str(due_at.iso())),
            ]))
        }
        "testPartner.closurePaidOut" => {
            let p = on(w)?;
            let closed = p.lock().report_paid_out(user, now)?;
            Ok(Json::obj([
                ("label", Json::str(closed.label)),
                ("closureId", Json::str(closed.id)),
                (
                    "payoutMoveIds",
                    Json::Array(closed.payout_move_ids.iter().map(Json::str).collect()),
                ),
                ("closedAt", Json::str(closed.closed_at.unwrap_or(now).iso())),
            ]))
        }
        "testPartner.cardRefund" => {
            on(w)?;
            Err(Refusal::Trpc(not_ported(Slice::CardOps)))
        }
        "convertCash.offers" => Ok(cash_leg::offers(
            w.cash_legs.as_ref().filter(|_| w.partner.is_some()),
            &custody,
            &w.custody_layer,
            user,
            now,
        )),
        "convertCash.carry" => {
            let Some(legs) = w.cash_legs.as_ref().filter(|_| w.partner.is_some()) else {
                return Err(refuse(
                    "bank.cash_leg_not_offered",
                    format!(
                        "The partner does not offer cash through a coin here: {}. Nothing was moved.",
                        cash_leg::NONE_HERE
                    ),
                ));
            };
            let venue = input.get("venue");
            let ask = Ask {
                key: text(input, "legKey"),
                cash: text(input, "cash"),
                coin: text(input, "coin"),
                spend: amount(input, "spend")?,
                least: amount(input, "least")?,
                venue: VenueAccount {
                    venue_id: text(venue, "venueId"),
                    owner: text(venue, "owner").to_lowercase(),
                },
            };
            Ok(cash_leg::present(&legs.carry(
                &custody,
                &w.custody_layer,
                user,
                &ask,
                now,
            )?))
        }
        "convertCash.leg" => {
            let leg = w
                .cash_legs
                .as_ref()
                .filter(|_| w.partner.is_some())
                .and_then(|l| l.leg(user, &text(input, "legKey")));
            Ok(Json::obj([(
                "leg",
                leg.as_ref().map_or(Json::Null, cash_leg::present),
            )]))
        }
        other => Err(Refusal::Trpc(TrpcError::plain(
            "INTERNAL_SERVER_ERROR",
            format!("svc-bank in Rust: {other} is in no ported call of the partner slice"),
        ))),
    })();
    Some(out.map(Some).map_err(|r| {
        to_trpc(r, || {
            service_kit::approvals::random_uuid().unwrap_or_default()
        })
    }))
}
