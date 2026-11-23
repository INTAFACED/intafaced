//! The gateway's adapters (`services/svc-agents/src/providers/`): the interface every engine sits behind, the
//! deterministic mock (`mock.ts`) and the HTTP upstream described only by configuration (`upstream.ts`). No vendor is
//! named: the upstream's address, paths, auth header and model ids are all `AGENTS_UPSTREAM_*`.
//!
//! Token counts come from the engine, never estimated here (the mock's are a fixed function of the request, so a test
//! can predict a bill). A completion whose counts the upstream does not report is refused, never billed as zero.

use std::path::PathBuf;
use std::sync::Mutex;
use std::time::Duration;

use sha2::{Digest, Sha256};

use service_kit::http::{Fetch, HttpRequest, TIMED_OUT};
use service_kit::json::{self, Json};
use service_kit::time::Instant;

use super::routing::{Capability, Engine};

/// `PROVIDER_UNPROBED_REASON`: an HTTP adapter that has not been called yet. Not an outage, and not live.
pub const UNPROBED: &str = "no call made yet";

/// `ProviderHealth`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Health {
    pub healthy: bool,
    pub latency_ms: i64,
    pub last_update: Instant,
    /// Operator-facing only.
    pub reason: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Role {
    User,
    Assistant,
}

impl Role {
    pub fn name(self) -> &'static str {
        match self {
            Role::User => "user",
            Role::Assistant => "assistant",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ChatMessage {
    pub role: Role,
    pub content: String,
}

/// `CompletionRequest`: the model as the routing table names it, and a hard output ceiling.
#[derive(Debug, Clone, PartialEq)]
pub struct CompletionRequest {
    pub model: String,
    pub system: Option<String>,
    pub messages: Vec<ChatMessage>,
    pub max_output_tokens: i64,
    pub temperature: Option<f64>,
    pub stop_sequences: Option<Vec<String>>,
}

/// Exact counts as the engine reported them.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TokenUsage {
    pub input_tokens: i64,
    pub output_tokens: i64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StopReason {
    End,
    MaxTokens,
    StopSequence,
    Refusal,
}

impl StopReason {
    pub fn name(self) -> &'static str {
        match self {
            StopReason::End => "end",
            StopReason::MaxTokens => "max_tokens",
            StopReason::StopSequence => "stop_sequence",
            StopReason::Refusal => "refusal",
        }
    }

    /// `STOP_REASONS[raw] ?? 'end'`.
    fn of_upstream(raw: &str) -> StopReason {
        match raw {
            "stop_sequence" => StopReason::StopSequence,
            "max_tokens" | "length" => StopReason::MaxTokens,
            "refusal" => StopReason::Refusal,
            _ => StopReason::End,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CompletionResult {
    pub provider_id: String,
    /// The alias the routing table asked for, never the upstream's concrete id.
    pub model: String,
    pub text: String,
    pub usage: TokenUsage,
    pub stop_reason: StopReason,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EmbedRequest {
    pub model: String,
    pub inputs: Vec<String>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct EmbedResult {
    pub provider_id: String,
    pub model: String,
    pub vectors: Vec<Vec<f64>>,
    pub usage: TokenUsage,
}

/// `ProviderError`: an engine's failure, retryable or not. Its message is operator-facing only.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProviderError {
    pub message: String,
    pub provider_id: String,
    pub retryable: bool,
    pub status: Option<u16>,
}

impl ProviderError {
    fn new(message: &str, provider_id: &str, retryable: bool, status: Option<u16>) -> Self {
        ProviderError {
            message: message.to_owned(),
            provider_id: provider_id.to_owned(),
            retryable,
            status,
        }
    }
}

/// What an adapter call can fail with: its own typed error, or anything else (a body of the wrong shape).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Failure {
    Provider(ProviderError),
    Unexpected,
}

impl From<ProviderError> for Failure {
    fn from(e: ProviderError) -> Failure {
        Failure::Provider(e)
    }
}

/// `ModelProvider`.
pub trait Provider: Send + Sync {
    /// The configuration id (`primary`), never a vendor name.
    fn id(&self) -> &str;
    fn capabilities(&self) -> &[Capability];
    /// `engineOfAdapter`: the adapter's own class decides it.
    fn engine(&self) -> Engine;
    fn health(&self, now: Instant) -> Health;
    fn complete(&self, request: &CompletionRequest) -> Result<CompletionResult, Failure>;
    /// `None` when the adapter does not implement embedding.
    fn embed(&self, request: &EmbedRequest) -> Option<Result<EmbedResult, Failure>>;
}

/// `supports`.
pub fn supports(provider: &dyn Provider, capability: Capability) -> bool {
    provider.capabilities().contains(&capability)
}

/// `isUsable`: healthy, and heard from within the last minute.
pub fn is_usable(provider: &dyn Provider, now: Instant) -> bool {
    let h = provider.health(now);
    h.healthy && now.0 - h.last_update.0 <= 60_000
}

fn sha256_hex(text: &str) -> String {
    Sha256::digest(text.as_bytes())
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

/// JavaScript's `.length`.
fn js_len(s: &str) -> i64 {
    i64::try_from(s.encode_utf16().count()).unwrap_or(i64::MAX)
}

/// `Math.ceil(n / 4)` for a count.
fn ceil_quarter(n: i64) -> i64 {
    (n + 3).div_euclid(4)
}

fn messages_json(messages: &[ChatMessage]) -> Json {
    Json::Array(
        messages
            .iter()
            .map(|m| Json::Array(vec![Json::str(m.role.name()), Json::str(m.content.clone())]))
            .collect(),
    )
}

// ── The mock ────────────────────────────────────────────────────────────────

/// `mockInputTokens`: four characters a token, over the system prompt and `role:content` lines.
pub fn mock_input_tokens(request: &CompletionRequest) -> i64 {
    let system = request.system.as_deref().unwrap_or("");
    let body = request
        .messages
        .iter()
        .map(|m| format!("{}:{}", m.role.name(), m.content))
        .collect::<Vec<_>>()
        .join("\n");
    ceil_quarter(js_len(system) + js_len(&body))
}

/// The mock's request digest (`requestDigest`): it covers temperature and stop sequences too.
fn mock_digest(request: &CompletionRequest) -> String {
    let canonical = Json::obj([
        ("model", Json::str(request.model.clone())),
        (
            "system",
            request.system.clone().map_or(Json::Null, Json::String),
        ),
        ("messages", messages_json(&request.messages)),
        ("maxOutputTokens", Json::int(request.max_output_tokens)),
        (
            "temperature",
            request.temperature.map_or(Json::Null, Json::Number),
        ),
        (
            "stopSequences",
            Json::Array(
                request
                    .stop_sequences
                    .iter()
                    .flatten()
                    .map(|s| Json::str(s.clone()))
                    .collect(),
            ),
        ),
    ]);
    sha256_hex(&canonical.compact())
}

/// `mockOutputTokens`: a pseudo-length in `[1, maxOutputTokens]` from the digest.
pub fn mock_output_tokens(request: &CompletionRequest) -> i64 {
    let digest = mock_digest(request);
    let nibble = digest
        .get(..4)
        .and_then(|h| i64::from_str_radix(h, 16).ok())
        .unwrap_or(0);
    1 + nibble.rem_euclid(request.max_output_tokens.max(1))
}

/// `MockProviderOptions`, as `index.ts` and the tests set them.
#[derive(Debug, Clone, Default)]
pub struct MockOptions {
    pub id: Option<String>,
    pub capabilities: Option<Vec<Capability>>,
    pub fail_with: Option<ProviderError>,
    pub fail_first: u32,
    pub latency_ms: Option<i64>,
    /// `AGENTS_MOCK_DELAY_MS`: how long each answer takes.
    pub answer_delay_ms: u64,
    /// `AGENTS_MOCK_HOLD_FILE`: while it exists, a completion parks before it answers (a TEST stand-in control).
    pub hold_file: Option<PathBuf>,
    pub hold_max_ms: Option<u64>,
}

struct MockState {
    calls: u64,
    failures: u64,
    last_update: Instant,
    fail_with: Option<ProviderError>,
    fail_first: u32,
}

/// `MockModelProvider`: deterministic, in process, and the default engine. It never reaches an upstream.
pub struct MockProvider {
    id: String,
    capabilities: Vec<Capability>,
    latency_ms: i64,
    answer_delay_ms: u64,
    hold_file: Option<PathBuf>,
    hold_max_ms: u64,
    clock: fn() -> Instant,
    state: Mutex<MockState>,
}

impl MockProvider {
    pub fn new(options: MockOptions, clock: fn() -> Instant) -> MockProvider {
        MockProvider {
            id: options.id.unwrap_or_else(|| "mock".to_owned()),
            capabilities: options.capabilities.unwrap_or_else(|| {
                vec![Capability::Complete, Capability::Stream, Capability::Embed]
            }),
            latency_ms: options.latency_ms.unwrap_or(1),
            answer_delay_ms: options.answer_delay_ms,
            hold_file: options.hold_file,
            hold_max_ms: options.hold_max_ms.unwrap_or(60_000),
            clock,
            state: Mutex::new(MockState {
                calls: 0,
                failures: 0,
                last_update: Instant(0),
                fail_with: options.fail_with,
                fail_first: options.fail_first,
            }),
        }
    }

    fn state(&self) -> std::sync::MutexGuard<'_, MockState> {
        self.state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    /// Test control: fail every call with this error until repaired.
    pub fn break_with(&self, error: ProviderError) {
        self.state().fail_with = Some(error);
    }

    /// Test control: stop failing.
    pub fn repair(&self) {
        let mut s = self.state();
        s.fail_with = None;
        s.fail_first = 0;
    }

    /// How many times the gateway reached the engine.
    pub fn call_count(&self) -> u64 {
        self.state().calls
    }

    pub fn failure_count(&self) -> u64 {
        self.state().failures
    }

    /// Counts the call and records that the engine answered; then fails if it is broken.
    fn reached(&self, delay: bool) -> Result<(), Failure> {
        self.state().calls += 1;
        if delay {
            if let Some(hold) = self.hold_file.as_ref().filter(|h| h.exists()) {
                let calls = PathBuf::from(format!("{}.calls", hold.display()));
                let line = format!("{}\n", (self.clock)().iso());
                let _ = std::fs::OpenOptions::new()
                    .create(true)
                    .append(true)
                    .open(calls)
                    .and_then(|mut f| std::io::Write::write_all(&mut f, line.as_bytes()));
            }
            if self.answer_delay_ms > 0 {
                std::thread::sleep(Duration::from_millis(self.answer_delay_ms));
            }
        }
        let mut s = self.state();
        s.last_update = (self.clock)();
        if let Some(e) = s.fail_with.clone() {
            s.failures += 1;
            return Err(Failure::Provider(e));
        }
        if s.fail_first > 0 {
            s.fail_first -= 1;
            s.failures += 1;
            return Err(Failure::Provider(ProviderError::new(
                "Injected transient failure",
                &self.id,
                true,
                Some(503),
            )));
        }
        Ok(())
    }

    /// Waits while the hold file exists, marking itself parked; answers anyway after `hold_max_ms`.
    fn park_while_held(&self) {
        let Some(hold) = self.hold_file.as_ref().filter(|h| h.exists()) else {
            return;
        };
        let marker = PathBuf::from(format!("{}.held", hold.display()));
        let _ = std::fs::write(&marker, (self.clock)().iso());
        let until = std::time::Instant::now() + Duration::from_millis(self.hold_max_ms);
        while hold.exists() && std::time::Instant::now() < until {
            std::thread::sleep(Duration::from_millis(25));
        }
        let _ = std::fs::remove_file(&marker);
    }
}

impl Provider for MockProvider {
    fn id(&self) -> &str {
        &self.id
    }

    fn capabilities(&self) -> &[Capability] {
        &self.capabilities
    }

    fn engine(&self) -> Engine {
        Engine::Sandbox
    }

    fn health(&self, now: Instant) -> Health {
        let s = self.state();
        match &s.fail_with {
            Some(e) => Health {
                healthy: false,
                latency_ms: self.latency_ms,
                last_update: s.last_update,
                reason: Some(e.message.clone()),
            },
            // Never called: healthy, and fresh as of now.
            None => Health {
                healthy: true,
                latency_ms: self.latency_ms,
                last_update: if s.calls == 0 { now } else { s.last_update },
                reason: None,
            },
        }
    }

    fn complete(&self, request: &CompletionRequest) -> Result<CompletionResult, Failure> {
        self.reached(true)?;
        self.park_while_held();
        let usage = TokenUsage {
            input_tokens: mock_input_tokens(request),
            output_tokens: mock_output_tokens(request),
        };
        let digest = mock_digest(request);
        Ok(CompletionResult {
            provider_id: self.id.clone(),
            model: request.model.clone(),
            text: format!(
                "mock:{}:{}",
                request.model,
                digest.get(..16).unwrap_or(&digest)
            ),
            usage,
            stop_reason: if usage.output_tokens >= request.max_output_tokens {
                StopReason::MaxTokens
            } else {
                StopReason::End
            },
        })
    }

    fn embed(&self, request: &EmbedRequest) -> Option<Result<EmbedResult, Failure>> {
        if let Err(e) = self.reached(false) {
            return Some(Err(e));
        }
        let vectors = request
            .inputs
            .iter()
            .map(|input| {
                let digest = Sha256::digest(format!("{}:{input}", request.model).as_bytes());
                digest
                    .iter()
                    .take(16)
                    .map(|b| {
                        #[expect(
                            clippy::float_arithmetic,
                            reason = "an embedding component in [-1, 1), not money"
                        )]
                        let v = (f64::from(*b) - 128.0) / 128.0;
                        v
                    })
                    .collect()
            })
            .collect();
        let input_tokens = request.inputs.iter().map(|s| ceil_quarter(js_len(s))).sum();
        Some(Ok(EmbedResult {
            provider_id: self.id.clone(),
            model: request.model.clone(),
            vectors,
            usage: TokenUsage {
                input_tokens,
                output_tokens: 0,
            },
        }))
    }
}

// ── The upstream ────────────────────────────────────────────────────────────

/// `UpstreamProviderConfig`, from `AGENTS_UPSTREAM_*`.
#[derive(Debug, Clone, Default)]
pub struct UpstreamConfig {
    pub id: String,
    pub base_url: String,
    /// Secret: placed on the request and nowhere else.
    pub api_key: String,
    pub auth_header: Option<String>,
    pub auth_prefix: Option<String>,
    pub headers: Vec<(String, String)>,
    pub completions_path: Option<String>,
    /// Only when set does the adapter declare `embed`.
    pub embeddings_path: Option<String>,
    /// Routing-table alias to the upstream's model id; an alias with no entry passes through.
    pub models: Vec<(String, String)>,
    pub timeout_ms: Option<u64>,
    pub supports_streaming: Option<bool>,
}

struct UpstreamState {
    last_update: Instant,
    last_latency_ms: i64,
    last_failure: Option<String>,
    consecutive_failures: u32,
    ever_attempted: bool,
}

/// `UpstreamModelProvider`: an HTTP model service speaking the messages protocol. Unprobed until a call is observed;
/// three failures in a row mark it unhealthy.
pub struct UpstreamProvider {
    config: UpstreamConfig,
    base_url: String,
    completions_path: String,
    timeout_ms: u64,
    capabilities: Vec<Capability>,
    fetch: std::sync::Arc<dyn Fetch>,
    clock: fn() -> Instant,
    state: Mutex<UpstreamState>,
}

const UNHEALTHY_AFTER: u32 = 3;

impl UpstreamProvider {
    pub fn new(
        config: UpstreamConfig,
        fetch: std::sync::Arc<dyn Fetch>,
        clock: fn() -> Instant,
    ) -> UpstreamProvider {
        let base_url = config
            .base_url
            .strip_suffix('/')
            .unwrap_or(&config.base_url)
            .to_owned();
        let mut capabilities = vec![Capability::Complete];
        if config.supports_streaming != Some(false) {
            capabilities.push(Capability::Stream);
        }
        if config.embeddings_path.is_some() {
            capabilities.push(Capability::Embed);
        }
        UpstreamProvider {
            base_url,
            completions_path: config
                .completions_path
                .clone()
                .unwrap_or_else(|| "/v1/messages".to_owned()),
            timeout_ms: config.timeout_ms.unwrap_or(60_000),
            capabilities,
            fetch,
            clock,
            state: Mutex::new(UpstreamState {
                last_update: Instant(0),
                last_latency_ms: 0,
                last_failure: None,
                consecutive_failures: 0,
                ever_attempted: false,
            }),
            config,
        }
    }

    fn state(&self) -> std::sync::MutexGuard<'_, UpstreamState> {
        self.state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    /// `resolveModel`.
    pub fn resolve_model(&self, alias: &str) -> String {
        self.config
            .models
            .iter()
            .find(|(k, _)| k == alias)
            .map_or_else(|| alias.to_owned(), |(_, v)| v.clone())
    }

    fn record_success(&self) {
        let mut s = self.state();
        s.ever_attempted = true;
        s.consecutive_failures = 0;
        s.last_failure = None;
        s.last_update = (self.clock)();
    }

    fn record_failure(&self, reason: &str) {
        let mut s = self.state();
        s.ever_attempted = true;
        s.consecutive_failures += 1;
        s.last_failure = Some(reason.to_owned());
        s.last_update = (self.clock)();
    }

    fn fail(&self, message: &str, retryable: bool, status: Option<u16>) -> Failure {
        Failure::Provider(ProviderError::new(
            message,
            &self.config.id,
            retryable,
            status,
        ))
    }

    /// `call`: one POST, its status judged, its body read as JSON.
    fn call(&self, path: &str, body: &Json) -> Result<Json, Failure> {
        let mut headers = vec![
            ("content-type".to_owned(), "application/json".to_owned()),
            ("accept".to_owned(), "application/json".to_owned()),
            (
                self.config
                    .auth_header
                    .clone()
                    .unwrap_or_else(|| "x-api-key".to_owned()),
                format!(
                    "{}{}",
                    self.config.auth_prefix.as_deref().unwrap_or(""),
                    self.config.api_key
                ),
            ),
        ];
        // `{ ...base, ...config.headers }`: a key already there keeps its place and takes the new value.
        for (k, v) in &self.config.headers {
            match headers.iter_mut().find(|(h, _)| h == k) {
                Some(slot) => slot.1.clone_from(v),
                None => headers.push((k.clone(), v.clone())),
            }
        }
        let started = std::time::Instant::now();
        let out = self.fetch.fetch(&HttpRequest {
            method: "POST".to_owned(),
            url: format!("{}{path}", self.base_url),
            headers,
            body: Some(body.compact()),
            timeout_ms: Some(self.timeout_ms),
            refuse_redirect: false,
        });
        let latency = i64::try_from(started.elapsed().as_millis()).unwrap_or(i64::MAX);
        self.state().last_latency_ms = latency;
        let response = match out {
            Ok(r) => r,
            Err(e) => {
                let timed_out = e.message == TIMED_OUT;
                self.record_failure(if timed_out {
                    "upstream timed out"
                } else {
                    "upstream transport error"
                });
                return Err(self.fail(
                    if timed_out {
                        "Upstream call timed out"
                    } else {
                        "Upstream call failed in transport"
                    },
                    true,
                    None,
                ));
            }
        };
        if !response.ok() {
            // The upstream's error body is never read into our error: a vendor name would arrive there.
            let retryable = response.status == 429 || response.status >= 500;
            self.record_failure(&format!("upstream status {}", response.status));
            return Err(self.fail(
                &format!("Upstream rejected the request (status {})", response.status),
                retryable,
                Some(response.status),
            ));
        }
        self.state().ever_attempted = true;
        match json::parse(&response.body) {
            Ok(parsed) => {
                self.record_success();
                Ok(parsed)
            }
            Err(_) => {
                self.record_failure("unparseable upstream response");
                Err(self.fail(
                    "Upstream returned a body that is not JSON",
                    true,
                    Some(response.status),
                ))
            }
        }
    }
}

/// `raw?.a ?? raw?.b`, as a JSON value; `null` counts as absent.
fn either<'a>(raw: Option<&'a Json>, a: &str, b: &str) -> Option<&'a Json> {
    let pick = |k: &str| {
        raw.and_then(|r| r.get(k))
            .filter(|v| !matches!(v, Json::Null))
    };
    pick(a).or_else(|| pick(b))
}

/// A non-negative whole JSON number.
fn count(v: Option<&Json>) -> Option<i64> {
    match v {
        Some(Json::Number(n)) if n.fract() == 0.0 && *n >= 0.0 && *n <= 9_007_199_254_740_991.0 => {
            #[expect(
                clippy::cast_possible_truncation,
                reason = "a whole number inside the safe integer range"
            )]
            let n = *n as i64;
            Some(n)
        }
        _ => None,
    }
}

