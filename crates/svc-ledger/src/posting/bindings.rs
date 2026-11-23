//! The four checks that bind a post to what the book already holds, run after the recipe gate and before anything is
//! written. The gate knows a post by its shape alone; these read the posted transaction a post claims to follow and
//! refuse it unless it matches:
//! - a maker rebate, its trade fill (`maker-rebate-binding.ts`);
//! - a campaign reward's unlock or forfeit, its lock; a lock, no earlier payment (`campaign-lock-binding.ts`);
//! - a returned withdrawal, its settle (`withdraw-return-binding.ts`);
//! - a withdrawal's fee, its hold (`withdraw-fee-binding.ts`).

use std::cmp::Ordering;

use service_kit::json::Json;
use service_kit::money::{Amount, cmp_products, parse_amount};

use crate::errors::Failure;
use crate::posting::PostError;
use crate::posting::engine::Posted;
use crate::posting::gate::Caller;
use crate::posting::rules::{AccountRef, Direction, Entry, PostRequest, js_string};

/// `MAKER_REBATE_UNBOUND_CODE`, `CAMPAIGN_LOCK_UNBOUND_CODE`, `WITHDRAW_RETURN_UNBOUND_CODE`, `WITHDRAW_FEE_UNBOUND_CODE`.
pub const REBATE_UNBOUND: &str = "ledger.rebate_unbound";
pub const CAMPAIGN_LOCK_UNBOUND: &str = "ledger.campaign_lock_unbound";
pub const WITHDRAW_RETURN_UNBOUND: &str = "ledger.withdraw_return_unbound";
pub const WITHDRAW_FEE_UNBOUND: &str = "ledger.withdraw_fee_unbound";

/// What the checks read: `getTxByKey` and `balance(ref).accountId`.
pub trait Reader {
    fn tx_by_key(&self, key: &str) -> Result<Option<Posted>, PostError>;
    /// The account's id, or none for an account never touched.
    fn account_id(&self, a: &AccountRef) -> Result<Option<String>, PostError>;
}

fn refuse<T>(code: &str, lead: &str, why: &str) -> Result<T, PostError> {
    Err(PostError::Refused(Failure::ledger(
        code,
        format!("{lead}: {why}"),
    )))
}

/// `typeof v === 'string' ? v : ''`.
fn text(v: Option<&Json>) -> &str {
    match v {
        Some(Json::String(s)) => s,
        _ => "",
    }
}

/// `a === b` for two values a JSON object holds (`undefined` when absent): objects and arrays are never equal.
fn strict_eq(a: Option<&Json>, b: Option<&Json>) -> bool {
    match (a, b) {
        (None, None) => true,
        (Some(Json::Null), Some(Json::Null)) => true,
        (Some(Json::Bool(x)), Some(Json::Bool(y))) => x == y,
        (Some(Json::Number(x)), Some(Json::Number(y))) => x == y,
        (Some(Json::String(x)), Some(Json::String(y))) => x == y,
        _ => false,
    }
}

/// `String(v)`, `undefined` included.
fn js_text(v: Option<&Json>) -> String {
    v.map_or_else(|| "undefined".to_owned(), js_string)
}

fn hold(user: &str, asset: &str, purpose: String) -> AccountRef {
    AccountRef {
        owner_type: "user".to_owned(),
        owner_id: user.to_owned(),
        asset_id: asset.to_owned(),
        kind: "hold".to_owned(),
        purpose: Some(purpose),
    }
}

fn find_leg<'a>(
    tx: &'a Posted,
    account: Option<&str>,
    d: Direction,
) -> Option<&'a crate::posting::engine::PostedEntry> {
    let id = account.filter(|a| !a.is_empty())?;
    tx.entries
        .iter()
        .find(|e| e.account_id == id && e.direction == d)
}

/// A whole number of basis points (`Number.isInteger(v) && v >= 0`).
fn whole_bps(v: Option<&Json>) -> Option<f64> {
    match v {
        Some(Json::Number(n)) if n.is_finite() && n.fract() == 0.0 && *n >= 0.0 => Some(*n),
        _ => None,
    }
}

