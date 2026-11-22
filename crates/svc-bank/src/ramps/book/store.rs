//! The withdrawal address store (`withdraw-destination.ts`, `UserWithdrawDestinationStore`): the legacy one-per-kind
//! slot the off-ramp writes, and the customer's saved address book, with every shape check the TypeScript makes.
//!
//! A saved entry starts `pending` until the customer approves it (by an emailed link or from another signed-in device),
//! then `cooling`: its cooling-off runs from the approval. Entries from before approvals existed, and the legacy slot, are
//! `active`. The label is unique per customer (case-insensitive), the number of saved entries is the owner's
//! `BANK_ADDRESS_BOOK_CAP`, and a rename never moves `updated_at` (the cooling clock).

use postgres::{GenericClient, IsolationLevel, Row, Transaction};
use service_kit::time::Instant;
use sha3::{Digest, Keccak256};

use crate::db::Store;
use crate::errors::Refusal;
use crate::partner::refuse;
use crate::ramps::refs::{is_bank_destination_ref, is_evm_address_ref, js_trim};
use crate::spaces::space::{db, pg};

/// `DESTINATION_STATES`.
pub const STATES: [&str; 5] = ["pending", "cooling", "active", "blocked", "archived"];

/// `WithdrawDestination`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Destination {
    pub destination_id: String,
    pub user_id: String,
    /// `crypto` or `bank`.
    pub kind: String,
    pub r#ref: String,
    pub label: Option<String>,
    /// None on the legacy slot, which is not tied to an asset or network.
    pub asset_id: Option<String>,
    pub network: Option<String>,
    pub tag: Option<String>,
    /// `legacy` (the one-per-kind slot the off-ramp writes) or `customer` (a saved address-book entry).
    pub origin: String,
    pub state: String,
    pub added_at: Instant,
    pub updated_at: Instant,
    pub lookalike_of: Option<String>,
    pub lookalike_confirmed_at: Option<Instant>,
    pub approved_at: Option<Instant>,
    /// `link` or `device`.
    pub approved_by: Option<String>,
}

/// `SavedOn`: the sign-in and the trusted device an entry was saved from; none where the token named none.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct SavedOn {
    pub fam: Option<String>,
    pub dev: Option<String>,
}

/// `SaveDestinationInput`.
#[derive(Debug, Clone, Default)]
pub struct SaveInput<'a> {
    pub user_id: &'a str,
    pub asset_id: &'a str,
    pub network: &'a str,
    pub r#ref: &'a str,
    pub tag: Option<&'a str>,
    pub label: &'a str,
    pub lookalike_of: Option<String>,
    pub saved_on: SavedOn,
}

/// `assertBookEntry`'s answer: the entry as the store keeps it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BookEntry {
    pub asset_id: String,
    pub network: String,
    pub r#ref: String,
    pub tag: Option<String>,
    pub label: String,
    pub lookalike_of: Option<String>,
}

fn invalid(message: impl Into<String>) -> Refusal {
    refuse("bank.ramp_invalid_destination", message)
}

/// JavaScript's `.length`: UTF-16 code units.
pub fn js_len(s: &str) -> usize {
    s.encode_utf16().count()
}

/// `/[\u0000-\u001f]/`.
fn has_control(s: &str) -> bool {
    s.chars().any(|c| u32::from(c) <= 0x1f)
}

fn hex_groups(s: &str, version: bool) -> bool {
    let b = s.as_bytes();
    if b.len() != 36 {
        return false;
    }
    let dash = |i: usize| matches!(i, 8 | 13 | 18 | 23);
    let shaped = b.iter().enumerate().all(|(i, c)| {
        if dash(i) {
            *c == b'-'
        } else {
            c.is_ascii_hexdigit()
        }
    });
    shaped
        && (!version
            || (matches!(b.get(14), Some(b'1'..=b'8'))
                && matches!(b.get(19), Some(b'8' | b'9' | b'a' | b'b' | b'A' | b'B'))))
}

/// `UUID_RE`: a version 1 to 8 uuid with its variant bits, any case.
pub fn is_uuid(s: &str) -> bool {
    hex_groups(s, true)
}

