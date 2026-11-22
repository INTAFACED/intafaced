//! Card details, PIN and phone wallets (J-bank-14 #3, #4; `card-service.ts`' `assertSecretIssuer`, `assertPinDigits`,
//! `reveal`, `revealPin`, `setPin`, `walletProvision`, `walletTokens`, `secretsOffered`, `rewards`, and the router's
//! `cards.reveal`, `cards.pin.*`, `cards.walletProvision`, `cards.secretsOffered`, `cards.walletTokens`,
//! `cards.rewards`).
//!
//! No live issuer exists: the only issuer that answers a secret is the TEST partner's simulator with `secrets: "test"`,
//! and every answer it gives says TEST. A secret is never written: the audit row (`card_secret_audits`) names the reveal,
//! the PIN change or the wallet add, keyed by the caller's id, and never what was shown. A phone wallet keeps one token
//! row per card and wallet (`card_wallet_tokens`), never its payload.

use service_kit::edge::Principal;
use service_kit::json::Json;
use service_kit::money::{Amount, format_amount, parse_amount};
use service_kit::time::Instant;

use super::core::{opt_text, text};
use super::step_up as gate;
use super::{Card, Deps, ms, own, owned_card};
use crate::door::Ctx;
use crate::errors::Refusal;
use crate::partner::refuse;
use crate::spaces::space::{pg, with};

/// `SECRET_TTL_MS`: when the caller should drop what it was shown.
pub const SECRET_TTL_MS: i64 = 60_000;

const PAN_UNSET: &str = "No live card issuer can return a card number. The missing piece is socket.live-issuer (a card-scheme sponsor and an issuing BIN). This service will not invent a number, expiry, or security code.";
const PIN_UNSET: &str = "No live card issuer can view or set a PIN. The missing piece is socket.live-issuer (a card-scheme sponsor and an issuing BIN). This service will not invent a PIN.";
const WALLET_UNSET: &str = "No live card issuer can add this card to a phone wallet. The missing piece is socket.live-issuer (a card-scheme sponsor and an issuing BIN). This service will not invent a provisioning payload.";
const REWARDS_UNSET: &str = "Card rewards are refused. The missing piece is an outside company, the card issuer. A cashback field is not a rewards balance.";

/// The three things a secret call may ask the issuer for.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    Pan,
    Pin,
    Wallet,
}

fn unset(kind: Kind) -> Refusal {
    match kind {
        Kind::Pan => refuse("bank.card_pan_issuer_unset", PAN_UNSET),
        Kind::Pin => refuse("bank.card_pin_issuer_unset", PIN_UNSET),
        Kind::Wallet => refuse("bank.card_wallet_issuer_unset", WALLET_UNSET),
    }
}

/// `liveSecretProgramme`: a live issuer, or the TEST partner adapter whose switches say `secrets: "test"`. No live issuer
/// exists in this crate (the issuer port is `none` or `card-sim`), so only the second is ever true.
pub fn live_secret_programme(d: &Deps<'_>) -> bool {
    let p = d.issuer().programme();
    if d.issuer().test_secrets() && p.id == "card-sim" {
        return true;
    }
    !p.simulated && p.id != "none" && p.id != "card-sim"
}

/// `secretsAreTest`: every answer is the TEST partner's stand-in, so it says TEST.
pub fn secrets_are_test(d: &Deps<'_>) -> bool {
    d.issuer().test_secrets()
}

/// `assertLiveSecret`.
fn assert_live_secret(d: &Deps<'_>, kind: Kind) -> Result<(), Refusal> {
    if live_secret_programme(d) {
        return Ok(());
    }
    Err(unset(kind))
}

/// `assertSecretIssuer(kind, op)`: the module, a live secret programme, then the issuer's method. The router runs it
/// before step-up. Every secret method is present together (`has_secret_methods`).
pub fn assert_secret_issuer(d: &Deps<'_>, kind: Kind) -> Result<(), Refusal> {
    d.assert_module_enabled()?;
    assert_live_secret(d, kind)?;
    if d.issuer().has_secret_methods() {
        return Ok(());
    }
    Err(unset(kind))
}

/// `assertPinDigits`: 4 to 12 ASCII digits (`/^\d{4,12}$/`). The message does not echo the PIN.
pub fn assert_pin_digits(pin: &str) -> Result<(), Refusal> {
    if (4..=12).contains(&pin.len()) && pin.bytes().all(|b| b.is_ascii_digit()) {
        return Ok(());
    }
    Err(refuse(
        "bank.card_pin_invalid",
        "A PIN must be 4 to 12 digits",
    ))
}

