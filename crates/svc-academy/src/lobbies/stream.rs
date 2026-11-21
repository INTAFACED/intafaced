//! The stream provider (`stream/provider.ts`, §8.3): LiveKit's RoomService over Twirp and its HS256 join tokens, the
//! choice between it and the refusing `NullStream` (`streamProviderFromEnv`), and the provider's honesty cards. A
//! constructed LiveKit is never reported usable: `/ready` does not probe RoomService.

use std::sync::Arc;

use base64::Engine as _;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use hmac::{Hmac, Mac};
use service_kit::http::{Fetch, HttpRequest};
use service_kit::json::{self, Json};
use service_kit::time::Instant;
use sha2::Sha256;

use crate::errors::{AcademyError, Refusal};
use crate::ports::{NullStream, Stream, StreamCredential};

/// `randomUUID()`: a version-4 UUID from the system's randomness, or why there is none.
pub fn random_uuid() -> Result<String, Refusal> {
    let mut b = [0u8; 16];
    getrandom::fill(&mut b).map_err(|e| Refusal::Internal {
        message: format!("no randomness for a uuid: {e}"),
        code: None,
    })?;
    let [
        b0,
        b1,
        b2,
        b3,
        b4,
        b5,
        b6,
        b7,
        b8,
        b9,
        b10,
        b11,
        b12,
        b13,
        b14,
        b15,
    ] = b;
    let b6 = (b6 & 0x0f) | 0x40;
    let b8 = (b8 & 0x3f) | 0x80;
    Ok(format!(
        "{b0:02x}{b1:02x}{b2:02x}{b3:02x}-{b4:02x}{b5:02x}-{b6:02x}{b7:02x}-{b8:02x}{b9:02x}-{b10:02x}{b11:02x}{b12:02x}{b13:02x}{b14:02x}{b15:02x}"
    ))
}

/// `LiveKitProviderOptions`.
#[derive(Clone)]
pub struct LiveKitOptions {
    pub url: String,
    pub api_key: String,
    pub api_secret: String,
    /// `tokenTtlSeconds ?? 3600`.
    pub token_ttl_seconds: i64,
}

/// `LiveKitStreamProvider`.
pub struct LiveKit {
    options: LiveKitOptions,
    base_url: String,
    fetch: Arc<dyn Fetch>,
    /// `Date.now()`.
    clock: fn() -> Instant,
    /// `randomUUID()` for each token's `jti`.
    jti: fn() -> Result<String, Refusal>,
}

/// `jwt(apiKey, secret, subject, grant, ttl)`: `{alg, typ}`, then `{iss, sub, iat, nbf, exp, jti, video}`, HS256.
pub fn jwt(
    api_key: &str,
    secret: &str,
    subject: &str,
    grant: Json,
    ttl: i64,
    now: Instant,
    jti: &str,
) -> Result<String, Refusal> {
    let seconds = now.0.div_euclid(1000);
    let encode = |v: &Json| URL_SAFE_NO_PAD.encode(v.compact().as_bytes());
    let header = Json::obj([("alg", Json::str("HS256")), ("typ", Json::str("JWT"))]);
    let claims = Json::obj([
        ("iss", Json::str(api_key)),
        ("sub", Json::str(subject)),
        ("iat", Json::int(seconds)),
        ("nbf", Json::int(seconds)),
        ("exp", Json::int(seconds.saturating_add(ttl))),
        ("jti", Json::str(jti)),
        ("video", grant),
    ]);
    let body = format!("{}.{}", encode(&header), encode(&claims));
    let mut mac =
        Hmac::<Sha256>::new_from_slice(secret.as_bytes()).map_err(|e| Refusal::Internal {
            message: e.to_string(),
            code: None,
        })?;
    mac.update(body.as_bytes());
    Ok(format!(
        "{body}.{}",
        URL_SAFE_NO_PAD.encode(mac.finalize().into_bytes())
    ))
}

impl LiveKit {
    pub fn new(options: LiveKitOptions, fetch: Arc<dyn Fetch>) -> LiveKit {
        // `url.replace(/^ws/, 'http').replace(/\/$/, '')`.
        let mut base = match options.url.strip_prefix("ws") {
            Some(rest) => format!("http{rest}"),
            None => options.url.clone(),
        };
        if base.ends_with('/') {
            base.pop();
        }
        LiveKit {
            options,
            base_url: base,
            fetch,
            clock: crate::door::system_now,
            jti: random_uuid,
        }
    }

    /// Pins the clock and the token ids (tests).
    pub fn with_sources(
        mut self,
        clock: fn() -> Instant,
        jti: fn() -> Result<String, Refusal>,
    ) -> LiveKit {
        self.clock = clock;
        self.jti = jti;
        self
    }

    fn room_service(&self, path: &str, body: &Json) -> Result<Json, Refusal> {
        let grant = Json::obj([
            ("roomCreate", Json::Bool(true)),
            ("roomAdmin", Json::Bool(true)),
        ]);
        let token = jwt(
            &self.options.api_key,
            &self.options.api_secret,
            &self.options.api_key,
            grant,
            60,
            (self.clock)(),
            &(self.jti)()?,
        )?;
        let req = HttpRequest {
            method: "POST".to_owned(),
            url: format!("{}/twirp/livekit.RoomService/{path}", self.base_url),
            headers: vec![
                ("authorization".to_owned(), format!("Bearer {token}")),
                ("content-type".to_owned(), "application/json".to_owned()),
            ],
            body: Some(body.compact()),
            timeout_ms: None,
            refuse_redirect: false,
        };
        let response = self.fetch.fetch(&req).map_err(|e| Refusal::Internal {
            message: e.message,
            code: None,
        })?;
        if !response.ok() {
            return Err(Refusal::Academy(AcademyError::new(
                format!("LiveKit {path} failed with HTTP {}", response.status),
                "academy.stream_unavailable",
            )));
        }
        json::parse(&response.body).map_err(|e| Refusal::Internal {
            message: e.message,
            code: None,
        })
    }
}

