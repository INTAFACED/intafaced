//! New-address approval (`ramps/address-approval.ts`, W-withdraw-09): a saved address waits `pending` until the customer
//! approves it by an emailed single-use link or from another signed-in device; only then does its cooling-off start.
//!
//! - By email: a link row is written first (its token's sha256 only), then identity is asked to mail it under the key
//!   `address-approval:<entry>:<n>`; a refused mail leaves a link never sent, which can never be used. It lives the
//!   owner's `BANK_ADDRESS_APPROVAL_LINK_MINUTES`; only the newest mailed link of an entry works.
//! - From another device: the entry keeps the sign-in (`fam`) and trusted device (`dev`) it was saved from; the
//!   approving token's must be a different device, and identity must say that device may be relied on.
//!
//! Both refuse while the customer's security lock holds. Approving twice changes nothing.

use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use postgres::{GenericClient, Row};
use service_kit::approvals::random_uuid;
use service_kit::time::Instant;
use sha2::{Digest, Sha256};

use crate::db::Store;
use crate::errors::Refusal;
use crate::partner::refuse;
use crate::ramps::refs::js_trim;
use crate::spaces::space::{at, pg, with};
use crate::transfers::ports::{SecurityLock, assert_security_lock_open};

use super::ports::{ApprovalMail, MailRequest, TrustedDevices, device_may_approve};
use super::store::{self, Destination, SavedOn, positive_digits};

const ACTION: &str = "approving a withdrawal address";
/// Identity refuses a link shown as valid more than seven days ahead.
const MAX_LINK_MINUTES: i64 = 7 * 24 * 60;

/// `requireApprovalLinkMinutes`: whole minutes, 1 to seven days, or `bank.address_approval_link_unset`.
pub fn require_link_minutes(raw: Option<&str>) -> Result<i64, Refusal> {
    positive_digits(raw, 5)
        .filter(|m| *m <= MAX_LINK_MINUTES)
        .ok_or_else(|| {
            refuse(
                "bank.address_approval_link_unset",
                "BANK_ADDRESS_APPROVAL_LINK_MINUTES is unset or not a whole number of minutes up to seven days, so no approval link is sent",
            )
        })
}

/// `hashToken`: sha256, lower-case hex.
pub fn hash_token(token: &str) -> String {
    Sha256::digest(token.as_bytes())
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

/// A fresh link token: 32 bytes, base64url (`randomBytes(32).toString('base64url')`). The bytes are the sha256 of two
/// fresh random uuids (244 random bits), from the one random source the kit holds.
fn new_token() -> Result<String, Refusal> {
    let seed = format!(
        "{}{}",
        random_uuid().map_err(Refusal::Other)?,
        random_uuid().map_err(Refusal::Other)?
    );
    Ok(URL_SAFE_NO_PAD.encode(Sha256::digest(seed.as_bytes())))
}

/// `ApprovalLinkRow`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Link {
    pub id: String,
    pub user_id: String,
    pub destination_id: String,
    pub seq: i64,
    pub expires_at: Instant,
    pub mailed_at: Option<Instant>,
    pub used_at: Option<Instant>,
}

/// The link columns, each under `p` (a table alias with its dot, or blank), in [`link_of`]'s order.
fn link_cols(p: &str) -> String {
    format!(
        "{p}id::text, {p}user_id, {p}destination_id::text, {p}seq::int8, \
         floor(extract(epoch from {p}expires_at) * 1000)::int8, \
         floor(extract(epoch from {p}mailed_at) * 1000)::int8, \
         floor(extract(epoch from {p}used_at) * 1000)::int8"
    )
}

fn link_of(r: &Row) -> Result<Link, Refusal> {
    let t = |i: usize| {
        r.try_get::<_, Option<i64>>(i)
            .map(|v| v.map(Instant))
            .map_err(|e| pg(&e))
    };
    Ok(Link {
        id: r.try_get(0).map_err(|e| pg(&e))?,
        user_id: r.try_get(1).map_err(|e| pg(&e))?,
        destination_id: r.try_get(2).map_err(|e| pg(&e))?,
        seq: r.try_get(3).map_err(|e| pg(&e))?,
        expires_at: t(4)?.unwrap_or(Instant(0)),
        mailed_at: t(5)?,
        used_at: t(6)?,
    })
}

