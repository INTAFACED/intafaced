//! svc-bank's `spaces.ownedAccounts` (`packages/contracts/src/bank-own-spaces-client.ts`): which named spaces are the
//! customer's. One bounded request signed over its body with the shared secret. A missing or malformed URL, a short
//! secret, a non-2xx reply, a reply its schema refuses, a timeout and a failed request all answer unavailable (`None`):
//! no answer is never "no spaces".

use std::sync::Arc;

use crate::http::{Fetch, HttpRequest};
use crate::json::Json;
use crate::ports::{OwnSpace, OwnSpaces};
use crate::s2s::{js_length, legacy_headers, system_seconds};

/// What a door client sends: the endpoint (`None` when the URL is missing or not a plain http(s) URL), the secret, the
/// timeout, and where the request goes.
pub struct DoorClient {
    pub endpoint: Option<String>,
    pub secret: Option<String>,
    pub timeout_ms: u64,
    pub fetch: Arc<dyn Fetch>,
    pub clock: Arc<dyn Fn() -> i64 + Send + Sync>,
}

/// `new URL(raw)` checked as the clients check it, then `${url.href without its trailing slash}/trpc/<procedure>`.
pub fn door_endpoint(raw: Option<&str>, procedure: &str) -> Option<String> {
    let url = url::Url::parse(raw?).ok()?;
    if !matches!(url.scheme(), "http" | "https")
        || !url.username().is_empty()
        || url.password().is_some_and(|p| !p.is_empty())
        || url.query().is_some_and(|q| !q.is_empty())
        || url.fragment().is_some_and(|f| !f.is_empty())
    {
        return None;
    }
    let href = url.as_str();
    Some(format!(
        "{}/trpc/{procedure}",
        href.strip_suffix('/').unwrap_or(href)
    ))
}

impl DoorClient {
    /// POSTs `{"userId":...}` (checked: 1 to 128 characters) and returns `result.data` of the reply, or `None`.
    pub fn post_user(&self, user_id: &str) -> Option<Json> {
        let endpoint = self.endpoint.as_ref()?;
        let secret = self.secret.as_ref().filter(|s| js_length(s) >= 32)?;
        if !(1..=128).contains(&user_id.chars().count()) {
            return None;
        }
        let body = Json::obj([("userId", Json::str(user_id))]).compact();
        let mut headers = vec![
            ("content-type".to_owned(), "application/json".to_owned()),
            ("cache-control".to_owned(), "no-store".to_owned()),
        ];
        headers.extend(legacy_headers("svc-tax", secret, &body, (self.clock)()).ok()?);
        let res = self
            .fetch
            .fetch(&HttpRequest {
                method: "POST".to_owned(),
                url: endpoint.clone(),
                headers,
                body: Some(body),
                timeout_ms: Some(self.timeout_ms),
                refuse_redirect: true,
            })
            .ok()?;
        if !res.ok() {
            return None;
        }
        let envelope = crate::json::parse(&res.body).ok()?;
        let Json::Object(fields) = &envelope else {
            return None;
        };
        let result = fields.iter().find(|(k, _)| k == "result").map(|(_, v)| v)?;
        // `envelope.result?.data`: absent unless `result` is an object holding `data`; undefined fails every schema.
        result.get("data").cloned()
    }
}

/// The default clock: `new Date()` in seconds.
pub fn default_clock() -> Arc<dyn Fn() -> i64 + Send + Sync> {
    Arc::new(system_seconds)
}

/// `z.string().guid()`.
fn is_guid(s: &str) -> bool {
    let b = s.as_bytes();
    b.len() == 36
        && b.iter().enumerate().all(|(i, c)| {
            if [8, 13, 18, 23].contains(&i) {
                *c == b'-'
            } else {
                c.is_ascii_hexdigit()
            }
        })
}

/// Only these keys, as `.strict()` allows.
pub fn only_keys(v: &Json, keys: &[&str]) -> bool {
    match v {
        Json::Object(fields) => fields.iter().all(|(k, _)| keys.contains(&k.as_str())),
        _ => false,
    }
}

/// `bankOwnSpacesSchema.safeParse(data)`.
fn parse_spaces(data: &Json) -> Option<Vec<OwnSpace>> {
    if !only_keys(data, &["spaces"]) {
        return None;
    }
    let Some(Json::Array(rows)) = data.get("spaces") else {
        return None;
    };
    rows.iter()
        .map(|r| {
            if !only_keys(r, &["spaceId", "assetId", "name", "archived"]) {
                return None;
            }
            let s = |k: &str| match r.get(k) {
                Some(Json::String(v)) => Some(v.clone()),
                _ => None,
            };
            let space_id = s("spaceId").filter(|v| is_guid(v))?;
            let asset_id = s("assetId").filter(|v| !v.is_empty())?;
            let name = s("name").filter(|v| !v.is_empty())?;
            let Some(Json::Bool(archived)) = r.get("archived") else {
                return None;
            };
            Some(OwnSpace {
                space_id,
                asset_id,
                name,
                archived: *archived,
            })
        })
        .collect()
}

/// `createBankOwnSpacesClient({ bankUrl, secret })`.
pub struct BankOwnSpaces {
    door: DoorClient,
}

impl BankOwnSpaces {
    pub fn new(
        bank_url: Option<&str>,
        secret: Option<&str>,
        fetch: Arc<dyn Fetch>,
    ) -> BankOwnSpaces {
        BankOwnSpaces {
            door: DoorClient {
                endpoint: door_endpoint(bank_url, "spaces.ownedAccounts"),
                secret: secret.map(str::to_owned),
                timeout_ms: 3000,
                fetch,
                clock: default_clock(),
            },
        }
    }

    pub fn with_clock(mut self, clock: Arc<dyn Fn() -> i64 + Send + Sync>) -> BankOwnSpaces {
        self.door.clock = clock;
        self
    }
}

impl OwnSpaces for BankOwnSpaces {
    fn list(&self, user_id: &str) -> Option<Vec<OwnSpace>> {
        parse_spaces(&self.door.post_user(user_id)?)
    }
}
