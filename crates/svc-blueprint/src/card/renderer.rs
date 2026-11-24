//! The card rasterizer, behind one interface (`card/card-renderer.ts`, `card/http-renderer.ts`): it turns a composed
//! SVG into a hosted PNG's URL, or says why not as data. It never returns a URL that did not come back from a real
//! render, and it never fails the card: every failure is the `unavailable` arm with a typed code.
//!
//! [`Unconfigured`] is what a deployment with no `BLUEPRINT_CARD_RENDERER_URL` runs; [`Http`] posts the SVG to the
//! renderer at that URL. `tests/card_parity.rs` holds [`Http`] to what `HttpCardRenderer` sent and returned for each of
//! a set of answers (`tests/fixtures/card.golden.json`).

use std::sync::Arc;

use service_kit::http::{Fetch, HttpRequest, TIMED_OUT};
use service_kit::json::{self, Json};
use service_kit::schema::Value;

use crate::card::compose::Size;
use crate::door::inputs;

/// `CardRaster`: a real render, or why there is none.
#[derive(Debug, Clone, PartialEq)]
pub enum Raster {
    Rendered { url: String, bytes: f64 },
    Unavailable { code: &'static str, reason: String },
}

impl Raster {
    pub fn rendered(&self) -> Option<&str> {
        match self {
            Raster::Rendered { url, .. } => Some(url),
            Raster::Unavailable { .. } => None,
        }
    }

    /// As the TypeScript builds it, key for key.
    pub fn to_json(&self) -> Json {
        match self {
            Raster::Rendered { url, bytes } => Json::obj([
                ("status", Json::str("rendered")),
                ("url", Json::str(url.clone())),
                ("contentType", Json::str("image/png")),
                ("bytes", Json::Number(*bytes)),
            ]),
            Raster::Unavailable { code, reason } => Json::obj([
                ("status", Json::str("unavailable")),
                ("code", Json::str(*code)),
                ("reason", Json::str(reason.clone())),
            ]),
        }
    }
}

/// `CardRasterizeRequest`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RasterizeRequest {
    pub svg: String,
    pub size: Size,
    pub width: u32,
    pub height: u32,
    /// The asset's identity: the Blueprint's id, never the user's.
    pub blueprint_id: String,
}

/// `CardRenderer`.
pub trait CardRenderer: Send + Sync {
    fn rasterize(&self, request: &RasterizeRequest) -> Raster;
}

/// `UnconfiguredCardRenderer`: this deployment has no renderer, and says so.
pub struct Unconfigured;

pub const UNCONFIGURED_REASON: &str = "No card renderer is configured for this deployment — set BLUEPRINT_CARD_RENDERER_URL. The vector card is unaffected.";

impl CardRenderer for Unconfigured {
    fn rasterize(&self, _request: &RasterizeRequest) -> Raster {
        Raster::Unavailable {
            code: "blueprint.card_renderer_unconfigured",
            reason: UNCONFIGURED_REASON.to_owned(),
        }
    }
}

const UNREACHABLE: &str = "blueprint.card_renderer_unreachable";
const PROTOCOL: &str = "blueprint.card_renderer_protocol";

/// `HttpCardRenderer`: one POST to `<base>/v1/render`, one schema check, one error taxonomy.
pub struct Http {
    base_url: String,
    timeout_ms: u64,
    api_key: Option<String>,
    fetch: Arc<dyn Fetch>,
}

impl Http {
    /// `new HttpCardRenderer({ baseUrl, timeoutMs, apiKey })`: trailing slashes dropped, ten seconds by default.
    pub fn new(
        base_url: &str,
        timeout_ms: Option<u64>,
        api_key: Option<String>,
        fetch: Arc<dyn Fetch>,
    ) -> Http {
        Http {
            base_url: base_url.trim_end_matches('/').to_owned(),
            timeout_ms: timeout_ms.unwrap_or(10_000),
            api_key,
            fetch,
        }
    }
}

