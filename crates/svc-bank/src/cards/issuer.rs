//! The card issuer port (`cards/issuer.ts`): the seam between the ledger half of cards, built here, and a live rail,
//! which is a contract (`socket.live-issuer`). Exactly two settings: `none` (every card call refuses
//! `bank.no_card_issuer`) and `card-sim` (a simulator; there is no card), and `card-sim` in a live posture refuses every
//! mutation `bank.card_sim_not_live`. An issuer never moves value: no ledger is handed to it.
//!
//! The simulator keeps the TEST partner's book in this process (its provisional dispute credits, its programme funding
//! instructions, and, with `secrets: "test"`, its PINs and the answers it gave to PIN checks), as the TypeScript's does;
//! a restart forgets them.

use std::collections::BTreeMap;
use std::sync::{Mutex, MutexGuard};

use service_kit::money::{Amount, format_amount, parse_amount};
use sha2::{Digest, Sha256};

use super::terms::PartnerTerms;
use crate::errors::Refusal;
use crate::partner::refuse;

/// `CardProgramme`: what the programme calls itself, and whether it is real.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Programme {
    pub id: &'static str,
    pub simulated: bool,
    pub display_name: &'static str,
}

/// `IssuedCardHandle`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Handle {
    pub issuer_ref: String,
    pub pan_tail: String,
}

/// The answer to a PIN entered at a terminal (`verifyPin`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PinVerdict {
    Ok,
    Wrong,
    Blocked,
    Unset,
}

/// One provisional dispute credit the TEST partner gave.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Credit {
    pub user_id: String,
    pub asset_id: String,
    pub amount: Amount,
    pub partner_ref: String,
    pub reversed: bool,
}

/// One programme funding instruction the TEST partner took (`TestCardPartnerBook['funding']`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FundingTaken {
    pub request_id: String,
    pub kind: String,
    pub asset_id: String,
    pub amount: String,
    pub threshold: Option<String>,
    pub partner_ref: String,
}

/// The simulator's in-process book.
#[derive(Debug, Default)]
pub struct SimBook {
    /// `cardId` → `(pin, wrong tries in a row)`.
    pins: BTreeMap<String, (String, i64)>,
    /// `cardId:authorizationRef` → the answer given, so a redelivered purchase is never a second wrong try.
    answered: BTreeMap<String, PinVerdict>,
    /// By request key, in the order taken.
    pub credits: Vec<(String, Credit)>,
    pub funding: Vec<FundingTaken>,
}

/// The issuer a deployment chose (`cardIssuerFor`).
#[derive(Debug)]
pub enum Issuer {
    /// `noCardIssuer`: no card programme; everything refuses `bank.no_card_issuer`.
    None,
    /// `cardSim()`: the simulator, with the TEST partner's answers.
    Sim {
        partner: Box<PartnerTerms>,
        book: Mutex<SimBook>,
    },
    /// `cardSimNotLive()`: the simulator in a live posture; every mutation refuses `bank.card_sim_not_live`.
    SimNotLive,
}

const NO_ISSUER: &str =
    "No card issuer is configured \u{2014} this deployment has no card programme";
const NOT_LIVE: &str = "card-sim is not a live issuer \u{2014} this deployment will not issue or authorise as if a BIN exists";

fn no_issuer(what: &str) -> Refusal {
    refuse(
        "bank.no_card_issuer",
        format!(
            "No card issuer is configured \u{2014} this deployment has no card partner to {what}"
        ),
    )
}

fn not_live() -> Refusal {
    refuse("bank.card_sim_not_live", NOT_LIVE)
}

fn hex(bytes: &[u8]) -> String {
    use std::fmt::Write as _;
    bytes.iter().fold(String::new(), |mut s, b| {
        let _ = write!(s, "{b:02x}");
        s
    })
}

/// `createHash('sha256').update(text).digest('hex')`.
pub fn sha256_hex(text: &str) -> String {
    hex(&Sha256::digest(text.as_bytes()))
}

