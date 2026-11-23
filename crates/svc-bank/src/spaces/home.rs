//! The account home and the owner's tables (`account-home/`, `plans/`, `dormancy/`, `assets/`, and the partner's
//! limits and holds of `router/limits.router.ts`): which profile a call is for, the published account terms, the
//! currencies on an account, the plans and fee table, the dormancy fee, the supported asset list, and what the partner
//! reports it holds back. Every owner value is read as published and has no default: blank refuses by its own code.

use service_kit::json::{self, Json};
use service_kit::money::{Amount, format_amount, parse_amount};
use service_kit::time::Instant;

use super::ports::Ledger;
use super::space::{self, Money, Space, pg, reported, with};
use crate::db::Store;
use crate::errors::Refusal;
use crate::partner::custody::Held;
use crate::partner::{AccountRef, MoveRequest, MovesQuery, STALE_AFTER_MS, fees_account, refuse};

// ---------------------------------------------------------------------------------------------------------------
// Profiles (`account-home/profile.ts`)

/// The profile a call is made for: personal, or a business the caller belongs to.
pub enum Profile {
    Personal,
    Business {
        profile: String,
        account_id: String,
        name: String,
        role: String,
    },
}

fn not_held() -> Refusal {
    refuse("bank.profile_not_held", "This profile is not one you hold")
}

/// `BUSINESS_PROFILE`: `business:<lowercase uuid>`.
fn business_id(profile: &str) -> Option<&str> {
    let id = profile.strip_prefix("business:")?;
    let groups: Vec<&str> = id.split('-').collect();
    let ok = groups.len() == 5
        && groups.iter().zip([8, 4, 4, 4, 12]).all(|(g, n)| {
            g.len() == n
                && g.bytes()
                    .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
        });
    ok.then_some(id)
}

/// `ProfileService.resolve`: the profile, proved held by this caller, or `bank.profile_not_held`. Reads only.
pub fn resolve(pool: &Store, user_id: &str, profile: Option<&str>) -> Result<Profile, Refusal> {
    let Some(profile) = profile.filter(|p| *p != "personal") else {
        return Ok(Profile::Personal);
    };
    let Some(account_id) = business_id(profile) else {
        return Err(not_held());
    };
    let row = with(pool, |c| {
        c.query(
            "SELECT a.name, m.role::text FROM bank.business_accounts a \
             JOIN bank.business_members m ON m.account_id = a.id AND m.user_id = $1 \
             WHERE a.id = $2::text::uuid AND a.status = 'active'",
            &[&user_id, &account_id],
        )
        .map_err(|e| pg(&e))
    })?;
    let Some(r) = row.first() else {
        return Err(not_held());
    };
    Ok(Profile::Business {
        profile: profile.to_owned(),
        account_id: account_id.to_owned(),
        name: r.get(0),
        role: r.get(1),
    })
}

/// `personalOnly`: a held business refuses the personal-account parts, an unheld one too.
pub fn personal_only(pool: &Store, user_id: &str, profile: Option<&str>) -> Result<(), Refusal> {
    match resolve(pool, user_id, profile)? {
        Profile::Personal => Ok(()),
        Profile::Business { .. } => Err(refuse(
            "bank.company_account_unwired",
            "A business profile has no company account of its own in this build, so personal money is not shown as company money",
        )),
    }
}

/// `profileView`.
pub fn profile_view(held: &Profile) -> Json {
    match held {
        Profile::Personal => Json::obj([
            ("profile", Json::str("personal")),
            ("kind", Json::str("personal")),
            ("business", Json::Null),
        ]),
        Profile::Business {
            profile,
            account_id,
            name,
            role,
        } => Json::obj([
            ("profile", Json::str(profile.clone())),
            ("kind", Json::str("business")),
            (
                "business",
                Json::obj([
                    ("accountId", Json::str(account_id.clone())),
                    ("name", Json::str(name.clone())),
                    ("role", Json::str(role.clone())),
                ]),
            ),
        ]),
    }
}

// ---------------------------------------------------------------------------------------------------------------
// Owner tables

fn units(s: &str) -> usize {
    s.encode_utf16().count()
}

/// `/^\d+(\.\d{1,18})?$/`.
pub fn is_decimal(s: &str) -> bool {
    let (whole, frac) = match s.split_once('.') {
        Some((w, f)) => (w, Some(f)),
        None => (s, None),
    };
    !whole.is_empty()
        && whole.bytes().all(|b| b.is_ascii_digit())
        && frac.is_none_or(|f| (1..=18).contains(&f.len()) && f.bytes().all(|b| b.is_ascii_digit()))
}

/// `[A-Z0-9]{2,16}`.
fn is_asset_code(s: &str) -> bool {
    (2..=16).contains(&s.len())
        && s.bytes()
            .all(|b| b.is_ascii_uppercase() || b.is_ascii_digit())
}

fn parse_json(raw: Option<&str>) -> Option<Json> {
    let t = raw.map(service_kit::money::js_trim).unwrap_or_default();
    if t.is_empty() {
        return None;
    }
    json::parse(t).ok()
}

