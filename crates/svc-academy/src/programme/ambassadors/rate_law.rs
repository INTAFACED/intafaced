//! Ambassador IFC pay and revenue-share rate authority (`ambassadors/ifc-pay-rate-law.ts`, D26-P1-C2).
//!
//! Rates are the owner's alone (DIRECTION §8). A blank or unpublished law refuses closed; nothing here invents a
//! session credit, a fee percentage or a bps figure. The schedule only resolves: settlement still needs a Class M
//! ledger recipe, which does not exist, so no money moves from here.

use service_kit::json::{self, Json};
use service_kit::schema::js_trim;

/// `AmbassadorIfcPayLaw`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum IfcPayLaw {
    Unpublished,
    Published {
        /// Owner-published IFC credit per paid session, a decimal string.
        session_credit: String,
        asset: String,
        period: String,
    },
}

/// `AmbassadorRevenueShareLaw`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RevenueShareLaw {
    Unpublished,
    Published {
        /// Share of the named fee basis in bps (0..10000).
        share_of_fee_bps: i64,
        fee_basis: String,
    },
}

/// `UNPUBLISHED_AMBASSADOR_IFC_PAY_LAW`: the production default, `{ published: false }`.
pub const UNPUBLISHED_IFC_PAY_LAW: IfcPayLaw = IfcPayLaw::Unpublished;
/// `UNPUBLISHED_AMBASSADOR_REVENUE_SHARE_LAW`.
pub const UNPUBLISHED_REVENUE_SHARE_LAW: RevenueShareLaw = RevenueShareLaw::Unpublished;

pub const IFC_RATE_AUTHORITY_RESIDUAL: &str = "DIRECTION §8 ambassador IFC rates are owner-only — refuse-closed (never invent session credits)";
pub const REVENUE_SHARE_RATE_AUTHORITY_RESIDUAL: &str = "DIRECTION §8 ambassador revenue-share rates are owner-only — refuse-closed (never invent fee %)";

/// `AmbassadorRateAuthorityRefuseError`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RateAuthorityRefuse {
    pub message: String,
    pub code: &'static str,
    pub residual: &'static str,
}

const IFC_UNSET: &str = "academy.ambassador_pay.rates_unset";
const SHARE_UNSET: &str = "academy.ambassador_revenue_share.rates_unset";

fn ifc_refuse(message: impl Into<String>) -> RateAuthorityRefuse {
    RateAuthorityRefuse {
        message: message.into(),
        code: IFC_UNSET,
        residual: IFC_RATE_AUTHORITY_RESIDUAL,
    }
}

fn share_refuse(message: impl Into<String>) -> RateAuthorityRefuse {
    RateAuthorityRefuse {
        message: message.into(),
        code: SHARE_UNSET,
        residual: REVENUE_SHARE_RATE_AUTHORITY_RESIDUAL,
    }
}

/// A law of either kind, as the pay doors take one.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Law<'a> {
    Ifc(&'a IfcPayLaw),
    Share(&'a RevenueShareLaw),
}

impl Law<'_> {
    /// `law.published === true`.
    pub fn published(self) -> bool {
        match self {
            Law::Ifc(l) => matches!(l, IfcPayLaw::Published { .. }),
            Law::Share(l) => matches!(l, RevenueShareLaw::Published { .. }),
        }
    }
}

/// `isAmbassadorRateAuthorityUnset`.
pub fn is_rate_authority_unset(law: Law<'_>) -> bool {
    !law.published()
}

/// `/^(?:0|[1-9]\d*)(?:\.\d{1,18})?$/`.
fn is_decimal(s: &str) -> bool {
    let (int, frac) = match s.split_once('.') {
        Some((i, f)) => (i, Some(f)),
        None => (s, None),
    };
    let int_ok = int == "0"
        || (int.starts_with(|c: char| ('1'..='9').contains(&c))
            && int.chars().all(|c| c.is_ascii_digit()));
    let frac_ok =
        frac.is_none_or(|f| (1..=18).contains(&f.len()) && f.chars().all(|c| c.is_ascii_digit()));
    int_ok && frac_ok
}

fn session_credit(raw: Option<&Json>, path: &str) -> Result<String, RateAuthorityRefuse> {
    let Some(Json::String(s)) = raw else {
        return Err(ifc_refuse(format!(
            "{path} must be a non-negative decimal string"
        )));
    };
    let trimmed = js_trim(s);
    if !is_decimal(trimmed) {
        return Err(ifc_refuse(format!(
            "{path} must be a non-negative decimal string"
        )));
    }
    // '0', '0.0' and /^0\.0+$/.
    let zero = trimmed == "0"
        || trimmed
            .strip_prefix("0.")
            .is_some_and(|f| !f.is_empty() && f.chars().all(|c| c == '0'));
    if zero {
        return Err(ifc_refuse(format!(
            "{path} must be > 0 when published (zero is not a pay schedule)"
        )));
    }
    Ok(trimmed.to_owned())
}

