//! Part `feed` of the activity slice (`activity/`): `activity.list`, `get`, `taxEffects`, `note.set`, `dispute.open`
//! and `savedFilters.list`, `save`, `remove` (`activity.router.ts`), and [`collect`] for the statements.
//!
//! - `service`: the merged feed over svc-ledger's history (`activity-service.ts`).
//! - `cursor`: the signed composite cursor (`activity-cursor.ts`).
//! - `kind`: the kind of each line and the tax-effect map (`activity-kind.ts`, `tax-effects.ts`).
//! - `partner`: the history when the partner bank holds the money (`partner-activity.ts`).
//! - `records`: notes, disputes, transfer messages, addresses, and the feed's reads of svc-bank's own tables.
//! - `saved`: saved filters (`saved-filters.ts`).
//! - `pay`: svc-pay's withdrawal addresses (`pay-withdrawal-addresses-client.ts`).
//!
//! Every handler answers through `activityFailure` (`failure`), not the main router's guard: a `BankError` is its own
//! sentence and code, and anything it does not name is "Something went wrong".

pub mod cursor;
pub mod kind;
pub mod partner;
pub mod pay;
pub mod records;
pub mod saved;
pub mod service;

use service_kit::json::Json;
use service_kit::schema::Value;
use service_kit::trpc::TrpcError;

use super::{Deps, user_of};
use crate::door::Ctx;
use crate::partner::custody::Custody;
use crate::partner::{Move, MovesQuery};
use records::StoreFeed;
pub use service::{CollectQuery, FeedError, Item};
use service::{Feed, PartnerBook, PayAddresses, Query};

/// What the door holds for this part, built once at start-up: the tax-effect map and svc-pay's withdrawal addresses.
#[derive(Default)]
pub struct Wiring {
    /// `taxEffects`: the owner's map, the TEST one on a test stack, or none (refused by name).
    pub tax_effects: Option<kind::TaxEffects>,
    /// `payWithdrawals`. None: only the bank's own off-ramps carry an address.
    pub pay: Option<Box<dyn PayAddresses>>,
}

impl Wiring {
    pub fn none() -> Wiring {
        Wiring::default()
    }
}

/// This part's wiring from the environment: `taxEffectsFor` (refused at boot outside dev or test) and svc-pay's client.
pub fn wiring(b: &super::Build<'_>) -> Result<Wiring, String> {
    let tax_effects = kind::tax_effects_for(
        b.env.str("BANK_TAX_EFFECTS").unwrap_or("off"),
        b.raw("APP_ENV"),
        b.raw("NODE_ENV"),
        &kind::OWNER_TAX_EFFECTS,
    )?;
    Ok(Wiring {
        tax_effects,
        pay: Some(Box::new(pay::PayHttp::new(
            b.env.str("PAY_URL"),
            b.env.str("INTERNAL_SERVICE_SECRET"),
            (b.fetch)(),
        ))),
    })
}

/// The partner's record through the door's custody (`custody.bankFor`).
struct DoorPartner<'a>(Custody<'a>);

impl PartnerBook for DoorPartner<'_> {
    fn holds(&self, user_id: &str) -> bool {
        self.0.bank_for(user_id).is_some()
    }

    fn moves(&self, user_id: &str, q: &MovesQuery) -> Result<Vec<Move>, FeedError> {
        Ok(self
            .0
            .bank_for(user_id)
            .map(|held| held.moves(user_id, q))
            .unwrap_or_default())
    }
}

/// The feed as `compose.ts` builds it: the ledger's pages, the cursor secret, the records, the send facts, the
/// custody and svc-pay.
fn with_feed<T>(d: &Deps<'_>, f: impl FnOnce(&Feed<'_>) -> T) -> T {
    let store = StoreFeed(d.store());
    let partner = DoorPartner(d.door.partner().custody(d.store()));
    let feed = Feed {
        spaces: &store,
        pages: Some(d.w.pages.as_ref()),
        secret: d.w.cursor_secret.as_deref(),
        counterparties: None,
        facts: Some(&store),
        records: Some(&store),
        partner: Some(&partner),
        pay: d.w.feed.pay.as_deref(),
    };
    f(&feed)
}