/// `parseAccountTerms` and `accountFeatures`: the owner's terms as published, with whether their overdraft can be used.
pub fn account_features(raw: Option<&str>) -> Result<Json, Refusal> {
    let unset = || {
        refuse(
            "bank.account_terms_unset",
            "The owner has not published the account terms, so no fee or feature is claimed",
        )
    };
    let Some(Json::Object(fields)) = parse_json(raw) else {
        return Err(unset());
    };
    const KEYS: [&str; 7] = [
        "tier",
        "version",
        "currency",
        "monthlyFee",
        "minimumBalance",
        "overdraftFee",
        "included",
    ];
    if fields.iter().any(|(k, _)| !KEYS.contains(&k.as_str())) {
        return Err(unset());
    }
    let field = |k: &str| fields.iter().find(|(f, _)| f == k).map(|(_, v)| v);
    let trimmed = |k: &str, max: usize| match field(k) {
        Some(Json::String(s)) => {
            let t = service_kit::money::js_trim(s);
            (1..=max).contains(&units(t)).then(|| t.to_owned())
        }
        _ => None,
    };
    let decimal = |k: &str| match field(k) {
        Some(Json::String(s)) if is_decimal(s) => Some(s.clone()),
        _ => None,
    };
    let (Some(tier), Some(version)) = (trimmed("tier", 64), trimmed("version", 64)) else {
        return Err(unset());
    };
    let Some(Json::String(currency)) =
        field("currency").filter(|c| matches!(c, Json::String(s) if is_asset_code(s)))
    else {
        return Err(unset());
    };
    let (Some(monthly), Some(minimum)) = (decimal("monthlyFee"), decimal("minimumBalance")) else {
        return Err(unset());
    };
    let overdraft = match field("overdraftFee") {
        Some(Json::Null) => None,
        Some(Json::String(s)) if is_decimal(s) => Some(s.clone()),
        _ => return Err(unset()),
    };
    let Some(Json::Array(included)) = field("included") else {
        return Err(unset());
    };
    if !(1..=20).contains(&included.len()) {
        return Err(unset());
    }
    let mut lines = Vec::new();
    for i in included {
        let Json::String(s) = i else {
            return Err(unset());
        };
        let t = service_kit::money::js_trim(s);
        if !(1..=140).contains(&units(t)) {
            return Err(unset());
        }
        lines.push(Json::str(t));
    }
    Ok(Json::obj([
        ("tier", Json::str(tier)),
        ("version", Json::str(version)),
        ("currency", Json::str(currency.clone())),
        ("monthlyFee", Json::str(monthly)),
        ("minimumBalance", Json::str(minimum)),
        (
            "overdraftFee",
            overdraft.clone().map_or(Json::Null, Json::str),
        ),
        ("included", Json::Array(lines)),
        (
            "overdraftBlocker",
            if overdraft.is_some() {
                Json::str("bank.overdraft_switched_off")
            } else {
                Json::Null
            },
        ),
    ]))
}

/// `text(v, max)` of `plans.ts`: a string not blank once trimmed, at most `max` units as given.
fn plan_text(v: Option<&Json>, max: usize) -> Option<String> {
    match v {
        Some(Json::String(s)) if !service_kit::money::js_trim(s).is_empty() && units(s) <= max => {
            Some(s.clone())
        }
        _ => None,
    }
}

fn plan_amount(v: Option<&Json>) -> Option<String> {
    match v {
        Some(Json::String(s)) if is_decimal(s) => parse_amount(s).ok().map(format_amount),
        _ => None,
    }
}

/// `ID`: `^[a-z][a-z0-9-]{0,31}$`.
fn is_plan_id(s: &str) -> bool {
    let b = s.as_bytes();
    (1..=32).contains(&b.len())
        && b.first().is_some_and(u8::is_ascii_lowercase)
        && b.iter()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || *c == b'-')
}

/// One plan as `plans.list` shows it.
#[derive(Debug, Clone)]
pub struct Plan {
    pub id: String,
    pub name: String,
    pub tier: String,
    pub price: String,
    pub asset_id: String,
}

impl Plan {
    fn fields(&self) -> Vec<(String, Json)> {
        vec![
            ("id".to_owned(), Json::str(self.id.clone())),
            ("name".to_owned(), Json::str(self.name.clone())),
            ("tier".to_owned(), Json::str(self.tier.clone())),
            ("price".to_owned(), Json::str(self.price.clone())),
            ("assetId".to_owned(), Json::str(self.asset_id.clone())),
            ("period".to_owned(), Json::str("month")),
        ]
    }
}

/// `parsePlans`: the owner's plan table, or none when blank or not in shape.
pub fn parse_plans(raw: Option<&str>) -> Option<(String, Vec<Plan>)> {
    if raw.is_none_or(|r| service_kit::money::js_trim(r).is_empty()) {
        return None;
    }
    let o = json::parse(raw?).ok()?;
    let Some(Json::Array(rows)) = o.get("plans") else {
        return None;
    };
    let Some(Json::String(default)) = o.get("defaultPlanId") else {
        return None;
    };
    if rows.is_empty() {
        return None;
    }
    let mut plans: Vec<Plan> = Vec::new();
    for p in rows {
        let price = plan_amount(p.get("price"))?;
        let Some(Json::String(id)) = p.get("id") else {
            return None;
        };
        if !is_plan_id(id) {
            return None;
        }
        let name = plan_text(p.get("name"), 80)?;
        let tier = plan_text(p.get("tier"), 32)?;
        let asset_id = plan_text(p.get("assetId"), 16)?;
        if p.get("period") != Some(&Json::str("month")) {
            return None;
        }
        plans.push(Plan {
            id: id.clone(),
            name,
            tier,
            price,
            asset_id,
        });
    }
    for (i, p) in plans.iter().enumerate() {
        if plans.iter().skip(i + 1).any(|q| q.id == p.id) {
            return None;
        }
    }
    if !plans.iter().any(|p| p.id == *default) {
        return None;
    }
    Some((default.clone(), plans))
}

