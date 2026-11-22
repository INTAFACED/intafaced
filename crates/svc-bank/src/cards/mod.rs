//! The cards slice (`PORT.md`): the person's own card calls (`router/cards.router.ts`, `cards.*`, 40 calls), the
//! printer's shipment door (`/internal/jobs/card-sim/shipment`) and the card a shared pot's holder freezes
//! (`sharedPots.freezeCard`).
//!
//! A card holds no money. It draws on one of its owner's balances, and every move a card makes (a hold, a capture, a
//! reversal, a cashback) is the issuer speaking and belongs to slice `card-ops`. This slice issues and orders cards,
//! sets their status, limits, channels and controls, reveals what the issuer offers (the TEST partner's stand-ins only:
//! no live issuer exists), answers 3D Secure challenges, takes fraud reports and the person's own disputes, and reads
//! back what the partner and the authorisations say.
//!
//! - `terms`: the owner's and the TEST partner's values, read at boot.
//! - `issuer`: the issuer port (`none`, `card-sim`, `card-sim` refused in a live posture).
//! - `core`: the card itself: programme, list, issue, status, limits, channels, controls, replace, activate, uses.
//! - `orders`: the card room (J-bank-13): catalogue, terms, order, delivery, the shipment door.
//! - `secrets`: card details, PIN and phone wallets (J-bank-14 #3, #4).
//! - `safety`: 3D Secure and fraud reports (J-bank-14 #5, #7).
//! - `disputes`: the cardholder's own disputes (J-bank-15).
//! - `reads`: authorisations, recurring payments, cashback, rewards, pay from, and the partner's holds.
//! - `router`: the calls.

pub mod core;
pub mod disputes;
pub mod issuer;
pub mod orders;
pub mod reads;
pub mod router;
pub mod safety;
pub mod secrets;
pub mod step_up;
pub mod terms;

use postgres::Row;
use service_kit::json::{self, Json};
use service_kit::money::{Amount, format_amount, parse_amount};
use service_kit::time::Instant;

use self::issuer::Issuer;
use self::terms::{CashbackRates, ProgrammeTerms};
use crate::errors::Refusal;
use crate::partner::refuse;
use crate::spaces::space::pg;

/// `RankTierPort`: which card tier a person's rank gives (svc-identity's rank perks door).
pub trait RankTier: Send + Sync {
    /// One of `terms::CARD_TIERS`, or `bank.rank_unavailable`.
    fn card_tier_of(&self, user_id: &str) -> Result<String, Refusal>;
}

/// `unconfiguredRankTier`: no `IDENTITY_URL`.
pub struct NoRankTier;

impl RankTier for NoRankTier {
    fn card_tier_of(&self, _: &str) -> Result<String, Refusal> {
        Err(refuse(
            "bank.rank_unavailable",
            "IDENTITY_URL is unset, so the bank cannot read which card tier a rank gives",
        ))
    }
}

/// The owner's card values (`index.ts`'s `cards` options).
#[derive(Debug, Clone)]
pub struct Settings {
    /// `BANK_CARDS_ENABLED`: on unless the owner turns cards off.
    pub module_enabled: bool,
    /// `BANK_CARD_PROGRAMME_JSON`.
    pub programme: Option<ProgrammeTerms>,
    /// `BANK_CARD_CASHBACK_RATES_JSON`.
    pub cashback_rates: Option<CashbackRates>,
    /// `BANK_CARD_SIM_CASHBACK=test`.
    pub simulator_pays: bool,
    /// `BANK_CARD_SPEND_ASSETS`.
    pub spend_assets: Option<Vec<String>>,
    /// `BANK_CARD_PIN_TRY_LIMIT`.
    pub pin_try_limit: Option<i64>,
    /// `BANK_CARD_3DS_TRY_LIMIT`.
    pub three_ds_try_limit: Option<i64>,
    /// `BANK_CARD_DISPUTE_CAP_JSON`, per asset; `None` is not published.
    pub dispute_cap: Option<Vec<(String, String)>>,
}

impl Default for Settings {
    fn default() -> Settings {
        Settings {
            module_enabled: true,
            programme: None,
            cashback_rates: None,
            simulator_pays: false,
            spend_assets: None,
            pin_try_limit: None,
            three_ds_try_limit: None,
            dispute_cap: None,
        }
    }
}

