//! svc-bank's client for svc-pay's withdrawal addresses (`pay-withdrawal-addresses-client.ts`, J-portfolio-03 #2):
//! one bounded POST of `{userId, withdrawalIds}` to `/internal/withdrawals/addresses`, signed over its body with the
//! shared service secret. A missing or malformed URL, a secret under 32 characters, a non-2xx reply, a reply that does
//! not parse or names an id that was not asked, a timeout and a failed fetch all answer `None`: no address is assumed.

use std::collections::BTreeMap;

use service_kit::http::{Fetch, HttpRequest};
use service_kit::json::{self, Json};
use service_kit::s2s::{js_length, legacy_headers, system_seconds};

use super::service::{PayAddresses, is_uuid};

/// `PAY_WITHDRAWAL_ADDRESSES_PATH`.
pub const PATH: &str = "/internal/withdrawals/addresses";
/// `PAY_WITHDRAWAL_ADDRESSES_MAX`.
pub const MAX: usize = 500;
const TIMEOUT_MS: u64 = 3_000;

pub struct PayHttp {
    base: Option<String>,
    secret: Option<String>,
    fetch: Box<dyn Fetch>,
}

/// `new URL(payUrl)`, refused unless http or https with no credentials, query or fragment; the href without its
/// trailing slash.
fn base_of(pay_url: Option<&str>) -> Option<String> {
    let url = url::Url::parse(pay_url?).ok()?;
    if !matches!(url.scheme(), "http" | "https")
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return None;
    }
    let href = url.as_str();
    Some(href.strip_suffix('/').unwrap_or(href).to_owned())
}

impl PayHttp {
    pub fn new(pay_url: Option<&str>, secret: Option<&str>, fetch: Box<dyn Fetch>) -> PayHttp {
        PayHttp {
            base: base_of(pay_url),
            secret: secret.map(str::to_owned),
            fetch,
        }
    }
}

/// `payWithdrawalAddressesReplySchema` (strict) and the asked ids: the answer, or `None`.
fn read_reply(body: &str, asked: &[String]) -> Option<BTreeMap<String, String>> {
    let Json::Object(top) = json::parse(body).ok()? else {
        return None;
    };
    if top.len() != 1 {
        return None;
    }
    let Some(Json::Array(rows)) = top
        .first()
        .filter(|(k, _)| k == "addresses")
        .map(|(_, v)| v)
    else {
        return None;
    };
    if rows.len() > MAX {
        return None;
    }
    let mut out = BTreeMap::new();
    for r in rows {
        let Json::Object(fields) = r else {
            return None;
        };
        if fields
            .iter()
            .any(|(k, _)| k != "withdrawalId" && k != "address")
        {
            return None;
        }
        let (Some(Json::String(id)), Some(Json::String(address))) =
            (r.get("withdrawalId"), r.get("address"))
        else {
            return None;
        };
        let n = js_length(address);
        if !is_uuid(id) || !(1..=256).contains(&n) {
            return None;
        }
        // Only ids that were asked: an answer naming any other is not trusted at all.
        if !asked.contains(id) {
            return None;
        }
        out.insert(id.clone(), address.clone());
    }
    Some(out)
}