/// `planView`: the plans on offer and the person's own, the default; a paid plan names `bank.plan_fee_unwired`.
pub fn plans_list(raw: Option<&str>) -> Result<Json, Refusal> {
    let Some((default, plans)) = parse_plans(raw) else {
        return Err(refuse(
            "bank.plans_unset",
            "No plan table is published, so no plan can be shown",
        ));
    };
    let current = plans
        .iter()
        .find(|p| p.id == default)
        .map(|p| Json::Object(p.fields()))
        .unwrap_or(Json::Null);
    let on_offer = plans
        .iter()
        .map(|p| {
            let mut f = p.fields();
            let paid = parse_amount(&p.price).is_ok_and(|a| a > Amount::ZERO);
            f.push((
                "blocker".to_owned(),
                if paid {
                    Json::str("bank.plan_fee_unwired")
                } else {
                    Json::Null
                },
            ));
            Json::Object(f)
        })
        .collect();
    Ok(Json::obj([
        ("plans", Json::Array(on_offer)),
        ("current", current),
    ]))
}

/// `parseFeeTable` as `fees.account` shows it: none published is `set: false` and no lines.
pub fn account_fees(raw: Option<&str>) -> Json {
    let lines = (|| {
        if raw.is_none_or(|r| service_kit::money::js_trim(r).is_empty()) {
            return None;
        }
        let o = json::parse(raw?).ok()?;
        let Some(Json::Array(rows)) = o.get("lines") else {
            return None;
        };
        if rows.is_empty() {
            return None;
        }
        let mut out = Vec::new();
        for l in rows {
            let fee = plan_amount(l.get("fee"));
            let Some(Json::String(id)) = l.get("id") else {
                return None;
            };
            if !is_plan_id(id) {
                return None;
            }
            let label = plan_text(l.get("label"), 80)?;
            let fee = fee?;
            let asset_id = plan_text(l.get("assetId"), 16)?;
            out.push(Json::obj([
                ("id", Json::str(id.clone())),
                ("label", Json::str(label)),
                ("fee", Json::str(fee)),
                ("assetId", Json::str(asset_id)),
            ]));
        }
        Some(out)
    })();
    Json::obj([
        ("set", Json::Bool(lines.is_some())),
        ("lines", Json::Array(lines.unwrap_or_default())),
    ])
}

// ---------------------------------------------------------------------------------------------------------------
// Currencies (`account-home/currencies.ts`)

/// `allowed`: the owner's list (`BANK_ACCOUNT_CURRENCIES`), in order, without repeats; blank refuses.
fn allowed(raw: Option<&str>) -> Result<Vec<String>, Refusal> {
    let t = raw.map(service_kit::money::js_trim).unwrap_or_default();
    let mut ids: Vec<String> = Vec::new();
    if !t.is_empty() {
        for c in t.split(',') {
            let id = service_kit::money::js_trim(c).to_uppercase();
            if !ids.contains(&id) {
                ids.push(id);
            }
        }
    }
    if ids.is_empty() || ids.iter().any(|id| !is_asset_code(id)) {
        return Err(refuse(
            "bank.account_currencies_unset",
            "The owner has not published which currencies an account can hold, so none can be added",
        ));
    }
    Ok(ids)
}

fn currency(asset_id: &str, space_id: &str, balance: Amount) -> Json {
    Json::obj([
        ("assetId", Json::str(asset_id)),
        ("spaceId", Json::str(space_id)),
        ("balance", Json::str(format_amount(balance))),
    ])
}

/// `CurrencyService.list`.
pub fn currencies_list(
    pool: &Store,
    money: &Money<'_>,
    owner_list: Option<&str>,
    user_id: &str,
) -> Result<Json, Refusal> {
    space::ensure_held_primaries(pool, money, user_id, None);
    let rows = with(pool, |c| {
        c.query(
            "SELECT id::text, asset_id FROM bank.spaces WHERE user_id = $1 AND kind = 'primary' AND archived_at IS NULL \
             AND removed_at IS NULL ORDER BY asset_id ASC",
            &[&user_id],
        )
        .map_err(|e| pg(&e))
    })?;
    let mut main: Vec<(String, Amount)> = Vec::new();
    if let Some(p) = money.held(user_id) {
        for b in p.balances(user_id, money.now) {
            if b.account.space_id.is_none() {
                main.push((b.account.asset_id.clone(), reported(&b)?));
            }
        }
    } else {
        for b in money
            .ledger
            .balances("user", user_id)
            .map_err(Refusal::Other)?
        {
            if b.kind == "available" && b.purpose.is_empty() {
                main.push((b.asset_id, b.amount));
            }
        }
    }
    let figure = |asset: &str| {
        main.iter()
            .rev()
            .find(|(a, _)| a == asset)
            .map_or(Amount::ZERO, |(_, v)| *v)
    };
    let currencies: Vec<(String, String)> = rows.iter().map(|r| (r.get(1), r.get(0))).collect();
    let list = Json::Array(
        currencies
            .iter()
            .map(|(a, s)| currency(a, s, figure(a)))
            .collect(),
    );
    match allowed(owner_list) {
        Ok(ids) => Ok(Json::obj([
            ("currencies", list),
            (
                "addable",
                Json::Array(
                    ids.iter()
                        .filter(|id| !currencies.iter().any(|(a, _)| a == *id))
                        .map(Json::str)
                        .collect(),
                ),
            ),
            ("addableBlocker", Json::Null),
        ])),
        Err(_) => Ok(Json::obj([
            ("currencies", list),
            ("addable", Json::Null),
            ("addableBlocker", Json::str("bank.account_currencies_unset")),
        ])),
    }
}