fn non_empty(
    raw: Option<&Json>,
    path: &str,
    refuse: fn(String) -> RateAuthorityRefuse,
) -> Result<String, RateAuthorityRefuse> {
    match raw {
        Some(Json::String(s)) if !js_trim(s).is_empty() => Ok(js_trim(s).to_owned()),
        _ => Err(refuse(format!("{path} must be a non-empty string"))),
    }
}

/// `JSON.parse` then `typeof parsed === 'object' && parsed`: an object or an array, or the refusal.
fn parse_object<'a>(
    trimmed: &str,
    key: &str,
    refuse: fn(String) -> RateAuthorityRefuse,
    out: &'a mut Json,
) -> Result<Option<&'a Json>, RateAuthorityRefuse> {
    *out = json::parse(trimmed).map_err(|_| refuse(format!("{key} is not valid JSON")))?;
    match out {
        Json::Object(_) | Json::Array(_) => {}
        _ => return Err(refuse(format!("{key} must be an object"))),
    }
    match out.get("published") {
        Some(Json::Bool(false)) => Ok(None),
        Some(Json::Bool(true)) => Ok(Some(out)),
        _ => Err(refuse(format!("{key}.published must be true or false"))),
    }
}

/// `parseAmbassadorIfcPayLawJson`: blank is unpublished; anything malformed refuses (the TypeScript fails boot).
pub fn parse_ifc_pay_law_json(raw: Option<&str>) -> Result<IfcPayLaw, RateAuthorityRefuse> {
    let trimmed = js_trim(raw.unwrap_or_default());
    if trimmed.is_empty() {
        return Ok(IfcPayLaw::Unpublished);
    }
    let mut doc = Json::Null;
    let Some(obj) = parse_object(
        trimmed,
        "ACADEMY_AMBASSADOR_IFC_PAY_LAW_JSON",
        ifc_refuse,
        &mut doc,
    )?
    else {
        return Ok(IfcPayLaw::Unpublished);
    };
    Ok(IfcPayLaw::Published {
        session_credit: session_credit(obj.get("sessionCredit"), "sessionCredit")?,
        asset: non_empty(obj.get("asset"), "asset", ifc_refuse)?,
        period: non_empty(obj.get("period"), "period", ifc_refuse)?,
    })
}

/// `parseAmbassadorRevenueShareLawJson`.
pub fn parse_revenue_share_law_json(
    raw: Option<&str>,
) -> Result<RevenueShareLaw, RateAuthorityRefuse> {
    let trimmed = js_trim(raw.unwrap_or_default());
    if trimmed.is_empty() {
        return Ok(RevenueShareLaw::Unpublished);
    }
    let key = "ACADEMY_AMBASSADOR_REVENUE_SHARE_LAW_JSON";
    let mut doc = Json::Null;
    let Some(obj) = parse_object(trimmed, key, share_refuse, &mut doc)? else {
        return Ok(RevenueShareLaw::Unpublished);
    };
    #[allow(
        clippy::float_cmp,
        reason = "Number.isInteger: a whole number equals its truncation"
    )]
    let bps = match obj.get("shareOfFeeBps") {
        Some(Json::Number(n))
            if n.is_finite() && n.trunc() == *n && *n >= 0.0 && *n <= 10_000.0 =>
        {
            #[allow(
                clippy::cast_possible_truncation,
                reason = "a whole number in 0..=10000"
            )]
            let whole = *n as i64;
            whole
        }
        _ => {
            return Err(share_refuse(format!(
                "{key}.shareOfFeeBps must be an integer 0..10000"
            )));
        }
    };
    Ok(RevenueShareLaw::Published {
        share_of_fee_bps: bps,
        fee_basis: non_empty(obj.get("feeBasis"), "feeBasis", share_refuse)?,
    })
}

/// The IFC law's published schedule.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct IfcSchedule {
    pub session_credit: String,
    pub asset: String,
    pub period: String,
}

/// The revenue-share law's published schedule.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ShareSchedule {
    pub share_of_fee_bps: i64,
    pub fee_basis: String,
}