/// `readUsage`: both counts, or the call is refused (`partial`: embeddings report input only).
pub fn read_usage(
    raw: Option<&Json>,
    provider_id: &str,
    partial: bool,
) -> Result<TokenUsage, ProviderError> {
    // A usage that is not an object reads as no counts at all.
    let raw = raw.filter(|r| matches!(r, Json::Object(_)));
    let input = count(either(raw, "input_tokens", "prompt_tokens"));
    let output = match either(raw, "output_tokens", "completion_tokens") {
        None if partial => Some(0),
        v => count(v),
    };
    match (input, output) {
        (Some(input_tokens), Some(output_tokens)) => Ok(TokenUsage {
            input_tokens,
            output_tokens,
        }),
        _ => Err(ProviderError::new(
            "Upstream did not report usable token counts — refusing to meter a call we cannot price",
            provider_id,
            false,
            None,
        )),
    }
}

impl Provider for UpstreamProvider {
    fn id(&self) -> &str {
        &self.config.id
    }

    fn capabilities(&self) -> &[Capability] {
        &self.capabilities
    }

    fn engine(&self) -> Engine {
        Engine::Live
    }

    fn health(&self, _now: Instant) -> Health {
        let s = self.state();
        if !s.ever_attempted {
            return Health {
                healthy: false,
                latency_ms: s.last_latency_ms,
                last_update: s.last_update,
                reason: Some(UNPROBED.to_owned()),
            };
        }
        let healthy = s.consecutive_failures < UNHEALTHY_AFTER;
        Health {
            healthy,
            latency_ms: s.last_latency_ms,
            last_update: s.last_update,
            reason: (!healthy).then(|| {
                s.last_failure
                    .clone()
                    .unwrap_or_else(|| "consecutive upstream failures".to_owned())
            }),
        }
    }

