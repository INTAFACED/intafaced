//! Ambassador IFC pay and revenue share under rate authority (`ambassadors/ifc-pay.ts`, D26-P1-C2).
//!
//! 1. No rate is invented: the schedule comes only from [`super::rate_law`].
//! 2. A published schedule opens a dry-run quote, nothing more.
//! 3. Live settlement refuses closed until a Class M ledger recipe exists: ambassadors hold no balance, and nothing
//!    here reaches the ledger.
//! 4. A residency that is present must be accepted before a quote.

use service_kit::json::Json;

use super::rate_law::{
    IFC_RATE_AUTHORITY_RESIDUAL, IfcPayLaw, Law, REVENUE_SHARE_RATE_AUTHORITY_RESIDUAL,
    RateAuthorityRefuse, RevenueShareLaw, UNPUBLISHED_IFC_PAY_LAW, UNPUBLISHED_REVENUE_SHARE_LAW,
    ifc_pay_law_is_published, is_rate_authority_unset, resolve_ifc_pay_law,
    resolve_revenue_share_law, revenue_share_law_is_published,
};

/// `AmbassadorPayKind`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PayKind {
    IfcPay,
    RevenueShare,
}

impl PayKind {
    pub fn name(self) -> &'static str {
        match self {
            PayKind::IfcPay => "ifc_pay",
            PayKind::RevenueShare => "revenue_share",
        }
    }
}

/// `PublicAmbassadorPayKind`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PublicKind {
    IfcPay,
    RevenueShare,
    Residency,
}

impl PublicKind {
    pub fn name(self) -> &'static str {
        match self {
            PublicKind::IfcPay => "ifc_pay",
            PublicKind::RevenueShare => "revenue_share",
            PublicKind::Residency => "residency",
        }
    }
}

/// `AmbassadorPayRefuseError`: named, with no amount on it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PayRefuse {
    pub message: String,
    pub code: &'static str,
    pub residual: &'static str,
    pub kind: PayKind,
}

impl PayRefuse {
    /// `JSON.stringify(err)`: an Error's own enumerable fields (`code`, `residual`, `kind`, `name`), never its message.
    pub fn to_json(&self) -> Json {
        Json::obj([
            ("code", Json::str(self.code)),
            ("residual", Json::str(self.residual)),
            ("kind", Json::str(self.kind.name())),
            ("name", Json::str("AmbassadorPayRefuseError")),
        ])
    }
}

pub const IFC_PAY_RESIDUAL: &str = "TRK-academy.ambassadors Class M — IFC pay schedule + ledger recipe unset; refuse-closed (no invent rates)";
pub const REVENUE_SHARE_RESIDUAL: &str = "TRK-academy.ambassadors Class M — revenue share basis + ledger recipe unset; refuse-closed (no invent fee %)";
pub const IFC_PAY_RECIPE_RESIDUAL: &str = "TRK-academy.ambassadors Class M — ledger recipe unset; rate authority present but settlement refuse-closed";
pub const REVENUE_SHARE_RECIPE_RESIDUAL: &str = "TRK-academy.ambassadors Class M — ledger recipe unset; revenue-share rate authority present but settlement refuse-closed";
pub const RESIDENCY_GATE_RESIDUAL: &str = "TRK-academy.ambassadors — residency must be accepted before IFC / share quote under rate authority";

fn map_rate_refuse(e: RateAuthorityRefuse, kind: PayKind) -> PayRefuse {
    PayRefuse {
        message: e.message,
        code: e.code,
        residual: e.residual,
        kind,
    }
}

/// `refuseAmbassadorIfcPay`.
pub fn refuse_ifc_pay() -> PayRefuse {
    PayRefuse {
        message: "Ambassador IFC pay is refuse-closed until owner-published pay schedule and a ledger recipe exist"
            .to_owned(),
        code: "academy.ambassador_pay.rates_unset",
        residual: IFC_PAY_RESIDUAL,
        kind: PayKind::IfcPay,
    }
}

/// `refuseAmbassadorRevenueShare`.
pub fn refuse_revenue_share() -> PayRefuse {
    PayRefuse {
        message:
            "Ambassador revenue share is refuse-closed until owner-published share basis and a ledger recipe exist"
                .to_owned(),
        code: "academy.ambassador_revenue_share.rates_unset",
        residual: REVENUE_SHARE_RESIDUAL,
        kind: PayKind::RevenueShare,
    }
}

/// `refuseAmbassadorPayAttempt`: always refuses, dry run included.
pub fn refuse_pay_attempt(kind: PayKind, _dry_run: bool) -> PayRefuse {
    match kind {
        PayKind::RevenueShare => refuse_revenue_share(),
        PayKind::IfcPay => refuse_ifc_pay(),
    }
}