/// What the binary hands the slice: the issuer, the rank door and the owner's values.
pub struct Wiring {
    pub issuer: Issuer,
    pub rank: Box<dyn RankTier>,
    pub settings: Settings,
}

impl Wiring {
    /// No card programme: what a door gets until the binary hands one in.
    pub fn none() -> Wiring {
        Wiring {
            issuer: Issuer::None,
            rank: Box::new(NoRankTier),
            settings: Settings::default(),
        }
    }
}

/// What every part of the slice is handed for one call: the transfers slice's dependencies (the store, the ledger, the
/// partner, identity's approvals and the step-up gate) and the card wiring.
pub struct Deps<'a> {
    pub t: &'a crate::transfers::Deps<'a>,
    pub w: &'a Wiring,
}

impl Deps<'_> {
    pub fn store(&self) -> &crate::db::Store {
        self.t.store
    }

    pub fn now(&self) -> Instant {
        self.t.now
    }

    pub fn issuer(&self) -> &Issuer {
        &self.w.issuer
    }

    pub fn settings(&self) -> &Settings {
        &self.w.settings
    }

    /// `assertModuleEnabled`.
    pub fn assert_module_enabled(&self) -> Result<(), Refusal> {
        if self.w.settings.module_enabled {
            return Ok(());
        }
        Err(refuse(
            "bank.cards_disabled",
            "Cards module is disabled (BANK_CARDS_ENABLED / bank.cards)",
        ))
    }

    /// `assertIssuerMayMutate`: the simulator in a live posture refuses before a row is written.
    pub fn assert_issuer_may_mutate(&self) -> Result<(), Refusal> {
        match self.w.issuer.mutation_refuse() {
            None => Ok(()),
            Some(code) => Err(refuse(
                code,
                "card-sim is not a live issuer \u{2014} this deployment will not issue or authorise as if a BIN exists",
            )),
        }
    }
}

/// `CardShippingAddress`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Address {
    pub name: String,
    pub line1: String,
    pub line2: Option<String>,
    pub city: String,
    pub region: Option<String>,
    pub postal_code: String,
    pub country: String,
}

impl Address {
    /// The stored and shown shape, in the TypeScript's key order (`JSON.stringify` of the object it builds).
    pub fn json(&self) -> Json {
        let opt = |v: &Option<String>| v.clone().map_or(Json::Null, Json::str);
        Json::obj([
            ("name", Json::str(self.name.clone())),
            ("line1", Json::str(self.line1.clone())),
            ("line2", opt(&self.line2)),
            ("city", Json::str(self.city.clone())),
            ("region", opt(&self.region)),
            ("postalCode", Json::str(self.postal_code.clone())),
            ("country", Json::str(self.country.clone())),
        ])
    }

    /// `toAddress`: a stored delivery address read back from its jsonb, or `None`.
    pub fn from_json(v: &Json) -> Option<Address> {
        let s = |k: &str| match v.get(k) {
            Some(Json::String(s)) => Some(s.clone()),
            _ => None,
        };
        Some(Address {
            name: s("name")?,
            line1: s("line1")?,
            line2: s("line2"),
            city: s("city")?,
            region: s("region"),
            postal_code: s("postalCode")?,
            country: s("country")?,
        })
    }
}

/// `CardRecord`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Card {
    pub id: String,
    pub user_id: String,
    pub asset_id: String,
    pub settlement_asset_id: String,
    pub issuer: String,
    pub simulated: bool,
    pub issuer_ref: String,
    pub pan_tail: String,
    /// `active`, `frozen` or `closed`.
    pub status: String,
    pub cashback_bps: i64,
    pub per_authorization_limit: Amount,
    pub daily_limit: Option<Amount>,
    pub monthly_limit: Option<Amount>,
    pub cash_limit: Option<Amount>,
    pub online: bool,
    pub contactless: bool,
    pub atm: bool,
    pub abroad: bool,
    /// `virtual` or `physical`.
    pub card_type: String,
    pub shipping_address: Option<Address>,
    pub replaces_card_id: Option<String>,
    pub replaced_by_card_id: Option<String>,
    pub replace_reason: Option<String>,
    /// `owner`, `holder` or `operator`.
    pub frozen_by: Option<String>,
    pub activated_at: Option<Instant>,
    pub uses_allowed: Option<i64>,
    pub design_id: Option<String>,
    pub delivery_speed: Option<String>,
    pub residence_country: Option<String>,
}