/// `insert`: a new link for the entry, numbered after the last one (two requests at once take turns).
fn insert(
    store: &Store,
    user_id: &str,
    destination_id: &str,
    token_hash: &str,
    expires_at: Instant,
) -> Result<Link, Refusal> {
    store::serializable(store, |tx| {
        tx.execute(
            "SELECT pg_advisory_xact_lock(hashtext($1))",
            &[&format!("destination-approval:{destination_id}")],
        )
        .map_err(|e| pg(&e))?;
        let rows = tx
            .query(
                &format!(
                    "INSERT INTO bank.destination_approval_links (user_id, destination_id, seq, token_hash, expires_at) \
                     SELECT $1, $2::text::uuid, coalesce(max(seq), 0) + 1, $3, {} \
                       FROM bank.destination_approval_links WHERE destination_id = $2::text::uuid \
                     RETURNING {}",
                    at("$4"),
                    link_cols("")
                ),
                &[&user_id, &destination_id, &token_hash, &expires_at.0],
            )
            .map_err(|e| pg(&e))?;
        rows.first()
            .ok_or_else(|| Refusal::Other("the approval link returned no row".to_owned()))
            .and_then(link_of)
    })
}

fn mark_mailed(c: &mut impl GenericClient, id: &str, mail_id: &str) -> Result<(), Refusal> {
    c.execute(
        "UPDATE bank.destination_approval_links SET mailed_at = now(), mail_id = $2::text::uuid \
         WHERE id = $1::text::uuid AND mailed_at IS NULL",
        &[&id, &mail_id],
    )
    .map(|_| ())
    .map_err(|e| pg(&e))
}

/// `byToken`: the link with this token hash, and the highest mailed link number of its entry (its own when none).
fn by_token(c: &mut impl GenericClient, token_hash: &str) -> Result<Option<(Link, i64)>, Refusal> {
    let rows = c
        .query(
            &format!(
                "SELECT {}, \
                   (SELECT max(seq) FROM bank.destination_approval_links n \
                     WHERE n.destination_id = l.destination_id AND n.mailed_at IS NOT NULL)::int8 \
                 FROM bank.destination_approval_links l WHERE l.token_hash = $1",
                link_cols("l.")
            ),
            &[&token_hash],
        )
        .map_err(|e| pg(&e))?;
    rows.first()
        .map(|r| {
            let link = link_of(r)?;
            let newest: Option<i64> = r.try_get(7).map_err(|e| pg(&e))?;
            let seq = link.seq;
            Ok((link, newest.unwrap_or(seq)))
        })
        .transpose()
}

/// `markUsed`: once; false when it was used already.
fn mark_used(c: &mut impl GenericClient, id: &str) -> Result<bool, Refusal> {
    c.query(
        "UPDATE bank.destination_approval_links SET used_at = now() \
         WHERE id = $1::text::uuid AND used_at IS NULL RETURNING id",
        &[&id],
    )
    .map(|rows| rows.len() == 1)
    .map_err(|e| pg(&e))
}

/// `newestMailed`: the newest mailed link of each of the customer's entries.
fn newest_mailed(c: &mut impl GenericClient, user_id: &str) -> Result<Vec<Link>, Refusal> {
    c.query(
        &format!(
            "SELECT DISTINCT ON (destination_id) {} FROM bank.destination_approval_links \
             WHERE user_id = $1 AND mailed_at IS NOT NULL ORDER BY destination_id, seq DESC",
            link_cols("")
        ),
        &[&user_id],
    )
    .map_err(|e| pg(&e))?
    .iter()
    .map(link_of)
    .collect()
}