fn asset_unknown(id: &str) -> Refusal {
    refuse(
        "bank.asset_unknown",
        format!("{id} is not a currency an account can hold"),
    )
}

/// `CurrencyService.add`: the same currency again is the same space.
pub fn currencies_add(
    pool: &Store,
    money: &Money<'_>,
    owner_list: Option<&str>,
    user_id: &str,
    asset: &str,
) -> Result<Json, Refusal> {
    let id = service_kit::money::js_trim(asset).to_uppercase();
    if !allowed(owner_list)?.contains(&id) {
        return Err(asset_unknown(&id));
    }
    let space = with(pool, |c| {
        let s = space::ensure_primary(c, user_id, &id)?;
        space::restore_currency(c, user_id, &id)?;
        Ok(s)
    })?;
    Ok(currency(&id, &space.id, money.balance_of(&space)?))
}

fn in_use(asset: &str) -> Refusal {
    refuse(
        "bank.currency_in_use",
        format!(
            "{asset} still holds money, a hold, an open order or a space. Send or convert it first, then remove it"
        ),
    )
}

/// Slice `cards`' partner figure of what is held on a person's card in one asset (`cardHolds.figures(...).held`), by
/// person and asset; `None` when the card partner gives none.
pub type CardHeld<'a> = dyn Fn(&str, &str) -> Result<Option<String>, Refusal> + 'a;

/// `partnerCommits`: whether the partner reports anything else held in this asset: a card hold still open (slice
/// `cards`' figure, `card_held`; a figure the card partner does not give is an asset it cannot hold in), a purchase
/// hold not yet released, or an open order.
fn partner_commits(
    p: &Held<'_>,
    card_held: &CardHeld<'_>,
    user_id: &str,
    asset: &str,
    now: Instant,
) -> Result<bool, Refusal> {
    if let Some(held) = card_held(user_id, asset)?
        && parse_amount(&held).map_err(Refusal::Other)? != Amount::ZERO
    {
        return Ok(true);
    }
    if let Some(holds) = p.purchase_holds(user_id, now)?
        && holds
            .holds
            .iter()
            .any(|h| h.asset_id == asset && h.amount != Amount::ZERO)
    {
        return Ok(true);
    }
    Ok(p.open_orders(user_id).iter().any(|o| o.asset_id == asset))
}

/// `CurrencyService.remove`: refuses `bank.currency_in_use` while anything is held in it.
pub fn currencies_remove(
    pool: &Store,
    money: &Money<'_>,
    card_held: &CardHeld<'_>,
    user_id: &str,
    asset: &str,
) -> Result<Json, Refusal> {
    let id = service_kit::money::js_trim(asset).to_uppercase();
    if !is_asset_code(&id) {
        return Err(asset_unknown(&id));
    }
    space::under_space_lock(pool, user_id, |tx| {
        let partner = money.held(user_id);
        let mut amounts: Vec<Amount> = money
            .ledger
            .balances("user", user_id)
            .map_err(Refusal::Other)?
            .into_iter()
            .filter(|b| b.asset_id == id)
            .map(|b| b.amount)
            .collect();
        if let Some(p) = &partner {
            for b in p.balances(user_id, money.now) {
                if b.account.asset_id == id {
                    amounts.push(reported(&b)?);
                }
            }
        }
        if amounts.iter().any(|a| *a != Amount::ZERO) {
            return Err(in_use(&id));
        }
        if let Some(p) = &partner
            && partner_commits(p, card_held, user_id, &id, money.now)?
        {
            return Err(in_use(&id));
        }
        let named = tx
            .query(
                "SELECT id::text, archived_at IS NOT NULL FROM bank.spaces WHERE user_id = $1 AND asset_id = $2 AND kind = 'named'",
                &[&user_id, &id],
            )
            .map_err(|e| pg(&e))?;
        for r in &named {
            if !r.get::<_, bool>(1) {
                return Err(in_use(&id));
            }
            let s = Space {
                id: r.get(0),
                user_id: user_id.to_owned(),
                asset_id: id.clone(),
                kind: "named".to_owned(),
                name: String::new(),
                goal_target: None,
                locked_until: None,
                unlock_requested_at: None,
                unlocks_at: None,
                archived_at: None,
            };
            if money.balance_of(&s)? != Amount::ZERO {
                return Err(in_use(&id));
            }
        }
        tx.execute(
            "UPDATE bank.spaces SET removed_at = now(), updated_at = now() \
             WHERE user_id = $1 AND asset_id = $2 AND kind = 'primary' AND removed_at IS NULL",
            &[&user_id, &id],
        )
        .map_err(|e| pg(&e))?;
        Ok(Json::obj([
            ("assetId", Json::str(id.clone())),
            ("removed", Json::Bool(true)),
        ]))
    })
}

// ---------------------------------------------------------------------------------------------------------------
// The supported asset list (`assets/supported-assets.ts`)

fn registry_unreadable() -> Refusal {
    refuse(
        "bank.asset_registry_unavailable",
        "The list of supported assets and networks could not be read. Try again shortly",
    )
}