/// `amount === mulBps(paid, bps, 'floor')`, exactly: `amount * 10^4 <= paid * bps < (amount + 1) * 10^4`.
fn is_floor_bps(amount: Amount, paid: Amount, bps: f64) -> bool {
    #[expect(
        clippy::cast_possible_truncation,
        reason = "a whole, non-negative rate; past i128 it saturates, far above any rate below a stored taker rate"
    )]
    let bps = bps as i128;
    cmp_products(amount, 10_000, paid, bps) != Ordering::Greater
        && cmp_products(paid, bps, amount + 1, 10_000) == Ordering::Less
}

/// `assertMakerRebateBound`: a maker rebate is paid only against the fill it rebates (SP-fees-vip-01).
pub fn maker_rebate(l: &dyn Reader, r: &PostRequest) -> Result<(), PostError> {
    const LEAD: &str = "A maker rebate must match its posted trade fill";
    let no = |why: &str| refuse(REBATE_UNBOUND, LEAD, why);
    if r.reason != "trade.fill.rebate" {
        return Ok(());
    }
    let fill_id = text(r.meta("fillId"));
    let maker_order = text(r.meta("makerOrderId"));
    if fill_id.is_empty() || r.idempotency_key != format!("trade.fill.rebate:{fill_id}") {
        return no("the key does not name its fill");
    }
    if maker_order.is_empty() {
        return no("no maker order");
    }
    let Some(rebate_bps) = whole_bps(r.meta("makerRebateBps")).filter(|b| *b != 0.0) else {
        return no("no rebate rate");
    };
    let house = r.entries.iter().find(|e| e.account.owner_type == "house");
    let maker = r.entries.iter().find(|e| e.account.owner_type == "user");
    let (Some(house), Some(maker)) = (house, maker) else {
        return no("not the rebate shape");
    };
    if r.entries.len() != 2 {
        return no("not the rebate shape");
    }
    let asset = house.account.asset_id.as_str();
    let maker_id = maker.account.owner_id.as_str();
    if maker.account.asset_id != asset || maker_id.is_empty() {
        return no("the maker leg is in another asset");
    }
    let amount = house.amount;

    let fill = l.tx_by_key(&format!("trade.fill:{fill_id}"))?;
    let Some(fill) = fill.filter(|f| f.module == "trade" && f.reason == "trade.fill") else {
        return no("no posted fill");
    };
    if !strict_eq(fill.meta("makerOrderId"), Some(&Json::str(maker_order))) {
        return no("another maker order");
    }
    if !strict_eq(fill.meta("makerFeeBps"), Some(&Json::Number(0.0))) {
        return no("the maker paid a fee on this fill");
    }
    match whole_bps(fill.meta("takerFeeBps")) {
        Some(taker) if rebate_bps < taker => {}
        _ => return no("the rate is not below the fill taker rate"),
    }
    let hold_id = l.account_id(&hold(maker_id, asset, format!("order:{maker_order}")))?;
    let Some(paid) = find_leg(&fill, hold_id.as_deref(), Direction::Credit) else {
        return no("this maker did not pay that asset from that order on the fill");
    };
    let fees = AccountRef {
        owner_type: "house".to_owned(),
        owner_id: "fees:trade".to_owned(),
        asset_id: asset.to_owned(),
        kind: "available".to_owned(),
        purpose: None,
    };
    let house_id = l.account_id(&fees)?;
    let Some(fee) = find_leg(&fill, house_id.as_deref(), Direction::Debit) else {
        return no("the fill took no taker fee in that asset");
    };
    if !is_floor_bps(amount, paid.amount, rebate_bps) {
        return no("the amount is not the rate on what the maker paid");
    }
    if amount >= fee.amount {
        return no("the rebate is not below the fill fee");
    }
    Ok(())
}