    fn complete(&self, request: &CompletionRequest) -> Result<CompletionResult, Failure> {
        let mut body = vec![("model", Json::str(self.resolve_model(&request.model)))];
        if let Some(system) = request.system.as_ref().filter(|s| !s.is_empty()) {
            body.push(("system", Json::str(system.clone())));
        }
        body.push((
            "messages",
            Json::Array(
                request
                    .messages
                    .iter()
                    .map(|m| {
                        Json::obj([
                            ("role", Json::str(m.role.name())),
                            ("content", Json::str(m.content.clone())),
                        ])
                    })
                    .collect(),
            ),
        ));
        body.push(("max_tokens", Json::int(request.max_output_tokens)));
        if let Some(t) = request.temperature {
            body.push(("temperature", Json::Number(t)));
        }
        if let Some(stops) = request.stop_sequences.as_ref().filter(|s| !s.is_empty()) {
            body.push((
                "stop_sequences",
                Json::Array(stops.iter().map(|s| Json::str(s.clone())).collect()),
            ));
        }
        let body = Json::Object(body.into_iter().map(|(k, v)| (k.to_owned(), v)).collect());
        let parsed = self.call(&self.completions_path, &body)?;
        // `parsed.content ?? []`, each block `(type ?? 'text') === 'text'`: any other shape throws in the TypeScript.
        if !matches!(parsed, Json::Object(_)) {
            return Err(Failure::Unexpected);
        }
        let blocks = match parsed.get("content") {
            None | Some(Json::Null) => Vec::new(),
            Some(Json::Array(b)) => b.clone(),
            Some(_) => return Err(Failure::Unexpected),
        };
        let mut text = String::new();
        for block in &blocks {
            if !matches!(block, Json::Object(_)) {
                return Err(Failure::Unexpected);
            }
            let is_text = match block.get("type") {
                None | Some(Json::Null) => true,
                Some(Json::String(t)) => t == "text",
                Some(_) => false,
            };
            if is_text {
                match block.get("text") {
                    None | Some(Json::Null) => {}
                    Some(Json::String(s)) => text.push_str(s),
                    Some(other) => {
                        text.push_str(&service_kit::schema::Value::from_json(other).js_string())
                    }
                }
            }
        }
        let usage = read_usage(parsed.get("usage"), &self.config.id, false)?;
        let stop_reason = match parsed.get("stop_reason") {
            Some(Json::String(s)) => StopReason::of_upstream(s),
            _ => StopReason::End,
        };
        Ok(CompletionResult {
            provider_id: self.config.id.clone(),
            model: request.model.clone(),
            text,
            usage,
            stop_reason,
        })
    }