fn view_asset(a: &Json) -> Option<Json> {
    let s = |k: &str| match a.get(k) {
        Some(Json::String(v)) => Some(Json::str(v.clone())),
        _ => None,
    };
    let Some(Json::Array(networks)) = a.get("networks") else {
        return None;
    };
    let networks: Option<Vec<Json>> = networks
        .iter()
        .map(|n| {
            let ns = |k: &str| match n.get(k) {
                Some(Json::String(v)) => Some(Json::str(v.clone())),
                _ => None,
            };
            let links = match n.get("links") {
                None | Some(Json::Null) => Vec::new(),
                Some(Json::Array(l)) => l
                    .iter()
                    .map(|x| match (x.get("label"), x.get("url")) {
                        (Some(Json::String(label)), Some(Json::String(url))) => Some(Json::obj([
                            ("label", Json::str(label.clone())),
                            ("url", Json::str(url.clone())),
                        ])),
                        _ => None,
                    })
                    .collect::<Option<Vec<_>>>()?,
                Some(_) => return None,
            };
            Some(Json::obj([
                ("networkId", ns("networkId")?),
                ("label", ns("label")?),
                (
                    "contract",
                    match n.get("contract") {
                        None | Some(Json::Null) => Json::Null,
                        Some(Json::String(c)) => Json::str(c.clone()),
                        Some(_) => return None,
                    },
                ),
                ("links", Json::Array(links)),
            ]))
        })
        .collect();
    let precision = match a.get("precision") {
        Some(Json::Number(p)) if p.fract() == 0.0 && *p >= 0.0 => Json::Number(*p),
        _ => return None,
    };
    let Some(Json::Array(actions)) = a.get("allowedActions") else {
        return None;
    };
    Some(Json::obj([
        ("assetId", s("id")?),
        ("kind", s("kind")?),
        ("precision", precision),
        ("networks", Json::Array(networks?)),
        (
            "defaultNetworkId",
            match a.get("defaultNetworkId") {
                Some(Json::Null) => Json::Null,
                Some(Json::String(d)) => Json::str(d.clone()),
                _ => return None,
            },
        ),
        ("allowedActions", Json::Array(actions.clone())),
        ("state", s("state")?),
    ]))
}

/// `listSupportedAssets`: every published row, any state; an unreadable registry refuses, never an empty list.
pub fn assets_list(ledger: &dyn Ledger) -> Result<Json, Refusal> {
    let rows = ledger.assets().map_err(|_| registry_unreadable())?;
    let assets: Option<Vec<Json>> = rows.iter().map(view_asset).collect();
    Ok(Json::obj([(
        "assets",
        Json::Array(assets.ok_or_else(registry_unreadable)?),
    )]))
}

// ---------------------------------------------------------------------------------------------------------------
// The partner's limits and holds (`router/limits.router.ts`)

/// `fees.partner`: the partner's send limit and fee for a partner-held person; `held: false` is our own terms.
pub fn partner_limits(money: &Money<'_>, user_id: &str, asset: &str) -> Result<Json, Refusal> {
    let Some(p) = money.held(user_id) else {
        return Ok(Json::obj([("held", Json::Bool(false))]));
    };
    let l = p.limits(user_id, asset, money.now)?;
    let remaining = if l.daily_send > l.used_today {
        l.daily_send - l.used_today
    } else {
        Amount::ZERO
    };
    Ok(Json::obj([
        ("held", Json::Bool(true)),
        ("label", Json::str(l.label)),
        ("assetId", Json::str(l.asset_id.clone())),
        ("dailyLimit", Json::str(format_amount(l.daily_send))),
        ("usedToday", Json::str(format_amount(l.used_today))),
        ("remainingToday", Json::str(format_amount(remaining))),
        (
            "sendFee",
            l.send_fee
                .map_or(Json::Null, |f| Json::str(format_amount(f))),
        ),
        ("asOf", Json::str(l.as_of.iso())),
    ]))
}

fn hold_view(h: &crate::partner::desks::PurchaseHold) -> Vec<(String, Json)> {
    vec![
        ("id".to_owned(), Json::str(h.id.clone())),
        ("assetId".to_owned(), Json::str(h.asset_id.clone())),
        ("amount".to_owned(), Json::str(format_amount(h.amount))),
        ("paidBy".to_owned(), Json::str(h.paid_by.clone())),
        ("releaseAt".to_owned(), Json::str(h.release_at.iso())),
    ]
}

/// `partnerHolds`: what a partner-held person can withdraw from their main balance, and what the partner holds back.
pub fn partner_holds(money: &Money<'_>, user_id: &str) -> Result<Json, Refusal> {
    let Some(p) = money.held(user_id) else {
        return Ok(Json::obj([("held", Json::Bool(false))]));
    };
    let report = p.purchase_holds(user_id, money.now)?;
    let balances = p.balances(user_id, money.now);
    let holds = report.as_ref().map(|r| r.holds.clone()).unwrap_or_default();
    let rows = balances
        .iter()
        .filter(|b| b.account.space_id.is_none())
        .map(|b| {
            let known = match (b.amount, b.as_of) {
                (Some(a), Some(_)) => Some(a),
                _ => None,
            };
            let back: Option<Amount> = report.as_ref().map(|_| {
                holds
                    .iter()
                    .filter(|h| h.asset_id == b.account.asset_id)
                    .map(|h| h.amount)
                    .sum()
            });
            let withdrawable = match (known, back) {
                (Some(k), Some(bk)) => {
                    Json::str(format_amount(if k > bk { k - bk } else { Amount::ZERO }))
                }
                _ => Json::Null,
            };
            Json::obj([
                ("assetId", Json::str(b.account.asset_id.clone())),
                (
                    "balance",
                    known.map_or(Json::Null, |k| Json::str(format_amount(k))),
                ),
                (
                    "balanceAsOf",
                    b.as_of.map_or(Json::Null, |t| Json::str(t.iso())),
                ),
                (
                    "heldBack",
                    back.map_or(Json::Null, |v| Json::str(format_amount(v))),
                ),
                ("withdrawable", withdrawable),
            ])
        })
        .collect();
    Ok(Json::obj([
        ("held", Json::Bool(true)),
        ("label", Json::str(p.label())),
        ("reported", Json::Bool(report.is_some())),
        (
            "asOf",
            report
                .as_ref()
                .map_or(Json::Null, |r| Json::str(r.as_of.iso())),
        ),
        ("balances", Json::Array(rows)),
        (
            "holds",
            Json::Array(holds.iter().map(|h| Json::Object(hold_view(h))).collect()),
        ),
        (
            "released",
            Json::Array(
                report
                    .as_ref()
                    .map(|r| {
                        r.released
                            .iter()
                            .map(|h| {
                                let mut f = hold_view(h);
                                f.push((
                                    "releasedAt".to_owned(),
                                    Json::str(h.released_at.unwrap_or(h.release_at).iso()),
                                ));
                                Json::Object(f)
                            })
                            .collect()
                    })
                    .unwrap_or_default(),
            ),
        ),
    ]))
}