/// `issue.path.join('.') || '(root)'` for each issue, the leading row index dropped (the schema is recorded as an array).
fn issue_paths(issues: &[service_kit::schema::Issue]) -> String {
    issues
        .iter()
        .map(|i| {
            let parts: Vec<String> = i
                .path()
                .iter()
                .skip(1)
                .map(|p| match p {
                    Json::String(s) => s.clone(),
                    other => other.compact(),
                })
                .collect();
            if parts.is_empty() {
                "(root)".to_owned()
            } else {
                parts.join(".")
            }
        })
        .collect::<Vec<_>>()
        .join(", ")
}

impl CardRenderer for Http {
    fn rasterize(&self, request: &RasterizeRequest) -> Raster {
        let unavailable = |code: &'static str, reason: String| Raster::Unavailable { code, reason };
        let mut headers = vec![
            ("content-type".to_owned(), "application/json".to_owned()),
            ("accept".to_owned(), "application/json".to_owned()),
        ];
        if let Some(key) = self.api_key.as_deref().filter(|k| !k.is_empty()) {
            headers.push(("authorization".to_owned(), format!("Bearer {key}")));
        }
        let body = Json::obj([
            ("svg", Json::str(request.svg.clone())),
            ("format", Json::str("png")),
            ("width", Json::Number(f64::from(request.width))),
            ("height", Json::Number(f64::from(request.height))),
            (
                "key",
                Json::str(format!(
                    "blueprint/{}/{}.png",
                    request.blueprint_id,
                    request.size.name()
                )),
            ),
        ])
        .compact();
        let sent = self.fetch.fetch(&HttpRequest {
            method: "POST".to_owned(),
            url: format!("{}/v1/render", self.base_url),
            headers,
            body: Some(body),
            timeout_ms: Some(self.timeout_ms),
            refuse_redirect: false,
        });
        let response = match sent {
            Ok(r) => r,
            Err(e) if e.message == TIMED_OUT => {
                return unavailable(
                    UNREACHABLE,
                    format!("Card renderer timed out after {}ms", self.timeout_ms),
                );
            }
            // `describe(err)`: the thrown error's name, never its message; `fetch` throws a `TypeError`.
            Err(_) => {
                return unavailable(
                    UNREACHABLE,
                    "Card renderer is unreachable: TypeError".to_owned(),
                );
            }
        };
        if !response.ok() {
            return unavailable(
                UNREACHABLE,
                format!("Card renderer returned {}", response.status),
            );
        }
        let Ok(body) = json::parse(&response.body) else {
            return unavailable(
                PROTOCOL,
                "Card renderer returned a body that is not JSON".to_owned(),
            );
        };
        let checked = inputs::rows_part("RendererResponse")
            .and_then(|part| inputs::parse_part(part, Value::Array(vec![Value::from_json(&body)])));
        let contract = |detail: String| {
            unavailable(
                PROTOCOL,
                format!("Card renderer response did not match the contract: {detail}"),
            )
        };
        match checked {
            Ok(Ok(Value::Array(rows))) => {
                let row = rows.first().unwrap_or(&Value::Undefined);
                match (row.get("url").as_str(), row.get("bytes").as_number()) {
                    (Some(url), Some(bytes)) => Raster::Rendered {
                        url: url.to_owned(),
                        bytes,
                    },
                    _ => contract("(root)".to_owned()),
                }
            }
            Ok(Ok(_)) => contract("(root)".to_owned()),
            Ok(Err(inputs::Refused::Issues(issues))) => contract(issue_paths(&issues)),
            Ok(Err(inputs::Refused::Thrown(m))) | Err(m) => contract(m),
        }
    }
}

/// `index.ts`'s choice: [`Http`] when `BLUEPRINT_CARD_RENDERER_URL` is set, else [`Unconfigured`]; never a fallback
/// from one to the other.
pub fn from_env(env: &crate::env::BlueprintEnv, fetch: Arc<dyn Fetch>) -> Box<dyn CardRenderer> {
    match env
        .str("BLUEPRINT_CARD_RENDERER_URL")
        .filter(|u| !u.is_empty())
    {
        Some(url) => Box::new(Http::new(
            url,
            env.int("BLUEPRINT_CARD_RENDERER_TIMEOUT_MS")
                .and_then(|ms| u64::try_from(ms).ok()),
            env.str("BLUEPRINT_CARD_RENDERER_API_KEY")
                .map(str::to_owned),
            fetch,
        )),
        None => Box::new(Unconfigured),
    }
}