/// The columns every card read selects, in [`Card::from_row`]'s order.
pub const CARD_COLS: &str = "id::text, user_id, asset_id, settlement_asset_id, issuer, simulated, issuer_ref, pan_tail, \
     status::text, cashback_bps::int8, per_authorization_limit::text, daily_limit::text, monthly_limit::text, \
     cash_limit::text, channel_online, channel_contactless, channel_atm, channel_abroad, card_type, \
     shipping_address::text, replaces_card_id::text, replaced_by_card_id::text, replace_reason, frozen_by, \
     floor(extract(epoch from activated_at) * 1000)::int8, uses_allowed::int8, design_id, delivery_speed, \
     residence_country";

fn amount_at(r: &Row, i: usize) -> Result<Amount, Refusal> {
    parse_amount(&r.try_get::<_, String>(i).map_err(|e| pg(&e))?).map_err(Refusal::Other)
}

fn opt_amount_at(r: &Row, i: usize) -> Result<Option<Amount>, Refusal> {
    r.try_get::<_, Option<String>>(i)
        .map_err(|e| pg(&e))?
        .map(|s| parse_amount(&s).map_err(Refusal::Other))
        .transpose()
}

impl Card {
    /// `toCard`.
    pub fn from_row(r: &Row) -> Result<Card, Refusal> {
        let g = |i: usize| -> Result<String, Refusal> { r.try_get(i).map_err(|e| pg(&e)) };
        let o = |i: usize| -> Result<Option<String>, Refusal> { r.try_get(i).map_err(|e| pg(&e)) };
        let b = |i: usize| -> Result<bool, Refusal> { r.try_get(i).map_err(|e| pg(&e)) };
        let card_type = g(18)?;
        let replace_reason = o(22)?.filter(|v| matches!(v.as_str(), "lost" | "stolen" | "damaged"));
        let frozen_by = o(23)?.filter(|v| matches!(v.as_str(), "owner" | "holder" | "operator"));
        Ok(Card {
            id: g(0)?,
            user_id: g(1)?,
            asset_id: g(2)?,
            settlement_asset_id: g(3)?,
            issuer: g(4)?,
            simulated: b(5)?,
            issuer_ref: g(6)?,
            pan_tail: g(7)?,
            status: g(8)?,
            cashback_bps: r.try_get(9).map_err(|e| pg(&e))?,
            per_authorization_limit: amount_at(r, 10)?,
            daily_limit: opt_amount_at(r, 11)?,
            monthly_limit: opt_amount_at(r, 12)?,
            cash_limit: opt_amount_at(r, 13)?,
            online: b(14)?,
            contactless: b(15)?,
            atm: b(16)?,
            abroad: b(17)?,
            card_type: if card_type == "physical" {
                card_type
            } else {
                "virtual".to_owned()
            },
            shipping_address: o(19)?
                .and_then(|t| json::parse(&t).ok())
                .and_then(|j| Address::from_json(&j)),
            replaces_card_id: o(20)?,
            replaced_by_card_id: o(21)?,
            replace_reason,
            frozen_by,
            activated_at: r
                .try_get::<_, Option<i64>>(24)
                .map_err(|e| pg(&e))?
                .map(Instant),
            uses_allowed: r.try_get(25).map_err(|e| pg(&e))?,
            design_id: o(26)?,
            delivery_speed: o(27)?,
            residence_country: o(28)?,
        })
    }

    /// `cardInactive`: issued but not activated yet.
    pub fn inactive(&self) -> bool {
        self.activated_at.is_none()
    }

    /// `presentStatus`.
    pub fn shown_status(&self) -> &str {
        if self.status == "active" && self.inactive() {
            "inactive"
        } else {
            &self.status
        }
    }

