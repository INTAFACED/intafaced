//! The partner's send of an own move to the person's wallet on chain (`OwnMoveDelivery`: the pay-in partner's `deliver`,
//! `ramps/payin-sim.ts` `payinSimDelivery`), and the chain read that confirms a move's deposit leg
//! (`OwnMoveDepositReader`, wired by nobody today: every deposit leg stays claimed).

use service_kit::http::{Fetch, HttpRequest};
use service_kit::json::{self, Json};
use service_kit::money::Amount;

/// `OwnMoveDelivery`: the partner's send, once per key; the transfer's hash back, or why it did not deliver.
pub trait Delivery: Send + Sync {
    fn deliver(&self, key: &str, to: &str, asset_id: &str, amount: &str) -> Result<String, String>;
}

/// `OwnMoveDepositReader`: true only when `tx` is mined and is a transfer from `wallet` to the venue's deposit address
/// of exactly `amount` of `asset_id`.
pub trait DepositReader: Send + Sync {
    fn confirmed(&self, tx: &str, wallet: &str, asset_id: &str, amount: Amount) -> bool;
}

/// `payinSimDelivery`: the TEST partner's delivery at a loopback address, one POST, the transfer's hash back.
pub struct PayinSimDelivery {
    pub url: String,
    pub fetch: Box<dyn Fetch>,
}

/// `^0x[0-9a-fA-F]{64}$`.
fn tx_hash(s: &str) -> bool {
    s.len() == 66 && s.starts_with("0x") && s.bytes().skip(2).all(|b| b.is_ascii_hexdigit())
}

impl Delivery for PayinSimDelivery {
    fn deliver(&self, key: &str, to: &str, asset_id: &str, amount: &str) -> Result<String, String> {
        let body = Json::obj([
            ("to", Json::str(to)),
            ("asset", Json::str(asset_id)),
            ("amount", Json::str(amount)),
            ("key", Json::str(key)),
        ]);
        let res = self
            .fetch
            .fetch(&HttpRequest {
                method: "POST".to_owned(),
                url: self.url.clone(),
                headers: vec![("content-type".to_owned(), "application/json".to_owned())],
                body: Some(body.compact()),
                timeout_ms: Some(90_000),
                refuse_redirect: true,
            })
            .map_err(|e| e.message)?;
        let answer = json::parse(&res.body).unwrap_or(Json::Null);
        match answer.get("hash") {
            Some(Json::String(h)) if res.status == 200 && tx_hash(h) => Ok(h.clone()),
            _ => {
                let error = match answer.get("error") {
                    None | Some(Json::Null) => String::new(),
                    Some(Json::String(s)) => s.clone(),
                    Some(other) => other.compact(),
                };
                Err(format!(
                    "the TEST partner did not deliver: {} {}",
                    res.status,
                    error.chars().take(200).collect::<String>()
                ))
            }
        }
    }
}

/// The send `onrampPartnerFor` gives own moves: none unless `BANK_ONRAMP_PARTNER=payin-sim` with a delivery address. The
/// stand-in refuses to start outside dev or test, and a delivery address that is not a loopback http(s) base; its
/// catalogue, page and return checks are the ramps slice's.
pub fn for_stack(
    setting: Option<&str>,
    deliver_url: Option<&str>,
    app_env: Option<&str>,
    node_env: Option<&str>,
    fetch: Box<dyn Fetch>,
) -> Result<Option<PayinSimDelivery>, String> {
    if setting != Some("payin-sim") {
        return Ok(None);
    }
    if !crate::cards::terms::dev_or_test(app_env, node_env) {
        return Err("BANK_ONRAMP_PARTNER=payin-sim is a local-test stand-in that takes no money; it runs only with APP_ENV exactly dev or test.".to_owned());
    }
    let raw = deliver_url.map(service_kit::money::js_trim).unwrap_or("");
    if raw.is_empty() {
        return Ok(None);
    }
    let loopback = url::Url::parse(raw).ok().filter(|u| {
        matches!(u.host_str(), Some("127.0.0.1" | "localhost" | "[::1]"))
            && matches!(u.scheme(), "http" | "https")
            && u.query().is_none()
            && u.fragment().is_none()
            && u.username().is_empty()
            && u.password().is_none()
    });
    match loopback {
        Some(u) => Ok(Some(PayinSimDelivery {
            url: u.to_string(),
            fetch,
        })),
        None => Err("BANK_PAYIN_SIM_DELIVER_URL, when set, must be a loopback http(s) address (the TEST partner on the stack).".to_owned()),
    }
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used, reason = "a test")]
    use super::*;
    use service_kit::http::{FetchError, HttpResponse};

    struct Answer(u16, &'static str);

    impl Fetch for Answer {
        fn fetch(&self, req: &HttpRequest) -> Result<HttpResponse, FetchError> {
            assert!(req.refuse_redirect);
            assert_eq!(
                req.body.as_deref(),
                Some(r#"{"to":"0xw","asset":"USDC","amount":"600","key":"k1"}"#)
            );
            Ok(HttpResponse {
                status: self.0,
                body: self.1.to_owned(),
            })
        }
    }

    fn send(status: u16, body: &'static str) -> Result<String, String> {
        PayinSimDelivery {
            url: "http://127.0.0.1:9/deliver".to_owned(),
            fetch: Box::new(Answer(status, body)),
        }
        .deliver("k1", "0xw", "USDC", "600")
    }

    #[test]
    fn the_send_answers_the_transfers_hash_or_says_why_it_did_not_deliver() {
        let h = format!("0x{}", "Ab".repeat(32));
        let ok = Box::leak(format!(r#"{{"hash":"{h}"}}"#).into_boxed_str());
        assert_eq!(send(200, ok).unwrap(), h);
        assert_eq!(
            send(502, r#"{"error":"payin.send_failed"}"#).unwrap_err(),
            "the TEST partner did not deliver: 502 payin.send_failed"
        );
        assert_eq!(
            send(200, r#"{"hash":"0x12"}"#).unwrap_err(),
            "the TEST partner did not deliver: 200 "
        );
    }

    #[test]
    fn the_send_is_wired_only_for_the_stand_in_on_a_dev_or_test_stack_at_a_loopback_address() {
        let f = || -> Box<dyn Fetch> { Box::new(service_kit::http::UreqFetch::new()) };
        let dev = (Some("dev"), Some("development"));
        let wired = |s, u| for_stack(s, u, dev.0, dev.1, f());
        assert!(wired(None, Some("http://127.0.0.1:1/d")).unwrap().is_none());
        assert!(wired(Some("payin-sim"), None).unwrap().is_none());
        assert!(
            wired(Some("payin-sim"), Some("http://127.0.0.1:1/d"))
                .unwrap()
                .is_some()
        );
        assert!(wired(Some("payin-sim"), Some("https://chain.example/d")).is_err());
        assert!(wired(Some("payin-sim"), Some("http://localhost:1/d?x=1")).is_err());
        assert!(
            for_stack(
                Some("payin-sim"),
                Some("http://127.0.0.1:1/d"),
                Some("prod"),
                None,
                f()
            )
            .is_err()
        );
    }
}