// ---------------------------------------------------------------------------------------------------------------
// The dormancy fee (`dormancy/dormancy.ts`)

/// One owner rule (`DormancyRule`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Rule {
    pub asset_id: String,
    pub fee: String,
    pub inactive_days: i64,
    pub notice_lead_days: i64,
    pub version: String,
}

/// `parseDormancyRules`: the owner's rules, or none when blank or not in shape.
pub fn parse_dormancy_rules(raw: Option<&str>) -> Option<Vec<Rule>> {
    if raw.is_none_or(|r| service_kit::money::js_trim(r).is_empty()) {
        return None;
    }
    let Json::Array(rows) = json::parse(raw?).ok()? else {
        return None;
    };
    if rows.is_empty() {
        return None;
    }
    let int = |v: Option<&Json>| match v {
        #[allow(
            clippy::cast_possible_truncation,
            reason = "an integer the check below holds"
        )]
        Some(Json::Number(n)) if n.fract() == 0.0 && *n >= 1.0 && *n <= 9.0e15 => Some(*n as i64),
        _ => None,
    };
    let mut out: Vec<Rule> = Vec::new();
    for r in rows {
        let Some(Json::String(asset)) = r.get("assetId") else {
            return None;
        };
        if !is_asset_code(asset) {
            return None;
        }
        let Some(Json::String(fee)) = r.get("fee") else {
            return None;
        };
        if !is_decimal(fee) || parse_amount(fee).ok()? <= Amount::ZERO {
            return None;
        }
        let inactive = int(r.get("inactiveDays"))?;
        let lead = int(r.get("noticeLeadDays"))?;
        let Some(Json::String(version)) = r.get("version") else {
            return None;
        };
        if service_kit::money::js_trim(version).is_empty() {
            return None;
        }
        out.push(Rule {
            asset_id: asset.clone(),
            fee: format_amount(parse_amount(fee).ok()?),
            inactive_days: inactive,
            notice_lead_days: lead,
            version: version.clone(),
        });
    }
    for (i, r) in out.iter().enumerate() {
        if out.iter().skip(i + 1).any(|q| q.asset_id == r.asset_id) {
            return None;
        }
    }
    Some(out)
}

/// `published`.
pub fn dormancy_rules(raw: Option<&str>) -> Result<Vec<Rule>, Refusal> {
    parse_dormancy_rules(raw).ok_or_else(|| {
        refuse(
            "bank.dormancy_rule_unset",
            "No dormancy rule is published, so no dormancy fee is noticed or taken",
        )
    })
}

pub fn rule_json(r: &Rule) -> Json {
    Json::obj([
        ("assetId", Json::str(r.asset_id.clone())),
        ("fee", Json::str(r.fee.clone())),
        ("inactiveDays", Json::int(r.inactive_days)),
        ("noticeLeadDays", Json::int(r.notice_lead_days)),
        ("version", Json::str(r.version.clone())),
    ])
}

/// `notices`: the person's own notices, newest first.
pub fn dormancy_notices(pool: &Store, user_id: &str) -> Result<Json, Refusal> {
    let rows = with(pool, |c| {
        c.query(
            "SELECT asset_id, fee::text, debit_date, inactive_days, state, partner_move_id, \
             floor(extract(epoch from noticed_at) * 1000)::int8, floor(extract(epoch from settled_at) * 1000)::int8 \
             FROM bank.dormancy_notices WHERE user_id = $1 ORDER BY noticed_at DESC, asset_id",
            &[&user_id],
        )
        .map_err(|e| pg(&e))
    })?;
    let mut out = Vec::new();
    for r in &rows {
        let fee = parse_amount(&r.get::<_, String>(1)).map_err(Refusal::Other)?;
        out.push(Json::obj([
            ("assetId", Json::str(r.get::<_, String>(0))),
            ("fee", Json::str(format_amount(fee))),
            ("debitDate", Json::str(r.get::<_, String>(2))),
            ("inactiveDays", Json::int(i64::from(r.get::<_, i32>(3)))),
            ("state", Json::str(r.get::<_, String>(4))),
            (
                "partnerMoveId",
                r.get::<_, Option<String>>(5).map_or(Json::Null, Json::str),
            ),
            ("noticedAt", Json::str(Instant(r.get(6)).iso())),
            (
                "settledAt",
                r.get::<_, Option<i64>>(7)
                    .map_or(Json::Null, |t| Json::str(Instant(t).iso())),
            ),
        ]));
    }
    Ok(Json::Array(out))
}