/// `REWARD_KEY_PATTERN`: `^[a-z][a-z0-9-]*(:[A-Za-z0-9_-]+)+$`.
fn is_reward_key(k: &str) -> bool {
    let mut parts = k.split(':');
    let head = parts.next().unwrap_or("");
    let mut hb = head.bytes();
    let rest: Vec<&str> = parts.collect();
    hb.next().is_some_and(|c| c.is_ascii_lowercase())
        && hb.all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == b'-')
        && !rest.is_empty()
        && rest.iter().all(|p| {
            !p.is_empty()
                && p.bytes()
                    .all(|c| c.is_ascii_alphanumeric() || c == b'_' || c == b'-')
        })
}

/// `campaignLockAccount(rewardKey, assetId).ownerId`, or none where it throws.
fn lock_pot(reward_key: &str, asset: &str) -> Option<String> {
    let key_ok = reward_key.encode_utf16().count() <= 200 - "campaigns:forfeit:".len()
        && is_reward_key(reward_key);
    let asset_ok = !asset.is_empty()
        && asset.encode_utf16().count() <= 16
        && service_kit::money::js_trim(asset) == asset;
    (key_ok && asset_ok).then(|| format!("campaigns:lock:{}", reward_key.replace(':', ".")))
}

/// `assertCampaignLockBound`: a locked reward has one outcome, the outcome of that lock (CM-payouts-ledger-01).
pub fn campaign_lock(l: &dyn Reader, r: &PostRequest) -> Result<(), PostError> {
    const LEAD: &str = "A locked campaign reward must match its posted lock";
    let no = |why: &str| refuse(CAMPAIGN_LOCK_UNBOUND, LEAD, why);
    let locked = r.reason == "campaigns.reward.locked";
    let outcome = match r.reason.as_str() {
        "campaigns.reward.unlocked" => Some("campaigns:unlock:"),
        "campaigns.reward.forfeited" => Some("campaigns:forfeit:"),
        _ => None,
    };
    if !locked && outcome.is_none() {
        return Ok(());
    }
    if r.module != "campaigns" {
        return no("not the campaigns module");
    }
    let reward_key = text(r.meta("rewardKey"));
    let user = text(r.meta("userId"));
    if reward_key.is_empty() || user.is_empty() {
        return no("no reward key or customer");
    }
    if r.entries.len() != 2 {
        return no("not the locked reward shape");
    }
    let pot_at = r
        .entries
        .iter()
        .position(|e| e.account.owner_type == "module");
    let (Some(pot), Some(other)) = (
        pot_at.and_then(|i| r.entries.get(i)),
        pot_at.and_then(|i| {
            r.entries
                .iter()
                .enumerate()
                .find(|(j, _)| *j != i)
                .map(|(_, e)| e)
        }),
    ) else {
        return no("not the locked reward shape");
    };
    let asset = pot.account.asset_id.as_str();
    let Some(own_pot) = lock_pot(reward_key, asset) else {
        return no("the reward key is not a stored reward key");
    };
    if pot.account.owner_id != own_pot {
        return no("another reward's pot");
    }
    if other.account.asset_id != asset {
        return no("the legs are in two assets");
    }

    if locked {
        if r.idempotency_key != format!("campaigns:lock:{reward_key}") {
            return no("the key does not name its reward");
        }
        if l.tx_by_key(&format!("reward:{reward_key}"))?.is_some() {
            return no("this reward was already paid");
        }
        return Ok(());
    }

    let prefix = outcome.unwrap_or_default();
    if r.idempotency_key != format!("{prefix}{reward_key}") {
        return no("the key does not name its reward");
    }
    let lock = l.tx_by_key(&format!("campaigns:lock:{reward_key}"))?;
    let Some(lock) =
        lock.filter(|t| t.module == "campaigns" && t.reason == "campaigns.reward.locked")
    else {
        return no("no posted lock");
    };
    if !strict_eq(lock.meta("userId"), Some(&Json::str(user))) {
        return no("another customer");
    }
    let Some(held) = lock
        .entries
        .iter()
        .find(|e| e.direction == Direction::Debit && e.asset_id == asset)
    else {
        return no("the lock is in another asset");
    };
    if pot.amount != held.amount {
        return no("not the whole locked amount");
    }
    if r.reason == "campaigns.reward.unlocked"
        && (other.account.owner_type != "user" || other.account.owner_id != user)
    {
        return no("an unlock pays only the customer the lock names");
    }
    Ok(())
}