/// `ambassadorPayResidualIsHonest`.
pub fn pay_residual_is_honest(residual: &str) -> bool {
    let names_class = residual.contains("Class M") || residual.contains("DIRECTION §8");
    let names_refuse = residual.contains("refuse-closed") || residual.contains("must be accepted");
    let names_no_invent = residual.contains("no invent")
        || residual.contains("never invent")
        || residual.contains("residency");
    names_class && names_refuse && names_no_invent
}

/// `AmbassadorPayPlaneStatus`. Settlement stays dark on this stage.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PayPlaneStatus {
    pub ifc_pay_enabled: bool,
    pub revenue_share_enabled: bool,
    pub ifc_rate_authority_published: bool,
    pub revenue_share_rate_authority_published: bool,
    pub ifc_pay_quote_enabled: bool,
    pub revenue_share_quote_enabled: bool,
    pub class_m: bool,
    pub residual_ifc_pay: &'static str,
    pub residual_revenue_share: &'static str,
}

impl PayPlaneStatus {
    /// The `ambassadorPayPlane` answer, in its output schema's key order.
    pub fn to_json(&self) -> Json {
        Json::obj([
            ("ifcPayEnabled", Json::Bool(self.ifc_pay_enabled)),
            (
                "revenueShareEnabled",
                Json::Bool(self.revenue_share_enabled),
            ),
            (
                "ifcRateAuthorityPublished",
                Json::Bool(self.ifc_rate_authority_published),
            ),
            (
                "revenueShareRateAuthorityPublished",
                Json::Bool(self.revenue_share_rate_authority_published),
            ),
            ("ifcPayQuoteEnabled", Json::Bool(self.ifc_pay_quote_enabled)),
            (
                "revenueShareQuoteEnabled",
                Json::Bool(self.revenue_share_quote_enabled),
            ),
            ("classM", Json::Bool(self.class_m)),
            ("residualIfcPay", Json::str(self.residual_ifc_pay)),
            (
                "residualRevenueShare",
                Json::str(self.residual_revenue_share),
            ),
        ])
    }
}

/// `ambassadorPayPlaneStatus`.
pub fn pay_plane_status(
    ifc: Option<&IfcPayLaw>,
    share: Option<&RevenueShareLaw>,
) -> PayPlaneStatus {
    let ifc_published = ifc_pay_law_is_published(ifc.unwrap_or(&UNPUBLISHED_IFC_PAY_LAW));
    let share_published =
        revenue_share_law_is_published(share.unwrap_or(&UNPUBLISHED_REVENUE_SHARE_LAW));
    PayPlaneStatus {
        ifc_pay_enabled: false,
        revenue_share_enabled: false,
        ifc_rate_authority_published: ifc_published,
        revenue_share_rate_authority_published: share_published,
        ifc_pay_quote_enabled: ifc_published,
        revenue_share_quote_enabled: share_published,
        class_m: true,
        residual_ifc_pay: if ifc_published {
            IFC_PAY_RECIPE_RESIDUAL
        } else {
            IFC_RATE_AUTHORITY_RESIDUAL
        },
        residual_revenue_share: if share_published {
            REVENUE_SHARE_RECIPE_RESIDUAL
        } else {
            REVENUE_SHARE_RATE_AUTHORITY_RESIDUAL
        },
    }
}

fn bit(b: bool) -> &'static str {
    if b { "1" } else { "0" }
}

/// `ambassadorPayStatusLine`: no money fields.
pub fn pay_status_line(s: &PayPlaneStatus) -> String {
    format!(
        "ifcPay={} revenueShare={} ifcAuth={} shareAuth={} classM={}",
        bit(s.ifc_pay_enabled),
        bit(s.revenue_share_enabled),
        bit(s.ifc_rate_authority_published),
        bit(s.revenue_share_rate_authority_published),
        bit(s.class_m)
    )
}

/// `ambassadorPayPlaneIsDark`.
pub fn pay_plane_is_dark(s: &PayPlaneStatus) -> bool {
    !s.ifc_pay_enabled && !s.revenue_share_enabled && s.class_m
}

/// `AmbassadorPayRefuseResult`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PayRefuseResult {
    pub kind: PayKind,
    pub code: &'static str,
    pub residual: &'static str,
    pub message: String,
}

impl PayRefuseResult {
    pub fn to_json(&self) -> Json {
        Json::obj([
            ("ok", Json::Bool(false)),
            ("kind", Json::str(self.kind.name())),
            ("code", Json::str(self.code)),
            ("residual", Json::str(self.residual)),
            ("message", Json::str(self.message.clone())),
        ])
    }
}

/// `tryRefuseAmbassadorPay`.
pub fn try_refuse_pay(kind: PayKind) -> PayRefuseResult {
    let e = refuse_pay_attempt(kind, false);
    PayRefuseResult {
        kind: e.kind,
        code: e.code,
        residual: e.residual,
        message: e.message,
    }
}

