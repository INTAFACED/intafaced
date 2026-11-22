//! The owner's destination fraud list (`ramps/fraud-list.ts`, W-withdraw-03): an address listed as fraud on one network
//! or on every network (`*`) is never saved to an address book, the add form's check says so, and a saved entry listed
//! later reads `blocked`. An empty list refuses nothing; a list that cannot be read refuses
//! `bank.destination_fraud_list_unreadable`, never "not listed". An EVM address is matched in lower case, any other
//! exactly as written.
//!
//! Every change names the revision it was made against and consumes a second person's approval bound to the network,
//! the address, the listed state, the new revision and the reason, after the checks and before the write. The history
//! row carries the business key `ops-fraud-list:<network>:<address>:<revision>`, so a retry replays and a different
//! change on the same revision refuses `bank.ops_revision_conflict`.

use postgres::{GenericClient, Row};
use service_kit::json::Json;
use service_kit::time::Instant;

use crate::db::Store;
use crate::errors::Refusal;
use crate::partner::refuse;
use crate::ramps::refs::{ANY_NETWORK, address_key, js_trim, network_key};
use crate::spaces::space::{in_tx, pg, with};

use super::store::js_len;

/// `SET_FRAUD_LISTING_ACTION`.
pub const SET_ACTION: &str = "bank.ops.setDestinationFraudListing";

/// `refuseFraudListed`: the address-book and send refusal for a listed address.
pub fn refuse_listed() -> Refusal {
    refuse(
        "bank.destination_fraud_listed",
        "This address is on the fraud list, so it cannot be saved or sent to. Nothing was saved or sent",
    )
}

fn unreadable() -> Refusal {
    refuse(
        "bank.destination_fraud_list_unreadable",
        "The fraud list could not be read, so the address was refused rather than assumed safe",
    )
}

/// `DestinationFraudList.isListed`: whether `r` is listed on `network` or on every network. No network (an entry stored
/// without one) matches a listing on any network. Unreadable refuses `bank.destination_fraud_list_unreadable`.
pub fn is_listed(
    c: &mut impl GenericClient,
    network: Option<&str>,
    r: &str,
) -> Result<bool, Refusal> {
    let key = address_key(r);
    let networks: Option<Vec<String>> =
        network.map(|n| vec![ANY_NETWORK.to_owned(), js_trim(n).to_lowercase()]);
    c.query(
        "SELECT listed FROM bank.destination_fraud_list \
         WHERE address_key = $1 AND ($2::text[] IS NULL OR network = ANY($2::text[])) AND listed LIMIT 1",
        &[&key, &networks],
    )
    .map(|rows| !rows.is_empty())
    .map_err(|_| unreadable())
}

/// [`is_listed`] on a connection of its own; an unreachable database is unreadable too.
pub fn is_listed_in(store: &Store, network: Option<&str>, r: &str) -> Result<bool, Refusal> {
    with(store, |c| is_listed(c, network, r)).map_err(|e| match e {
        Refusal::Bank(_) => e,
        _ => unreadable(),
    })
}

/// `FraudListing`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Listing {
    pub network: String,
    pub address: String,
    pub listed: bool,
    pub revision: i64,
    pub reason: Option<String>,
    pub approved_by: Option<String>,
    pub updated_at: Option<Instant>,
}

impl Listing {
    fn fields(&self) -> Vec<(String, Json)> {
        let opt = |s: &Option<String>| s.clone().map_or(Json::Null, Json::str);
        vec![
            ("network".to_owned(), Json::str(self.network.clone())),
            ("address".to_owned(), Json::str(self.address.clone())),
            ("listed".to_owned(), Json::Bool(self.listed)),
            ("revision".to_owned(), Json::int(self.revision)),
            ("reason".to_owned(), opt(&self.reason)),
            ("approvedBy".to_owned(), opt(&self.approved_by)),
            (
                "updatedAt".to_owned(),
                self.updated_at.map_or(Json::Null, |t| Json::str(t.iso())),
            ),
        ]
    }

    pub fn json(&self) -> Json {
        Json::Object(self.fields())
    }

    pub fn json_replayed(&self, replayed: bool) -> Json {
        let mut f = self.fields();
        f.push(("replayed".to_owned(), Json::Bool(replayed)));
        Json::Object(f)
    }
}

const LIST_COLS: &str = "network, address_key, listed, revision::int8, reason, approved_by, \
     floor(extract(epoch from updated_at) * 1000)::int8";

fn listing(r: &Row) -> Result<Listing, Refusal> {
    Ok(Listing {
        network: r.try_get(0).map_err(|e| pg(&e))?,
        address: r.try_get(1).map_err(|e| pg(&e))?,
        listed: r.try_get(2).map_err(|e| pg(&e))?,
        revision: r.try_get(3).map_err(|e| pg(&e))?,
        reason: Some(r.try_get(4).map_err(|e| pg(&e))?),
        approved_by: Some(r.try_get(5).map_err(|e| pg(&e))?),
        updated_at: Some(Instant(r.try_get(6).map_err(|e| pg(&e))?)),
    })
}

