//! Private-wallet ownership proof (`ramps/wallet-ownership.ts`, W-withdraw-17): the customer proves they control a saved
//! address by signing a message with its key (EIP-191 `personal_sign`). Nothing is paid out to prove anything.
//!
//! `start` offers a message naming the address, a proof id and when the offer lapses (the owner's
//! `BANK_WALLET_PROOF_WINDOW_MINUTES`); `verify` recovers the signer and marks the proof verified for the owner's
//! `BANK_WALLET_PROOF_VALID_DAYS`. Another signer is refused by name and the offer stays open. Blank window or validity
//! refuses with its own `_unset` code.

use k256::ecdsa::{RecoveryId, Signature, VerifyingKey};
use postgres::{GenericClient, Row};
use service_kit::approvals::random_uuid;
use service_kit::json::Json;
use service_kit::time::Instant;

use crate::db::Store;
use crate::errors::Refusal;
use crate::partner::refuse;
use crate::ramps::refs::{is_evm_address_ref, js_trim};
use crate::spaces::space::{at, pg, with};

use super::store::{self, is_uuid, keccak, positive_digits};

/// `WalletProofRow`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Proof {
    pub id: String,
    pub user_id: String,
    pub destination_id: String,
    /// The saved address, lower-case, as it was when the proof started.
    pub address: String,
    pub message: String,
    /// `pending` or `verified`.
    pub status: String,
    pub expires_at: Instant,
    pub verified_at: Option<Instant>,
    pub valid_until: Option<Instant>,
    pub signature: Option<String>,
}

/// `EntryProofs`: an entry's newest offer still `pending` and newest `verified` proof.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct EntryProofs {
    pub pending: Option<Proof>,
    pub verified: Option<Proof>,
}

/// `Ownership`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Ownership {
    pub state: &'static str,
    pub verified_at: Option<String>,
    pub valid_until: Option<String>,
    pub offer_expires_at: Option<String>,
}

impl Ownership {
    pub fn fields(&self) -> Vec<(String, Json)> {
        let opt = |s: &Option<String>| s.clone().map_or(Json::Null, Json::str);
        vec![
            ("state".to_owned(), Json::str(self.state)),
            ("verifiedAt".to_owned(), opt(&self.verified_at)),
            ("validUntil".to_owned(), opt(&self.valid_until)),
            ("offerExpiresAt".to_owned(), opt(&self.offer_expires_at)),
        ]
    }

    pub fn json(&self) -> Json {
        Json::Object(self.fields())
    }
}

/// `ownershipOf`: a still-valid verified proof wins over any newer offer; then an open offer; then whatever lapsed. Given
/// the entry's address now, a proof made for another address is ignored.
pub fn ownership_of(
    proofs: Option<&EntryProofs>,
    now: Instant,
    address: Option<&str>,
) -> Ownership {
    let wanted = address.map(|a| js_trim(a).to_lowercase());
    let for_address = |row: Option<&Proof>| {
        row.filter(|r| wanted.as_ref().is_none_or(|w| r.address == *w))
            .cloned()
    };
    let verified = for_address(proofs.and_then(|p| p.verified.as_ref()));
    let pending = for_address(proofs.and_then(|p| p.pending.as_ref()));
    let (verified_at, valid_until) = verified.as_ref().map_or((None, None), |v| {
        (
            v.verified_at.map(Instant::iso),
            v.valid_until.map(Instant::iso),
        )
    });
    if let Some(v) = &verified
        && v.valid_until.is_some_and(|u| u.0 > now.0)
    {
        return Ownership {
            state: "verified",
            verified_at,
            valid_until,
            offer_expires_at: None,
        };
    }
    if let Some(p) = &pending
        && p.expires_at.0 > now.0
    {
        return Ownership {
            state: "pending",
            verified_at,
            valid_until,
            offer_expires_at: Some(p.expires_at.iso()),
        };
    }
    if verified.is_some() || pending.is_some() {
        return Ownership {
            state: "expired",
            verified_at,
            valid_until,
            offer_expires_at: pending.map(|p| p.expires_at.iso()),
        };
    }
    Ownership {
        state: "none",
        verified_at: None,
        valid_until: None,
        offer_expires_at: None,
    }
}

/// The EIP-191 digest a wallet signs for `personal_sign`.
fn personal_message_hash(message: &str) -> [u8; 32] {
    let body = message.as_bytes();
    let mut joined = format!("\x19Ethereum Signed Message:\n{}", body.len()).into_bytes();
    joined.extend_from_slice(body);
    keccak(&joined)
}