/// `commandHash`: sha256 over `key=value` lines, the keys sorted (a private copy of `core`'s).
fn command_hash(fields: &[(&str, &str)]) -> String {
    let mut sorted = fields.to_vec();
    sorted.sort_by(|a, b| a.0.cmp(b.0));
    let canonical = sorted
        .iter()
        .map(|(k, v)| format!("{k}={v}"))
        .collect::<Vec<_>>()
        .join("\n");
    super::issuer::sha256_hex(&canonical)
}

fn command_conflict() -> Refusal {
    refuse(
        "bank.card_command_conflict",
        "This command id was already used for a different card change",
    )
}

/// The audit row `id` names, as `(card_id, kind, payload_hash)`.
fn audit_row(
    c: &mut impl postgres::GenericClient,
    id: &str,
) -> Result<Option<(String, String, String)>, Refusal> {
    Ok(c.query(
        "SELECT card_id::text, kind, payload_hash FROM bank.card_secret_audits WHERE id = $1::text::uuid",
        &[&id],
    )
    .map_err(|e| pg(&e))?
    .first()
    .map(|r| (r.get(0), r.get(1), r.get(2))))
}

/// One audit: what `id` was used for.
pub struct Audit<'a> {
    pub id: &'a str,
    pub card_id: &'a str,
    pub user_id: &'a str,
    /// `pan_reveal`, `pin_reveal`, `pin_set` or `wallet_provision`.
    pub kind: &'a str,
    pub payload_hash: &'a str,
}

impl Audit<'_> {
    fn same(&self, row: &(String, String, String)) -> bool {
        row.0 == self.card_id && row.1 == self.kind && row.2 == self.payload_hash
    }
}

/// `secretAlreadyAudited`: true when `id` already names this change; another change under it refuses.
fn already_audited(d: &Deps<'_>, a: &Audit<'_>) -> Result<bool, Refusal> {
    match with(d.store(), |c| audit_row(c, a.id))? {
        None => Ok(false),
        Some(row) if a.same(&row) => Ok(true),
        Some(_) => Err(command_conflict()),
    }
}

/// `auditSecret`: the row names the call, never the secret. The same id for the same change is one row.
fn audit_secret(d: &Deps<'_>, a: &Audit<'_>) -> Result<(), Refusal> {
    with(d.store(), |c| {
        let inserted = c
            .query(
                "INSERT INTO bank.card_secret_audits (id, card_id, user_id, kind, payload_hash) \
                 VALUES ($1::text::uuid, $2::text::uuid, $3, $4, $5) ON CONFLICT (id) DO NOTHING RETURNING id",
                &[&a.id, &a.card_id, &a.user_id, &a.kind, &a.payload_hash],
            )
            .map_err(|e| pg(&e))?;
        if !inserted.is_empty() {
            return Ok(());
        }
        match audit_row(c, a.id)? {
            Some(row) if a.same(&row) => Ok(()),
            _ => Err(command_conflict()),
        }
    })
}

/// `secretExpiresAt`.
fn expires_at(d: &Deps<'_>) -> String {
    Instant(d.now().0 + SECRET_TTL_MS).iso()
}

/// `reveal`: PAN, expiry and CVV, `(pan, expiry, cvv, expiresAt)`. Not stored; the audit names the reveal.
pub fn reveal(
    d: &Deps<'_>,
    card_id: &str,
    user_id: &str,
    reveal_id: &str,
) -> Result<(String, String, String, String), Refusal> {
    d.assert_module_enabled()?;
    let card = with(d.store(), |c| owned_card(c, card_id, user_id))?;
    assert_live_secret(d, Kind::Pan)?;
    let (pan, expiry, cvv) = d
        .issuer()
        .reveal_credentials(&card.id)
        .ok_or_else(|| unset(Kind::Pan))?;
    audit_secret(
        d,
        &Audit {
            id: reveal_id,
            card_id: &card.id,
            user_id,
            kind: "pan_reveal",
            payload_hash: &command_hash(&[("cardId", &card.id), ("kind", "pan_reveal")]),
        },
    )?;
    Ok((pan, expiry, cvv, expires_at(d)))
}