/// `list`: addresses that have ever been listed (one address's rows when `address` is given), listed first.
pub fn list(
    c: &mut impl GenericClient,
    limit: i64,
    address: Option<&str>,
) -> Result<Vec<Listing>, Refusal> {
    let key = address.map(address_key);
    c.query(
        &format!(
            "SELECT {LIST_COLS} FROM bank.destination_fraud_list \
             WHERE ($1::text IS NULL OR address_key = $1) \
             ORDER BY listed DESC, network, address_key LIMIT $2"
        ),
        &[&key, &limit],
    )
    .map_err(|e| pg(&e))?
    .iter()
    .map(listing)
    .collect()
}

fn state(c: &mut impl GenericClient, network: &str, address: &str) -> Result<Listing, Refusal> {
    let rows = c
        .query(
            &format!(
                "SELECT {LIST_COLS} FROM bank.destination_fraud_list WHERE network = $1 AND address_key = $2"
            ),
            &[&network, &address],
        )
        .map_err(|e| pg(&e))?;
    match rows.first() {
        Some(r) => listing(r),
        None => Ok(Listing {
            network: network.to_owned(),
            address: address.to_owned(),
            listed: false,
            revision: 0,
            reason: None,
            approved_by: None,
            updated_at: None,
        }),
    }
}

/// `fraudChangeKey`.
pub fn change_key(network: &str, address: &str, revision: i64) -> String {
    format!("ops-fraud-list:{network}:{address}:{revision}")
}

/// One history row (`HistoryRow`).
struct History {
    network: String,
    address: String,
    revision: i64,
    listed: bool,
    reason: String,
    approved_by: String,
}

fn history(
    c: &mut impl GenericClient,
    network: &str,
    address: &str,
    revision: i64,
) -> Result<Option<History>, Refusal> {
    let rows = c
        .query(
            "SELECT network, address_key, revision::int8, listed, reason, approved_by \
             FROM bank.destination_fraud_list_history WHERE change_key = $1",
            &[&change_key(network, address, revision)],
        )
        .map_err(|e| pg(&e))?;
    rows.first()
        .map(|r| {
            Ok(History {
                network: r.try_get(0).map_err(|e| pg(&e))?,
                address: r.try_get(1).map_err(|e| pg(&e))?,
                revision: r.try_get(2).map_err(|e| pg(&e))?,
                listed: r.try_get(3).map_err(|e| pg(&e))?,
                reason: r.try_get(4).map_err(|e| pg(&e))?,
                approved_by: r.try_get(5).map_err(|e| pg(&e))?,
            })
        })
        .transpose()
}

fn conflict(network: &str, address: &str, expected: i64, actual: i64) -> Refusal {
    refuse(
        "bank.ops_revision_conflict",
        format!(
            "The fraud listing of {address} on {network} changed underneath this request (expected revision {expected}, found {actual}); read it again"
        ),
    )
}

fn replay(prior: &History, listed: bool, reason: &str) -> Result<Listing, Refusal> {
    if prior.listed != listed || prior.reason != reason {
        return Err(conflict(
            &prior.network,
            &prior.address,
            prior.revision - 1,
            prior.revision,
        ));
    }
    Ok(Listing {
        network: prior.network.clone(),
        address: prior.address.clone(),
        listed: prior.listed,
        revision: prior.revision,
        reason: Some(prior.reason.clone()),
        approved_by: Some(prior.approved_by.clone()),
        updated_at: None,
    })
}

/// `FraudListingChange`.
pub struct Change<'a> {
    pub network: &'a str,
    pub address: &'a str,
    pub listed: bool,
    pub expected_revision: i64,
    pub reason: &'a str,
}

/// `fraudListingFields`: the fields the approval is bound to, normalised. `None` when the network is no network id.
pub fn fields(change: &Change<'_>) -> Result<Vec<(String, String)>, Refusal> {
    Ok(vec![
        ("network".to_owned(), network_key(change.network)?),
        ("address".to_owned(), address_key(change.address)),
        ("listed".to_owned(), change.listed.to_string()),
        (
            "revision".to_owned(),
            (change.expected_revision + 1).to_string(),
        ),
        ("reason".to_owned(), js_trim(change.reason).to_owned()),
    ])
}

const MAX_SAFE: i64 = 9_007_199_254_740_991;

