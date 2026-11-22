//! The slice's calls (`router/spaces.router.ts`, `spaces/shared-pots.router.ts`, `account-home/account-home.router.ts`,
//! `router/limits.router.ts`, `router.ts`'s `directDeposit`, `fees` and `assets`, and `ops.runDormancy`), each checked as
//! the TypeScript checks it before any read: the partner's offer, then the owner's values, then the database.
//!
//! `sharedPots.freezeCard` proves the caller holds the pot's card, then is owed by slice `cards`, which sets the card's
//! status.

use service_kit::json::Json;
use service_kit::money::{format_amount, parse_amount};
use service_kit::schema::Value;
use service_kit::time::{Instant, js_date};
use service_kit::trpc::TrpcError;

use super::Wiring;
use super::home;
use super::shared::{self, InviteAsk, Ports};
use super::space::{self, Money, NewSpace, Space, with};
use crate::db::Store;
use crate::door::Ctx;
use crate::errors::{Refusal, to_trpc};
use crate::partner::refuse;
use crate::partner::router::Wiring as PartnerWiring;

/// `FEATURE_WORDS`.
fn feature_words(feature: &str) -> &'static str {
    match feature {
        "currencies" => "currency accounts",
        "spaces" => "spaces",
        "pots" => "pots",
        _ => "joint accounts and shared pots",
    }
}

/// `assertPartnerOffers`: the partner down refuses first, then a feature it does not offer; without it, nothing.
pub fn offers(partner: &PartnerWiring, user_id: &str, feature: &str) -> Result<(), Refusal> {
    let Some(p) = partner.partner.as_ref() else {
        return Ok(());
    };
    let now = p.switches(user_id);
    if now.down {
        return Err(refuse(
            "bank.partner_unavailable",
            "The partner bank is not answering. Nothing was sent or changed.",
        ));
    }
    if now.not_offered.iter().any(|f| f == feature) {
        return Err(refuse(
            "bank.not_offered_by_partner",
            format!(
                "Not offered by the partner: {}. Nothing was sent or changed.",
                feature_words(feature)
            ),
        ));
    }
    Ok(())
}

/// `assertSelf`.
fn assert_self(user_id: &str, owner: &str) -> Result<(), Refusal> {
    if user_id == owner {
        return Ok(());
    }
    Err(Refusal::Trpc(TrpcError::plain(
        "FORBIDDEN",
        "This account belongs to another user",
    )))
}

fn text<'v>(v: &'v Value, key: &str) -> &'v str {
    v.get(key).as_str().unwrap_or_default()
}

fn opt_text<'v>(v: &'v Value, key: &str) -> Option<&'v str> {
    v.get(key).as_str()
}

fn date(v: &Value, key: &str) -> Result<Instant, Refusal> {
    js_date(text(v, key)).ok_or_else(|| Refusal::Other(format!("{key} is no date")))
}

fn amount_of(s: &str) -> Result<service_kit::money::Amount, Refusal> {
    parse_amount(s).map_err(Refusal::Other)
}

fn iso(t: Option<Instant>) -> Json {
    t.map_or(Json::Null, |t| Json::str(t.iso()))
}

/// `potState`: an early unlock that has taken effect shows no lock; one still waiting shows the date and when it opens.
fn pot_state(s: &Space, now: Instant) -> Vec<(String, Json)> {
    let end = space::lock_end(s.locked_until, s.unlocks_at, now);
    let waiting = end.is_some() && s.unlocks_at.is_some();
    vec![
        (
            "goalTarget".to_owned(),
            s.goal_target
                .map_or(Json::Null, |g| Json::str(format_amount(g))),
        ),
        (
            "lockedUntil".to_owned(),
            if s.unlocks_at.is_some() && !waiting {
                Json::Null
            } else {
                iso(s.locked_until)
            },
        ),
        (
            "unlocksAt".to_owned(),
            if waiting {
                iso(s.unlocks_at)
            } else {
                Json::Null
            },
        ),
        (
            "unlockRequestedAt".to_owned(),
            if waiting {
                iso(s.unlock_requested_at)
            } else {
                Json::Null
            },
        ),
    ]
}

fn pot_out(s: &Space, now: Instant) -> Json {
    let mut f = vec![("id".to_owned(), Json::str(s.id.clone()))];
    f.extend(pot_state(s, now));
    Json::Object(f)
}