    /// `presentCard`: the one view of a card that leaves svc-bank. Nothing secret is in it.
    pub fn view(&self) -> Json {
        let amt = |a: Option<Amount>| a.map_or(Json::Null, |a| Json::str(format_amount(a)));
        let opt = |v: &Option<String>| v.clone().map_or(Json::Null, Json::str);
        Json::obj([
            ("id", Json::str(self.id.clone())),
            ("assetId", Json::str(self.asset_id.clone())),
            (
                "settlementAssetId",
                Json::str(self.settlement_asset_id.clone()),
            ),
            ("issuer", Json::str(self.issuer.clone())),
            ("simulated", Json::Bool(self.simulated)),
            ("panTail", Json::str(self.pan_tail.clone())),
            ("status", Json::str(self.shown_status())),
            ("cashbackBps", Json::int(self.cashback_bps)),
            (
                "perAuthorizationLimit",
                Json::str(format_amount(self.per_authorization_limit)),
            ),
            ("dailyLimit", amt(self.daily_limit)),
            ("monthlyLimit", amt(self.monthly_limit)),
            ("cashLimit", amt(self.cash_limit)),
            ("online", Json::Bool(self.online)),
            ("contactless", Json::Bool(self.contactless)),
            ("atm", Json::Bool(self.atm)),
            ("abroad", Json::Bool(self.abroad)),
            ("cardType", Json::str(self.card_type.clone())),
            (
                "shippingAddress",
                self.shipping_address
                    .as_ref()
                    .map_or(Json::Null, Address::json),
            ),
            (
                "usesAllowed",
                self.uses_allowed.map_or(Json::Null, Json::int),
            ),
            ("designId", opt(&self.design_id)),
            ("deliverySpeed", opt(&self.delivery_speed)),
            ("replacesCardId", opt(&self.replaces_card_id)),
            ("replacedByCardId", opt(&self.replaced_by_card_id)),
        ])
    }
}

/// `bank.card_not_found`.
pub fn card_not_found(card_id: &str) -> Refusal {
    refuse("bank.card_not_found", format!("Card {card_id} not found"))
}

/// `cardOrNull`.
pub fn card_or_none(
    c: &mut impl postgres::GenericClient,
    card_id: &str,
) -> Result<Option<Card>, Refusal> {
    let rows = c
        .query(
            &format!("SELECT {CARD_COLS} FROM bank.cards WHERE id = $1::text::uuid"),
            &[&card_id],
        )
        .map_err(|e| pg(&e))?;
    rows.first().map(Card::from_row).transpose()
}

/// `card`: the card, or `bank.card_not_found`.
pub fn card(c: &mut impl postgres::GenericClient, card_id: &str) -> Result<Card, Refusal> {
    card_or_none(c, card_id)?.ok_or_else(|| card_not_found(card_id))
}

/// `ownedCard`: the card, when it is this person's; another's is not found.
pub fn owned_card(
    c: &mut impl postgres::GenericClient,
    card_id: &str,
    user_id: &str,
) -> Result<Card, Refusal> {
    let card = card(c, card_id)?;
    if card.user_id != user_id {
        return Err(card_not_found(card_id));
    }
    Ok(card)
}

/// `card` through the pool.
pub fn read_card(d: &Deps<'_>, card_id: &str) -> Result<Card, Refusal> {
    crate::spaces::space::with(d.store(), |c| card(c, card_id))
}

/// The router's opening for a card call: the card, then `assertSelf` (another person's card is the guard's 403).
pub fn own(d: &Deps<'_>, user_id: &str, card_id: &str) -> Result<Card, Refusal> {
    let card = read_card(d, card_id)?;
    crate::transfers::schedules::assert_self(user_id, &card.user_id)?;
    Ok(card)
}

/// `noteStatusEvent`: one line in the card's lock history.
pub fn note_status_event(
    tx: &mut postgres::Transaction<'_>,
    card_id: &str,
    status: &str,
    actor: &str,
) -> Result<(), Refusal> {
    tx.execute(
        "INSERT INTO bank.card_status_events (card_id, status, actor) VALUES ($1::text::uuid, $2, $3)",
        &[&card_id, &status, &actor],
    )
    .map_err(|e| pg(&e))?;
    Ok(())
}