/// `resolveAmbassadorIfcPayLaw`: the owner-published law only; a per-call published law is an invention.
pub fn resolve_ifc_pay_law(
    request_law: Option<&IfcPayLaw>,
    law: &IfcPayLaw,
) -> Result<IfcSchedule, RateAuthorityRefuse> {
    if matches!(request_law, Some(IfcPayLaw::Published { .. })) {
        return Err(RateAuthorityRefuse {
            message:
                "Ambassador IFC pay refuses per-call rate invent — owner-published authority only"
                    .to_owned(),
            code: "academy.ambassador_pay.invent_refused",
            residual: IFC_RATE_AUTHORITY_RESIDUAL,
        });
    }
    match law {
        IfcPayLaw::Published {
            session_credit,
            asset,
            period,
        } => Ok(IfcSchedule {
            session_credit: session_credit.clone(),
            asset: asset.clone(),
            period: period.clone(),
        }),
        IfcPayLaw::Unpublished => Err(ifc_refuse(
            "Ambassador IFC pay is refuse-closed until owner-published rate authority exists",
        )),
    }
}

/// `resolveAmbassadorRevenueShareLaw`.
pub fn resolve_revenue_share_law(
    request_law: Option<&RevenueShareLaw>,
    law: &RevenueShareLaw,
) -> Result<ShareSchedule, RateAuthorityRefuse> {
    if matches!(request_law, Some(RevenueShareLaw::Published { .. })) {
        return Err(RateAuthorityRefuse {
            message: "Ambassador revenue share refuses per-call rate invent — owner-published authority only".to_owned(),
            code: "academy.ambassador_revenue_share.invent_refused",
            residual: REVENUE_SHARE_RATE_AUTHORITY_RESIDUAL,
        });
    }
    match law {
        RevenueShareLaw::Published {
            share_of_fee_bps,
            fee_basis,
        } => Ok(ShareSchedule {
            share_of_fee_bps: *share_of_fee_bps,
            fee_basis: fee_basis.clone(),
        }),
        RevenueShareLaw::Unpublished => Err(share_refuse(
            "Ambassador revenue share is refuse-closed until owner-published rate authority exists",
        )),
    }
}

/// `ambassadorIfcPayLawIsPublished`.
pub fn ifc_pay_law_is_published(law: &IfcPayLaw) -> bool {
    Law::Ifc(law).published()
}

/// `ambassadorRevenueShareLawIsPublished`.
pub fn revenue_share_law_is_published(law: &RevenueShareLaw) -> bool {
    Law::Share(law).published()
}

/// `ambassadorIfcPayLawStatusLine`: never prints a rate.
pub fn ifc_pay_law_status_line(law: &IfcPayLaw) -> String {
    match law {
        IfcPayLaw::Unpublished => "published=0".to_owned(),
        IfcPayLaw::Published { asset, period, .. } => {
            format!("published=1 period={period} asset={asset}")
        }
    }
}

/// `ambassadorRevenueShareLawStatusLine`.
pub fn revenue_share_law_status_line(law: &RevenueShareLaw) -> String {
    match law {
        RevenueShareLaw::Unpublished => "published=0".to_owned(),
        RevenueShareLaw::Published {
            share_of_fee_bps,
            fee_basis,
        } => {
            format!("published=1 basis={fee_basis} bps={share_of_fee_bps}")
        }
    }
}

#[cfg(test)]
mod tests {
    //! `ambassadors/ifc-pay-rate-law.test.ts`.
    #![allow(clippy::unwrap_used, reason = "a test")]

    use super::*;

    fn ifc_json(credit: &str) -> String {
        format!(
            r#"{{"published":true,"sessionCredit":"{credit}","asset":"IFC","period":"session"}}"#
        )
    }

    #[test]
    fn blank_env_is_unpublished() {
        assert_eq!(parse_ifc_pay_law_json(None), Ok(UNPUBLISHED_IFC_PAY_LAW));
        assert_eq!(
            parse_ifc_pay_law_json(Some("")),
            Ok(UNPUBLISHED_IFC_PAY_LAW)
        );
        assert_eq!(
            parse_ifc_pay_law_json(Some("   ")),
            Ok(UNPUBLISHED_IFC_PAY_LAW)
        );
        assert!(!ifc_pay_law_is_published(&UNPUBLISHED_IFC_PAY_LAW));
        assert_eq!(
            ifc_pay_law_status_line(&UNPUBLISHED_IFC_PAY_LAW),
            "published=0"
        );
    }