const DAY_MS: i64 = 86_400_000;
const DORMANCY_MODULE: &str = "bank.dormancy";
const WINDOW: usize = 200;
const MAX_MOVES: usize = 10_000;

fn day(t: i64) -> String {
    Instant(t).iso().chars().take(10).collect()
}

/// `partnerMovesBetween` then `movedBetween`: a move in `[from, to)` that is not a dormancy fee.
fn moved_between(
    p: &Held<'_>,
    user_id: &str,
    asset: &str,
    from: i64,
    to: i64,
) -> Result<bool, Refusal> {
    if to <= from {
        return Ok(false);
    }
    let fee = format!("fee:{DORMANCY_MODULE}:");
    let mut before: Option<String> = None;
    let mut scanned = 0;
    while scanned < MAX_MOVES {
        let window = p.moves(
            user_id,
            &MovesQuery {
                limit: WINDOW,
                before: before.clone(),
                asset_id: Some(asset.to_owned()),
                pay_ins: true,
            },
        );
        for m in &window {
            if m.moved_at.0 < from {
                return Ok(false);
            }
            if m.moved_at.0 < to && !m.key.starts_with(&fee) {
                return Ok(true);
            }
        }
        if window.len() < WINDOW {
            return Ok(false);
        }
        before = window.last().map(|m| m.id.clone());
        scanned += WINDOW;
    }
    Err(refuse(
        "bank.statement_too_large",
        format!("More than {MAX_MOVES} lines are in this range. Narrow the dates."),
    ))
}

/// The partner's figure for the main balance, or none when not known or too old to decide on (`partnerFigure` known).
fn main_balance(p: &Held<'_>, user_id: &str, asset: &str, now: Instant) -> Option<Amount> {
    let b = p.balance(&AccountRef::main(user_id, asset), now);
    let (amount, as_of) = (b.amount?, b.as_of?);
    let age = now.0 - as_of.0;
    (-STALE_AFTER_MS..=STALE_AFTER_MS)
        .contains(&age)
        .then_some(amount)
}

/// `run`: one dormancy run as of `at` for the accounts named.
pub fn dormancy_run(
    pool: &Store,
    money: &Money<'_>,
    raw_rules: Option<&str>,
    at_ms: i64,
    user_ids: &[String],
) -> Result<Json, Refusal> {
    let rules = dormancy_rules(raw_rules)?;
    let mut noticed = Vec::new();
    let mut settled = Vec::new();
    for user_id in user_ids {
        let Some(p) = money.held(user_id) else {
            continue;
        };
        for rule in &rules {
            let open = with(pool, |c| {
                c.query(
                    "SELECT debit_date, fee::text, floor(extract(epoch from noticed_at) * 1000)::int8 FROM bank.dormancy_notices \
                     WHERE user_id = $1 AND asset_id = $2 AND state = 'noticed'",
                    &[user_id, &rule.asset_id],
                )
                .map_err(|e| pg(&e))
            })?;
            if let Some(o) = open.first() {
                let debit: String = o.get(0);
                if day(at_ms) < debit {
                    continue;
                }
                let fee = parse_amount(&o.get::<_, String>(1)).map_err(Refusal::Other)?;
                if let Some(outcome) = settle(
                    pool,
                    money,
                    &p,
                    user_id,
                    &rule.asset_id,
                    &debit,
                    fee,
                    o.get(2),
                    at_ms,
                )? {
                    settled.push(Json::obj([
                        ("userId", Json::str(user_id.clone())),
                        ("assetId", Json::str(rule.asset_id.clone())),
                        ("debitDate", Json::str(debit)),
                        ("outcome", Json::str(outcome)),
                    ]));
                }
                continue;
            }
            let window_start = at_ms - rule.inactive_days * DAY_MS;
            let prior: Option<String> = with(pool, |c| {
                c.query_one(
                    "SELECT max(debit_date) FROM bank.dormancy_notices WHERE user_id = $1 AND asset_id = $2 AND state <> 'noticed'",
                    &[user_id, &rule.asset_id],
                )
                .map_err(|e| pg(&e))
                .map(|r| r.get(0))
            })?;
            if let Some(prior) = prior
                && service_kit::time::js_date(&format!("{prior}T00:00:00Z"))
                    .is_some_and(|d| d.0 > window_start)
            {
                continue;
            }
            if moved_between(&p, user_id, &rule.asset_id, window_start, at_ms)? {
                continue;
            }
            let fee = parse_amount(&rule.fee).map_err(Refusal::Other)?;
            match main_balance(&p, user_id, &rule.asset_id, money.now) {
                Some(b) if b >= fee => {}
                _ => continue,
            }
            let debit = day(at_ms + rule.notice_lead_days * DAY_MS);
            let inactive =
                i32::try_from(rule.inactive_days).map_err(|e| Refusal::Other(e.to_string()))?;
            let inserted = with(pool, |c| {
                c.query(
                    &format!(
                        "INSERT INTO bank.dormancy_notices (user_id, asset_id, debit_date, fee, inactive_days, rule_version, noticed_at) \
                         VALUES ($1, $2, $3, $4::text::numeric, $5, $6, {}) ON CONFLICT DO NOTHING RETURNING user_id",
                        space::at("$7")
                    ),
                    &[user_id, &rule.asset_id, &debit, &rule.fee, &inactive, &rule.version, &at_ms],
                )
                .map_err(|e| pg(&e))
            })?;
            if !inserted.is_empty() {
                noticed.push(Json::obj([
                    ("userId", Json::str(user_id.clone())),
                    ("assetId", Json::str(rule.asset_id.clone())),
                    ("fee", Json::str(rule.fee.clone())),
                    ("debitDate", Json::str(debit)),
                ]));
            }
        }
    }
    Ok(Json::obj([
        ("noticed", Json::Array(noticed)),
        ("settled", Json::Array(settled)),
    ]))
}

