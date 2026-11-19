//! The one seam every outgoing call goes through: `fetch`, as the TypeScript clients call it. The clients build the exact
//! request (method, URL, the headers they set, body) and read status and body; `UreqFetch` puts it on the wire, and tests
//! put a fake or a recorder in its place.

use std::time::Duration;

/// One outgoing request, as a client builds it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HttpRequest {
    pub method: String,
    pub url: String,
    /// The headers the client sets, in the order it sets them (the transport may add its own, as `fetch` does).
    pub headers: Vec<(String, String)>,
    pub body: Option<String>,
    /// `AbortSignal.timeout(ms)` or a client's own timer: the whole exchange, body included.
    pub timeout_ms: Option<u64>,
    /// `redirect: 'error'`: a redirect is a failure instead of being followed.
    pub refuse_redirect: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HttpResponse {
    pub status: u16,
    pub body: String,
}

impl HttpResponse {
    /// `response.ok`.
    pub fn ok(&self) -> bool {
        (200..=299).contains(&self.status)
    }
}

/// Why no response came back. `message` is what `fetch` would have thrown, as near as a different HTTP stack allows.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FetchError {
    pub message: String,
}

/// What a thrown `fetch` says: `fetch failed` (undici's `TypeError`), or the timeout's `DOMException`.
pub const FETCH_FAILED: &str = "fetch failed";
pub const TIMED_OUT: &str = "The operation was aborted due to timeout";

pub trait Fetch: Send + Sync {
    fn fetch(&self, req: &HttpRequest) -> Result<HttpResponse, FetchError>;
}

/// undici's own limits when no signal is set: five minutes for the headers and five for the body.
const UNDICI_DEFAULT: Duration = Duration::from_secs(300);

/// The real wire.
pub struct UreqFetch {
    agent: ureq::Agent,
}

impl Default for UreqFetch {
    fn default() -> Self {
        Self::new()
    }
}

impl UreqFetch {
    pub fn new() -> UreqFetch {
        let agent = ureq::Agent::config_builder()
            .http_status_as_error(false)
            .user_agent("node")
            .build()
            .new_agent();
        UreqFetch { agent }
    }
}

impl Fetch for UreqFetch {
    fn fetch(&self, req: &HttpRequest) -> Result<HttpResponse, FetchError> {
        let failed = |e: ureq::Error| FetchError {
            message: match e {
                ureq::Error::Timeout(_) => TIMED_OUT.to_owned(),
                _ => FETCH_FAILED.to_owned(),
            },
        };
        let mut builder = ureq::http::Request::builder()
            .method(req.method.as_str())
            .uri(req.url.as_str());
        for (name, value) in &req.headers {
            builder = builder.header(name.as_str(), value.as_str());
        }
        let request = builder
            .body(req.body.clone().unwrap_or_default().into_bytes())
            .map_err(|_| FetchError {
                message: FETCH_FAILED.to_owned(),
            })?;
        let mut config = self.agent.configure_request(request);
        config = match req.timeout_ms {
            Some(ms) => config.timeout_global(Some(Duration::from_millis(ms))),
            None => config
                .timeout_recv_response(Some(UNDICI_DEFAULT))
                .timeout_recv_body(Some(UNDICI_DEFAULT)),
        };
        if req.refuse_redirect {
            config = config.max_redirects(0).max_redirects_will_error(true);
        }
        let mut response = self.agent.run(config.build()).map_err(failed)?;
        let status = response.status().as_u16();
        let bytes = response
            .body_mut()
            .with_config()
            .limit(u64::MAX)
            .read_to_vec()
            .map_err(failed)?;
        Ok(HttpResponse {
            status,
            body: String::from_utf8_lossy(&bytes).into_owned(),
        })
    }
}