/// `ambassadorPayRefuseExportLine`.
pub fn pay_refuse_export_line(r: &PayRefuseResult) -> String {
    format!("{},{}", r.kind.name(), r.code)
}

/// `ambassadorPayRefuseExportHeader`.
pub fn pay_refuse_export_header() -> &'static str {
    "kind,code"
}

fn assert_residency_gate(residency_status: Option<&str>, kind: PayKind) -> Result<(), PayRefuse> {
    match residency_status {
        None | Some("accepted") => Ok(()),
        Some(_) => Err(PayRefuse {
            message: "Ambassador pay quote requires an accepted residency under rate authority"
                .to_owned(),
            code: match kind {
                PayKind::IfcPay => "academy.ambassador_pay.residency_not_accepted",
                PayKind::RevenueShare => "academy.ambassador_revenue_share.residency_not_accepted",
            },
            residual: RESIDENCY_GATE_RESIDUAL,
            kind,
        }),
    }
}

/// A dry-run quote under owner-published authority: `AmbassadorIfcPayQuote` or `AmbassadorRevenueShareQuote`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PayQuote {
    Ifc {
        beneficiary_id: String,
        session_credit: String,
        asset: String,
        period: String,
        residency_status: Option<String>,
    },
    Share {
        beneficiary_id: String,
        share_of_fee_bps: i64,
        fee_basis: String,
        residency_status: Option<String>,
    },
}

fn opt(s: Option<&String>) -> Json {
    s.map_or(Json::Null, |v| Json::str(v.clone()))
}

impl PayQuote {
    /// The quote as the TypeScript returns it, keys in its literal's order.
    pub fn to_json(&self) -> Json {
        match self {
            PayQuote::Ifc {
                beneficiary_id,
                session_credit,
                asset,
                period,
                residency_status,
            } => Json::obj([
                ("ok", Json::Bool(true)),
                ("kind", Json::str("ifc_pay")),
                ("dryRun", Json::Bool(true)),
                ("authority", Json::str("owner_published")),
                ("beneficiaryId", Json::str(beneficiary_id.clone())),
                ("sessionCredit", Json::str(session_credit.clone())),
                ("asset", Json::str(asset.clone())),
                ("period", Json::str(period.clone())),
                ("residencyStatus", opt(residency_status.as_ref())),
                ("settlement", Json::str("refuse_recipe_unset")),
            ]),
            PayQuote::Share {
                beneficiary_id,
                share_of_fee_bps,
                fee_basis,
                residency_status,
            } => Json::obj([
                ("ok", Json::Bool(true)),
                ("kind", Json::str("revenue_share")),
                ("dryRun", Json::Bool(true)),
                ("authority", Json::str("owner_published")),
                ("beneficiaryId", Json::str(beneficiary_id.clone())),
                ("shareOfFeeBps", Json::int(*share_of_fee_bps)),
                ("feeBasis", Json::str(fee_basis.clone())),
                ("residencyStatus", opt(residency_status.as_ref())),
                ("settlement", Json::str("refuse_recipe_unset")),
            ]),
        }
    }
}

/// `AmbassadorPayAttemptInput`.
#[derive(Debug, Clone, Copy)]
pub struct PayAttempt<'a> {
    pub kind: PayKind,
    pub law: Law<'a>,
    pub beneficiary_id: &'a str,
    /// `dryRun`: absent is a live settle.
    pub dry_run: bool,
    pub residency_status: Option<&'a str>,
    pub request_law: Option<Law<'a>>,
}