/// `settle`: one notice whose date has come, or none to leave it open while the partner's figure is not known.
#[allow(
    clippy::too_many_arguments,
    reason = "the notice's own fields, as the TypeScript passes them"
)]
fn settle(
    pool: &Store,
    money: &Money<'_>,
    p: &Held<'_>,
    user_id: &str,
    asset: &str,
    debit: &str,
    fee: Amount,
    noticed_at: i64,
    at_ms: i64,
) -> Result<Option<&'static str>, Refusal> {
    let key = format!("fee:{DORMANCY_MODULE}:{user_id}:{asset}:{debit}");
    let (outcome, move_id): (&'static str, Option<String>) =
        if let Some(taken) = p.move_by_key(&key) {
            ("charged", Some(taken.id))
        } else {
            let Some(balance) = main_balance(p, user_id, asset, money.now) else {
                return Ok(None);
            };
            if balance == Amount::ZERO {
                ("skipped_zero", None)
            } else if moved_between(p, user_id, asset, noticed_at, at_ms)? {
                ("cancelled", None)
            } else if balance < fee {
                ("skipped_insufficient", None)
            } else {
                match p.move_(
                    &MoveRequest {
                        key: key.clone(),
                        from: AccountRef::main(user_id, asset),
                        to: fees_account(asset),
                        amount: fee,
                        payees: None,
                    },
                    money.now,
                ) {
                    Ok(m) => ("charged", Some(m.id)),
                    Err(Refusal::Bank(e)) if e.row.code == "bank.partner_insufficient_funds" => {
                        ("skipped_insufficient", None)
                    }
                    Err(e) => return Err(e),
                }
            }
        };
    with(pool, |c| {
        c.execute(
            "UPDATE bank.dormancy_notices SET state = $1, partner_move_id = $2, settled_at = now() \
             WHERE user_id = $3 AND asset_id = $4 AND debit_date = $5 AND state = 'noticed'",
            &[&outcome, &move_id, &user_id, &asset, &debit],
        )
        .map_err(|e| pg(&e))
    })?;
    Ok(Some(outcome))
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used, reason = "a test")]
    use super::*;

    #[test]
    fn the_owner_tables_parse_as_published_or_not_at_all() {
        let plans = r#"{"defaultPlanId":"basic","plans":[{"id":"basic","name":"Basic","tier":"base","price":"0","assetId":"EUR","period":"month"},{"id":"plus","name":"Plus","tier":"plus","price":"4.50","assetId":"EUR","period":"month"}]}"#;
        assert_eq!(
            plans_list(Some(plans)).unwrap().compact(),
            concat!(
                r#"{"plans":[{"id":"basic","name":"Basic","tier":"base","price":"0","assetId":"EUR","period":"month","blocker":null},"#,
                r#"{"id":"plus","name":"Plus","tier":"plus","price":"4.5","assetId":"EUR","period":"month","blocker":"bank.plan_fee_unwired"}],"#,
                r#""current":{"id":"basic","name":"Basic","tier":"base","price":"0","assetId":"EUR","period":"month"}}"#
            )
        );
        assert!(plans_list(Some(&plans.replace("basic\",\"plans", "gold\",\"plans"))).is_err());
        assert!(plans_list(None).is_err());
        assert_eq!(account_fees(None).compact(), r#"{"set":false,"lines":[]}"#);
        assert_eq!(
            account_fees(Some(
                r#"{"lines":[{"id":"atm","label":"ATM","fee":"1.00","assetId":"EUR"}]}"#
            ))
            .compact(),
            r#"{"set":true,"lines":[{"id":"atm","label":"ATM","fee":"1","assetId":"EUR"}]}"#
        );
        let rules = parse_dormancy_rules(Some(
            r#"[{"assetId":"EUR","fee":"5.0","inactiveDays":365,"noticeLeadDays":30,"version":"2026-1"}]"#,
        ))
        .unwrap();
        assert_eq!(
            rule_json(&rules[0]).compact(),
            r#"{"assetId":"EUR","fee":"5","inactiveDays":365,"noticeLeadDays":30,"version":"2026-1"}"#
        );
        assert!(
            parse_dormancy_rules(Some(
                r#"[{"assetId":"EUR","fee":"0","inactiveDays":1,"noticeLeadDays":1,"version":"v"}]"#
            ))
            .is_none()
        );
        let terms = r#"{"tier":" Base ","version":"v1","currency":"EUR","monthlyFee":"0","minimumBalance":"0","overdraftFee":"2","included":["IBAN"]}"#;
        assert_eq!(
            account_features(Some(terms)).unwrap().compact(),
            r#"{"tier":"Base","version":"v1","currency":"EUR","monthlyFee":"0","minimumBalance":"0","overdraftFee":"2","included":["IBAN"],"overdraftBlocker":"bank.overdraft_switched_off"}"#
        );
        assert!(
            account_features(Some(
                &terms.replace("\"included\"", "\"extra\":1,\"included\"")
            ))
            .is_err()
        );
    }

    #[test]
    fn a_business_profile_names_a_lowercase_uuid() {
        assert!(business_id("business:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa").is_some());
        assert!(business_id("business:AAAAAAAA-aaaa-4aaa-8aaa-aaaaaaaaaaaa").is_none());
        assert!(business_id("personal").is_none());
    }
}