/// `openApprovalLinks`: per entry, until when its newest mailed link works, when it still does at `now`.
pub fn open_links(
    c: &mut impl GenericClient,
    user_id: &str,
    now: Instant,
) -> Result<Vec<(String, String)>, Refusal> {
    Ok(newest_mailed(c, user_id)?
        .into_iter()
        .filter(|l| l.used_at.is_none() && l.expires_at.0 > now.0)
        .map(|l| (l.destination_id, l.expires_at.iso()))
        .collect())
}

/// What the approval calls are handed.
pub struct Approval<'a> {
    pub store: &'a Store,
    pub lock: &'a dyn SecurityLock,
    pub mail: &'a dyn ApprovalMail,
    pub devices: &'a dyn TrustedDevices,
    pub link_minutes_raw: Option<&'a str>,
    pub now: Instant,
}

fn find(
    store: &Store,
    user_id: &str,
    destination_id: &str,
) -> Result<Option<Destination>, Refusal> {
    Ok(with(store, |c| store::list(c, user_id))?
        .into_iter()
        .find(|e| e.destination_id == destination_id))
}

/// `approvableEntry`: missing refuses `bank.withdraw_destination_missing`, removed or blocked since
/// `bank.address_approval_not_pending`; waiting and approved entries are returned.
fn approvable(store: &Store, user_id: &str, destination_id: &str) -> Result<Destination, Refusal> {
    let entry = find(store, user_id, destination_id)?.ok_or_else(|| {
        refuse(
            "bank.withdraw_destination_missing",
            "The address to approve was removed from your address book",
        )
    })?;
    if entry.state == "blocked" || entry.state == "archived" {
        return Err(refuse(
            "bank.address_approval_not_pending",
            "This address can no longer be approved: it was removed or blocked",
        ));
    }
    Ok(entry)
}

/// `detailOf`: what the mail shows so the customer can tell which address they approve.
fn detail_of(row: &Destination) -> String {
    let r: String = row
        .r#ref
        .chars()
        .filter(char::is_ascii_alphanumeric)
        .collect();
    let short = if r.len() <= 12 {
        r.clone()
    } else {
        format!(
            "{}...{}",
            r.get(..6).unwrap_or_default(),
            r.get(r.len() - 4..).unwrap_or_default()
        )
    };
    let text = format!(
        "{} on {}, {short}",
        row.asset_id.as_deref().unwrap_or_default(),
        row.network.as_deref().unwrap_or_default()
    );
    let kept: String = text
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || " .:,()_-".contains(*c))
        .collect();
    kept.chars().take(120).collect()
}

/// `requestApprovalMail`: mail a single-use approval link for one pending entry; answers until when it works.
pub fn request_mail(
    a: &Approval<'_>,
    user_id: &str,
    destination_id: &str,
) -> Result<(String, String), Refusal> {
    let minutes = require_link_minutes(a.link_minutes_raw)?;
    assert_security_lock_open(a.lock, user_id, ACTION)?;
    let row = find(a.store, user_id, destination_id)?.ok_or_else(|| {
        refuse(
            "bank.withdraw_destination_missing",
            format!("User {user_id} has no saved address {destination_id}"),
        )
    })?;
    if row.state != "pending" {
        return Err(refuse(
            "bank.address_approval_not_pending",
            "This address does not need approving: it was approved already",
        ));
    }
    let token = new_token()?;
    // Whole seconds: the mail shows the time, and identity compares it as sent.
    let expires_at = Instant(a.now.0.div_euclid(1000) * 1000 + minutes * 60_000);
    let link = insert(
        a.store,
        user_id,
        &row.destination_id,
        &hash_token(&token),
        expires_at,
    )?;
    let mail_id = a.mail.send(&MailRequest {
        key: format!("address-approval:{}:{}", row.destination_id, link.seq),
        user_id: user_id.to_owned(),
        token,
        detail: detail_of(&row),
        expires_at: expires_at.iso(),
    })?;
    with(a.store, |c| mark_mailed(c, &link.id, &mail_id))?;
    Ok((row.destination_id, expires_at.iso()))
}