/// `GUID_RE` (`z.guid()`): any 8-4-4-4-12 hex id.
pub fn is_guid(s: &str) -> bool {
    hex_groups(s, false)
}

/// `/^[1-9][0-9]{0,N}$/` on a trimmed value: the number, or none.
pub fn positive_digits(raw: Option<&str>, max_digits: usize) -> Option<i64> {
    let t = js_trim(raw.unwrap_or_default());
    let b = t.as_bytes();
    let ok = !b.is_empty()
        && b.len() <= max_digits
        && matches!(b.first(), Some(b'1'..=b'9'))
        && b.iter().all(u8::is_ascii_digit);
    if ok { t.parse().ok() } else { None }
}

/// `requireAddressBookCap`: unset, blank, zero or not a whole number refuses `bank.address_book_cap_unset`.
pub fn require_address_book_cap(raw: Option<&str>) -> Result<i64, Refusal> {
    positive_digits(raw, 6).ok_or_else(|| {
        refuse(
            "bank.address_book_cap_unset",
            "BANK_ADDRESS_BOOK_CAP is unset or not a positive whole number. Saving an address refuses rather than inventing a limit",
        )
    })
}

/// `assertDestinationLabel`.
pub fn assert_label(label: &str) -> Result<String, Refusal> {
    if js_trim(label) != label || js_len(label) < 1 || js_len(label) > 64 || has_control(label) {
        return Err(invalid(
            "Withdraw destination label must be 1–64 characters with no surrounding whitespace or control characters",
        ));
    }
    Ok(label.to_owned())
}

/// `assertSavedOn`: each a uuid (lower-cased) or none; anything else is a caller bug, refused.
pub fn assert_saved_on(input: &SavedOn) -> Result<SavedOn, Refusal> {
    let one = |v: &Option<String>| -> Result<Option<String>, Refusal> {
        match v {
            None => Ok(None),
            Some(s) if is_guid(s) => Ok(Some(s.to_lowercase())),
            Some(_) => Err(invalid("The saving sign-in or device is not a uuid")),
        }
    };
    Ok(SavedOn {
        fam: one(&input.fam)?,
        dev: one(&input.dev)?,
    })
}

/// `assertBookEntry`: normalise and check one address-book entry. Crypto only.
pub fn assert_book_entry(input: &SaveInput<'_>) -> Result<BookEntry, Refusal> {
    let asset_id = js_trim(input.asset_id).to_uppercase();
    let asset_ok = (1..=16).contains(&asset_id.len())
        && asset_id
            .bytes()
            .all(|b| b.is_ascii_uppercase() || b.is_ascii_digit());
    if !asset_ok {
        return Err(invalid(
            "Saved address needs an asset code of 1 to 16 letters or digits",
        ));
    }
    let network = js_trim(input.network).to_lowercase();
    let nb = network.as_bytes();
    let network_ok = (2..=32).contains(&nb.len())
        && nb
            .first()
            .is_some_and(|b| b.is_ascii_lowercase() || b.is_ascii_digit())
        && nb
            .iter()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || *b == b'_' || *b == b'-');
    if !network_ok {
        return Err(invalid(
            "Saved address needs a network name of 2 to 32 letters, digits, dashes or underscores",
        ));
    }
    let (_, r) = assert_persistable("crypto", input.r#ref)?;
    let tag = match input.tag {
        None => None,
        Some(t) => {
            if js_trim(t) != t || js_len(t) < 1 || js_len(t) > 64 || has_control(t) {
                return Err(invalid(
                    "Memo or tag must be 1 to 64 characters with no surrounding whitespace",
                ));
            }
            Some(t.to_owned())
        }
    };
    let lookalike_of = match &input.lookalike_of {
        None => None,
        Some(id) if is_uuid(id) => Some(id.to_lowercase()),
        Some(_) => {
            return Err(invalid(
                "The look-alike confirmation must name a saved entry by its id",
            ));
        }
    };
    Ok(BookEntry {
        asset_id,
        network,
        r#ref: r,
        tag,
        label: assert_label(input.label)?,
        lookalike_of,
    })
}