fn hex_bytes(s: &str) -> Option<Vec<u8>> {
    (0..s.len())
        .step_by(2)
        .map(|i| s.get(i..i + 2).and_then(|h| u8::from_str_radix(h, 16).ok()))
        .collect()
}

/// `recoverPersonalSignAddress`: the address that signed `message` (a 65-byte `r || s || v`, `v` 27/28 or 0/1),
/// lower-case, or none when the signature is not one. A high `s` recovers the same key as its low twin, as the
/// TypeScript's library recovers it.
pub fn recover_personal_sign_address(message: &str, signature: &str) -> Option<String> {
    let sig = js_trim(signature);
    let hex = sig.strip_prefix("0x")?;
    if hex.len() != 130 || !hex.bytes().all(|b| b.is_ascii_hexdigit()) {
        return None;
    }
    let bytes = hex_bytes(hex)?;
    let v = *bytes.get(64)?;
    let bit = if v >= 27 { v - 27 } else { v };
    if bit > 1 {
        return None;
    }
    let mut signature = Signature::from_slice(bytes.get(..64)?).ok()?;
    let mut parity = bit == 1;
    let low = signature.normalize_s();
    if low.to_bytes() != signature.to_bytes() {
        signature = low;
        parity = !parity;
    }
    let id = RecoveryId::new(parity, false);
    let key =
        VerifyingKey::recover_from_prehash(&personal_message_hash(message), &signature, id).ok()?;
    let point = key.to_sec1_point(false);
    let hash = keccak(point.as_bytes().get(1..)?);
    Some(format!(
        "0x{}",
        hash.get(12..)?
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect::<String>()
    ))
}

fn short(address: &str) -> String {
    format!(
        "{}…{}",
        address.get(..6).unwrap_or(address),
        address
            .get(address.len().saturating_sub(4)..)
            .unwrap_or(address)
    )
}

/// `proofMessage`: the exact text the customer signs.
pub fn proof_message(address: &str, proof_id: &str, expires_at: Instant) -> String {
    [
        "INTAFACED wallet ownership proof".to_owned(),
        format!("Address: {address}"),
        format!("Proof: {proof_id}"),
        format!("Sign before: {}", expires_at.iso()),
        "Signing this proves you control this address. It moves no funds and approves nothing else.".to_owned(),
    ]
    .join("\n")
}

fn require_positive(raw: Option<&str>, env: &str, code: &str) -> Result<i64, Refusal> {
    positive_digits(raw, 6).ok_or_else(|| {
        refuse(
            code,
            format!("{env} is unset or not a positive whole number, so a wallet proof refuses rather than inventing one"),
        )
    })
}

fn window(raw: Option<&str>) -> Result<i64, Refusal> {
    require_positive(
        raw,
        "BANK_WALLET_PROOF_WINDOW_MINUTES",
        "bank.wallet_proof_window_unset",
    )
}

fn validity(raw: Option<&str>) -> Result<i64, Refusal> {
    require_positive(
        raw,
        "BANK_WALLET_PROOF_VALID_DAYS",
        "bank.wallet_proof_validity_unset",
    )
}

fn not_found() -> Refusal {
    refuse(
        "bank.wallet_proof_not_found",
        "That wallet proof could not be found. Start a new one",
    )
}

fn lapsed() -> Refusal {
    refuse(
        "bank.wallet_proof_expired",
        "This proof expired before it was signed. Start a new one",
    )
}

fn cols() -> &'static str {
    "id::text, user_id, destination_id::text, address, message, status, \
     floor(extract(epoch from expires_at) * 1000)::int8, \
     floor(extract(epoch from verified_at) * 1000)::int8, \
     floor(extract(epoch from valid_until) * 1000)::int8, signature"
}

fn proof_of(r: &Row) -> Result<Proof, Refusal> {
    let t = |i: usize| {
        r.try_get::<_, Option<i64>>(i)
            .map(|v| v.map(Instant))
            .map_err(|e| pg(&e))
    };
    Ok(Proof {
        id: r.try_get(0).map_err(|e| pg(&e))?,
        user_id: r.try_get(1).map_err(|e| pg(&e))?,
        destination_id: r.try_get(2).map_err(|e| pg(&e))?,
        address: r.try_get(3).map_err(|e| pg(&e))?,
        message: r.try_get(4).map_err(|e| pg(&e))?,
        status: r.try_get(5).map_err(|e| pg(&e))?,
        expires_at: t(6)?.unwrap_or(Instant(0)),
        verified_at: t(7)?,
        valid_until: t(8)?,
        signature: r.try_get(9).map_err(|e| pg(&e))?,
    })
}