impl PayAddresses for PayHttp {
    fn addresses_for(
        &self,
        user_id: &str,
        withdrawal_ids: &[String],
    ) -> Option<BTreeMap<String, String>> {
        if withdrawal_ids.is_empty() {
            return Some(BTreeMap::new());
        }
        let base = self.base.as_ref()?;
        let secret = self.secret.as_deref().filter(|s| js_length(s) >= 32)?;
        let mut ids: Vec<String> = Vec::new();
        for id in withdrawal_ids {
            if !ids.contains(id) {
                ids.push(id.clone());
            }
        }
        let user_len = js_length(user_id);
        if !(1..=128).contains(&user_len) || ids.len() > MAX || !ids.iter().all(|i| is_uuid(i)) {
            return None;
        }
        let body = Json::obj([
            ("userId", Json::str(user_id)),
            (
                "withdrawalIds",
                Json::Array(ids.iter().cloned().map(Json::String).collect()),
            ),
        ])
        .compact();
        let mut headers = vec![
            ("content-type".to_owned(), "application/json".to_owned()),
            ("cache-control".to_owned(), "no-store".to_owned()),
        ];
        headers.extend(legacy_headers("svc-bank", secret, &body, system_seconds()).ok()?);
        let response = self
            .fetch
            .fetch(&HttpRequest {
                method: "POST".to_owned(),
                url: format!("{base}{PATH}"),
                headers,
                body: Some(body),
                timeout_ms: Some(TIMEOUT_MS),
                refuse_redirect: true,
            })
            .ok()?;
        if !response.ok() {
            return None;
        }
        read_reply(&response.body, &ids)
    }
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used, reason = "a test")]
    use super::*;
    use service_kit::http::{FetchError, HttpResponse};
    use std::sync::{Arc, Mutex};

    const SECRET: &str = "a-pay-withdrawal-secret-that-is-long-enough";
    const W1: &str = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const W2: &str = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

    struct Fake(
        Arc<Mutex<Vec<HttpRequest>>>,
        Result<HttpResponse, FetchError>,
    );

    impl Fetch for Fake {
        fn fetch(&self, req: &HttpRequest) -> Result<HttpResponse, FetchError> {
            self.0.lock().unwrap().push(req.clone());
            self.1.clone()
        }
    }

    fn client(
        url: Option<&str>,
        status: u16,
        body: &str,
    ) -> (PayHttp, Arc<Mutex<Vec<HttpRequest>>>) {
        let seen = Arc::new(Mutex::new(Vec::new()));
        let fake = Fake(
            seen.clone(),
            Ok(HttpResponse {
                status,
                body: body.to_owned(),
            }),
        );
        (PayHttp::new(url, Some(SECRET), Box::new(fake)), seen)
    }

    #[test]
    fn asks_once_signed_and_answers_only_the_asked_ids() {
        let reply = format!(r#"{{"addresses":[{{"withdrawalId":"{W1}","address":"0xabc"}}]}}"#);
        let (c, seen) = client(Some("http://pay.internal:4020/"), 200, &reply);
        let got = c
            .addresses_for("u1", &[W1.to_owned(), W2.to_owned(), W1.to_owned()])
            .unwrap();
        assert_eq!(got.get(W1).map(String::as_str), Some("0xabc"));
        let req = seen.lock().unwrap()[0].clone();
        assert_eq!(
            req.url,
            "http://pay.internal:4020/internal/withdrawals/addresses"
        );
        assert_eq!(
            req.body.as_deref(),
            Some(format!(r#"{{"userId":"u1","withdrawalIds":["{W1}","{W2}"]}}"#).as_str())
        );
        let names: Vec<&str> = req.headers.iter().map(|(k, _)| k.as_str()).collect();
        assert_eq!(
            names,
            vec![
                "content-type",
                "cache-control",
                "x-intafaced-service",
                "x-intafaced-service-ts",
                "x-intafaced-service-body",
                "x-intafaced-service-sig"
            ]
        );
        assert!(req.refuse_redirect);
    }

    #[test]
    fn answers_none_rather_than_assume() {
        let stranger = r#"{"addresses":[{"withdrawalId":"cccccccc-cccc-4ccc-8ccc-cccccccccccc","address":"0x1"}]}"#;
        assert!(
            client(Some("http://pay"), 200, stranger)
                .0
                .addresses_for("u", &[W1.to_owned()])
                .is_none()
        );
        assert!(
            client(Some("http://pay"), 500, "{}")
                .0
                .addresses_for("u", &[W1.to_owned()])
                .is_none()
        );
        assert!(
            client(Some("http://pay"), 200, "nope")
                .0
                .addresses_for("u", &[W1.to_owned()])
                .is_none()
        );
        assert!(
            client(Some("http://pay"), 200, r#"{"addresses":[],"x":1}"#)
                .0
                .addresses_for("u", &[W1.to_owned()])
                .is_none()
        );
        assert!(
            client(None, 200, "{}")
                .0
                .addresses_for("u", &[W1.to_owned()])
                .is_none()
        );
        assert!(
            client(Some("ftp://pay"), 200, "{}")
                .0
                .addresses_for("u", &[W1.to_owned()])
                .is_none()
        );
        assert!(
            client(Some("http://pay?x=1"), 200, "{}")
                .0
                .addresses_for("u", &[W1.to_owned()])
                .is_none()
        );
        let (c, seen) = client(Some("http://pay"), 200, "{}");
        assert_eq!(c.addresses_for("u", &[]), Some(BTreeMap::new()));
        assert!(seen.lock().unwrap().is_empty());
        let short = PayHttp::new(
            Some("http://pay"),
            Some("short"),
            Box::new(Fake(
                Arc::default(),
                Err(FetchError {
                    message: "x".into(),
                }),
            )),
        );
        assert!(short.addresses_for("u", &[W1.to_owned()]).is_none());
    }
}