    #[test]
    fn published_false_json_is_unpublished() {
        assert_eq!(
            parse_ifc_pay_law_json(Some(r#"{"published":false}"#)),
            Ok(UNPUBLISHED_IFC_PAY_LAW)
        );
        assert_eq!(
            parse_revenue_share_law_json(Some(r#"{"published":false}"#)),
            Ok(UNPUBLISHED_REVENUE_SHARE_LAW)
        );
    }

    #[test]
    fn a_published_ifc_law_parses_and_resolves() {
        let law = parse_ifc_pay_law_json(Some(&ifc_json("12.50000000"))).unwrap();
        let IfcPayLaw::Published { session_credit, .. } = &law else {
            panic!("expected published")
        };
        assert_eq!(session_credit, "12.50000000");
        assert_eq!(
            resolve_ifc_pay_law(None, &law),
            Ok(IfcSchedule {
                session_credit: "12.50000000".to_owned(),
                asset: "IFC".to_owned(),
                period: "session".to_owned()
            })
        );
        assert_eq!(
            ifc_pay_law_status_line(&law),
            "published=1 period=session asset=IFC"
        );
    }

    #[test]
    fn a_published_revenue_share_law_parses_and_resolves() {
        let law = parse_revenue_share_law_json(Some(
            r#"{"published":true,"shareOfFeeBps":500,"feeBasis":"lobby_host_fees"}"#,
        ))
        .unwrap();
        assert_eq!(
            law,
            RevenueShareLaw::Published {
                share_of_fee_bps: 500,
                fee_basis: "lobby_host_fees".to_owned()
            }
        );
        assert_eq!(
            resolve_revenue_share_law(None, &law),
            Ok(ShareSchedule {
                share_of_fee_bps: 500,
                fee_basis: "lobby_host_fees".to_owned()
            })
        );
        assert!(revenue_share_law_is_published(&law));
        assert_eq!(
            revenue_share_law_status_line(&law),
            "published=1 basis=lobby_host_fees bps=500"
        );
    }

    #[test]
    fn a_per_call_published_law_is_invent_refused() {
        let request = IfcPayLaw::Published {
            session_credit: "3.00000000".to_owned(),
            asset: "IFC".to_owned(),
            period: "season".to_owned(),
        };
        let e = resolve_ifc_pay_law(Some(&request), &UNPUBLISHED_IFC_PAY_LAW).unwrap_err();
        assert_eq!(e.code, "academy.ambassador_pay.invent_refused");
    }

    #[test]
    fn no_request_and_unpublished_is_rates_unset_with_its_residual() {
        let e = resolve_ifc_pay_law(None, &UNPUBLISHED_IFC_PAY_LAW).unwrap_err();
        assert_eq!(e.code, "academy.ambassador_pay.rates_unset");
        assert_eq!(e.residual, IFC_RATE_AUTHORITY_RESIDUAL);
        let e = resolve_revenue_share_law(None, &UNPUBLISHED_REVENUE_SHARE_LAW).unwrap_err();
        assert_eq!(e.code, "academy.ambassador_revenue_share.rates_unset");
        assert_eq!(e.residual, REVENUE_SHARE_RATE_AUTHORITY_RESIDUAL);
    }

    #[test]
    fn a_malformed_or_zero_credit_fails_closed() {
        assert!(parse_ifc_pay_law_json(Some("{not-json")).is_err());
        assert!(parse_ifc_pay_law_json(Some(r#"{"published":true}"#)).is_err());
        assert!(parse_ifc_pay_law_json(Some(&ifc_json("0"))).is_err());
        assert!(
            parse_revenue_share_law_json(Some(
                r#"{"published":true,"shareOfFeeBps":10001,"feeBasis":"x"}"#
            ))
            .is_err()
        );
        // The other zero spellings and shapes the TypeScript refuses.
        for credit in ["0.0", "0.000", "-1", "01", "1.", "1.1234567890123456789"] {
            assert!(
                parse_ifc_pay_law_json(Some(&ifc_json(credit))).is_err(),
                "{credit}"
            );
        }
        assert_eq!(
            parse_ifc_pay_law_json(Some("null")).unwrap_err().message,
            "ACADEMY_AMBASSADOR_IFC_PAY_LAW_JSON must be an object"
        );
        assert_eq!(
            parse_ifc_pay_law_json(Some("[]")).unwrap_err().message,
            "ACADEMY_AMBASSADOR_IFC_PAY_LAW_JSON.published must be true or false"
        );
        assert!(
            parse_revenue_share_law_json(Some(
                r#"{"published":true,"shareOfFeeBps":2.5,"feeBasis":"x"}"#
            ))
            .is_err()
        );
        assert!(
            parse_ifc_pay_law_json(Some(&ifc_json(" 0.5 "))).is_ok(),
            "a credit is trimmed"
        );
    }
}