fn hex_prefix(h: &str, from: usize, to: usize) -> u64 {
    u64::from_str_radix(h.get(from..to).unwrap_or("0"), 16).unwrap_or(0)
}

/// `testCardNumber`: the 999999 prefix (no scheme issues it), nine digits from the card id, and a Luhn check digit.
pub fn test_card_number(card_id: &str) -> String {
    let h = sha256_hex(&format!("pan:{card_id}"));
    let body = format!("999999{:09}", hex_prefix(&h, 0, 15) % 1_000_000_000);
    let digits: Vec<u32> = body.chars().filter_map(|c| c.to_digit(10)).collect();
    let mut sum = 0;
    for (i, d) in digits.iter().rev().enumerate() {
        let mut d = *d;
        if i % 2 == 0 {
            d *= 2;
            if d > 9 {
                d -= 9;
            }
        }
        sum += d;
    }
    format!("{body}{}", (10 - (sum % 10)) % 10)
}

fn test_ref(kind: &str, key: &str) -> String {
    format!("TEST-card-sim-{kind}-{}", &sha256_hex(key)[..16])
}

impl Issuer {
    /// `cardIssuerFor(setting, posture, partner)`. `live` is `cardSimIsLivePosture`.
    pub fn for_setting(setting: &str, live: bool, partner: PartnerTerms) -> Issuer {
        match setting {
            "card-sim" if live => Issuer::SimNotLive,
            "card-sim" => Issuer::Sim {
                partner: Box::new(PartnerTerms {
                    test: true,
                    ..partner
                }),
                book: Mutex::new(SimBook::default()),
            },
            _ => Issuer::None,
        }
    }

    /// The simulator with the TEST partner's answers, for a test.
    pub fn sim(partner: PartnerTerms) -> Issuer {
        Issuer::for_setting("card-sim", false, partner)
    }

    /// `cardProgrammeOutput(issuer.programme)`.
    pub fn programme(&self) -> Programme {
        match self {
            Issuer::None => Programme {
                id: "none",
                simulated: true,
                display_name: "No card programme",
            },
            Issuer::Sim { .. } | Issuer::SimNotLive => Programme {
                id: "card-sim",
                simulated: true,
                display_name: "Simulated card (no card programme)",
            },
        }
    }

