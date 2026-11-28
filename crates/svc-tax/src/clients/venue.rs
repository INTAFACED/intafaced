//! svc-trade's `venue.ownActivity` (`packages/contracts/src/trade-venue-activity-client.ts`): the customer's own venue
//! accounts, read at the moment of the request. Any failure, including a reply its schema refuses, is unavailable.

use std::sync::Arc;

use super::bank::{DoorClient, default_clock, door_endpoint, only_keys};
use crate::http::Fetch;
use crate::json::Json;
use crate::ports::{
    VenueAccountActivity, VenueActivity, VenueActivitySource, VenueArrival, VenueBalance,
    VenueFill, VenueOwnMove,
};

/// `/^-?\d+(\.\d+)?$/`.
fn decimal(s: &str) -> bool {
    let body = s.strip_prefix('-').unwrap_or(s);
    let (whole, frac) = match body.split_once('.') {
        Some((w, f)) => (w, Some(f)),
        None => (body, None),
    };
    let digits = |p: &str| !p.is_empty() && p.bytes().all(|b| b.is_ascii_digit());
    digits(whole) && frac.is_none_or(digits)
}

/// `z.string().datetime()`: ISO 8601 in UTC (`Z`), any precision.
fn datetime(s: &str) -> bool {
    crate::time::zod_datetime(s, false).is_some()
}

/// One account's fields, read as its strict schema allows.
struct Obj<'a>(&'a Json);

impl Obj<'_> {
    fn s(&self, k: &str) -> Option<String> {
        match self.0.get(k) {
            Some(Json::String(v)) => Some(v.clone()),
            _ => None,
        }
    }
    fn nonempty(&self, k: &str) -> Option<String> {
        self.s(k).filter(|v| !v.is_empty())
    }
    fn dec(&self, k: &str) -> Option<String> {
        self.s(k).filter(|v| decimal(v))
    }
    fn when(&self, k: &str) -> Option<String> {
        self.s(k).filter(|v| datetime(v))
    }
    fn list(&self, k: &str) -> Option<&Vec<Json>> {
        match self.0.get(k) {
            Some(Json::Array(a)) => Some(a),
            _ => None,
        }
    }
    /// An optional array: absent is `Some(None)`, present and not an array is a refusal (`None`).
    fn opt_list(&self, k: &str) -> Option<Option<&Vec<Json>>> {
        match self.0.get(k) {
            None => Some(None),
            Some(Json::Array(a)) => Some(Some(a)),
            Some(_) => None,
        }
    }
}

fn fill(v: &Json) -> Option<VenueFill> {
    let keys = [
        "fillId", "symbol", "base", "quote", "side", "price", "amount", "fee", "feeAsset",
        "filledAt",
    ];
    if !only_keys(v, &keys) {
        return None;
    }
    let o = Obj(v);
    let fill_id = o.nonempty("fillId")?;
    let symbol = o.nonempty("symbol")?;
    let base = o.nonempty("base")?;
    let quote = o.nonempty("quote")?;
    let buy = match o.s("side")?.as_str() {
        "buy" => true,
        "sell" => false,
        _ => return None,
    };
    Some(VenueFill {
        fill_id,
        symbol,
        base,
        quote,
        buy,
        price: o.dec("price")?,
        amount: o.dec("amount")?,
        fee: o.dec("fee")?,
        fee_asset: o.nonempty("feeAsset")?,
        filled_at: o.when("filledAt")?,
    })
}

fn own_move(v: &Json) -> Option<VenueOwnMove> {
    if !only_keys(
        v,
        &[
            "moveId",
            "subAccount",
            "direction",
            "asset",
            "amount",
            "settledAt",
        ],
    ) {
        return None;
    }
    let o = Obj(v);
    let move_id = o.nonempty("moveId")?;
    let sub_account = o.nonempty("subAccount")?;
    let into_sub_account = match o.s("direction")?.as_str() {
        "into_sub_account" => true,
        "out_of_sub_account" => false,
        _ => return None,
    };
    Some(VenueOwnMove {
        move_id,
        sub_account,
        into_sub_account,
        asset: o.nonempty("asset")?,
        amount: o.dec("amount")?,
        settled_at: o.when("settledAt")?,
    })
}

