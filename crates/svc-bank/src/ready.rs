//! `GET /ready` (`services/svc-bank/src/ready.ts`, `bankHttpReady`, fed by `index.ts`): the job switches, the
//! product kills, whether auto-invest's convert port is wired, and what the card and ramp programmes are, each read
//! once at boot from the environment. Job flags are not module kills: `loanAccrual: true` with `loans: false` is a real
//! deploy.
//!
//! The two programmes are the adapters' own constants: `cardIssuerFor(BANK_CARD_ISSUER)` (`cards/issuer.ts`: `none`
//! is no programme; `card-sim`, live posture or not, is the simulator by name) and `rampProgrammeFor(BANK_RAMP_MODE)`
//! (`ramps/rails.ts`). Both say `simulated: true`: no arrangement of these fields reads as a live programme.

use service_kit::json::Json;

use crate::env::BankEnv;

/// `CardProgramme` of the issuer `BANK_CARD_ISSUER` chooses.
pub fn card_programme(setting: &str) -> Json {
    let (id, display) = match setting {
        "card-sim" => ("card-sim", "Simulated card (no card programme)"),
        _ => ("none", "No card programme"),
    };
    Json::obj([
        ("id", Json::str(id)),
        ("simulated", Json::Bool(true)),
        ("displayName", Json::str(display)),
    ])
}

/// `RampProgramme` of `BANK_RAMP_MODE` (`NO_RAMP_PROGRAMME`, `CRYPTO_LEDGER_PROGRAMME`).
pub fn ramp_programme(setting: &str) -> Json {
    let (id, display, rail) = match setting {
        "crypto-ledger" => (
            "crypto-ledger",
            "Crypto ledger half (no chain broadcast; fiat via pay adapters / socket)",
            Json::str("bank-crypto-ledger"),
        ),
        _ => ("none", "No bank ramp programme", Json::Null),
    };
    Json::obj([
        ("id", Json::str(id)),
        ("simulated", Json::Bool(true)),
        ("displayName", Json::str(display)),
        ("cryptoRail", rail),
        ("fiatLeg", Json::str("socket.psp-partners")),
        ("fiatVia", Json::str("svc-pay.RailAdapter")),
    ])
}

/// `usableTradeConvertUrl(TRADE_URL)`: an `http:` or `https:` URL with a host.
pub fn usable_trade_convert_url(url: Option<&str>) -> bool {
    let Some(url) = url.filter(|u| !u.is_empty()) else {
        return false;
    };
    url::Url::parse(url).is_ok_and(|u| {
        matches!(u.scheme(), "http" | "https") && u.host_str().is_some_and(|h| !h.is_empty())
    })
}

/// The `/ready` body, in `bankHttpReady`'s key order.
pub fn body(env: &BankEnv) -> Json {
    let flag = |k: &str| Json::Bool(env.flag(k).unwrap_or(false));
    Json::obj([
        ("ready", Json::Bool(true)),
        ("scheduledTransfers", flag("SCHEDULED_TRANSFERS_ENABLED")),
        ("interestAccrual", flag("INTEREST_ACCRUAL_ENABLED")),
        ("loanAccrual", flag("LOAN_ACCRUAL_ENABLED")),
        ("loanRiskSweep", flag("LOAN_RISK_SWEEP_ENABLED")),
        ("autoInvest", flag("AUTO_INVEST_ENABLED")),
        ("loans", flag("BANK_LOANS_ENABLED")),
        ("cards", flag("BANK_CARDS_ENABLED")),
        (
            "autoInvestConvertWired",
            Json::Bool(usable_trade_convert_url(env.str("TRADE_URL"))),
        ),
        (
            "cardProgramme",
            card_programme(env.str("BANK_CARD_ISSUER").unwrap_or("none")),
        ),
        (
            "rampProgramme",
            ramp_programme(env.str("BANK_RAMP_MODE").unwrap_or("none")),
        ),
    ])
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used, reason = "a test: a failure is the point")]
    use super::*;

    fn env(extra: &[(&str, &str)]) -> BankEnv {
        crate::env::test_env(extra)
    }

    #[test]
    fn the_default_deploy_has_no_card_or_ramp_programme_and_says_each_is_simulated() {
        assert_eq!(
            body(&env(&[])).compact(),
            concat!(
                r#"{"ready":true,"scheduledTransfers":true,"interestAccrual":true,"loanAccrual":true,"#,
                r#""loanRiskSweep":false,"autoInvest":true,"loans":true,"cards":true,"autoInvestConvertWired":true,"#,
                r#""cardProgramme":{"id":"none","simulated":true,"displayName":"No card programme"},"#,
                r#""rampProgramme":{"id":"none","simulated":true,"displayName":"No bank ramp programme","#,
                r#""cryptoRail":null,"fiatLeg":"socket.psp-partners","fiatVia":"svc-pay.RailAdapter"}}"#
            )
        );
    }

    #[test]
    fn a_job_switch_and_its_product_kill_are_reported_apart() {
        let b = body(&env(&[
            ("BANK_LOANS_ENABLED", "false"),
            ("LOAN_RISK_SWEEP_ENABLED", "true"),
        ]));
        assert_eq!(b.get("loanAccrual"), Some(&Json::Bool(true)));
        assert_eq!(b.get("loans"), Some(&Json::Bool(false)));
        assert_eq!(b.get("loanRiskSweep"), Some(&Json::Bool(true)));
    }

    #[test]
    fn the_simulators_are_named_as_simulators() {
        let b = body(&env(&[
            ("BANK_CARD_ISSUER", "card-sim"),
            ("BANK_RAMP_MODE", "crypto-ledger"),
        ]));
        assert_eq!(
            b.get("cardProgramme").unwrap().compact(),
            r#"{"id":"card-sim","simulated":true,"displayName":"Simulated card (no card programme)"}"#
        );
        assert_eq!(
            b.get("rampProgramme").unwrap().get("cryptoRail"),
            Some(&Json::str("bank-crypto-ledger"))
        );
    }

    #[test]
    fn only_an_http_url_with_a_host_wires_the_convert_port() {
        assert!(usable_trade_convert_url(Some("http://svc-trade:4004")));
        assert!(usable_trade_convert_url(Some("https://trade.example")));
        assert!(!usable_trade_convert_url(None));
        assert!(!usable_trade_convert_url(Some("")));
        assert!(!usable_trade_convert_url(Some("ftp://trade.example")));
        assert!(!usable_trade_convert_url(Some("not a url")));
    }
}