/// `assertWithdrawReturnBound`: a returned withdrawal is booked only against the settle it returns (W-withdraw-07).
pub fn withdraw_return(l: &dyn Reader, r: &PostRequest) -> Result<(), PostError> {
    const LEAD: &str = "A returned withdrawal must match its posted settle";
    let no = |why: &str| refuse(WITHDRAW_RETURN_UNBOUND, LEAD, why);
    if r.reason != "withdraw.returned" {
        return Ok(());
    }
    if r.module != "ledger" {
        return no("not the ledger module");
    }
    let withdrawal = text(r.meta("withdrawalId"));
    if withdrawal.is_empty() || r.idempotency_key != format!("withdraw.returned:{withdrawal}") {
        return no("the key does not name its withdrawal");
    }
    let boundary = r
        .entries
        .iter()
        .find(|e| e.account.owner_type == "treasury" && e.direction == Direction::Credit);
    let person = r
        .entries
        .iter()
        .find(|e| e.account.owner_type == "user" && e.direction == Direction::Debit);
    let (Some(boundary), Some(person)) = (boundary, person) else {
        return no("not the return shape");
    };
    if r.entries.len() != 2 {
        return no("not the return shape");
    }
    let asset = boundary.account.asset_id.as_str();
    let user = person.account.owner_id.as_str();
    if person.account.asset_id != asset || user.is_empty() {
        return no("the person is credited in another asset");
    }
    let settle = l.tx_by_key(&format!("withdraw.settle:{withdrawal}"))?;
    let Some(settle) = settle.filter(|t| t.module == "ledger" && t.reason == "withdraw.settled")
    else {
        return no("no posted settle");
    };
    if !strict_eq(settle.meta("rail"), r.meta("rail")) {
        return no("another rail");
    }
    let hold_id = l.account_id(&hold(user, asset, format!("withdraw:{withdrawal}")))?;
    let rail_id = l.account_id(&boundary.account)?;
    if find_leg(&settle, hold_id.as_deref(), Direction::Credit).is_none() {
        return no("that settle did not draw on this person’s hold in this asset");
    }
    let Some(sent) = find_leg(&settle, rail_id.as_deref(), Direction::Debit) else {
        return no("that settle was not sent to this rail boundary");
    };
    // What went to the rail, not what left the hold: a fee drawn from the hold never left.
    if boundary.amount > sent.amount {
        return no("more than the settle sent");
    }
    Ok(())
}

/// `feeOf(meta)`: `meta.fee` as an amount above zero, none when absent; anything else refuses.
fn fee_of(fee: Option<&Json>) -> Result<Option<Amount>, PostError> {
    const LEAD: &str = "A withdrawal fee must match its posted hold";
    let Some(raw) = fee else { return Ok(None) };
    let Json::String(raw) = raw else {
        return refuse(
            WITHDRAW_FEE_UNBOUND,
            LEAD,
            "meta.fee is not a decimal string",
        );
    };
    let Ok(fee) = parse_amount(raw) else {
        return refuse(
            WITHDRAW_FEE_UNBOUND,
            LEAD,
            "meta.fee is not a decimal string",
        );
    };
    if fee <= 0 {
        return refuse(WITHDRAW_FEE_UNBOUND, LEAD, "meta.fee is not above zero");
    }
    Ok(Some(fee))
}

fn is_fee_pot(a: &AccountRef) -> bool {
    a.owner_type == "house" && a.owner_id.starts_with("fees:")
}