    fn embed(&self, request: &EmbedRequest) -> Option<Result<EmbedResult, Failure>> {
        let Some(path) = self.config.embeddings_path.clone() else {
            return Some(Err(self.fail(
                "This provider is not configured with an embeddings endpoint",
                false,
                None,
            )));
        };
        let body = Json::obj([
            ("model", Json::str(self.resolve_model(&request.model))),
            (
                "input",
                Json::Array(
                    request
                        .inputs
                        .iter()
                        .map(|s| Json::str(s.clone()))
                        .collect(),
                ),
            ),
        ]);
        Some(self.call(&path, &body).and_then(|parsed| {
            let rows = match parsed.get("data") {
                None | Some(Json::Null) => Vec::new(),
                Some(Json::Array(rows)) => rows.clone(),
                Some(_) => return Err(Failure::Unexpected),
            };
            let vectors = rows
                .iter()
                .map(|d| match d.get("embedding") {
                    Some(Json::Array(v)) => v
                        .iter()
                        .map(|x| match x {
                            Json::Number(n) => *n,
                            _ => 0.0,
                        })
                        .collect(),
                    _ => Vec::new(),
                })
                .collect();
            Ok(EmbedResult {
                provider_id: self.config.id.clone(),
                model: request.model.clone(),
                vectors,
                usage: read_usage(parsed.get("usage"), &self.config.id, true)?,
            })
        }))
    }
}