/// `attemptAmbassadorPay`: unset rates refuse; an unaccepted residency refuses; a published law with `dryRun` quotes
/// from the law alone; a published law without it refuses `recipe_unset`.
pub fn attempt_pay(input: &PayAttempt<'_>) -> Result<PayQuote, PayRefuse> {
    let beneficiary_id = service_kit::schema::js_trim(input.beneficiary_id);
    if beneficiary_id.is_empty() {
        return Err(PayRefuse {
            message: "beneficiaryId required".to_owned(),
            code: match input.kind {
                PayKind::IfcPay => "academy.ambassador_pay.class_m",
                PayKind::RevenueShare => "academy.ambassador_revenue_share.class_m",
            },
            residual: match input.kind {
                PayKind::IfcPay => IFC_PAY_RESIDUAL,
                PayKind::RevenueShare => REVENUE_SHARE_RESIDUAL,
            },
            kind: input.kind,
        });
    }
    assert_residency_gate(input.residency_status, input.kind)?;
    let residency_status = input.residency_status.map(str::to_owned);

    if input.kind == PayKind::IfcPay {
        // `input.law as AmbassadorIfcPayLaw`: a revenue-share law read as IFC has no session credit to publish.
        let unpublished = IfcPayLaw::Unpublished;
        let law = match input.law {
            Law::Ifc(l) => l,
            Law::Share(_) => &unpublished,
        };
        let request = match input.request_law {
            Some(Law::Ifc(l)) => Some(l),
            _ => None,
        };
        let published =
            resolve_ifc_pay_law(request, law).map_err(|e| map_rate_refuse(e, PayKind::IfcPay))?;
        if !input.dry_run {
            return Err(PayRefuse {
                message: "Ambassador IFC settlement is refuse-closed until a Class M ledger recipe exists".to_owned(),
                code: "academy.ambassador_pay.recipe_unset",
                residual: IFC_PAY_RECIPE_RESIDUAL,
                kind: PayKind::IfcPay,
            });
        }
        return Ok(PayQuote::Ifc {
            beneficiary_id: beneficiary_id.to_owned(),
            session_credit: published.session_credit,
            asset: published.asset,
            period: published.period,
            residency_status,
        });
    }

    let unpublished = RevenueShareLaw::Unpublished;
    let law = match input.law {
        Law::Share(l) => l,
        Law::Ifc(_) => &unpublished,
    };
    let request = match input.request_law {
        Some(Law::Share(l)) => Some(l),
        _ => None,
    };
    let published = resolve_revenue_share_law(request, law)
        .map_err(|e| map_rate_refuse(e, PayKind::RevenueShare))?;
    if !input.dry_run {
        return Err(PayRefuse {
            message: "Ambassador revenue-share settlement is refuse-closed until a Class M ledger recipe exists"
                .to_owned(),
            code: "academy.ambassador_revenue_share.recipe_unset",
            residual: REVENUE_SHARE_RECIPE_RESIDUAL,
            kind: PayKind::RevenueShare,
        });
    }
    Ok(PayQuote::Share {
        beneficiary_id: beneficiary_id.to_owned(),
        share_of_fee_bps: published.share_of_fee_bps,
        fee_basis: published.fee_basis,
        residency_status,
    })
}

/// `attemptResidencyIfcPay`: an accepted residency and published IFC rates give a dry-run quote (`dryRun` defaults
/// to true).
pub fn attempt_residency_ifc_pay(
    law: &IfcPayLaw,
    beneficiary_id: &str,
    residency_status: &str,
    dry_run: Option<bool>,
) -> Result<PayQuote, PayRefuse> {
    attempt_pay(&PayAttempt {
        kind: PayKind::IfcPay,
        law: Law::Ifc(law),
        beneficiary_id,
        dry_run: dry_run.unwrap_or(true),
        residency_status: Some(residency_status),
        request_law: None,
    })
}

/// `PublicAmbassadorPayQuote`: always a refusal, never a payable quote.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PublicQuote {
    pub kind: PublicKind,
    pub code: &'static str,
    pub reason: &'static str,
    pub rate_authority_published: bool,
    pub residual: &'static str,
    pub message: &'static str,
}

impl PublicQuote {
    /// In `publicAmbassadorPayQuoteOut`'s key order.
    pub fn to_json(&self) -> Json {
        Json::obj([
            ("status", Json::str("refuse")),
            ("ok", Json::Bool(false)),
            ("payable", Json::Bool(false)),
            ("inventedIfc", Json::Bool(false)),
            ("kind", Json::str(self.kind.name())),
            ("code", Json::str(self.code)),
            ("reason", Json::str(self.reason)),
            (
                "rateAuthorityPublished",
                Json::Bool(self.rate_authority_published),
            ),
            ("residual", Json::str(self.residual)),
            ("message", Json::str(self.message)),
        ])
    }
}

/// `decidePublicAmbassadorPayQuote`.
pub fn decide_public_pay_quote(
    kind: PublicKind,
    law: Law<'_>,
    request_law: Option<Law<'_>>,
) -> PublicQuote {
    let pay_kind = if kind == PublicKind::RevenueShare {
        PayKind::RevenueShare
    } else {
        PayKind::IfcPay
    };
    let ifc = pay_kind == PayKind::IfcPay;
    let published = !is_rate_authority_unset(law);
    let rate_residual = if ifc {
        IFC_RATE_AUTHORITY_RESIDUAL
    } else {
        REVENUE_SHARE_RATE_AUTHORITY_RESIDUAL
    };
    if request_law.is_some_and(Law::published) {
        return PublicQuote {
            kind,
            code: if ifc {
                "academy.ambassador_pay.invent_refused"
            } else {
                "academy.ambassador_revenue_share.invent_refused"
            },
            reason: "invent",
            rate_authority_published: published,
            residual: rate_residual,
            message: "Ambassador pay refuses per-call rate invent — owner-published authority only",
        };
    }
    if !published {
        return PublicQuote {
            kind,
            code: if ifc {
                "academy.ambassador_pay.rates_unset"
            } else {
                "academy.ambassador_revenue_share.rates_unset"
            },
            reason: "unset",
            rate_authority_published: false,
            residual: rate_residual,
            message: if ifc {
                "Ambassador IFC pay is refuse-closed until owner-published rate authority exists"
            } else {
                "Ambassador revenue share is refuse-closed until owner-published rate authority exists"
            },
        };
    }
    PublicQuote {
        kind,
        code: if ifc {
            "academy.ambassador_pay.recipe_unset"
        } else {
            "academy.ambassador_revenue_share.recipe_unset"
        },
        reason: "class_m",
        rate_authority_published: true,
        residual: if ifc {
            IFC_PAY_RECIPE_RESIDUAL
        } else {
            REVENUE_SHARE_RECIPE_RESIDUAL
        },
        message: "Ambassador pay quote is not payable on the public door — Class M ledger recipe unset",
    }
}