fn arrival(v: &Json) -> Option<VenueArrival> {
    if !only_keys(v, &["arrivalId", "kind", "asset", "amount", "arrivedAt"]) {
        return None;
    }
    let o = Obj(v);
    let arrival_id = o.nonempty("arrivalId")?;
    let kind = o
        .s("kind")
        .filter(|k| k == "deposit" || k == "transfer_in" || k == "reward")?;
    Some(VenueArrival {
        arrival_id,
        kind,
        asset: o.nonempty("asset")?,
        amount: o.dec("amount")?,
        arrived_at: o.when("arrivedAt")?,
    })
}

/// `/^0x[0-9a-f]{40}$/`.
fn owner(s: &str) -> bool {
    s.strip_prefix("0x").is_some_and(|h| {
        h.len() == 40
            && h.bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    })
}

fn account(v: &Json) -> Option<VenueAccountActivity> {
    let keys = [
        "venueId",
        "owner",
        "subAccount",
        "balances",
        "fills",
        "transfers",
        "arrivals",
        "asOf",
    ];
    if !only_keys(v, &keys) {
        return None;
    }
    let o = Obj(v);
    let venue_id = o.nonempty("venueId")?;
    let owner_id = o.s("owner").filter(|w| owner(w))?;
    let sub_account = match v.get("subAccount") {
        Some(Json::String(s)) => Some(s.clone()),
        Some(Json::Null) => None,
        _ => return None,
    };
    let balances = o
        .list("balances")?
        .iter()
        .map(|b| {
            if !only_keys(b, &["asset", "total"]) {
                return None;
            }
            let b = Obj(b);
            Some(VenueBalance {
                asset: b.nonempty("asset")?,
                total: b.dec("total")?,
            })
        })
        .collect::<Option<Vec<_>>>()?;
    let fills = o
        .list("fills")?
        .iter()
        .map(fill)
        .collect::<Option<Vec<_>>>()?;
    let transfers = match o.opt_list("transfers")? {
        None => None,
        Some(a) => Some(a.iter().map(own_move).collect::<Option<Vec<_>>>()?),
    };
    let arrivals = match o.opt_list("arrivals")? {
        None => None,
        Some(a) => Some(a.iter().map(arrival).collect::<Option<Vec<_>>>()?),
    };
    Some(VenueAccountActivity {
        venue_id,
        owner: owner_id,
        sub_account,
        balances,
        fills,
        transfers,
        arrivals,
        as_of: o.when("asOf")?,
    })
}

/// `tradeVenueActivitySchema.safeParse(data)`.
fn parse_activity(data: &Json) -> Option<VenueActivity> {
    match data.get("state") {
        Some(Json::String(s)) if s == "off" => {
            only_keys(data, &["state"]).then_some(VenueActivity::Off)
        }
        Some(Json::String(s)) if s == "read" => {
            if !only_keys(data, &["state", "test", "accounts"]) {
                return None;
            }
            let Some(Json::Bool(test)) = data.get("test") else {
                return None;
            };
            let accounts = Obj(data)
                .list("accounts")?
                .iter()
                .map(account)
                .collect::<Option<Vec<_>>>()?;
            Some(VenueActivity::Read {
                test: *test,
                accounts,
            })
        }
        _ => None,
    }
}

/// `createTradeVenueActivityClient({ tradeUrl, secret })`.
pub struct TradeVenueActivity {
    door: DoorClient,
}

impl TradeVenueActivity {
    pub fn new(
        trade_url: Option<&str>,
        secret: Option<&str>,
        fetch: Arc<dyn Fetch>,
    ) -> TradeVenueActivity {
        TradeVenueActivity {
            door: DoorClient {
                endpoint: door_endpoint(trade_url, "venue.ownActivity"),
                secret: secret.map(str::to_owned),
                timeout_ms: 5000,
                fetch,
                clock: default_clock(),
            },
        }
    }

    pub fn with_clock(mut self, clock: Arc<dyn Fn() -> i64 + Send + Sync>) -> TradeVenueActivity {
        self.door.clock = clock;
        self
    }
}

impl VenueActivitySource for TradeVenueActivity {
    fn read(&self, user_id: &str) -> VenueActivity {
        self.door
            .post_user(user_id)
            .and_then(|d| parse_activity(&d))
            .unwrap_or(VenueActivity::Unavailable)
    }
}