/// `assertWithdrawFeeBound`: a withdrawal's quoted network fee is bound to its posted hold (J-wallet-05 #6).
pub fn withdraw_fee(
    l: &dyn Reader,
    r: &PostRequest,
    caller: Option<&Caller>,
) -> Result<(), PostError> {
    const LEAD: &str = "A withdrawal fee must match its posted hold";
    let no = |why: &str| refuse(WITHDRAW_FEE_UNBOUND, LEAD, why);
    let step = match r.reason.as_str() {
        "withdraw.held" => "hold",
        "withdraw.settled" => "settle",
        "withdraw.reversed" => "reverse",
        _ => return Ok(()),
    };
    if r.module != "ledger" {
        return Ok(());
    }
    let fee = fee_of(r.meta("fee"))?;
    let fee_legs: Vec<&Entry> = r
        .entries
        .iter()
        .filter(|e| e.direction == Direction::Debit && is_fee_pot(&e.account))
        .collect();
    let want = usize::from(r.reason == "withdraw.settled");
    let wrong_count = match fee {
        None => !fee_legs.is_empty(),
        Some(_) => fee_legs.len() != want,
    };
    if wrong_count {
        return no("the fee leg is not the fee the post names");
    }
    if let (Some(f), Some(leg)) = (fee, fee_legs.first())
        && leg.amount != f
    {
        return no("the fee leg is not the fee the post names");
    }
    if fee.is_some()
        && let Some(Caller::Bound(service)) = caller
        && service != "svc-pay"
    {
        return no("only svc-pay posts a withdrawal fee");
    }
    // The hold it moves, its key and its meta name one withdrawal; the hold is then found by that id.
    let hold_leg = r
        .entries
        .iter()
        .find(|e| e.account.owner_type == "user" && e.account.kind == "hold");
    let purpose = hold_leg
        .and_then(|e| e.account.purpose.as_deref())
        .unwrap_or("");
    let Some(withdrawal) = purpose.strip_prefix("withdraw:") else {
        return no("it moves no withdrawal hold");
    };
    if withdrawal.is_empty()
        || r.idempotency_key != format!("withdraw.{step}:{withdrawal}")
        || !strict_eq(r.meta("withdrawalId"), Some(&Json::str(withdrawal)))
    {
        return no("its key, its meta and the hold it moves do not name one withdrawal");
    }
    // A retried hold with another fee or rail is refused by the engine's own replay.
    if r.reason == "withdraw.held" {
        return Ok(());
    }
    let hold = l.tx_by_key(&format!("withdraw.hold:{withdrawal}"))?;
    let hold = hold.filter(|h| h.module == "ledger" && h.reason == "withdraw.held");
    let held_fee = match &hold {
        Some(h) => fee_of(h.meta("fee"))?,
        None => None,
    };
    if fee != held_fee {
        return no(if held_fee.is_none() {
            "its hold carried no fee"
        } else {
            "it does not carry the fee its hold carried"
        });
    }
    let (Some(_), Some(hold)) = (held_fee, hold) else {
        return Ok(());
    };
    // A fee-carrying hold is settled or reversed whole: amount and fee together, never a part.
    let held = hold
        .entries
        .iter()
        .find(|e| e.direction == Direction::Debit)
        .map(|e| e.amount);
    let drawn = r.entries.iter().find(|e| e.direction == Direction::Credit);
    match (held, drawn) {
        (Some(h), Some(d)) if d.amount == h => {}
        _ => return no("it does not draw the whole fee-carrying hold"),
    }
    if r.reason == "withdraw.reversed" {
        let back = r.entries.iter().find(|e| e.direction == Direction::Debit);
        let owner = hold_leg.map(|e| e.account.owner_id.as_str());
        let ok = back.is_some_and(|b| {
            b.account.owner_type == "user"
                && b.account.kind == "available"
                && Some(b.account.owner_id.as_str()) == owner
        });
        if !ok {
            return no("it gives the hold back to someone other than its owner");
        }
    } else {
        let rail_leg = r
            .entries
            .iter()
            .find(|e| e.direction == Direction::Debit && e.account.owner_type == "treasury");
        let rail = format!("rail:{}", js_text(hold.meta("rail")));
        if !strict_eq(r.meta("rail"), hold.meta("rail"))
            || rail_leg.map(|e| e.account.owner_id.as_str()) != Some(rail.as_str())
        {
            return no("it sends on another rail than its hold");
        }
    }
    Ok(())
}