/// `decidePublicResidencyPayQuote`: a residency never looks payable while the IFC rate authority is unset; its
/// status does not change the answer.
pub fn decide_public_residency_pay_quote(
    law: &IfcPayLaw,
    _residency_status: Option<&str>,
    request_law: Option<&IfcPayLaw>,
) -> PublicQuote {
    decide_public_pay_quote(
        PublicKind::Residency,
        Law::Ifc(law),
        request_law.map(Law::Ifc),
    )
}

/// `ambassadorIfcDefaultsCarryNoRates`.
pub fn ifc_defaults_carry_no_rates(ifc: &IfcPayLaw, share: &RevenueShareLaw) -> bool {
    matches!(ifc, IfcPayLaw::Unpublished) && matches!(share, RevenueShareLaw::Unpublished)
}

/// `ambassadorPayLooksPayable`: anything shaped like a payable quote.
pub fn pay_looks_payable(quote: &Json) -> bool {
    let has = |k: &str| quote.get(k).is_some();
    if quote.get("ok") == Some(&Json::Bool(true)) || quote.get("payable") == Some(&Json::Bool(true))
    {
        return true;
    }
    if quote
        .get("status")
        .is_some_and(|s| *s != Json::str("refuse"))
    {
        return true;
    }
    has("sessionCredit") || has("shareOfFeeBps") || has("amount") || has("rate") || has("quote")
}

const NAMED_PAY_REFUSE: [&str; 10] = [
    "academy.ambassador_pay.rates_unset",
    "academy.ambassador_pay.class_m",
    "academy.ambassador_pay.recipe_unset",
    "academy.ambassador_pay.invent_refused",
    "academy.ambassador_pay.residency_not_accepted",
    "academy.ambassador_revenue_share.rates_unset",
    "academy.ambassador_revenue_share.class_m",
    "academy.ambassador_revenue_share.recipe_unset",
    "academy.ambassador_revenue_share.invent_refused",
    "academy.ambassador_revenue_share.residency_not_accepted",
];

/// `ambassadorPayRefuseCodeFromUnknown`: the named pay refusal a code (an error's, or its cause's) is, if any.
pub fn pay_refuse_code(code: Option<&str>) -> Option<&'static str> {
    let code = code?;
    NAMED_PAY_REFUSE.iter().copied().find(|c| *c == code)
}

/// `unsetRatesPublicDoorHolds`: a public refusal names its code and does not look payable.
pub fn unset_rates_public_door_holds(quote: &Json) -> bool {
    if pay_looks_payable(quote) {
        return false;
    }
    let f = Json::Bool(false);
    if quote.get("ok") != Some(&f)
        || quote.get("payable") != Some(&f)
        || quote.get("inventedIfc") != Some(&f)
    {
        return false;
    }
    let code = match quote.get("code") {
        Some(Json::String(s)) => s.as_str(),
        _ => "",
    };
    match quote.get("reason") {
        Some(Json::String(r)) if r == "unset" => {
            code == "academy.ambassador_pay.rates_unset"
                || code == "academy.ambassador_revenue_share.rates_unset"
        }
        Some(Json::String(r)) if r == "invent" => {
            code == "academy.ambassador_pay.invent_refused"
                || code == "academy.ambassador_revenue_share.invent_refused"
        }
        _ => {
            code == "academy.ambassador_pay.recipe_unset"
                || code == "academy.ambassador_revenue_share.recipe_unset"
        }
    }
}

#[cfg(test)]
mod tests {
    //! `ambassadors/ifc-pay.test.ts`.
    #![allow(clippy::unwrap_used, clippy::panic, reason = "a test")]

    use super::*;
    use crate::programme::ambassadors::rate_law::parse_ifc_pay_law_json;

    const BENEFICIARY: &str = "11111111-1111-4111-8111-111111111111";