/// `keccak_256`.
pub fn keccak(bytes: &[u8]) -> [u8; 32] {
    Keccak256::digest(bytes).into()
}

/// `evmChecksumMatches` (EIP-55): all lower or all upper case carries no checksum and passes. Only meaningful on an
/// `isEvmAddressRef` shape.
pub fn evm_checksum_matches(r: &str) -> bool {
    let hex = js_trim(r).get(2..).unwrap_or_default();
    if hex == hex.to_lowercase() || hex == hex.to_uppercase() {
        return true;
    }
    let hash = keccak(hex.to_lowercase().as_bytes());
    hex.chars().enumerate().all(|(i, c)| {
        if c.is_ascii_digit() {
            return true;
        }
        let byte = hash.get(i / 2).copied().unwrap_or_default();
        let nibble = if i % 2 == 0 { byte >> 4 } else { byte & 0x0f };
        (nibble >= 8) == c.is_ascii_uppercase()
    })
}

/// `lookalikeOf`: the first saved entry `r` shows like (`0x` and four characters, then the last four, any case) but is
/// not; none when `r` is already in the book or not an EVM address.
pub fn lookalike_of<'a>(r: &str, saved: &'a [Destination]) -> Option<&'a Destination> {
    let address = js_trim(r).to_lowercase();
    if !is_evm_address_ref(&address) {
        return None;
    }
    if saved
        .iter()
        .any(|row| js_trim(&row.r#ref).to_lowercase() == address)
    {
        return None;
    }
    let shown = |v: &str| {
        format!(
            "{}{}",
            v.get(..6).unwrap_or(v),
            v.get(v.len().saturating_sub(4)..).unwrap_or(v)
        )
    };
    saved.iter().find(|row| {
        let other = js_trim(&row.r#ref).to_lowercase();
        is_evm_address_ref(&other) && other != address && shown(&other) == shown(&address)
    })
}

/// `asKind`.
pub fn as_kind(kind: &str) -> Result<&'static str, Refusal> {
    match js_trim(kind) {
        "crypto" => Ok("crypto"),
        "bank" => Ok("bank"),
        t => Err(invalid(format!(
            "Withdraw destination kind must be crypto (EVM) or bank (IBAN/IFSC), got '{t}'"
        ))),
    }
}

/// `ref.slice(0, n)` in UTF-16 units.
fn js_slice_to(s: &str, n: usize) -> String {
    String::from_utf16_lossy(&s.encode_utf16().take(n).collect::<Vec<_>>())
}

/// `assertPersistableWithdrawDestination`: the kind and the address's shape (and an EVM address's checksum).
pub fn assert_persistable(kind: &str, r: &str) -> Result<(&'static str, String), Refusal> {
    let kind = as_kind(kind)?;
    let r = js_trim(r);
    if r.is_empty() {
        return Err(invalid("Withdraw destination requires a non-empty ref"));
    }
    if kind == "crypto" {
        if !is_evm_address_ref(r) {
            let more = if js_len(r) > 24 { "…" } else { "" };
            return Err(invalid(format!(
                "Crypto withdraw dest must be a 20-byte EVM address (0x + 40 hex), got '{}{more}'",
                js_slice_to(r, 24)
            )));
        }
        if !evm_checksum_matches(r) {
            return Err(refuse(
                "bank.address_checksum_mismatch",
                "This address's upper and lower case letters do not match its checksum, so a character may have been changed. Copy it again from where it came from",
            ));
        }
        return Ok((kind, r.to_owned()));
    }
    if !is_bank_destination_ref(r) {
        return Err(invalid(
            "Bank withdraw dest must be a structural IBAN (mod-97) or IFSC (11-char India scheme).",
        ));
    }
    Ok((kind, r.to_owned()))
}

/// `MISSING`.
pub fn missing(user_id: &str, what: &str) -> Refusal {
    refuse(
        "bank.withdraw_destination_missing",
        format!("User {user_id} has no persisted withdraw destination {what}"),
    )
}

fn label_taken() -> Refusal {
    refuse(
        "bank.destination_label_taken",
        "You already have a saved address with this name",
    )
}

fn book_full(cap: i64) -> Refusal {
    refuse(
        "bank.address_book_full",
        format!("Your address book is full at {cap} addresses. Remove one to save a new one"),
    )
}

fn not_uuid() -> Refusal {
    invalid("destinationId must be a uuid")
}

fn ms(col: &str) -> String {
    format!("floor(extract(epoch from {col}) * 1000)::int8")
}

/// The columns every read selects, in [`from_row`]'s order.
fn cols() -> String {
    format!(
        "destination_id::text, user_id, kind, ref, label, asset_id, network, tag, origin, state, {}, {}, \
         lookalike_of::text, {}, {}, approved_by",
        ms("created_at"),
        ms("updated_at"),
        ms("lookalike_confirmed_at"),
        ms("approved_at")
    )
}

/// `toDestination`.
fn from_row(r: &Row) -> Result<Destination, Refusal> {
    let s = |i: usize| r.try_get::<_, String>(i).map_err(|e| pg(&e));
    let o = |i: usize| r.try_get::<_, Option<String>>(i).map_err(|e| pg(&e));
    let t = |i: usize| {
        r.try_get::<_, Option<i64>>(i)
            .map(|v| v.map(Instant))
            .map_err(|e| pg(&e))
    };
    let state = s(9)?;
    let approved_by = o(15)?.filter(|b| b == "link" || b == "device");
    Ok(Destination {
        destination_id: s(0)?,
        user_id: s(1)?,
        kind: as_kind(&s(2)?)?.to_owned(),
        r#ref: s(3)?,
        label: o(4)?,
        asset_id: o(5)?,
        network: o(6)?,
        tag: o(7)?,
        origin: if s(8)? == "customer" {
            "customer".to_owned()
        } else {
            "legacy".to_owned()
        },
        state: if STATES.contains(&state.as_str()) {
            state
        } else {
            "blocked".to_owned()
        },
        added_at: t(10)?.unwrap_or(Instant(0)),
        updated_at: t(11)?.unwrap_or(Instant(0)),
        lookalike_of: o(12)?,
        lookalike_confirmed_at: t(13)?,
        approved_at: t(14)?,
        approved_by,
    })
}

fn unique_violation(e: &postgres::Error, suffix: &str) -> bool {
    e.as_db_error().is_some_and(|d| {
        d.code().code() == "23505" && d.constraint().unwrap_or_default().ends_with(suffix)
    })
}

/// `@intafaced/db`'s `transaction`: serializable, retried up to five times on a serialization failure or deadlock.
pub fn serializable<T>(
    store: &Store,
    mut f: impl FnMut(&mut Transaction<'_>) -> Result<T, Refusal>,
) -> Result<T, Refusal> {
    let retryable = |r: &Refusal| matches!(r, Refusal::Other(m) if m.ends_with("[40001]") || m.ends_with("[40P01]"));
    let mut attempt = 1;
    loop {
        let out = (|| {
            let mut conn = store.pool().map_err(db)?.get().map_err(db)?;
            let client = conn.client().map_err(db)?;
            let mut tx = client
                .build_transaction()
                .isolation_level(IsolationLevel::Serializable)
                .start()
                .map_err(|e| pg(&e))?;
            let out = f(&mut tx)?;
            tx.commit().map_err(|e| pg(&e))?;
            Ok(out)
        })();
        match out {
            Err(r) if attempt < 5 && retryable(&r) => attempt += 1,
            other => return other,
        }
    }
}

fn book_lock(c: &mut impl GenericClient, user_id: &str) -> Result<(), Refusal> {
    c.execute(
        "SELECT pg_advisory_xact_lock(hashtext($1))",
        &[&format!("withdraw-address-book:{user_id}")],
    )
    .map(|_| ())
    .map_err(|e| pg(&e))
}

/// `UserWithdrawDestinationStore.persist`: the legacy slot, one address per kind, overwritten by the next. Takes the
/// customer's address-book lock, the one `save` takes, in its own transaction (a savepoint inside the caller's).
/// `cap_raw` is not read: the legacy slot is not counted against the book's cap.
pub fn persist(
    c: &mut impl GenericClient,
    _cap_raw: Option<&str>,
    user_id: &str,
    kind: &str,
    r: &str,
    label: Option<&str>,
) -> Result<Destination, Refusal> {
    let (kind, r) = assert_persistable(kind, r)?;
    let label = label.map(assert_label).transpose()?;
    let keep_label = label.is_none();
    let mut tx = c.transaction().map_err(|e| pg(&e))?;
    book_lock(&mut tx, user_id)?;
    let rows = tx.query(
        &format!(
            "INSERT INTO bank.user_withdraw_destinations (user_id, kind, ref, label, origin) \
             VALUES ($1, $2, $3, $4, 'legacy') \
             ON CONFLICT (user_id, kind) WHERE origin = 'legacy' \
             DO UPDATE SET ref = excluded.ref, \
               label = CASE WHEN $5 THEN bank.user_withdraw_destinations.label ELSE excluded.label END, \
               updated_at = now() \
             RETURNING {}",
            cols()
        ),
        &[&user_id, &kind, &r, &label, &keep_label],
    );
    let rows = match rows {
        Ok(rows) => rows,
        Err(e) if unique_violation(&e, "user_withdraw_destinations_label_idx") => {
            return Err(label_taken());
        }
        Err(e) => return Err(pg(&e)),
    };
    let row = rows
        .first()
        .ok_or_else(|| Refusal::Other("withdraw destination upsert returned no row".to_owned()))
        .and_then(from_row)?;
    tx.commit().map_err(|e| pg(&e))?;
    Ok(row)
}

/// `UserWithdrawDestinationStore.require`: the legacy slot of this kind only; a saved book entry is never picked.
pub fn require(
    c: &mut impl GenericClient,
    user_id: &str,
    kind: &str,
) -> Result<Destination, Refusal> {
    let kind = as_kind(kind)?;
    let rows = c
        .query(
            &format!(
                "SELECT {} FROM bank.user_withdraw_destinations \
                 WHERE user_id = $1 AND kind = $2 AND origin = 'legacy'",
                cols()
            ),
            &[&user_id, &kind],
        )
        .map_err(|e| pg(&e))?;
    match rows.first() {
        Some(r) => from_row(r),
        None => Err(missing(user_id, &format!("for kind {kind}"))),
    }
}

/// `UserWithdrawDestinationStore.list`: every entry of the customer's, oldest first.
pub fn list(c: &mut impl GenericClient, user_id: &str) -> Result<Vec<Destination>, Refusal> {
    c.query(
        &format!(
            "SELECT {} FROM bank.user_withdraw_destinations WHERE user_id = $1 \
             ORDER BY created_at ASC, destination_id ASC",
            cols()
        ),
        &[&user_id],
    )
    .map_err(|e| pg(&e))?
    .iter()
    .map(from_row)
    .collect()
}

/// `UserWithdrawDestinationStore.save`: the same (asset, network, address, tag) again returns the stored entry; a new
/// one is saved `pending` within the owner's cap and with a label the customer has not used.
pub fn save(
    store: &Store,
    cap_raw: Option<&str>,
    input: &SaveInput<'_>,
) -> Result<Destination, Refusal> {
    let entry = assert_book_entry(input)?;
    let saved_on = assert_saved_on(&input.saved_on)?;
    let cap = require_address_book_cap(cap_raw)?;
    let user_id = input.user_id;
    serializable(store, |tx| {
        book_lock(tx, user_id)?;
        let same = tx
            .query(
                &format!(
                    "SELECT {} FROM bank.user_withdraw_destinations \
                     WHERE user_id = $1 AND origin = 'customer' AND kind = 'crypto' \
                       AND asset_id = $2 AND network = $3 \
                       AND lower(ref) = lower($4) AND coalesce(tag, '') = $5",
                    cols()
                ),
                &[
                    &user_id,
                    &entry.asset_id,
                    &entry.network,
                    &entry.r#ref,
                    &entry.tag.clone().unwrap_or_default(),
                ],
            )
            .map_err(|e| pg(&e))?;
        if let Some(r) = same.first() {
            return from_row(r);
        }
        let n: i64 = tx
            .query_one(
                "SELECT count(*)::int8 FROM bank.user_withdraw_destinations \
                 WHERE user_id = $1 AND origin = 'customer'",
                &[&user_id],
            )
            .and_then(|r| r.try_get(0))
            .map_err(|e| pg(&e))?;
        if n >= cap {
            return Err(book_full(cap));
        }
        let rows = tx.query(
            &format!(
                "INSERT INTO bank.user_withdraw_destinations \
                   (user_id, kind, ref, label, asset_id, network, tag, origin, state, lookalike_of, \
                    lookalike_confirmed_at, saved_fam, saved_dev) \
                 VALUES ($1, 'crypto', $2, $3, $4, $5, $6, 'customer', 'pending', $7::text::uuid, \
                   CASE WHEN $7::text::uuid IS NULL THEN NULL ELSE now() END, $8::text::uuid, $9::text::uuid) \
                 RETURNING {}",
                cols()
            ),
            &[
                &user_id,
                &entry.r#ref,
                &entry.label,
                &entry.asset_id,
                &entry.network,
                &entry.tag,
                &entry.lookalike_of,
                &saved_on.fam,
                &saved_on.dev,
            ],
        );
        match rows {
            Ok(rows) => rows
                .first()
                .ok_or_else(|| Refusal::Other("the saved address returned no row".to_owned()))
                .and_then(from_row),
            Err(e) if unique_violation(&e, "label_idx") => Err(label_taken()),
            Err(e) => Err(pg(&e)),
        }
    })
}

/// `UserWithdrawDestinationStore.rename`: changes only the label; `updated_at` (the cooling clock) stays.
pub fn rename(
    c: &mut impl GenericClient,
    user_id: &str,
    destination_id: &str,
    label: &str,
) -> Result<Destination, Refusal> {
    let label = assert_label(label)?;
    let id = js_trim(destination_id);
    if !is_uuid(id) {
        return Err(not_uuid());
    }
    let rows = c.query(
        &format!(
            "UPDATE bank.user_withdraw_destinations SET label = $1 \
             WHERE user_id = $2 AND destination_id = $3::text::uuid RETURNING {}",
            cols()
        ),
        &[&label, &user_id, &id],
    );
    match rows {
        Ok(rows) => match rows.first() {
            Some(r) => from_row(r),
            None => Err(missing(user_id, destination_id)),
        },
        Err(e) if unique_violation(&e, "label_idx") => Err(label_taken()),
        Err(e) => Err(pg(&e)),
    }
}

/// `UserWithdrawDestinationStore.remove`: `idempotency_key` replays the same removal; another entry under the same key
/// refuses `bank.ramp_conflict`.
pub fn remove(
    store: &Store,
    user_id: &str,
    destination_id: &str,
    idempotency_key: &str,
) -> Result<String, Refusal> {
    let id = js_trim(destination_id).to_owned();
    let key = js_trim(idempotency_key).to_owned();
    if !is_uuid(&id) {
        return Err(not_uuid());
    }
    if key.is_empty() || js_len(&key) > 128 {
        return Err(invalid("Destination removal needs an idempotency key"));
    }
    serializable(store, |tx| {
        let prior = tx
            .query(
                "SELECT destination_id::text FROM bank.withdraw_destination_removals \
                 WHERE user_id = $1 AND idempotency_key = $2 FOR UPDATE",
                &[&user_id, &key],
            )
            .map_err(|e| pg(&e))?;
        if let Some(p) = prior.first() {
            let was: String = p.try_get(0).map_err(|e| pg(&e))?;
            if was != id {
                return Err(refuse(
                    "bank.ramp_conflict",
                    "Idempotency key was already used for a different destination",
                ));
            }
            return Ok(id.clone());
        }
        let deleted = tx
            .query(
                "DELETE FROM bank.user_withdraw_destinations \
                 WHERE user_id = $1 AND destination_id = $2::text::uuid RETURNING destination_id",
                &[&user_id, &id],
            )
            .map_err(|e| pg(&e))?;
        if deleted.is_empty() {
            return Err(missing(user_id, &id));
        }
        tx.execute(
            "INSERT INTO bank.withdraw_destination_removals (user_id, idempotency_key, destination_id) \
             VALUES ($1, $2, $3::text::uuid)",
            &[&user_id, &key, &id],
        )
        .map_err(|e| pg(&e))?;
        Ok(id.clone())
    })
}

/// `UserWithdrawDestinationStore.approve`: a `pending` entry becomes `cooling`, its cooling-off starting now; one
/// approved already is answered unchanged.
pub fn approve(
    c: &mut impl GenericClient,
    user_id: &str,
    destination_id: &str,
    by: &str,
) -> Result<Destination, Refusal> {
    let id = js_trim(destination_id);
    if !is_uuid(id) {
        return Err(not_uuid());
    }
    let rows = c
        .query(
            &format!(
                "UPDATE bank.user_withdraw_destinations \
                    SET state = 'cooling', approved_at = now(), approved_by = $3, updated_at = now() \
                  WHERE user_id = $1 AND destination_id = $2::text::uuid AND state = 'pending' \
                 RETURNING {}",
                cols()
            ),
            &[&user_id, &id, &by],
        )
        .map_err(|e| pg(&e))?;
    if let Some(r) = rows.first() {
        return from_row(r);
    }
    let current = c
        .query(
            &format!(
                "SELECT {} FROM bank.user_withdraw_destinations \
                 WHERE user_id = $1 AND destination_id = $2::text::uuid",
                cols()
            ),
            &[&user_id, &id],
        )
        .map_err(|e| pg(&e))?;
    match current.first() {
        Some(r) => from_row(r),
        None => Err(missing(user_id, id)),
    }
}

/// `UserWithdrawDestinationStore.savedOn`: the sign-in and device the entry was saved from, or none when the customer
/// has no such entry.
pub fn saved_on(
    c: &mut impl GenericClient,
    user_id: &str,
    destination_id: &str,
) -> Result<Option<SavedOn>, Refusal> {
    let id = js_trim(destination_id);
    if !is_uuid(id) {
        return Ok(None);
    }
    let rows = c
        .query(
            "SELECT saved_fam::text, saved_dev::text FROM bank.user_withdraw_destinations \
             WHERE user_id = $1 AND destination_id = $2::text::uuid",
            &[&user_id, &id],
        )
        .map_err(|e| pg(&e))?;
    rows.first()
        .map(|r| {
            Ok(SavedOn {
                fam: r.try_get(0).map_err(|e| pg(&e))?,
                dev: r.try_get(1).map_err(|e| pg(&e))?,
            })
        })
        .transpose()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn eip55_checksums_are_read_as_the_typescript_reads_them() {
        assert!(evm_checksum_matches(
            "0x52908400098527886E0F7030069857D2E4169EE7"
        ));
        assert!(evm_checksum_matches(
            "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed"
        ));
        assert!(!evm_checksum_matches(
            "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAeD"
        ));
        assert!(evm_checksum_matches(
            "0x5aaeb6053f3e94c9b9a09f33669435e7ef1beaed"
        ));
    }

    #[test]
    fn ids_and_owner_numbers_are_read_as_the_typescript_reads_them() {
        assert!(is_uuid("22222222-2222-4222-8222-222222222222"));
        assert!(!is_uuid("22222222-2222-0222-8222-222222222222"));
        assert!(is_guid("22222222-2222-0222-0222-222222222222"));
        assert_eq!(require_address_book_cap(Some(" 20 ")).ok(), Some(20));
        assert!(require_address_book_cap(Some("0")).is_err());
        assert!(require_address_book_cap(Some("1234567")).is_err());
        assert!(require_address_book_cap(None).is_err());
    }
}
