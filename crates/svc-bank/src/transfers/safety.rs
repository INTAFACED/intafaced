//! The slice's safety calls (`safety/`): the region notice a signed-out page reads (`safety.regionNotice`,
//! `region-notice.ts`), svc-support's one question about a reported transfer (`safety.transferSent`), and the person's
//! own extra checks on a send to another person (`extra-controls.ts` `assertExtrasAllow`).

use service_kit::json::Json;
use service_kit::money::{Amount, parse_amount};

use super::Deps;
use super::ports::ExtraControls;
use crate::door::Ctx;
use crate::errors::Refusal;
use crate::partner::refuse;
use crate::spaces::space::{pg, with};

/// `publishedWording`: the owner's sentence, trimmed; blank is none.
pub fn published_wording(raw: Option<&str>) -> Option<String> {
    let text = raw.unwrap_or("").trim();
    (!text.is_empty()).then(|| text.to_owned())
}

/// `regionNotice`: whether the bank is refused in the caller's region, by which authority, and the owner's wording.
/// A refusal for a verification tier is not the region's, so it never shows.
pub fn region_notice(ctx: &Ctx<'_>, wording: Option<&str>) -> Json {
    let refused = ctx.jurisdiction.check_open(ctx.region).err();
    let field = |v: Option<String>| v.map_or(Json::Null, Json::str);
    let blocked = refused.is_some();
    let blocked_by = refused
        .as_ref()
        .filter(|r| r.code == "denied.region_blocked")
        .and_then(|_| ctx.jurisdiction.blocked_by(ctx.region));
    Json::obj([
        ("region", Json::str(ctx.region)),
        ("blocked", Json::Bool(blocked)),
        ("code", field(refused.as_ref().map(|r| r.code.clone()))),
        (
            "restriction",
            field(refused.as_ref().map(|r| r.message.clone())),
        ),
        ("blockedBy", field(blocked_by.map(str::to_owned))),
        (
            "wording",
            field(if blocked {
                published_wording(wording)
            } else {
                None
            }),
        ),
    ])
}

/// `PersonalPayService.sentBy`: whether this person sent this transfer (posted, or reserved and on its way).
pub fn sent_by(d: &Deps<'_>, user_id: &str, transfer_id: &str) -> Result<bool, Refusal> {
    with(d.store, |c| {
        let rows = c
            .query(
                "SELECT 1 AS one FROM bank.personal_transfers \
                  WHERE transfer_id = $1 AND from_user_id = $2 AND status IN ('posted', 'reserved') \
                  LIMIT 1",
                &[&transfer_id, &user_id],
            )
            .map_err(|e| pg(&e))?;
        Ok(!rows.is_empty())
    })
}

/// `assertExtrasAllow`: a send to another person above the person's own extra-checks allowance waits, as those checks
/// cannot be done yet. A send to themselves, no allowance, no controls, or another asset is let through.
pub fn assert_extras_allow(
    extras: &dyn ExtraControls,
    user_id: &str,
    to_user_id: &str,
    asset_id: &str,
    amount: Amount,
) -> Result<(), Refusal> {
    if to_user_id.trim().to_lowercase() == user_id.to_lowercase() {
        return Ok(());
    }
    let read = extras.read(user_id)?;
    let Some((allowance, allowance_asset)) = read.allowance else {
        return Ok(());
    };
    if read.controls.is_empty() || allowance_asset != asset_id {
        return Ok(());
    }
    if amount <= parse_amount(&allowance).map_err(Refusal::Other)? {
        return Ok(());
    }
    Err(refuse(
        "bank.extra_controls_pending",
        format!(
            "This send is above your extra-checks allowance of {allowance} {allowance_asset}, and those checks cannot be done yet, so it waits: nothing was sent. Send {allowance} {allowance_asset} or less, or change your extra checks."
        ),
    ))
}

/// The answer of one of this part's calls, by its path; `None` for a path outside it.
pub fn answer(d: &Deps<'_>, ctx: &Ctx<'_>) -> Option<Result<Json, Refusal>> {
    match ctx.call.path {
        "safety.regionNotice" => Some(Ok(region_notice(
            ctx,
            d.w.settings.blocked_region_notice.as_deref(),
        ))),
        "safety.transferSent" => {
            let text = |k: &str| ctx.input.get(k).as_str().unwrap_or_default().to_owned();
            Some(
                sent_by(d, &text("userId"), &text("transferId"))
                    .map(|sent| Json::obj([("sent", Json::Bool(sent))])),
            )
        }
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used, clippy::panic, reason = "a test")]
    use super::*;
    use crate::transfers::ports::{Extras, MemoryIdentity};

    const ANN: &str = "11111111-1111-4111-8111-111111111111";
    const BEN: &str = "22222222-2222-4222-8222-222222222222";

    fn amount(s: &str) -> Amount {
        parse_amount(s).unwrap()
    }

    fn identity() -> MemoryIdentity {
        let m = MemoryIdentity::default();
        m.set_extras(
            ANN,
            Extras {
                controls: vec!["known_locations".to_owned()],
                allowance: Some(("100".to_owned(), "USDT".to_owned())),
            },
        );
        m
    }

    #[test]
    fn a_send_above_the_allowance_waits_and_names_it() {
        let m = identity();
        let Err(Refusal::Bank(e)) = assert_extras_allow(&m, ANN, BEN, "USDT", amount("100.01"))
        else {
            panic!()
        };
        assert_eq!(e.row.code, "bank.extra_controls_pending");
        assert!(e.message.contains("allowance of 100 USDT"));
    }

    #[test]
    fn at_or_below_the_allowance_another_asset_and_a_send_to_yourself_go_through() {
        let m = identity();
        assert!(assert_extras_allow(&m, ANN, BEN, "USDT", amount("100")).is_ok());
        assert!(assert_extras_allow(&m, ANN, BEN, "USDC", amount("5000")).is_ok());
        assert!(
            assert_extras_allow(
                &m,
                ANN,
                &format!(" {} ", ANN.to_uppercase()),
                "USDT",
                amount("5000")
            )
            .is_ok()
        );
    }

    #[test]
    fn no_controls_or_no_allowance_is_no_limit() {
        let m = MemoryIdentity::default();
        assert!(assert_extras_allow(&m, ANN, BEN, "USDT", amount("5000")).is_ok());
        m.set_extras(
            ANN,
            Extras {
                controls: Vec::new(),
                allowance: Some(("1".to_owned(), "USDT".to_owned())),
            },
        );
        assert!(assert_extras_allow(&m, ANN, BEN, "USDT", amount("5000")).is_ok());
    }

    #[test]
    fn an_unreadable_or_unwired_identity_refuses_the_send() {
        let m = identity();
        *m.extras_failure.lock().unwrap() = Some(refuse("bank.extra_controls_unavailable", "x"));
        let Err(Refusal::Bank(e)) = assert_extras_allow(&m, ANN, BEN, "USDT", amount("1")) else {
            panic!()
        };
        assert_eq!(e.row.code, "bank.extra_controls_unavailable");
        let Err(Refusal::Bank(e)) = assert_extras_allow(
            &crate::transfers::ports::NoIdentity,
            ANN,
            BEN,
            "USDT",
            amount("1"),
        ) else {
            panic!()
        };
        assert_eq!(e.row.code, "bank.extra_controls_unset");
    }

    #[test]
    fn blank_wording_is_none() {
        assert_eq!(published_wording(Some("  ")), None);
        assert_eq!(published_wording(None), None);
        assert_eq!(
            published_wording(Some(" Not here. ")).as_deref(),
            Some("Not here.")
        );
    }
}