/// `DestinationFraudList.set`: list or delist one address. `consume` spends the second person's approval and names who
/// proposed and who approved; it is called after the checks and the revision read, before the write.
pub fn set(
    store: &Store,
    change: &Change<'_>,
    consume: impl FnOnce() -> Result<(String, String), Refusal>,
) -> Result<(Listing, bool), Refusal> {
    let network = network_key(change.network)?;
    let address = address_key(change.address);
    let evm = address.len() == 42
        && address.starts_with("0x")
        && address
            .bytes()
            .skip(2)
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b));
    if !evm {
        return Err(refuse(
            "bank.validation_failed",
            "A listed address must be an EVM address: 0x followed by 40 letters a to f or digits",
        ));
    }
    let reason = js_trim(change.reason);
    if js_len(reason) < 10 {
        return Err(refuse(
            "bank.ops_reason_too_short",
            "A fraud list change needs a reason of at least 10 characters (bank.ops_reason_too_short)",
        ));
    }
    if !(0..=MAX_SAFE).contains(&change.expected_revision) {
        return Err(refuse(
            "bank.validation_failed",
            "expectedRevision must be the revision the desk read (0 for never listed)",
        ));
    }
    let revision = change.expected_revision + 1;
    let prior = with(store, |c| history(c, &network, &address, revision))?;
    let current = with(store, |c| state(c, &network, &address))?;
    if let Some(prior) = prior {
        if current.revision != revision {
            return Err(conflict(
                &network,
                &address,
                change.expected_revision,
                current.revision,
            ));
        }
        return replay(&prior, change.listed, reason).map(|l| (l, true));
    }
    if current.revision != change.expected_revision {
        return Err(conflict(
            &network,
            &address,
            change.expected_revision,
            current.revision,
        ));
    }
    let (requester, approver) = consume()?;
    let rev32 = i32::try_from(revision).map_err(|e| Refusal::Other(e.to_string()))?;
    in_tx(store, |tx| {
        let locked = tx
            .query(
                "SELECT revision::int8 FROM bank.destination_fraud_list \
                 WHERE network = $1 AND address_key = $2 FOR UPDATE",
                &[&network, &address],
            )
            .map_err(|e| pg(&e))?;
        let now = match locked.first() {
            Some(r) => r.try_get::<_, i64>(0).map_err(|e| pg(&e))?,
            None => 0,
        };
        if now != change.expected_revision {
            if let Some(raced) = history(tx, &network, &address, revision)? {
                return replay(&raced, change.listed, reason).map(|l| (l, true));
            }
            return Err(conflict(&network, &address, change.expected_revision, now));
        }
        let inserted = tx
            .query(
                "INSERT INTO bank.destination_fraud_list_history \
                   (network, address_key, revision, change_key, listed, reason, requested_by, approved_by) \
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8) ON CONFLICT DO NOTHING RETURNING network",
                &[
                    &network,
                    &address,
                    &rev32,
                    &change_key(&network, &address, revision),
                    &change.listed,
                    &reason,
                    &requester,
                    &approver,
                ],
            )
            .map_err(|e| pg(&e))?;
        if inserted.is_empty() {
            // A first-revision race: no row to lock, and the other change won the key.
            if let Some(raced) = history(tx, &network, &address, revision)? {
                return replay(&raced, change.listed, reason).map(|l| (l, true));
            }
            return Err(conflict(
                &network,
                &address,
                change.expected_revision,
                revision,
            ));
        }
        let rows = tx
            .query(
                &format!(
                    "INSERT INTO bank.destination_fraud_list \
                       (network, address_key, listed, revision, reason, approved_by, updated_at) \
                     VALUES ($1, $2, $3, $4, $5, $6, now()) \
                     ON CONFLICT (network, address_key) DO UPDATE \
                       SET listed = EXCLUDED.listed, revision = EXCLUDED.revision, reason = EXCLUDED.reason, \
                           approved_by = EXCLUDED.approved_by, updated_at = EXCLUDED.updated_at \
                     RETURNING {LIST_COLS}"
                ),
                &[&network, &address, &change.listed, &rev32, &reason, &approver],
            )
            .map_err(|e| pg(&e))?;
        rows.first()
            .ok_or_else(|| Refusal::Other("the fraud listing returned no row".to_owned()))
            .and_then(listing)
            .map(|l| (l, false))
    })
}

/// `historyOf`: one address's changes, newest first, in the desk's schema's key order.
pub fn history_of(
    c: &mut impl GenericClient,
    network: &str,
    address: &str,
    limit: i64,
) -> Result<Vec<Json>, Refusal> {
    let network = network_key(network)?;
    let address = address_key(address);
    let rows = c
        .query(
            "SELECT network, address_key, revision::int8, change_key, listed, reason, requested_by, approved_by, \
                    floor(extract(epoch from created_at) * 1000)::int8 \
             FROM bank.destination_fraud_list_history \
             WHERE network = $1 AND address_key = $2 ORDER BY revision DESC LIMIT $3",
            &[&network, &address, &limit],
        )
        .map_err(|e| pg(&e))?;
    rows.iter()
        .map(|r| {
            let s = |i: usize| r.try_get::<_, String>(i).map(Json::str).map_err(|e| pg(&e));
            Ok(Json::Object(vec![
                ("network".to_owned(), s(0)?),
                ("address".to_owned(), s(1)?),
                (
                    "listed".to_owned(),
                    Json::Bool(r.try_get(4).map_err(|e| pg(&e))?),
                ),
                (
                    "revision".to_owned(),
                    Json::int(r.try_get(2).map_err(|e| pg(&e))?),
                ),
                ("reason".to_owned(), s(5)?),
                ("approvedBy".to_owned(), s(7)?),
                ("requestedBy".to_owned(), s(6)?),
                ("changeKey".to_owned(), s(3)?),
                (
                    "at".to_owned(),
                    Json::str(Instant(r.try_get(8).map_err(|e| pg(&e))?).iso()),
                ),
            ]))
        })
        .collect()
}