    fn published_ifc() -> IfcPayLaw {
        parse_ifc_pay_law_json(Some(
            r#"{"published":true,"sessionCredit":"10.00000000","asset":"IFC","period":"session"}"#,
        ))
        .unwrap()
    }

    fn published_share() -> RevenueShareLaw {
        RevenueShareLaw::Published {
            share_of_fee_bps: 250,
            fee_basis: "lobby_host_fees".to_owned(),
        }
    }

    fn has_decimal(s: &str) -> bool {
        // /\d+\.\d+/
        let b = s.as_bytes();
        b.windows(3)
            .any(|w| w[0].is_ascii_digit() && w[1] == b'.' && w[2].is_ascii_digit())
    }

    fn attempt(
        kind: PayKind,
        law: Law<'_>,
        dry_run: bool,
        residency: Option<&str>,
    ) -> Result<PayQuote, PayRefuse> {
        attempt_pay(&PayAttempt {
            kind,
            law,
            beneficiary_id: BENEFICIARY,
            dry_run,
            residency_status: residency,
            request_law: None,
        })
    }

    #[test]
    fn refuses_ifc_pay_without_inventing_rates() {
        let e = refuse_ifc_pay();
        assert_eq!(e.code, "academy.ambassador_pay.rates_unset");
        assert_eq!(e.kind, PayKind::IfcPay);
        assert_eq!(e.residual, IFC_PAY_RESIDUAL);
        assert!(pay_residual_is_honest(e.residual));
        assert!(!has_decimal(&e.to_json().compact()));
    }

    #[test]
    fn refuses_revenue_share_without_inventing_fee_percent() {
        let e = refuse_revenue_share();
        assert_eq!(e.code, "academy.ambassador_revenue_share.rates_unset");
        assert_eq!(e.kind, PayKind::RevenueShare);
        assert_eq!(e.residual, REVENUE_SHARE_RESIDUAL);
        assert!(pay_residual_is_honest(e.residual));
    }

    #[test]
    fn a_legacy_dry_run_without_law_also_refuses() {
        assert_eq!(
            refuse_pay_attempt(PayKind::IfcPay, true).kind,
            PayKind::IfcPay
        );
        assert_eq!(
            refuse_pay_attempt(PayKind::RevenueShare, true).kind,
            PayKind::RevenueShare
        );
    }

    #[test]
    fn the_pay_plane_is_dark_for_settlement() {
        let s = pay_plane_status(None, None);
        assert!(!s.ifc_pay_enabled);
        assert!(!s.revenue_share_enabled);
        assert!(!s.ifc_rate_authority_published);
        assert!(!s.ifc_pay_quote_enabled);
        assert!(s.class_m);
        assert!(pay_plane_is_dark(&s));
        assert_eq!(
            pay_status_line(&s),
            "ifcPay=0 revenueShare=0 ifcAuth=0 shareAuth=0 classM=1"
        );
    }

    #[test]
    fn try_refuse_returns_its_shape_without_amounts() {
        let r = try_refuse_pay(PayKind::IfcPay);
        assert_eq!(r.kind, PayKind::IfcPay);
        assert_eq!(r.code, "academy.ambassador_pay.rates_unset");
        assert_eq!(pay_refuse_export_header(), "kind,code");
        assert_eq!(
            pay_refuse_export_line(&r),
            "ifc_pay,academy.ambassador_pay.rates_unset"
        );
        let Json::Object(fields) = r.to_json() else {
            panic!()
        };
        let mut keys: Vec<_> = fields.iter().map(|(k, _)| k.as_str()).collect();
        keys.sort_unstable();
        assert_eq!(keys, ["code", "kind", "message", "ok", "residual"]);
        assert_eq!(r.to_json().get("ok"), Some(&Json::Bool(false)));
    }

    #[test]
    fn residuals_name_class_m_or_direction_and_no_invent() {
        assert!(pay_residual_is_honest(IFC_PAY_RESIDUAL));
        assert!(pay_residual_is_honest(REVENUE_SHARE_RESIDUAL));
        assert!(pay_residual_is_honest(IFC_RATE_AUTHORITY_RESIDUAL));
        assert!(!pay_residual_is_honest("ok to pay"));
    }

    #[test]
    fn an_unpublished_law_refuses_rates_unset_on_attempt() {
        let e = attempt(
            PayKind::IfcPay,
            Law::Ifc(&UNPUBLISHED_IFC_PAY_LAW),
            true,
            None,
        )
        .unwrap_err();
        assert_eq!(e.code, "academy.ambassador_pay.rates_unset");
        assert_eq!(e.residual, IFC_RATE_AUTHORITY_RESIDUAL);
    }