/// `revealPin`: `(pin, expiresAt)`. A card with no PIN yet refuses `bank.card_pin_not_set` and audits nothing.
pub fn reveal_pin(
    d: &Deps<'_>,
    card_id: &str,
    user_id: &str,
    reveal_id: &str,
) -> Result<(String, String), Refusal> {
    d.assert_module_enabled()?;
    let card = with(d.store(), |c| owned_card(c, card_id, user_id))?;
    assert_live_secret(d, Kind::Pin)?;
    let pin = d
        .issuer()
        .reveal_pin(&card.id)
        .ok_or_else(|| unset(Kind::Pin))??;
    audit_secret(
        d,
        &Audit {
            id: reveal_id,
            card_id: &card.id,
            user_id,
            kind: "pin_reveal",
            payload_hash: &command_hash(&[("cardId", &card.id), ("kind", "pin_reveal")]),
        },
    )?;
    Ok((pin, expires_at(d)))
}

/// `setPin`: the PIN goes to the issuer and is never written, hashed or put in an error. `commandId` is the key: a
/// retried command is not sent again.
pub fn set_pin(
    d: &Deps<'_>,
    card_id: &str,
    user_id: &str,
    command_id: &str,
    pin: &str,
) -> Result<(), Refusal> {
    d.assert_module_enabled()?;
    assert_pin_digits(pin)?;
    let card = with(d.store(), |c| owned_card(c, card_id, user_id))?;
    assert_live_secret(d, Kind::Pin)?;
    if !d.issuer().has_secret_methods() {
        return Err(unset(Kind::Pin));
    }
    let hash = command_hash(&[("cardId", &card.id), ("kind", "pin_set")]);
    let audit = Audit {
        id: command_id,
        card_id: &card.id,
        user_id,
        kind: "pin_set",
        payload_hash: &hash,
    };
    if !already_audited(d, &audit)? {
        d.issuer()
            .set_pin(&card.id, pin)
            .ok_or_else(|| unset(Kind::Pin))?;
        audit_secret(d, &audit)?;
    }
    Ok(())
}

/// `walletRefusedFor`: the TEST partner says it does not add this person's cards to a phone wallet. A partner that is
/// down refuses something else (`bank.partner_unavailable`), so it is not "not offered".
pub fn wallet_refused_for(d: &Deps<'_>, user_id: &str) -> bool {
    d.t.partner.partner.as_ref().is_some_and(|p| {
        let now = p.switches(user_id);
        !now.down && now.not_offered.iter().any(|f| f == "phone_wallet")
    })
}

/// `assertPartnerOffers(testPartner, userId, 'phone_wallet')`: the partner down refuses first, then the wallet not
/// offered; without the TEST partner the issuer alone decides. (A private copy: `spaces::router::offers` words every
/// feature it does not know as "joint accounts and shared pots".)
fn assert_wallet_offered(d: &Deps<'_>, user_id: &str) -> Result<(), Refusal> {
    let Some(p) = d.t.partner.partner.as_ref() else {
        return Ok(());
    };
    let now = p.switches(user_id);
    if now.down {
        return Err(refuse(
            "bank.partner_unavailable",
            "The partner bank is not answering. Nothing was sent or changed.",
        ));
    }
    if now.not_offered.iter().any(|f| f == "phone_wallet") {
        return Err(refuse(
            "bank.not_offered_by_partner",
            "Not offered by the partner: adding a card to a phone wallet. Nothing was sent or changed.",
        ));
    }
    Ok(())
}

/// `walletProvision`: an opaque payload from the issuer, `(payload, expiresAt)`, and one token row per card and wallet.
/// `provisionId` is the key; a different nonce under it conflicts. The payload is not kept.
pub fn wallet_provision(
    d: &Deps<'_>,
    card_id: &str,
    user_id: &str,
    provision_id: &str,
    wallet: &str,
    nonce: &str,
) -> Result<(String, String), Refusal> {
    d.assert_module_enabled()?;
    let card = with(d.store(), |c| owned_card(c, card_id, user_id))?;
    assert_live_secret(d, Kind::Wallet)?;
    if !d.issuer().has_secret_methods() {
        return Err(unset(Kind::Wallet));
    }
    assert_wallet_offered(d, user_id)?;
    // A frozen or closed card is not added to a wallet; its tokens already there show paused (J-bank-14 #4).
    if card.status != "active" || card.inactive() {
        return Err(refuse("bank.card_not_active", "This card is not active"));
    }
    let hash = command_hash(&[("wallet", wallet), ("nonce", nonce)]);
    let payload = d
        .issuer()
        .provision_wallet(&card.id, wallet, nonce)
        .ok_or_else(|| unset(Kind::Wallet))?;
    audit_secret(
        d,
        &Audit {
            id: provision_id,
            card_id: &card.id,
            user_id,
            kind: "wallet_provision",
            payload_hash: &hash,
        },
    )?;
    // No conflict target: a concurrent retry with the same id that loses on the id key keeps the row that won.
    with(d.store(), |c| {
        c.execute(
            "INSERT INTO bank.card_wallet_tokens (id, card_id, user_id, wallet) \
             VALUES ($1::text::uuid, $2::text::uuid, $3, $4) ON CONFLICT DO NOTHING",
            &[&provision_id, &card.id, &user_id, &wallet],
        )
        .map_err(|e| pg(&e))?;
        Ok(())
    })?;
    Ok((payload, expires_at(d)))
}