    /// `mutationRefuse`: set only on the simulator in a live posture.
    pub fn mutation_refuse(&self) -> Option<&'static str> {
        matches!(self, Issuer::SimNotLive).then_some("bank.card_sim_not_live")
    }

    /// `testSecrets`: the TEST partner adapter with `secrets: "test"`.
    pub fn test_secrets(&self) -> bool {
        matches!(self, Issuer::Sim { partner, .. } if partner.test_secrets)
    }

    /// The TEST partner's answers, when this is the simulator.
    pub fn sim_partner(&self) -> Option<&PartnerTerms> {
        match self {
            Issuer::Sim { partner, .. } => Some(partner),
            _ => None,
        }
    }

    /// The simulator's book, when this is the simulator.
    pub fn sim_book(&self) -> Option<MutexGuard<'_, SimBook>> {
        match self {
            Issuer::Sim { book, .. } => Some(
                book.lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner),
            ),
            _ => None,
        }
    }

    /// `issue`: the issuer's handle on a card. The simulator's is derived from the card id, so the same id is the same card.
    pub fn issue(&self, card_id: &str) -> Result<Handle, Refusal> {
        match self {
            Issuer::None => Err(refuse("bank.no_card_issuer", NO_ISSUER)),
            Issuer::SimNotLive => Err(not_live()),
            Issuer::Sim { .. } => Ok(Handle {
                issuer_ref: format!("card-sim:{card_id}"),
                pan_tail: format!("{:04}", hex_prefix(&sha256_hex(card_id), 0, 8) % 10_000),
            }),
        }
    }

    /// `setStatus` at the issuer: the simulator has nowhere to carry it.
    pub fn set_status(&self) -> Result<(), Refusal> {
        match self {
            Issuer::None => Err(refuse("bank.no_card_issuer", NO_ISSUER)),
            Issuer::SimNotLive => Err(not_live()),
            Issuer::Sim { .. } => Ok(()),
        }
    }

    /// `respondToAuthorization`: the simulator has nowhere to carry a decision.
    pub fn respond_to_authorization(&self) -> Result<(), Refusal> {
        self.set_status()
    }

    /// `partnerTerms()`; `CardService.partnerTerms` (an adapter that reports nothing reads nothing reported).
    pub fn partner_terms(&self) -> Result<PartnerTerms, Refusal> {
        match self {
            Issuer::None => Err(no_issuer("ask")),
            Issuer::SimNotLive => Err(not_live()),
            Issuer::Sim { partner, .. } => Ok(partner.as_ref().clone()),
        }
    }

    /// `cardholderBalances`: the TEST figures for every cardholder plus the provisional credits not reversed.
    pub fn cardholder_balances(
        &self,
        user_id: &str,
    ) -> Result<Option<Vec<(String, String)>>, Refusal> {
        match self {
            Issuer::None => Err(no_issuer("ask")),
            Issuer::SimNotLive => Err(not_live()),
            Issuer::Sim { partner, book } => {
                let book = book
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner);
                Ok(with_credits(
                    partner.balances.as_ref(),
                    user_id,
                    &book.credits,
                ))
            }
        }
    }

    /// `programmeFunding`: the TEST partner takes an instruction it offers, once per request key.
    pub fn programme_funding(
        &self,
        request_id: &str,
        kind: &str,
        asset_id: &str,
        amount: &str,
        threshold: Option<&str>,
    ) -> Result<String, Refusal> {
        match self {
            Issuer::None => Err(no_issuer("fund")),
            Issuer::SimNotLive => Err(not_live()),
            Issuer::Sim { partner, book } => {
                let offered = partner.funding_offers.is_some_and(|o| match kind {
                    "fund" => o.fund,
                    "defund" => o.defund,
                    _ => o.auto_reload,
                });
                if !offered || partner.funding_asset_id.as_deref() != Some(asset_id) {
                    return Err(refuse(
                        "bank.card_funding_not_offered",
                        format!("The TEST card partner does not offer {kind} in {asset_id}"),
                    ));
                }
                let partner_ref = format!("TEST-card-sim-{}", &sha256_hex(request_id)[..16]);
                let mut book = book
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner);
                if !book.funding.iter().any(|f| f.request_id == request_id) {
                    book.funding.push(FundingTaken {
                        request_id: request_id.to_owned(),
                        kind: kind.to_owned(),
                        asset_id: asset_id.to_owned(),
                        amount: amount.to_owned(),
                        threshold: threshold.map(str::to_owned),
                        partner_ref: partner_ref.clone(),
                    });
                }
                Ok(partner_ref)
            }
        }
    }

    /// `provisionalCredit`: the disputed amount in full, once per request key. Returns `(partnerRef, amount)`.
    pub fn provisional_credit(
        &self,
        request_id: &str,
        user_id: &str,
        asset_id: &str,
        amount: &str,
    ) -> Result<(String, String), Refusal> {
        match self {
            Issuer::None => Err(no_issuer("credit")),
            Issuer::SimNotLive => Err(not_live()),
            Issuer::Sim { book, .. } => {
                let mut book = book
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner);
                if let Some((_, c)) = book.credits.iter().find(|(k, _)| k == request_id) {
                    return Ok((c.partner_ref.clone(), format_amount(c.amount)));
                }
                let credit = Credit {
                    user_id: user_id.to_owned(),
                    asset_id: asset_id.to_owned(),
                    amount: parse_amount(amount).map_err(Refusal::Other)?,
                    partner_ref: test_ref("credit", request_id),
                    reversed: false,
                };
                let out = (credit.partner_ref.clone(), format_amount(credit.amount));
                book.credits.push((request_id.to_owned(), credit));
                Ok(out)
            }
        }
    }

    /// `settleProvisionalCredit`: final, or reversed (the TEST partner takes its credit back).
    pub fn settle_provisional_credit(
        &self,
        request_id: &str,
        credit_request_id: &str,
        settlement: &str,
    ) -> Result<String, Refusal> {
        match self {
            Issuer::None => Err(no_issuer("tell")),
            Issuer::SimNotLive => Err(not_live()),
            Issuer::Sim { book, .. } => {
                let mut book = book
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner);
                if settlement == "reversed"
                    && let Some((_, c)) = book
                        .credits
                        .iter_mut()
                        .find(|(k, _)| k == credit_request_id)
                {
                    c.reversed = true;
                }
                Ok(test_ref(settlement, request_id))
            }
        }
    }

    /// Whether this issuer has the TEST secret methods (`revealCredentials`, `revealPin`, `setPin`, `verifyPin`,
    /// `provisionWallet`, `threeDSCode`): only the simulator with `secrets: "test"`. No live issuer exists.
    pub fn has_secret_methods(&self) -> bool {
        self.test_secrets()
    }

    /// `revealCredentials`: `(pan, expiry, cvv)`, derived from the card id.
    pub fn reveal_credentials(&self, card_id: &str) -> Option<(String, String, String)> {
        if !self.test_secrets() {
            return None;
        }
        let h = sha256_hex(&format!("details:{card_id}"));
        let month = hex_prefix(&h, 0, 2) % 12 + 1;
        Some((
            test_card_number(card_id),
            format!("{month:02}/{}", 30 + hex_prefix(&h, 2, 4) % 5),
            format!("{:03}", hex_prefix(&h, 4, 10) % 1000),
        ))
    }

    /// `revealPin`: the PIN held for this card, or `bank.card_pin_not_set`.
    pub fn reveal_pin(&self, card_id: &str) -> Option<Result<String, Refusal>> {
        let book = self.sim_book().filter(|_| self.test_secrets())?;
        Some(
            book.pins
                .get(card_id)
                .map(|(p, _)| p.clone())
                .ok_or_else(|| {
                    refuse(
                        "bank.card_pin_not_set",
                        "This card has no PIN yet. Set one first.",
                    )
                }),
        )
    }

    /// `setPin`: a new PIN also clears the wrong tries.
    pub fn set_pin(&self, card_id: &str, pin: &str) -> Option<()> {
        let mut book = self.sim_book().filter(|_| self.test_secrets())?;
        book.pins.insert(card_id.to_owned(), (pin.to_owned(), 0));
        Some(())
    }

    /// `verifyPin`: one answer per purchase; `Blocked` once `try_limit` wrong tries in a row are reached.
    pub fn verify_pin(
        &self,
        card_id: &str,
        authorization_ref: &str,
        pin: &str,
        try_limit: i64,
    ) -> Option<PinVerdict> {
        let mut book = self.sim_book().filter(|_| self.test_secrets())?;
        let key = format!("{card_id}:{authorization_ref}");
        if let Some(v) = book.answered.get(&key) {
            return Some(*v);
        }
        let verdict = match book.pins.get_mut(card_id) {
            None => PinVerdict::Unset,
            Some((_, wrong)) if *wrong >= try_limit => PinVerdict::Blocked,
            Some((held, wrong)) if held == pin => {
                *wrong = 0;
                PinVerdict::Ok
            }
            Some((_, wrong)) => {
                *wrong += 1;
                if *wrong >= try_limit {
                    PinVerdict::Blocked
                } else {
                    PinVerdict::Wrong
                }
            }
        };
        book.answered.insert(key, verdict);
        Some(verdict)
    }

    /// `threeDSCode`: six digits derived from the challenge id.
    pub fn three_ds_code(&self, challenge_id: &str) -> Option<String> {
        if !self.test_secrets() {
            return None;
        }
        let h = sha256_hex(&format!("3ds:{challenge_id}"));
        Some(format!("{:06}", hex_prefix(&h, 0, 12) % 1_000_000))
    }

    /// `provisionWallet`: a TEST payload.
    pub fn provision_wallet(&self, card_id: &str, wallet: &str, nonce: &str) -> Option<String> {
        if !self.test_secrets() {
            return None;
        }
        Some(format!(
            "TEST-wallet-{wallet}-{}",
            &sha256_hex(&format!("{card_id}:{wallet}:{nonce}"))[..24]
        ))
    }
}