    #[test]
    fn a_published_ifc_law_with_dry_run_quotes_from_authority_only() {
        let law = published_ifc();
        let q = attempt(PayKind::IfcPay, Law::Ifc(&law), true, Some("accepted")).unwrap();
        let j = q.to_json();
        assert_eq!(j.get("ok"), Some(&Json::Bool(true)));
        assert_eq!(j.get("sessionCredit"), Some(&Json::str("10.00000000")));
        assert_eq!(j.get("asset"), Some(&Json::str("IFC")));
        assert_eq!(j.get("authority"), Some(&Json::str("owner_published")));
        assert_eq!(j.get("settlement"), Some(&Json::str("refuse_recipe_unset")));
    }

    #[test]
    fn a_published_ifc_law_live_settle_refuses_recipe_unset() {
        let law = published_ifc();
        assert!(attempt(PayKind::IfcPay, Law::Ifc(&law), false, Some("accepted")).is_err());
        let e = attempt(PayKind::IfcPay, Law::Ifc(&law), false, None).unwrap_err();
        assert_eq!(e.code, "academy.ambassador_pay.recipe_unset");
        assert_eq!(e.residual, IFC_PAY_RECIPE_RESIDUAL);
    }

    #[test]
    fn a_published_revenue_share_quotes_and_the_plane_shows_authority() {
        let share = published_share();
        let q = attempt(PayKind::RevenueShare, Law::Share(&share), true, None).unwrap();
        let j = q.to_json();
        assert_eq!(j.get("ok"), Some(&Json::Bool(true)));
        assert_eq!(j.get("shareOfFeeBps"), Some(&Json::int(250)));
        assert_eq!(j.get("feeBasis"), Some(&Json::str("lobby_host_fees")));
        let ifc = published_ifc();
        let plane = pay_plane_status(Some(&ifc), Some(&share));
        assert!(plane.ifc_rate_authority_published);
        assert!(plane.revenue_share_rate_authority_published);
        assert!(plane.ifc_pay_quote_enabled);
        assert!(!plane.ifc_pay_enabled);
        assert!(pay_plane_is_dark(&plane));
        assert_eq!(
            pay_status_line(&plane),
            "ifcPay=0 revenueShare=0 ifcAuth=1 shareAuth=1 classM=1"
        );
    }

    #[test]
    fn the_residency_gate_refuses_applied_and_rejected_and_quotes_accepted() {
        let law = published_ifc();
        assert!(attempt_residency_ifc_pay(&law, BENEFICIARY, "applied", Some(true)).is_err());
        let e = attempt_residency_ifc_pay(&law, BENEFICIARY, "rejected", None).unwrap_err();
        assert_eq!(e.code, "academy.ambassador_pay.residency_not_accepted");
        assert_eq!(e.residual, RESIDENCY_GATE_RESIDUAL);
        let j = attempt_residency_ifc_pay(&law, BENEFICIARY, "accepted", None)
            .unwrap()
            .to_json();
        assert_eq!(j.get("ok"), Some(&Json::Bool(true)));
        assert_eq!(j.get("residencyStatus"), Some(&Json::str("accepted")));
        assert_eq!(j.get("sessionCredit"), Some(&Json::str("10.00000000")));
    }

    #[test]
    fn an_unpublished_share_law_refuses_even_on_dry_run() {
        assert!(
            attempt(
                PayKind::RevenueShare,
                Law::Share(&UNPUBLISHED_REVENUE_SHARE_LAW),
                true,
                None
            )
            .is_err()
        );
    }

    #[test]
    fn a_blank_beneficiary_refuses_class_m() {
        // The refusal before the residency gate and the law (a crash point of its own).
        let law = published_ifc();
        let e = attempt_pay(&PayAttempt {
            kind: PayKind::IfcPay,
            law: Law::Ifc(&law),
            beneficiary_id: "  ",
            dry_run: true,
            residency_status: Some("rejected"),
            request_law: None,
        })
        .unwrap_err();
        assert_eq!(e.code, "academy.ambassador_pay.class_m");
        assert_eq!(e.residual, IFC_PAY_RESIDUAL);
    }

    #[test]
    fn an_unset_ifc_public_quote_is_a_typed_refusal_without_magnitudes() {
        let q =
            decide_public_pay_quote(PublicKind::IfcPay, Law::Ifc(&UNPUBLISHED_IFC_PAY_LAW), None)
                .to_json();
        assert_eq!(q.get("status"), Some(&Json::str("refuse")));
        assert_eq!(
            q.get("code"),
            Some(&Json::str("academy.ambassador_pay.rates_unset"))
        );
        assert_eq!(q.get("reason"), Some(&Json::str("unset")));
        assert!(unset_rates_public_door_holds(&q));
        assert!(!pay_looks_payable(&q));
        assert!(!q.compact().contains("sessionCredit"));
    }