fn link_invalid() -> Refusal {
    refuse(
        "bank.address_approval_link_invalid",
        "This approval link is not one we sent you, or it belongs to another account",
    )
}

/// `TOKEN_RE`: `[A-Za-z0-9_-]{16,256}`.
fn token_shaped(t: &str) -> bool {
    (16..=256).contains(&t.len())
        && t.bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

/// `approveByLink`: approve the entry an emailed link names, for the customer it was sent to. An entry approved
/// already is answered as it is; for one still waiting a replaced, expired or used link approves nothing.
pub fn approve_by_link(
    a: &Approval<'_>,
    user_id: &str,
    token: &str,
) -> Result<Destination, Refusal> {
    let token = js_trim(token);
    if !token_shaped(token) {
        return Err(link_invalid());
    }
    let (link, newest) = match with(a.store, |c| by_token(c, &hash_token(token)))? {
        Some((link, newest)) if link.user_id == user_id => (link, newest),
        _ => return Err(link_invalid()),
    };
    let entry = approvable(a.store, user_id, &link.destination_id)?;
    if entry.state != "pending" {
        return Ok(entry);
    }
    if link.seq < newest {
        return Err(refuse(
            "bank.address_approval_link_replaced",
            "A newer approval link was sent for this address. Use the newest one",
        ));
    }
    if a.now.0 >= link.expires_at.0 {
        return Err(refuse(
            "bank.address_approval_link_expired",
            "This approval link has expired. Ask for a new one from your address book",
        ));
    }
    if link.used_at.is_some() {
        return Err(link_invalid());
    }
    assert_security_lock_open(a.lock, user_id, ACTION)?;
    // The entry moves first (only from `pending`), then the link is spent.
    let approved = with(a.store, |c| {
        store::approve(c, user_id, &link.destination_id, "link")
    })?;
    with(a.store, |c| mark_used(c, &link.id))?;
    Ok(approved)
}

/// `deviceComparison`: whether an approving sign-in is on a different device from the one that saved the entry.
pub fn device_comparison(saved: &SavedOn, approving: &SavedOn) -> &'static str {
    let lower = |v: &Option<String>| v.as_ref().map(|s| s.to_lowercase());
    let (saved_fam, approving_fam) = (lower(&saved.fam), lower(&approving.fam));
    if approving_fam.is_none() {
        return "unknown";
    }
    if let (Some(s), Some(a)) = (lower(&saved.dev), lower(&approving.dev)) {
        return if s == a { "same" } else { "different" };
    }
    if saved_fam == approving_fam {
        "same"
    } else {
        "unknown"
    }
}

/// `approveOnDevice`: approve a waiting entry from a signed-in device that did not save it.
pub fn approve_on_device(
    a: &Approval<'_>,
    user_id: &str,
    destination_id: &str,
    approving: &SavedOn,
) -> Result<Destination, Refusal> {
    assert_security_lock_open(a.lock, user_id, ACTION)?;
    let entry = approvable(a.store, user_id, destination_id)?;
    if entry.state != "pending" {
        return Ok(entry);
    }
    let saved = with(a.store, |c| {
        store::saved_on(c, user_id, &entry.destination_id)
    })?;
    let compared = saved.map_or("unknown", |s| device_comparison(&s, approving));
    if compared == "same" {
        return Err(refuse(
            "bank.address_approval_same_device",
            "This address was saved on this device, so it cannot be approved here. Approve it on another device where you are signed in, or by the emailed link",
        ));
    }
    if compared == "unknown" {
        return Err(refuse(
            "bank.address_approval_device_unknown",
            "This device cannot be told apart from the one that saved the address. Use the emailed link instead",
        ));
    }
    let device = approving.dev.as_deref().unwrap_or_default();
    if !device_may_approve(&a.devices.read(user_id, device)?) {
        return Err(refuse(
            "bank.address_approval_device_untrusted",
            "This device was not confirmed by an emailed code, so it cannot approve the address. Use the emailed link instead",
        ));
    }
    with(a.store, |c| {
        store::approve(c, user_id, &entry.destination_id, "device")
    })
}