/// `ActivityService.collect`: every matching line in the range, newest first, for a statement (it stops after
/// `q.limit` matches; pass limit + 1 to see an overflow).
pub fn collect(d: &Deps<'_>, user_id: &str, q: CollectQuery) -> Result<Vec<Item>, FeedError> {
    with_feed(d, |feed| feed.collect(user_id, &q))
}

const SOMETHING_WRONG: &str = "Something went wrong. Please try again.";

/// `activityFailure`.
pub fn failure(e: FeedError) -> TrpcError {
    let coded = |trpc: &'static str, message: &str, code: &str| {
        TrpcError::caused(trpc, format!("{message} ({code})"), code)
    };
    match e {
        FeedError::CursorInvalid => TrpcError::plain(
            "BAD_REQUEST",
            "Activity cursor is not valid, start again without a cursor",
        ),
        FeedError::Range => TrpcError::caused(
            "BAD_REQUEST",
            "The end of the range is before the start",
            "bank.activity_range",
        ),
        FeedError::TaxYearUnset => coded(
            "PRECONDITION_FAILED",
            "The tax year start is not set. Filter by calendar year instead",
            "portfolio.tax_year_start_unset",
        ),
        FeedError::TaxEffectMapUnset => coded(
            "PRECONDITION_FAILED",
            "The tax effect of each kind of line is not set",
            "portfolio.tax_effect_map_unset",
        ),
        FeedError::SortBounded => coded(
            "PRECONDITION_FAILED",
            "Oldest first is limited to 2,000 matching lines. Narrow the dates, the account or the filters",
            "bank.activity_sort_bounded",
        ),
        FeedError::AccountUnknown => coded(
            "NOT_FOUND",
            "That account is not yours",
            "bank.activity_account_unknown",
        ),
        FeedError::NotFound => coded(
            "NOT_FOUND",
            "That transaction is not in your activity",
            "bank.activity_not_found",
        ),
        FeedError::LookupBounded => coded(
            "PRECONDITION_FAILED",
            "Activity lookup stopped before the end of your history. Try again.",
            "bank.activity_lookup_bounded",
        ),
        FeedError::Unavailable => TrpcError::plain(
            "SERVICE_UNAVAILABLE",
            "Activity is not available right now. Try again in a minute.",
        ),
        // `throwBankProcedure`: the sentence and its code, whatever the customer copy says.
        FeedError::Bank(b) => coded(b.row.trpc_code(), &b.message, b.row.code),
        FeedError::Other(s) => match s.code {
            Some(code) => TrpcError::caused("INTERNAL_SERVER_ERROR", SOMETHING_WRONG, code),
            None => TrpcError::plain("INTERNAL_SERVER_ERROR", SOMETHING_WRONG),
        },
        FeedError::Thrown(code) => {
            TrpcError::caused("INTERNAL_SERVER_ERROR", SOMETHING_WRONG, code)
        }
    }
}

fn text(v: &Value, key: &str) -> Option<String> {
    v.get(key).as_str().map(str::to_owned)
}

fn int(v: &Value, key: &str) -> Option<i64> {
    #[allow(
        clippy::cast_possible_truncation,
        reason = "the schema held it to a whole number"
    )]
    v.get(key).as_number().map(|n| n as i64)
}