    #[test]
    fn an_accepted_residency_with_unset_rates_is_not_payable() {
        let q = decide_public_residency_pay_quote(&UNPUBLISHED_IFC_PAY_LAW, Some("accepted"), None);
        assert_eq!(q.kind, PublicKind::Residency);
        assert_eq!(q.code, "academy.ambassador_pay.rates_unset");
        assert!(!pay_looks_payable(&q.to_json()));
    }

    #[test]
    fn a_per_call_invent_on_the_public_door_refuses_without_quoting() {
        let ifc = published_ifc();
        let q = decide_public_pay_quote(
            PublicKind::IfcPay,
            Law::Ifc(&UNPUBLISHED_IFC_PAY_LAW),
            Some(Law::Ifc(&ifc)),
        );
        assert_eq!(q.code, "academy.ambassador_pay.invent_refused");
        assert!(!pay_looks_payable(&q.to_json()));
    }

    #[test]
    fn a_published_law_on_the_public_door_is_still_not_payable() {
        let ifc = published_ifc();
        let q = decide_public_pay_quote(PublicKind::IfcPay, Law::Ifc(&ifc), None);
        assert_eq!(q.code, "academy.ambassador_pay.recipe_unset");
        assert_eq!(q.reason, "class_m");
        assert!(unset_rates_public_door_holds(&q.to_json()));
    }

    #[test]
    fn it_fails_closed_if_an_unset_quote_were_marked_payable() {
        let fake = Json::obj([
            ("status", Json::str("ok")),
            ("ok", Json::Bool(true)),
            ("payable", Json::Bool(true)),
            ("sessionCredit", Json::str("1.00")),
        ]);
        assert!(pay_looks_payable(&fake));
    }

    #[test]
    fn the_unpublished_defaults_carry_no_session_credit_or_share_bps() {
        assert!(ifc_defaults_carry_no_rates(
            &UNPUBLISHED_IFC_PAY_LAW,
            &UNPUBLISHED_REVENUE_SHARE_LAW
        ));
        assert_eq!(UNPUBLISHED_IFC_PAY_LAW, IfcPayLaw::Unpublished);
        assert_eq!(UNPUBLISHED_REVENUE_SHARE_LAW, RevenueShareLaw::Unpublished);
    }

    #[test]
    fn unset_ifc_pay_and_revenue_share_refuse_without_inventing_rates() {
        let ifc = try_refuse_pay(PayKind::IfcPay);
        let share = try_refuse_pay(PayKind::RevenueShare);
        assert_eq!(ifc.code, "academy.ambassador_pay.rates_unset");
        assert_eq!(share.code, "academy.ambassador_revenue_share.rates_unset");
        assert_eq!(
            pay_refuse_code(Some(refuse_ifc_pay().code)),
            Some("academy.ambassador_pay.rates_unset")
        );
        for r in [&ifc, &share] {
            let j = r.to_json();
            assert_eq!(j.get("ok"), Some(&Json::Bool(false)));
            assert!(!pay_looks_payable(&j));
            assert!(
                !j.compact().contains("shareOfFeeBps") && !j.compact().contains("sessionCredit")
            );
        }
        assert_eq!(pay_refuse_code(Some("academy.room_full")), None);
    }

    #[test]
    fn a_sneaky_published_default_fails_the_no_rates_pin() {
        assert!(!ifc_defaults_carry_no_rates(
            &published_ifc(),
            &UNPUBLISHED_REVENUE_SHARE_LAW
        ));
        assert!(!ifc_defaults_carry_no_rates(
            &UNPUBLISHED_IFC_PAY_LAW,
            &published_share()
        ));
    }

    #[test]
    fn the_pay_modules_ship_no_default_rate() {
        for src in [include_str!("ifc_pay.rs"), include_str!("rate_law.rs")] {
            let body = src.split("#[cfg(test)]").next().unwrap_or_default();
            for forbidden in [
                "const DEFAULT_IFC",
                "const DEFAULT_SHARE",
                "const DEFAULT_RATE",
                "const DEFAULT_BPS",
                "const DEFAULT_FEE",
            ] {
                assert!(!body.contains(forbidden), "{forbidden}");
            }
            // shareOfFeeBps / sessionCredit never set to a literal number.
            for (i, _) in body.match_indices("share_of_fee_bps: ") {
                let next = body.get(i + 18..i + 19).unwrap_or_default();
                assert!(
                    !next.chars().all(|c| c.is_ascii_digit()) || next.is_empty(),
                    "a literal bps"
                );
            }
            for (i, _) in body.match_indices("session_credit: \"") {
                let next = body.get(i + 17..i + 18).unwrap_or_default();
                assert!(
                    !next.chars().all(|c| c.is_ascii_digit()) || next.is_empty(),
                    "a literal credit"
                );
            }
        }
    }
}