/// `walletTokens`: each wallet the card was added to, `added` while it is active, `paused` while it is frozen or not
/// activated, `closed` once it is closed, from the card's own status.
pub fn wallet_tokens(d: &Deps<'_>, card_id: &str, user_id: &str) -> Result<Json, Refusal> {
    d.assert_module_enabled()?;
    let card: Card = with(d.store(), |c| owned_card(c, card_id, user_id))?;
    let state = if card.status == "closed" {
        "closed"
    } else if card.status == "frozen" || card.inactive() {
        "paused"
    } else {
        "added"
    };
    let rows = with(d.store(), |c| {
        c.query(
            &format!(
                "SELECT id::text, wallet, {} FROM bank.card_wallet_tokens WHERE card_id = $1::text::uuid \
                 ORDER BY created_at, id",
                ms("created_at")
            ),
            &[&card.id],
        )
        .map_err(|e| pg(&e))
    })?;
    Ok(Json::Array(
        rows.iter()
            .map(|r| {
                Json::obj([
                    ("id", Json::str(r.get::<_, String>(0))),
                    ("wallet", Json::str(r.get::<_, String>(1))),
                    ("state", Json::str(state)),
                    ("addedAt", Json::str(Instant(r.get(2)).iso())),
                ])
            })
            .collect(),
    ))
}

/// `secretsOffered(userId)`: what this deployment's issuer offers, so a screen shows the button or the reason. The same
/// rule each call runs; reading it changes nothing.
pub fn secrets_offered(d: &Deps<'_>, user_id: &str) -> Json {
    let live = d.settings().module_enabled && live_secret_programme(d);
    let methods = d.issuer().has_secret_methods();
    let wallet_not_offered = wallet_refused_for(d, user_id);
    Json::obj([
        ("details", Json::Bool(live && methods)),
        ("pin", Json::Bool(live && methods)),
        ("wallet", Json::Bool(live && methods && !wallet_not_offered)),
        ("test", Json::Bool(secrets_are_test(d))),
        ("walletNotOffered", Json::Bool(wallet_not_offered)),
    ])
}

/// `rewards`: cashback already paid, summed from settled reward records in one asset, `(balance, assetId)`. Refuses
/// until a non-simulated issuer is connected; two assets are never added together.
pub fn rewards(d: &Deps<'_>, user_id: &str) -> Result<(Amount, String), Refusal> {
    if !live_secret_programme(d) {
        return Err(refuse("bank.rewards_issuer_unset", REWARDS_UNSET));
    }
    let issuer = d.issuer().programme().id;
    let rows = with(d.store(), |c| {
        c.query(
            "SELECT c.asset_id, COALESCE(SUM(cb.amount) FILTER (WHERE cb.status = 'settled'), 0)::text \
               FROM bank.cards c \
               LEFT JOIN bank.card_authorizations a ON a.card_id = c.id \
               LEFT JOIN bank.card_cashback cb ON cb.authorization_id = a.id \
              WHERE c.user_id = $1 AND c.simulated = false AND c.issuer = $2 \
              GROUP BY c.asset_id",
            &[&user_id, &issuer],
        )
        .map_err(|e| pg(&e))
    })?;
    match rows.as_slice() {
        [] => Err(refuse("bank.rewards_issuer_unset", REWARDS_UNSET)),
        [row] => {
            let balance = parse_amount(&row.get::<_, String>(1)).map_err(Refusal::Other)?;
            Ok((balance, row.get(0)))
        }
        _ => Err(refuse(
            "bank.rewards_asset_ambiguous",
            "Cashback for this customer is in more than one asset. This call will not add those figures together.",
        )),
    }
}

fn principal<'a>(ctx: &'a Ctx<'_>) -> Result<&'a Principal, Refusal> {
    ctx.principal.ok_or_else(|| {
        Refusal::Other("a scoped call reached the slice with no principal".to_owned())
    })
}