/// `activityListInput` as the schema returned it.
fn query_of(v: &Value) -> Query {
    Query {
        limit: int(v, "limit"),
        cursor: text(v, "cursor"),
        asset_id: text(v, "assetId"),
        kind: v.get("kind").as_array().map(|a| {
            a.iter()
                .filter_map(|k| k.as_str().map(str::to_owned))
                .collect()
        }),
        direction: text(v, "direction"),
        from: text(v, "from"),
        to: text(v, "to"),
        q: text(v, "q"),
        min_amount: text(v, "minAmount"),
        max_amount: text(v, "maxAmount"),
        account_id: text(v, "accountId"),
        sort: text(v, "sort"),
        year: int(v, "year"),
        tax_year: int(v, "taxYear"),
        address: text(v, "address"),
        has_note: match v.get("hasNote") {
            Value::Bool(b) => Some(*b),
            _ => None,
        },
    }
}

fn page_json(p: service::Page) -> Json {
    Json::obj([
        (
            "items",
            Json::Array(p.items.iter().map(Item::json).collect()),
        ),
        ("nextCursor", p.next_cursor.map_or(Json::Null, Json::String)),
    ])
}

/// `transfers.list` (`router/transfers.router.ts`): the feed narrowed to transfers and space moves, every line
/// `completed`, with the fields that router writes. Its failures are the feed's (`activityFailure`).
pub fn transfers_list(d: &Deps<'_>, ctx: &Ctx<'_>) -> Result<Json, TrpcError> {
    let mut q = query_of(&ctx.input);
    q.kind = Some(
        ["transfer_in", "transfer_out", "space_move"]
            .map(str::to_owned)
            .to_vec(),
    );
    let page = with_feed(d, |f| f.list(user_of(ctx), &q)).map_err(failure)?;
    let items = page
        .items
        .iter()
        .map(|i| {
            let mut f = vec![
                ("id".to_owned(), Json::str(i.id.clone())),
                ("txId".to_owned(), Json::str(i.tx_id.clone())),
                ("kind".to_owned(), Json::str(i.kind)),
                ("direction".to_owned(), Json::str(i.direction)),
                ("asset".to_owned(), Json::str(i.asset.clone())),
                (
                    "amount".to_owned(),
                    Json::str(service_kit::money::format_amount(i.amount)),
                ),
                ("postedAt".to_owned(), Json::str(i.posted_at.iso())),
                ("status".to_owned(), Json::str("completed")),
                (
                    "counterparty".to_owned(),
                    i.counterparty.as_ref().map_or(Json::Null, |h| {
                        Json::obj([("handle", Json::str(h.clone()))])
                    }),
                ),
                ("spaceName".to_owned(), opt_str(i.space_name.clone())),
            ];
            if let Some(label) = &i.held_at {
                f.push((
                    "heldAt".to_owned(),
                    Json::obj([("label", Json::str(label.clone()))]),
                ));
            }
            for (key, v) in [("note", &i.note), ("reference", &i.reference)] {
                if let Some(v) = v.as_ref().filter(|v| !v.is_empty()) {
                    f.push((key.to_owned(), Json::str(v.clone())));
                }
            }
            Json::Object(f)
        })
        .collect();
    Ok(Json::obj([
        ("items", Json::Array(items)),
        ("nextCursor", opt_str(page.next_cursor)),
    ]))
}

fn saved_json(s: &saved::Saved) -> Result<Json, FeedError> {
    Ok(Json::obj([
        ("name", Json::str(s.name.clone())),
        ("filter", saved::body(&s.filter)?),
        ("createdAt", Json::str(s.created_at.clone())),
    ]))
}

fn opt_str(s: Option<String>) -> Json {
    s.map_or(Json::Null, Json::String)
}

/// The id of one line, refusing `order:` (`bank.activity_line_required`, thrown inside the guard) before any read.
fn one_line(id: &str) -> Result<(), FeedError> {
    if id.starts_with("order:") {
        return Err(FeedError::Thrown("BAD_REQUEST"));
    }
    Ok(())
}