/// `overview` and the router's map: every space with its balance, the ledger's or the partner's figure.
fn spaces_list(
    store: &Store,
    money: &Money<'_>,
    user_id: &str,
    input: &Value,
) -> Result<Json, Refusal> {
    let page = space::spaces_list_limit(input.get("limit").as_number())?;
    let asset = opt_text(input, "assetId");
    space::ensure_held_primaries(store, money, user_id, asset);
    let spaces = space::list(store, money, user_id, asset, page)?;
    let partner = money.held(user_id);
    let reports = partner
        .as_ref()
        .map(|p| p.balances(user_id, money.now))
        .unwrap_or_default();
    let mut views = Vec::new();
    for s in spaces {
        let (balance, held_at) = if let Some(p) = &partner {
            let account = s.partner_account();
            let reported = reports
                .iter()
                .find(|b| {
                    b.account.asset_id == account.asset_id && b.account.space_id == account.space_id
                })
                .cloned()
                .unwrap_or_else(|| p.balance(&account, money.now));
            let (Some(amount), Some(as_of)) = (reported.amount, reported.as_of) else {
                return Err(crate::partner::balance_not_known(reported.label));
            };
            let age = money.now.0 - as_of.0;
            if age < -crate::partner::STALE_AFTER_MS {
                return Err(crate::partner::balance_not_known(reported.label));
            }
            let figure = format_amount(amount);
            let held = Json::obj([
                ("label", Json::str(reported.label)),
                ("asOf", Json::str(as_of.iso())),
                (
                    "figure",
                    Json::obj([
                        (
                            "state",
                            Json::str(if age > crate::partner::STALE_AFTER_MS {
                                "stale"
                            } else {
                                "known"
                            }),
                        ),
                        ("source", Json::str(reported.label)),
                        ("amount", Json::str(figure.clone())),
                        ("asOf", Json::str(as_of.iso())),
                        ("staleAfterMs", Json::int(crate::partner::STALE_AFTER_MS)),
                        ("reason", Json::Null),
                    ]),
                ),
            ]);
            (figure, Some(held))
        } else {
            (format_amount(money.balance_of(&s)?), None)
        };
        views.push((s, balance, held_at));
    }
    let bills = space::bills_pots(store, user_id)?;
    let now = money.now;
    Ok(Json::Array(
        views
            .into_iter()
            .map(|(s, balance, held_at)| {
                let mut f = vec![
                    ("id".to_owned(), Json::str(s.id.clone())),
                    ("assetId".to_owned(), Json::str(s.asset_id.clone())),
                    ("kind".to_owned(), Json::str(s.kind.clone())),
                    ("name".to_owned(), Json::str(s.name.clone())),
                ];
                f.extend(pot_state(&s, now));
                f.push((
                    "billsPot".to_owned(),
                    bills
                        .iter()
                        .find(|b| b.space_id == s.id)
                        .map_or(Json::Null, |b| {
                            Json::obj([("fallback", Json::Bool(b.fallback))])
                        }),
                ));
                f.push(("balance".to_owned(), Json::str(balance)));
                f.push((
                    "ledgerAccount".to_owned(),
                    if held_at.is_some() {
                        Json::Null
                    } else {
                        s.ledger_account().json()
                    },
                ));
                f.push(("heldAt".to_owned(), held_at.unwrap_or(Json::Null)));
                Json::Object(f)
            })
            .collect(),
    ))
}

fn owned(store: &Store, user_id: &str, space_id: &str) -> Result<Space, Refusal> {
    let s = with(store, |c| space::get(c, space_id))?;
    assert_self(user_id, &s.user_id)?;
    Ok(s)
}

/// The paths this slice answers.
pub fn serves(path: &str) -> bool {
    matches!(
        path.split_once('.').map_or(path, |(a, _)| a),
        "spaces"
            | "sharedPots"
            | "accounts"
            | "currencies"
            | "dormancy"
            | "plans"
            | "fees"
            | "assets"
    ) || matches!(path, "directDeposit" | "partnerHolds" | "ops.runDormancy")
}