/// `withCredits`: the TEST figure plus the credits to this cardholder not reversed. An asset the partner reports no
/// balance for stays "not known": a credit does not make it known.
pub fn with_credits(
    balances: Option<&Vec<(String, String)>>,
    user_id: &str,
    credits: &[(String, Credit)],
) -> Option<Vec<(String, String)>> {
    let mut out = balances?.clone();
    for (_, c) in credits {
        if c.user_id != user_id || c.reversed {
            continue;
        }
        if let Some((_, v)) = out.iter_mut().find(|(a, _)| *a == c.asset_id)
            && let Ok(n) = parse_amount(v)
        {
            *v = format_amount(n + c.amount);
        }
    }
    Some(out)
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used, reason = "a test")]
    use super::*;

    #[test]
    fn a_test_card_number_passes_luhn_and_no_scheme_issues_its_prefix() {
        let pan = test_card_number("6f1c1c2e-0000-4000-8000-000000000001");
        assert!(pan.starts_with("999999"));
        assert_eq!(pan.len(), 16);
        let sum: u32 = pan
            .chars()
            .rev()
            .enumerate()
            .map(|(i, c)| {
                let d = c.to_digit(10).unwrap();
                if i % 2 == 1 {
                    let x = d * 2;
                    if x > 9 { x - 9 } else { x }
                } else {
                    d
                }
            })
            .sum();
        assert_eq!(sum % 10, 0);
    }

    #[test]
    fn no_issuer_refuses_and_the_simulator_in_a_live_posture_refuses_every_mutation() {
        assert!(Issuer::None.issue("x").is_err());
        let live = Issuer::for_setting("card-sim", true, PartnerTerms::nothing_reported());
        assert_eq!(live.mutation_refuse(), Some("bank.card_sim_not_live"));
        assert!(live.issue("x").is_err());
        let sim = Issuer::sim(PartnerTerms::nothing_reported());
        assert_eq!(sim.issue("x").unwrap().issuer_ref, "card-sim:x");
        assert!(!sim.test_secrets());
    }

    #[test]
    fn a_pin_blocks_at_the_try_limit_and_one_purchase_is_never_counted_twice() {
        let mut p = PartnerTerms::nothing_reported();
        p.test_secrets = true;
        let sim = Issuer::sim(p);
        assert_eq!(
            sim.verify_pin("c", "a0", "1234", 2),
            Some(PinVerdict::Unset)
        );
        sim.set_pin("c", "1234").unwrap();
        assert_eq!(
            sim.verify_pin("c", "a1", "0000", 2),
            Some(PinVerdict::Wrong)
        );
        assert_eq!(
            sim.verify_pin("c", "a1", "0000", 2),
            Some(PinVerdict::Wrong)
        );
        assert_eq!(
            sim.verify_pin("c", "a2", "0000", 2),
            Some(PinVerdict::Blocked)
        );
        assert_eq!(
            sim.verify_pin("c", "a3", "1234", 2),
            Some(PinVerdict::Blocked)
        );
        sim.set_pin("c", "1234").unwrap();
        assert_eq!(sim.verify_pin("c", "a4", "1234", 2), Some(PinVerdict::Ok));
    }
}