fn handle(d: &Deps<'_>, ctx: &Ctx<'_>) -> Option<Result<Json, FeedError>> {
    let user = user_of(ctx);
    let input = &ctx.input;
    let store = d.store();
    Some(match ctx.call.path {
        "activity.list" => with_feed(d, |f| f.list(user, &query_of(input))).map(page_json),
        "activity.get" => {
            let id = text(input, "id").unwrap_or_default();
            with_feed(d, |f| f.get(user, &id)).map(|found| {
                let page = service::asset_page_of(if found.lines.is_empty() {
                    std::slice::from_ref(&found.item)
                } else {
                    &found.lines
                });
                Json::obj([
                    ("item", found.item.json()),
                    (
                        "lines",
                        Json::Array(found.lines.iter().map(Item::json).collect()),
                    ),
                    ("complete", Json::Bool(found.complete)),
                    ("assetPage", opt_str(page)),
                ])
            })
        }
        "activity.taxEffects" => match &d.w.feed.tax_effects {
            None => Err(FeedError::TaxEffectMapUnset),
            Some(m) => Ok(Json::obj([
                (
                    "effects",
                    Json::Object(
                        m.effects
                            .iter()
                            .map(|(k, v)| (k.clone(), Json::str(v.clone())))
                            .collect(),
                    ),
                ),
                ("label", m.label.map_or(Json::Null, Json::str)),
            ])),
        },
        "activity.note.set" => {
            let id = text(input, "id").unwrap_or_default();
            one_line(&id)
                .and_then(|()| with_feed(d, |f| f.get(user, &id)))
                .and_then(|_| {
                    records::set_note(
                        store,
                        user,
                        &id,
                        text(input, "text").as_deref(),
                        text(input, "reportDescription").as_deref(),
                        &text(input, "commandId").unwrap_or_default(),
                    )
                })
                .map(|n| {
                    Json::obj([
                        ("activityId", Json::str(n.activity_id)),
                        ("text", opt_str(n.text)),
                        ("reportDescription", opt_str(n.report_description)),
                        ("updatedAt", Json::str(n.updated_at)),
                    ])
                })
        }
        "activity.dispute.open" => {
            let id = text(input, "id").unwrap_or_default();
            one_line(&id)
                .and_then(|()| with_feed(d, |f| f.get(user, &id)))
                .and_then(|_| {
                    records::open_dispute(
                        store,
                        user,
                        &id,
                        &text(input, "reason").unwrap_or_default(),
                        &text(input, "disputeId").unwrap_or_default(),
                    )
                })
                .map(|o| {
                    Json::obj([
                        ("disputeId", Json::str(o.dispute_id)),
                        ("activityId", Json::str(o.activity_id)),
                        ("status", Json::str("open")),
                        ("reason", Json::str(o.reason)),
                        ("createdAt", Json::str(o.created_at)),
                    ])
                })
        }
        "activity.savedFilters.list" => saved::list(store, user, int(input, "limit"))
            .and_then(|rows| rows.iter().map(saved_json).collect::<Result<Vec<_>, _>>())
            .map(Json::Array),
        "activity.savedFilters.save" => {
            let filter = input
                .get("filter")
                .to_json()
                .unwrap_or(Json::Object(Vec::new()));
            saved::save(
                store,
                user,
                &text(input, "name").unwrap_or_default(),
                &filter,
            )
            .and_then(|(s, replayed)| {
                let Json::Object(mut f) = saved_json(&s)? else {
                    return Ok(Json::Null);
                };
                f.push(("replayed".to_owned(), Json::Bool(replayed)));
                Ok(Json::Object(f))
            })
        }
        "activity.savedFilters.remove" => {
            saved::remove(store, user, &text(input, "name").unwrap_or_default())
                .map(|deleted| Json::obj([("deleted", Json::Bool(deleted))]))
        }
        _ => return None,
    })
}

/// This part's answer to one of its calls.
pub fn answer(d: &Deps<'_>, ctx: &Ctx<'_>) -> Option<Result<Json, TrpcError>> {
    handle(d, ctx).map(|r| r.map_err(failure))
}

#[cfg(test)]
mod tests;