/// The answer of one of the slice's calls, by its path; `None` for a path outside it.
/// `freeze_card` is slice `cards`' freeze of a pot's card by its holder (`bank.cards.setStatus(cardId, 'frozen', userId)`):
/// the card id and the caller, answered with the pot's view of the card.
pub fn answer(
    w: &Wiring,
    partner: &PartnerWiring,
    store: &Store,
    ctx: &Ctx<'_>,
    freeze_card: &dyn Fn(&str, &str) -> Result<Json, Refusal>,
) -> Option<Result<Option<Json>, TrpcError>> {
    if !serves(ctx.call.path) {
        return None;
    }
    let user = ctx
        .principal
        .map(|p| p.user_id.as_str())
        .unwrap_or_default();
    let input = &ctx.input;
    let now = ctx.now;
    let custody = partner.custody(store);
    let money = Money {
        ledger: w.ledger.as_ref(),
        custody: &custody,
        now,
    };
    let ports = Ports {
        directory: w.directory.as_ref(),
        lookups: &w.lookups,
        terms: &w.terms,
    };
    let t = &w.tables;
    let profile = || opt_text(input, "profile");
    let out: Result<Json, Refusal> = (|| match ctx.call.path {
        "spaces.list" => spaces_list(store, &money, user, input),
        "spaces.unnamed" => Ok(Json::Array(
            space::unnamed_assets(store, &money, user)?
                .into_iter()
                .map(|(a, b)| {
                    Json::obj([
                        ("assetId", Json::str(a)),
                        ("balance", Json::str(format_amount(b))),
                    ])
                })
                .collect(),
        )),
        "spaces.create" => {
            offers(partner, user, "spaces")?;
            let goal = opt_text(input, "goalTarget").map(amount_of).transpose()?;
            let locked = match opt_text(input, "lockedUntil") {
                Some(_) => Some(date(input, "lockedUntil")?),
                None => None,
            };
            let s = space::create_within_limit(
                store,
                &w.rules,
                &NewSpace {
                    user_id: user,
                    asset_id: text(input, "assetId"),
                    name: text(input, "name"),
                    goal_target: goal,
                    locked_until: locked,
                },
            )?;
            Ok(Json::obj([
                ("id", Json::str(s.id)),
                ("name", Json::str(s.name)),
            ]))
        }
        "spaces.archive" => {
            offers(partner, user, "spaces")?;
            let id = text(input, "spaceId");
            owned(store, user, id)?;
            space::archive(store, id)?;
            Ok(Json::obj([("archived", Json::Bool(true))]))
        }
        "spaces.unarchive" => {
            offers(partner, user, "spaces")?;
            let id = text(input, "spaceId");
            owned(store, user, id)?;
            space::unarchive_within_limit(store, &w.rules, id)?;
            Ok(Json::obj([("archived", Json::Bool(false))]))
        }
        "spaces.setGoal" => {
            offers(partner, user, "pots")?;
            let goal = opt_text(input, "goalTarget").map(amount_of).transpose()?;
            Ok(pot_out(
                &space::set_goal(store, text(input, "spaceId"), user, goal)?,
                now,
            ))
        }
        "spaces.setLock" => {
            offers(partner, user, "pots")?;
            let until = date(input, "lockedUntil")?;
            Ok(pot_out(
                &space::set_lock(store, &w.rules, text(input, "spaceId"), user, until, now)?,
                now,
            ))
        }
        "spaces.requestUnlock" => {
            offers(partner, user, "pots")?;
            Ok(pot_out(
                &space::request_unlock(store, &w.rules, text(input, "spaceId"), user, now)?,
                now,
            ))
        }
        "spaces.cancelUnlock" => {
            offers(partner, user, "pots")?;
            Ok(pot_out(
                &space::cancel_unlock(store, text(input, "spaceId"), user, now)?,
                now,
            ))
        }
        "spaces.setBillsPot" => {
            offers(partner, user, "pots")?;
            let fallback = matches!(input.get("fallback"), Value::Bool(true));
            let pot = space::set_bills_pot(store, user, text(input, "spaceId"), fallback)?;
            Ok(Json::obj([
                ("spaceId", Json::str(pot.space_id)),
                ("assetId", Json::str(pot.asset_id)),
                ("fallback", Json::Bool(pot.fallback)),
            ]))
        }
        "spaces.clearBillsPot" => {
            offers(partner, user, "pots")?;
            let id = text(input, "spaceId");
            space::clear_bills_pot(store, user, id)?;
            Ok(Json::obj([
                ("spaceId", Json::str(id)),
                ("billsPot", Json::Null),
            ]))
        }
        "spaces.ownedAccounts" => Ok(Json::obj([(
            "spaces",
            Json::Array(
                space::all_named_spaces(store, text(input, "userId"))?
                    .into_iter()
                    .map(|s| {
                        Json::obj([
                            ("spaceId", Json::str(s.id)),
                            ("assetId", Json::str(s.asset_id)),
                            ("name", Json::str(s.name)),
                            ("archived", Json::Bool(s.archived_at.is_some())),
                        ])
                    })
                    .collect(),
            ),
        )])),
        "sharedPots.list" => {
            shared::overview(store, &ports, &money, user, input.get("limit").as_number())
        }
        "sharedPots.invite" => {
            offers(partner, user, "joint")?;
            shared::invite(
                store,
                &ports,
                &InviteAsk {
                    invite_id: text(input, "inviteId"),
                    owner: user,
                    space_id: text(input, "spaceId"),
                    handle: text(input, "handle"),
                    email: text(input, "email"),
                    role: text(input, "role"),
                },
                now,
            )
        }
        "sharedPots.cancelInvite" => {
            offers(partner, user, "joint")?;
            shared::cancel_invite(store, text(input, "inviteId"), user)
        }
        "sharedPots.accept" => {
            offers(partner, user, "joint")?;
            shared::accept(store, &w.terms, text(input, "inviteId"), user)
        }
        "sharedPots.decline" => {
            offers(partner, user, "joint")?;
            shared::decline(store, text(input, "inviteId"), user)
        }
        "sharedPots.leave" => {
            offers(partner, user, "joint")?;
            shared::leave(store, text(input, "spaceId"), user)
        }
        "sharedPots.remove" => {
            offers(partner, user, "joint")?;
            shared::remove(store, text(input, "spaceId"), user, text(input, "userId"))
        }
        "sharedPots.linkCard" => {
            offers(partner, user, "joint")?;
            shared::link_card(
                store,
                &w.terms,
                text(input, "spaceId"),
                user,
                text(input, "cardId"),
            )
        }
        "sharedPots.unlinkCard" => {
            offers(partner, user, "joint")?;
            shared::unlink_card(store, text(input, "spaceId"), user)
        }
        "sharedPots.freezeCard" => {
            let card_id = shared::card_to_freeze(store, &w.terms, text(input, "spaceId"), user)?;
            freeze_card(&card_id, user)
        }
        "sharedPots.activity" => shared::activity(
            store,
            &ports,
            text(input, "spaceId"),
            user,
            input.get("limit").as_number(),
            opt_text(input, "before"),
        ),
        "accounts.features" => {
            home::personal_only(store, user, profile())?;
            home::account_features(t.account_terms.as_deref())
        }
        "accounts.profile" => Ok(home::profile_view(&home::resolve(store, user, profile())?)),
        "currencies.list" => {
            home::personal_only(store, user, profile())?;
            home::currencies_list(store, &money, t.currencies.as_deref(), user)
        }
        "currencies.add" => {
            offers(partner, user, "currencies")?;
            home::personal_only(store, user, profile())?;
            home::currencies_add(
                store,
                &money,
                t.currencies.as_deref(),
                user,
                text(input, "assetId"),
            )
        }
        "currencies.remove" => {
            offers(partner, user, "currencies")?;
            home::personal_only(store, user, profile())?;
            home::currencies_remove(store, &money, user, text(input, "assetId"))
        }
        "plans.list" => home::plans_list(t.plans.as_deref()),
        "fees.account" => Ok(home::account_fees(t.fees.as_deref())),
        "fees.partner" => home::partner_limits(&money, user, text(input, "assetId")),
        "partnerHolds" => home::partner_holds(&money, user),
        "dormancy.rules" => Ok(Json::Array(
            home::dormancy_rules(t.dormancy.as_deref())?
                .iter()
                .map(home::rule_json)
                .collect(),
        )),
        "dormancy.notices" => home::dormancy_notices(store, user),
        "ops.runDormancy" => {
            let at = date(input, "at")?;
            let users: Vec<String> = input
                .get("userIds")
                .as_array()
                .unwrap_or_default()
                .iter()
                .filter_map(|u| u.as_str().map(str::to_owned))
                .collect();
            home::dormancy_run(store, &money, t.dormancy.as_deref(), at.0, &users)
        }
        "assets.list" => home::assets_list(w.ledger.as_ref()),
        "directDeposit" => Err(refuse(
            "bank.no_paycheck_rail",
            "Direct deposit is refused. The missing piece is an outside company, the paycheck rail.",
        )),
        other => Err(Refusal::Trpc(TrpcError::plain(
            "INTERNAL_SERVER_ERROR",
            format!("svc-bank in Rust: {other} is in no ported call of the spaces slice"),
        ))),
    })();
    Some(out.map(Some).map_err(|r| {
        to_trpc(r, || {
            service_kit::approvals::random_uuid().unwrap_or_default()
        })
    }))
}