/// `updateStatus`: set a card's status under its row lock (`set` is the SQL `SET` list, its values bound from `$2`).
/// True when the status it had differs from `status`, so two callers making the same change hear it once.
pub fn update_status(
    tx: &mut postgres::Transaction<'_>,
    card_id: &str,
    set: &str,
    params: &[&(dyn postgres::types::ToSql + Sync)],
    status: &str,
) -> Result<bool, Refusal> {
    let mut all: Vec<&(dyn postgres::types::ToSql + Sync)> = vec![&card_id];
    all.extend_from_slice(params);
    let rows = tx
        .query(
            &format!(
                "UPDATE bank.cards c SET {set}, updated_at = now() \
                   FROM (SELECT id, status FROM bank.cards WHERE id = $1::text::uuid FOR UPDATE) o \
                  WHERE c.id = o.id RETURNING o.status::text"
            ),
            &all,
        )
        .map_err(|e| pg(&e))?;
    Ok(rows
        .first()
        .is_some_and(|r| r.get::<_, String>(0) != status))
}

/// `CardStatusChange`, as the shared pot's log hears it (`sharedPots.noteCardStatus`).
pub struct StatusChange<'a> {
    pub card_id: &'a str,
    pub owner_user_id: &'a str,
    /// The person who acted, or `None` for the bank's operator.
    pub actor: Option<&'a str>,
    pub status: &'a str,
    pub replacement_card_id: Option<&'a str>,
}

/// `SharedPotService.noteCardStatus`: a card linked to a shared pot writes each change of its status into the pot's log,
/// in the card's transaction; a holder's freeze is checked again under the card's row lock.
pub fn note_card_status(
    tx: &mut postgres::Transaction<'_>,
    change: &StatusChange<'_>,
) -> Result<(), Refusal> {
    use crate::spaces::shared::BANK_ACTOR;
    let link: Option<String> = tx
        .query(
            "SELECT space_id::text FROM bank.shared_pot_cards WHERE card_id = $1::text::uuid",
            &[&change.card_id],
        )
        .map_err(|e| pg(&e))?
        .first()
        .map(|r| r.get(0));
    let actor = change.actor.unwrap_or(BANK_ACTOR);
    if actor != BANK_ACTOR && actor != change.owner_user_id {
        let Some(space) = link.as_deref() else {
            return Err(refuse(
                "bank.card_not_found",
                "No card is linked to this pot",
            ));
        };
        if crate::spaces::shared::role_of(tx, space, actor)?.as_deref() != Some("contributor") {
            return Err(refuse(
                "bank.space_forbidden",
                "Only the owner and contributors of a shared pot can freeze its card",
            ));
        }
    }
    let Some(space) = link else {
        return Ok(());
    };
    let log = |tx: &mut postgres::Transaction<'_>, kind: &str, card: &str| -> Result<(), Refusal> {
        tx.execute(
            "INSERT INTO bank.shared_pot_activity (space_id, actor_user_id, kind, card_id) \
             VALUES ($1::text::uuid, $2, $3, $4::text::uuid)",
            &[&space, &actor, &kind, &card],
        )
        .map_err(|e| pg(&e))?;
        Ok(())
    };
    if change.status != "closed" {
        let kind = if change.status == "frozen" {
            "card_frozen"
        } else {
            "card_unfrozen"
        };
        return log(tx, kind, change.card_id);
    }
    log(tx, "card_unlinked", change.card_id)?;
    if let Some(next) = change.replacement_card_id {
        tx.execute(
            "UPDATE bank.shared_pot_cards SET card_id = $2::text::uuid, linked_at = now() WHERE card_id = $1::text::uuid",
            &[&change.card_id, &next],
        )
        .map_err(|e| pg(&e))?;
        log(tx, "card_linked", next)?;
    } else {
        tx.execute(
            "DELETE FROM bank.shared_pot_cards WHERE card_id = $1::text::uuid",
            &[&change.card_id],
        )
        .map_err(|e| pg(&e))?;
    }
    Ok(())
}

/// A timestamp column as epoch milliseconds, as `Date` reads it.
pub fn ms(col: &str) -> String {
    format!("floor(extract(epoch from {col}) * 1000)::int8")
}

/// An ISO time, or null.
pub fn iso(t: Option<Instant>) -> Json {
    t.map_or(Json::Null, |t| Json::str(t.iso()))
}