/// `latest`: per entry of the customer's, the newest pending offer and the newest verified proof.
pub fn latest(
    c: &mut impl GenericClient,
    user_id: &str,
) -> Result<Vec<(String, EntryProofs)>, Refusal> {
    let rows = c
        .query(
            &format!(
                "SELECT DISTINCT ON (destination_id, status) {} FROM bank.wallet_ownership_proofs \
                 WHERE user_id = $1 ORDER BY destination_id, status, seq DESC",
                cols()
            ),
            &[&user_id],
        )
        .map_err(|e| pg(&e))?;
    let mut out: Vec<(String, EntryProofs)> = Vec::new();
    for r in &rows {
        let p = proof_of(r)?;
        let idx = match out.iter().position(|(d, _)| *d == p.destination_id) {
            Some(i) => i,
            None => {
                out.push((p.destination_id.clone(), EntryProofs::default()));
                out.len() - 1
            }
        };
        if let Some((_, entry)) = out.get_mut(idx) {
            if p.status == "verified" {
                entry.verified = Some(p);
            } else {
                entry.pending = Some(p);
            }
        }
    }
    Ok(out)
}

/// One entry's proofs out of [`latest`].
pub fn of<'a>(
    latest: &'a [(String, EntryProofs)],
    destination_id: &str,
) -> Option<&'a EntryProofs> {
    latest
        .iter()
        .find(|(d, _)| d == destination_id)
        .map(|(_, p)| p)
}

/// `startWalletProof`'s answer.
pub struct Started {
    pub proof_id: String,
    pub destination_id: String,
    pub message: String,
    pub expires_at: Instant,
}