impl Stream for LiveKit {
    fn id(&self) -> &str {
        "livekit"
    }
    fn usable(&self) -> bool {
        false
    }
    fn constructed(&self) -> bool {
        true
    }
    fn probed(&self) -> bool {
        false
    }

    fn open_room(&self, session_id: &str) -> Result<String, Refusal> {
        let result =
            self.room_service("CreateRoom", &Json::obj([("name", Json::str(session_id))]))?;
        match &result {
            // `result.name` on `null` throws.
            Json::Null => Err(Refusal::Internal {
                message: "Cannot read properties of null (reading 'name')".to_owned(),
                code: None,
            }),
            _ => Ok(match result.get("name") {
                Some(Json::String(name)) if !name.is_empty() => name.clone(),
                _ => session_id.to_owned(),
            }),
        }
    }

    fn credential(
        &self,
        session_id: &str,
        stream_room: &str,
        user_id: &str,
        role: &str,
    ) -> Result<StreamCredential, Refusal> {
        let room = if stream_room.is_empty() {
            session_id
        } else {
            stream_room
        };
        let grant = Json::obj([
            ("roomJoin", Json::Bool(true)),
            ("room", Json::str(room)),
            ("canPublish", Json::Bool(role != "attendee")),
            ("canSubscribe", Json::Bool(true)),
            ("canPublishData", Json::Bool(true)),
        ]);
        let now = (self.clock)();
        let ttl = self.options.token_ttl_seconds;
        let token = jwt(
            &self.options.api_key,
            &self.options.api_secret,
            user_id,
            grant,
            ttl,
            now,
            &(self.jti)()?,
        )?;
        Ok(StreamCredential {
            url: self.options.url.clone(),
            token,
            expires_at: Instant(now.0.saturating_add(ttl.saturating_mul(1000))),
        })
    }

    fn close_room(&self, stream_room: &str) -> Result<(), Refusal> {
        self.room_service("DeleteRoom", &Json::obj([("room", Json::str(stream_room))]))
            .map(|_| ())
    }
}

/// `streamProviderFromEnv`: LiveKit only when it is chosen and its URL and keys are all set; otherwise `NullStream`.
pub fn stream_from_env(
    provider: Option<&str>,
    url: Option<&str>,
    api_key: Option<&str>,
    api_secret: Option<&str>,
    token_ttl_seconds: Option<i64>,
    fetch: Arc<dyn Fetch>,
) -> Box<dyn Stream> {
    let filled = |s: Option<&str>| s.filter(|v| !v.is_empty()).map(str::to_owned);
    match (provider, filled(url), filled(api_key), filled(api_secret)) {
        (Some("livekit"), Some(url), Some(api_key), Some(api_secret)) => Box::new(LiveKit::new(
            LiveKitOptions {
                url,
                api_key,
                api_secret,
                token_ttl_seconds: token_ttl_seconds.unwrap_or(3600),
            },
            fetch,
        )),
        _ => Box::new(NullStream),
    }
}

// ── The honesty cards (`streamProviderBoardCard` and its lines) ────────────────────────────────────────────────────

/// `streamProviderBoardCard`: id, usable, constructed, probed, null.
pub fn board_card(p: &dyn Stream) -> (String, bool, bool, bool, bool) {
    (
        p.id().to_owned(),
        p.usable(),
        p.constructed(),
        p.probed(),
        !p.constructed(),
    )
}

fn bit(b: bool) -> &'static str {
    if b { "1" } else { "0" }
}

/// `streamProviderStatusLine`.
pub fn status_line(p: &dyn Stream) -> String {
    let (id, u, c, pr, n) = board_card(p);
    format!(
        "id={id} usable={} constructed={} probed={} null={}",
        bit(u),
        bit(c),
        bit(pr),
        bit(n)
    )
}

/// `parseStreamProviderStatusLine`.
pub fn parse_status_line(line: &str) -> Option<(String, bool, bool, bool, bool)> {
    let parts: Vec<&str> = service_kit::schema::js_trim(line).split(' ').collect();
    let [id, u, c, p, n] = parts.as_slice() else {
        return None;
    };
    let id = id.strip_prefix("id=").filter(|s| !s.is_empty())?;
    let flag = |s: &str, k: &str| match s.strip_prefix(k)? {
        "1" => Some(true),
        "0" => Some(false),
        _ => None,
    };
    Some((
        id.to_owned(),
        flag(u, "usable=")?,
        flag(c, "constructed=")?,
        flag(p, "probed=")?,
        flag(n, "null=")?,
    ))
}

/// `streamProviderStatusLineConsistent`: a null provider is never constructed, usable or probed; unprobed is never
/// usable.
pub fn status_line_consistent(line: &str) -> bool {
    let Some((_, usable, constructed, probed, null)) = parse_status_line(line) else {
        return false;
    };
    !(null && (constructed || usable || probed)) && !(!probed && usable)
}

/// `streamProviderExportHeader`, `streamProviderExportLine`.
pub fn export_header() -> &'static str {
    "id,usable,constructed,probed,isNull"
}
pub fn export_line(p: &dyn Stream) -> String {
    let (id, u, c, pr, n) = board_card(p);
    format!("{id},{},{},{},{}", bit(u), bit(c), bit(pr), bit(n))
}