/// The router's opening for `cards.reveal` and `cards.pin.*`: the card and `assertSelf`, (the PIN's digits,) the
/// issuer, then step-up, which must be switched on for a secret.
fn secret_gate(
    d: &Deps<'_>,
    ctx: &Ctx<'_>,
    kind: Kind,
    binding: impl FnOnce() -> crate::transfers::step_up::Binding,
    replay: bool,
    pin: Option<&str>,
) -> Result<(), Refusal> {
    let input = &ctx.input;
    let user = principal(ctx)?.user_id.as_str();
    own(d, user, text(input, "cardId"))?;
    if let Some(pin) = pin {
        assert_pin_digits(pin)?;
    }
    assert_secret_issuer(d, kind)?;
    if !gate::enforced(d) {
        return Err(gate::secret_without_step_up());
    }
    gate::require(
        d,
        principal(ctx)?,
        &binding(),
        opt_text(input, "stepUpApprovalId"),
        replay,
    )
}

/// This part's calls, or `None` for a call it does not hold.
pub fn answer(d: &Deps<'_>, ctx: &Ctx<'_>) -> Option<Result<Json, Refusal>> {
    let input = &ctx.input;
    let user = ctx
        .principal
        .map(|p| p.user_id.as_str())
        .unwrap_or_default();
    let card_id = text(input, "cardId");
    let test = || Json::Bool(secrets_are_test(d));
    Some(match ctx.call.path {
        "cards.reveal" => (|| {
            let reveal_id = text(input, "revealId");
            secret_gate(
                d,
                ctx,
                Kind::Pan,
                || gate::reveal(user, card_id, reveal_id),
                false,
                None,
            )?;
            let (pan, expiry, cvv, expires) = reveal(d, card_id, user, reveal_id)?;
            Ok(Json::obj([
                ("pan", Json::str(pan)),
                ("expiry", Json::str(expiry)),
                ("cvv", Json::str(cvv)),
                ("expiresAt", Json::str(expires)),
                ("test", test()),
            ]))
        })(),
        "cards.pin.reveal" => (|| {
            let reveal_id = text(input, "revealId");
            secret_gate(
                d,
                ctx,
                Kind::Pin,
                || gate::pin_reveal(user, card_id, reveal_id),
                false,
                None,
            )?;
            let (pin, expires) = reveal_pin(d, card_id, user, reveal_id)?;
            Ok(Json::obj([
                ("pin", Json::str(pin)),
                ("expiresAt", Json::str(expires)),
                ("test", test()),
            ]))
        })(),
        "cards.pin.set" => (|| {
            let command_id = text(input, "commandId");
            let pin = text(input, "pin");
            secret_gate(
                d,
                ctx,
                Kind::Pin,
                || gate::pin_set(user, card_id, command_id),
                true,
                Some(pin),
            )?;
            set_pin(d, card_id, user, command_id, pin)?;
            Ok(Json::obj([("ok", Json::Bool(true))]))
        })(),
        "cards.walletProvision" => (|| {
            own(d, user, card_id)?;
            let (payload, expires) = wallet_provision(
                d,
                card_id,
                user,
                text(input, "provisionId"),
                text(input, "wallet"),
                text(input, "nonce"),
            )?;
            Ok(Json::obj([
                ("payload", Json::str(payload)),
                ("expiresAt", Json::str(expires)),
                ("test", test()),
            ]))
        })(),
        "cards.secretsOffered" => Ok(secrets_offered(d, user)),
        "cards.walletTokens" => (|| {
            own(d, user, card_id)?;
            Ok(Json::obj([
                ("test", test()),
                ("tokens", wallet_tokens(d, card_id, user)?),
            ]))
        })(),
        "cards.rewards" => rewards(d, user).map(|(balance, asset)| {
            Json::obj([
                ("balance", Json::str(format_amount(balance))),
                ("asset", Json::str(asset)),
                ("simulated", Json::Bool(false)),
            ])
        }),
        _ => return None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_pin_is_four_to_twelve_ascii_digits() {
        for ok in ["1234", "135790", "123456789012"] {
            assert!(assert_pin_digits(ok).is_ok(), "{ok}");
        }
        for bad in [
            "",
            "12",
            "123",
            "1234567890123",
            "12a4",
            "1234\n",
            "١٢٣٤",
            " 1234",
        ] {
            assert!(assert_pin_digits(bad).is_err(), "{bad:?}");
        }
    }

    #[test]
    fn a_secret_audit_hash_is_sha256_over_sorted_key_value_lines() {
        assert_eq!(
            command_hash(&[("kind", "pan_reveal"), ("cardId", "c")]),
            super::super::issuer::sha256_hex("cardId=c\nkind=pan_reveal")
        );
    }
}