/// `startWalletProof`: offer a message to sign for one of the customer's own saved crypto addresses; an offer still
/// open for the entry is answered again.
pub fn start(
    store: &Store,
    window_raw: Option<&str>,
    validity_raw: Option<&str>,
    user_id: &str,
    destination_id: &str,
    now: Instant,
) -> Result<Started, Refusal> {
    let minutes = window(window_raw)?;
    validity(validity_raw)?;
    let entry = with(store, |c| store::list(c, user_id))?
        .into_iter()
        .find(|r| r.destination_id == destination_id)
        .filter(|e| e.origin == "customer" && e.kind == "crypto" && is_evm_address_ref(&e.r#ref))
        .ok_or_else(|| {
            refuse(
                "bank.wallet_proof_not_found",
                "Only a wallet address saved in your address book can be proved",
            )
        })?;
    let address = js_trim(&entry.r#ref).to_lowercase();
    let proofs = with(store, |c| latest(c, user_id))?;
    if let Some(open) = of(&proofs, &entry.destination_id).and_then(|p| p.pending.as_ref())
        && open.expires_at.0 > now.0
        && open.address == address
    {
        return Ok(Started {
            proof_id: open.id.clone(),
            destination_id: open.destination_id.clone(),
            message: open.message.clone(),
            expires_at: open.expires_at,
        });
    }
    let id = random_uuid().map_err(Refusal::Other)?;
    let expires_at = Instant(now.0 + minutes * 60_000);
    let message = proof_message(&address, &id, expires_at);
    let row = with(store, |c| {
        c.query_one(
            &format!(
                "INSERT INTO bank.wallet_ownership_proofs \
                   (id, user_id, destination_id, address, message, status, created_at, expires_at) \
                 VALUES ($1::text::uuid, $2, $3::text::uuid, $4, $5, 'pending', {}, {}) RETURNING {}",
                at("$6"),
                at("$7"),
                cols()
            ),
            &[
                &id,
                &user_id,
                &entry.destination_id,
                &address,
                &message,
                &now.0,
                &expires_at.0,
            ],
        )
        .map_err(|e| pg(&e))
        .and_then(|r| proof_of(&r))
    })?;
    Ok(Started {
        proof_id: row.id,
        destination_id: row.destination_id,
        message: row.message,
        expires_at: row.expires_at,
    })
}

fn get(
    c: &mut impl GenericClient,
    user_id: &str,
    proof_id: &str,
) -> Result<Option<Proof>, Refusal> {
    if !is_uuid(proof_id) {
        return Ok(None);
    }
    let rows = c
        .query(
            &format!(
                "SELECT {} FROM bank.wallet_ownership_proofs WHERE id = $1::text::uuid AND user_id = $2",
                cols()
            ),
            &[&proof_id, &user_id],
        )
        .map_err(|e| pg(&e))?;
    rows.first().map(proof_of).transpose()
}

/// `verifyWalletProof`: check a signature for an open offer. The saved address must have signed it.
pub fn verify(
    store: &Store,
    validity_raw: Option<&str>,
    user_id: &str,
    proof_id: &str,
    signature: &str,
    clock: &dyn Fn() -> Instant,
) -> Result<(Proof, Ownership), Refusal> {
    let row = with(store, |c| get(c, user_id, proof_id))?.ok_or_else(not_found)?;
    let sent = js_trim(signature).to_lowercase();
    if row.status == "verified" {
        if row.signature.as_deref() == Some(sent.as_str()) {
            let own = ownership_of(
                Some(&EntryProofs {
                    pending: None,
                    verified: Some(row.clone()),
                }),
                clock(),
                None,
            );
            return Ok((row, own));
        }
        return Err(refuse(
            "bank.wallet_proof_conflict",
            "This proof is already complete. Start a new one to prove the address again",
        ));
    }
    if row.expires_at.0 <= clock().0 {
        return Err(lapsed());
    }
    let entry = with(store, |c| store::list(c, user_id))?
        .into_iter()
        .find(|e| e.destination_id == row.destination_id);
    if entry.is_none_or(|e| js_trim(&e.r#ref).to_lowercase() != row.address) {
        return Err(not_found());
    }
    let Some(signer) = recover_personal_sign_address(&row.message, signature) else {
        return Err(refuse(
            "bank.wallet_proof_signature_invalid",
            "That is not a signature of the message. Paste the whole signature your wallet gave you",
        ));
    };
    if signer != row.address {
        return Err(refuse(
            "bank.wallet_proof_wrong_signer",
            format!(
                "This was signed by another address ({}). Sign with the wallet that holds {}",
                short(&signer),
                short(&row.address)
            ),
        ));
    }
    let days = validity(validity_raw)?;
    // The clock is read after the lookups, and the proof is marked only while the offer is still open at that time, so a
    // signature never lands after the "Sign before" the message promised.
    let now = clock();
    let valid_until = Instant(now.0 + days * 86_400_000);
    let done = with(store, |c| {
        c.query(
            &format!(
                "UPDATE bank.wallet_ownership_proofs \
                    SET status = 'verified', signature = $3, verified_at = {}, valid_until = {} \
                  WHERE id = $1::text::uuid AND user_id = $2 AND status = 'pending' AND expires_at > {} \
                 RETURNING {}",
                at("$4"),
                at("$5"),
                at("$4"),
                cols()
            ),
            &[&row.id, &user_id, &sent, &now.0, &valid_until.0],
        )
        .map_err(|e| pg(&e))?
        .first()
        .map(proof_of)
        .transpose()
    })?;
    let Some(done) = done else {
        if row.expires_at.0 <= now.0 {
            return Err(lapsed());
        }
        return Err(refuse(
            "bank.wallet_proof_conflict",
            "This proof changed while it was checked. Refresh and try again",
        ));
    };
    let own = ownership_of(
        Some(&EntryProofs {
            pending: None,
            verified: Some(done.clone()),
        }),
        now,
        None,
    );
    Ok((done, own))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_signature_that_is_not_one_recovers_nobody() {
        assert_eq!(recover_personal_sign_address("m", "0x12"), None);
        let zero = format!("0x{}", "0".repeat(130));
        assert_eq!(recover_personal_sign_address("m", &zero), None);
    }

    fn hex(bytes: &[u8]) -> String {
        format!(
            "0x{}",
            bytes.iter().map(|b| format!("{b:02x}")).collect::<String>()
        )
    }

    #[test]
    #[allow(clippy::unwrap_used, reason = "a test")]
    fn the_signer_and_its_high_s_twin_recover_the_same_wallet() {
        // The well-known development key and its wallet.
        let key =
            hex_bytes("ac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80").unwrap();
        let key = k256::ecdsa::SigningKey::from_slice(&key).unwrap();
        let wallet = "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266";
        let (sig, id) = key.sign_prehash_recoverable(&personal_message_hash("hello"));
        let mut low = sig.to_bytes().to_vec();
        low.push(id.to_byte() + 27);
        assert_eq!(
            recover_personal_sign_address("hello", &hex(&low)).as_deref(),
            Some(wallet)
        );
        assert_ne!(
            recover_personal_sign_address("other", &hex(&low)).as_deref(),
            Some(wallet)
        );
        let (r, s) = sig.split_scalars();
        let mut high = Signature::from_scalars(r, -*s).unwrap().to_bytes().to_vec();
        high.push(if id.is_y_odd() { 27 } else { 28 });
        assert_eq!(
            recover_personal_sign_address("hello", &hex(&high)).as_deref(),
            Some(wallet)
        );
    }
}
