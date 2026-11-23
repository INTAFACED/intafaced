//! The gateway slice held to what the TypeScript answers (`tests/fixtures/gateway-parity.golden.json`, written by
//! `scripts/record-gateway.mjs`): `parseRoutingTable` on a set of tables, the mock's completions, embeddings and the
//! request digest, the upstream adapter's requests and its answers through the gateway (results, refusals, health,
//! the outage threshold), `/ready`'s body, and `routes.list`.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing,
    reason = "a test: a failure is the point"
)]

use std::collections::BTreeMap;
use std::sync::{Arc, Mutex};

use service_kit::http::{FETCH_FAILED, Fetch, FetchError, HttpRequest, HttpResponse};
use service_kit::json::{self, Json};
use service_kit::money::{format_amount, parse_amount};
use service_kit::time::Instant;
use svc_agents::boot;
use svc_agents::door::system_now;
use svc_agents::gateway::desk::GatewaySlice;
use svc_agents::gateway::providers::{
    ChatMessage, MockOptions, MockProvider, Provider, ProviderError, Role, UpstreamConfig,
    UpstreamProvider,
};
use svc_agents::gateway::readiness::{self, ReadyInput};
use svc_agents::gateway::routing::{self, Capability, Price, Route, RoutingTable};
use svc_agents::gateway::{Gateway, TaskRequest, build_request, digest_of};

fn golden() -> Json {
    let text = std::fs::read_to_string(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/tests/fixtures/gateway-parity.golden.json"
    ))
    .unwrap();
    json::parse(&text).unwrap()
}

fn arr(v: &Json) -> &[Json] {
    match v {
        Json::Array(a) => a,
        other => panic!("not an array: {}", other.compact()),
    }
}

fn s(v: &Json) -> &str {
    match v {
        Json::String(s) => s,
        other => panic!("not a string: {}", other.compact()),
    }
}

fn get<'a>(v: &'a Json, k: &str) -> &'a Json {
    static NULL: Json = Json::Null;
    v.get(k).unwrap_or(&NULL)
}

fn int(v: &Json) -> i64 {
    match v {
        Json::Number(n) => format!("{n}").parse().unwrap(),
        other => panic!("not a number: {}", other.compact()),
    }
}

fn opt_str(v: &Json) -> Option<String> {
    match v {
        Json::String(s) => Some(s.clone()),
        _ => None,
    }
}

/// The golden's view of a table (`tableView`).
fn view(t: &RoutingTable) -> Json {
    Json::obj([
        (
            "routes",
            Json::Array(
                t.routes
                    .iter()
                    .map(|r| {
                        Json::obj([
                            ("task", Json::str(r.task.clone())),
                            ("providerId", Json::str(r.provider_id.clone())),
                            ("model", Json::str(r.model.clone())),
                            ("maxOutputTokens", Json::int(r.max_output_tokens)),
                            ("capability", Json::str(r.capability.name())),
                            (
                                "price",
                                r.price.map_or(Json::Null, |p| {
                                    Json::obj([
                                        (
                                            "inputPerMillion",
                                            Json::str(format_amount(p.input_per_million)),
                                        ),
                                        (
                                            "outputPerMillion",
                                            Json::str(format_amount(p.output_per_million)),
                                        ),
                                    ])
                                }),
                            ),
                        ])
                    })
                    .collect(),
            ),
        ),
        (
            "fallbackTask",
            t.fallback_task.clone().map_or(Json::Null, Json::String),
        ),
    ])
}

/// A table from the golden's view of it.
fn table_of(v: &Json) -> RoutingTable {
    RoutingTable {
        routes: arr(get(v, "routes"))
            .iter()
            .map(|r| Route {
                task: s(get(r, "task")).to_owned(),
                provider_id: s(get(r, "providerId")).to_owned(),
                model: s(get(r, "model")).to_owned(),
                max_output_tokens: int(get(r, "maxOutputTokens")),
                price: match get(r, "price") {
                    Json::Null => None,
                    p => Some(Price {
                        input_per_million: parse_amount(s(get(p, "inputPerMillion"))).unwrap(),
                        output_per_million: parse_amount(s(get(p, "outputPerMillion"))).unwrap(),
                    }),
                },
                capability: match s(get(r, "capability")) {
                    "embed" => Capability::Embed,
                    "stream" => Capability::Stream,
                    _ => Capability::Complete,
                },
            })
            .collect(),
        fallback_task: opt_str(get(v, "fallbackTask")),
    }
}

fn task_request(v: &Json) -> TaskRequest {
    TaskRequest {
        system: opt_str(get(v, "system")),
        messages: arr(get(v, "messages"))
            .iter()
            .map(|m| ChatMessage {
                role: if s(get(m, "role")) == "assistant" {
                    Role::Assistant
                } else {
                    Role::User
                },
                content: s(get(m, "content")).to_owned(),
            })
            .collect(),
        max_output_tokens: match get(v, "maxOutputTokens") {
            Json::Null => None,
            n => Some(int(n)),
        },
        temperature: match get(v, "temperature") {
            Json::Number(n) => Some(*n),
            _ => None,
        },
        stop_sequences: match get(v, "stopSequences") {
            Json::Array(a) => Some(a.iter().map(|x| s(x).to_owned()).collect()),
            _ => None,
        },
    }
}

fn mock(id: &str) -> MockProvider {
    MockProvider::new(
        MockOptions {
            id: Some(id.to_owned()),
            ..MockOptions::default()
        },
        system_now,
    )
}

#[test]
fn a_configured_table_is_parsed_or_refused_as_parse_routing_table_does() {
    let g = golden();
    for case in arr(get(&g, "tables")) {
        let text = s(get(case, "text"));
        let ours = routing::parse_routing_table(text).ok().map(|t| view(&t));
        let theirs = match get(case, "table") {
            Json::Null => None,
            t => Some(t.clone()),
        };
        assert_eq!(ours, theirs, "{text}");
    }
}

#[test]
fn the_mock_answers_byte_for_byte_and_the_digest_is_the_typescripts() {
    let g = golden();
    for case in arr(get(&g, "mock")) {
        let task = s(get(case, "task"));
        let request = task_request(get(case, "request"));
        let provider: Arc<dyn Provider> = Arc::new(mock("primary"));
        let gateway = Gateway::new(vec![provider.clone()], routing::default_table());
        let table = gateway.routing_table(system_now());
        let route = routing::resolve_route(&table, task).unwrap().clone();
        assert_eq!(
            digest_of(&build_request(&route, &request)),
            s(get(case, "digest")),
            "{task}"
        );
        let done = gateway
            .complete(task, &request, system_now())
            .unwrap()
            .result;
        let theirs = get(case, "result");
        assert_eq!(done.provider_id, s(get(theirs, "providerId")));
        assert_eq!(done.model, s(get(theirs, "model")));
        assert_eq!(done.text, s(get(theirs, "text")), "{task}");
        let usage = get(theirs, "usage");
        assert_eq!(
            (done.usage.input_tokens, done.usage.output_tokens),
            (
                int(get(usage, "inputTokens")),
                int(get(usage, "outputTokens"))
            ),
            "{task}"
        );
        assert_eq!(done.stop_reason.name(), s(get(theirs, "stopReason")));
        let embed = get(case, "embed");
        let inputs: Vec<String> = arr(get(embed, "inputs"))
            .iter()
            .map(|x| s(x).to_owned())
            .collect();
        let out = provider
            .embed(&svc_agents::gateway::providers::EmbedRequest {
                model: route.model.clone(),
                inputs,
            })
            .unwrap()
            .unwrap();
        let vectors = Json::Array(
            out.vectors
                .iter()
                .map(|v| Json::Array(v.iter().map(|x| Json::Number(*x)).collect()))
                .collect(),
        );
        assert_eq!(vectors.compact(), get(embed, "vectors").compact());
        assert_eq!(
            out.usage.input_tokens,
            int(get(get(embed, "usage"), "inputTokens"))
        );
    }
}

/// `fetch`, replaced: records each request and gives the case's answer.
struct Canned {
    answer: Json,
    sent: Mutex<Vec<HttpRequest>>,
}

impl Fetch for Canned {
    fn fetch(&self, req: &HttpRequest) -> Result<HttpResponse, FetchError> {
        self.sent.lock().unwrap().push(req.clone());
        if get(&self.answer, "throws") == &Json::Bool(true) {
            return Err(FetchError {
                message: FETCH_FAILED.to_owned(),
            });
        }
        let body = match get(&self.answer, "raw") {
            Json::String(raw) => raw.clone(),
            _ => get(&self.answer, "body").compact(),
        };
        Ok(HttpResponse {
            status: u16::try_from(int(get(&self.answer, "status"))).unwrap(),
            body,
        })
    }
}

fn pairs(v: &Json) -> Vec<(String, String)> {
    match v {
        Json::Object(f) => f
            .iter()
            .map(|(k, v)| (k.clone(), s(v).to_owned()))
            .collect(),
        _ => Vec::new(),
    }
}

fn upstream_config(c: &Json) -> UpstreamConfig {
    UpstreamConfig {
        id: s(get(c, "id")).to_owned(),
        base_url: s(get(c, "baseUrl")).to_owned(),
        api_key: s(get(c, "apiKey")).to_owned(),
        auth_header: opt_str(get(c, "authHeader")),
        auth_prefix: opt_str(get(c, "authPrefix")),
        headers: pairs(get(c, "headers")),
        completions_path: None,
        embeddings_path: opt_str(get(c, "embeddingsPath")),
        models: pairs(get(c, "models")),
        timeout_ms: Some(u64::try_from(int(get(c, "timeoutMs"))).unwrap()),
        supports_streaming: None,
    }
}

fn error_view(e: &svc_agents::errors::AgentError) -> Json {
    Json::obj([
        ("code", Json::str(e.code)),
        ("userMessageKey", Json::str(e.user_key.clone())),
        ("message", Json::str(e.message.clone())),
    ])
}

fn health_view(p: &dyn Provider) -> Json {
    let h = p.health(system_now());
    Json::obj([
        ("healthy", Json::Bool(h.healthy)),
        ("reason", h.reason.map_or(Json::Null, Json::String)),
    ])
}

fn sent_view(sent: &[HttpRequest]) -> Json {
    Json::Array(
        sent.iter()
            .map(|r| {
                Json::obj([
                    ("url", Json::str(r.url.clone())),
                    (
                        "headers",
                        Json::Array(
                            r.headers
                                .iter()
                                .map(|(k, v)| {
                                    Json::Array(vec![Json::str(k.clone()), Json::str(v.clone())])
                                })
                                .collect(),
                        ),
                    ),
                    ("body", r.body.clone().map_or(Json::Null, Json::String)),
                ])
            })
            .collect(),
    )
}

#[test]
fn the_upstream_sends_and_reads_as_the_typescript_and_the_gateway_refuses_alike() {
    let g = golden();
    let up = get(&g, "upstream");
    let config = upstream_config(get(up, "config"));
    let request = task_request(get(up, "request"));
    for case in arr(get(up, "cases")) {
        let outage = get(case, "outage") == &Json::Bool(true);
        let answer = if outage {
            json::parse(r#"{"status":503,"body":{}}"#).unwrap()
        } else {
            get(case, "answer").clone()
        };
        let fetch = Arc::new(Canned {
            answer,
            sent: Mutex::new(Vec::new()),
        });
        let provider: Arc<dyn Provider> = Arc::new(UpstreamProvider::new(
            config.clone(),
            fetch.clone(),
            system_now,
        ));
        let gateway = Gateway::new(vec![provider.clone()], routing::default_table());
        if outage {
            let errors: Vec<Json> = (0..4)
                .filter_map(|_| gateway.complete("own.run", &request, system_now()).err())
                .map(|e| error_view(&e))
                .collect();
            assert_eq!(Json::Array(errors).compact(), get(case, "errors").compact());
            assert_eq!(
                i64::try_from(fetch.sent.lock().unwrap().len()).unwrap(),
                int(get(case, "calls"))
            );
        } else {
            let out = gateway.complete("own.run", &request, system_now());
            assert_eq!(
                sent_view(&fetch.sent.lock().unwrap()).compact(),
                get(case, "sent").compact()
            );
            match (out, get(case, "result"), get(case, "error")) {
                (Ok(done), theirs, Json::Null) => {
                    let r = done.result;
                    let ours = Json::obj([
                        ("providerId", Json::str(r.provider_id)),
                        ("model", Json::str(r.model)),
                        ("text", Json::str(r.text)),
                        (
                            "usage",
                            Json::obj([
                                ("inputTokens", Json::int(r.usage.input_tokens)),
                                ("outputTokens", Json::int(r.usage.output_tokens)),
                            ]),
                        ),
                        ("stopReason", Json::str(r.stop_reason.name())),
                    ]);
                    assert_eq!(ours.compact(), theirs.compact());
                }
                (Err(e), Json::Null, theirs) => {
                    assert_eq!(error_view(&e).compact(), theirs.compact())
                }
                (ours, _, _) => panic!("{ours:?} against {}", case.compact()),
            }
        }
        assert_eq!(
            health_view(provider.as_ref()).compact(),
            get(case, "health").compact(),
            "{}",
            case.compact()
        );
    }
}

fn providers_for(name: &str, upstream: &UpstreamConfig) -> Vec<Arc<dyn Provider>> {
    let unused: Arc<dyn Fetch> = Arc::new(Canned {
        answer: Json::Null,
        sent: Mutex::new(Vec::new()),
    });
    match name {
        "mock that is down" => {
            let m = mock("primary");
            m.break_with(ProviderError {
                message: "engine outage (test)".to_owned(),
                provider_id: "primary".to_owned(),
                retryable: true,
                status: Some(503),
            });
            vec![Arc::new(m)]
        }
        "upstream, unprobed" => vec![Arc::new(UpstreamProvider::new(
            UpstreamConfig {
                embeddings_path: Some("/v1/embed".to_owned()),
                ..upstream.clone()
            },
            unused,
            system_now,
        ))],
        "a route naming an unregistered provider first" => vec![Arc::new(MockProvider::new(
            MockOptions {
                id: Some("primary".to_owned()),
                capabilities: Some(vec![Capability::Embed]),
                ..MockOptions::default()
            },
            system_now,
        ))],
        "no routes" => Vec::new(),
        "upstream" => vec![Arc::new(UpstreamProvider::new(
            upstream.clone(),
            unused,
            system_now,
        ))],
        _ => vec![Arc::new(mock("primary"))],
    }
}

#[test]
fn ready_reports_what_agents_readiness_reports() {
    let g = golden();
    let upstream = upstream_config(get(get(&g, "upstream"), "config"));
    let env: BTreeMap<String, String> = pairs(get(&g, "livePlanesEnv")).into_iter().collect();
    let boot = boot::boot_agents().unwrap();
    let ids: Vec<String> = boot.iter().map(|a| a.agent_id.clone()).collect();
    for case in arr(get(&g, "ready")) {
        let name = s(get(case, "name"));
        let gateway = Gateway::new(providers_for(name, &upstream), table_of(get(case, "table")));
        let input = ReadyInput {
            provider_mode: s(get(case, "mode")).to_owned(),
            metering_enabled: get(case, "metering") == &Json::Bool(true),
            product_agents_registered: if name.contains("no product agents") {
                0
            } else {
                readiness::product_agents_registered(&ids)
            },
            fleet: readiness::fleet_card(&boot),
            live_planes: readiness::live_planes(&env),
        };
        let ours = readiness::readiness(&gateway, &input, system_now());
        assert_eq!(ours.compact(), get(case, "body").compact(), "{name}");
    }
}

#[test]
fn routes_list_answers_what_the_router_answers() {
    let g = golden();
    let upstream = upstream_config(get(get(&g, "upstream"), "config"));
    for case in arr(get(&g, "list")) {
        let slice = GatewaySlice {
            gateway: Arc::new(Gateway::new(
                providers_for(s(get(case, "provider")), &upstream),
                table_of(get(case, "table")),
            )),
            fee_asset_id: "USDC".to_owned(),
            metering_enabled: match get(case, "metering") {
                Json::Bool(b) => Some(*b),
                _ => None,
            },
            window_minutes: 15,
        };
        assert_eq!(
            slice.list(Instant(0)).compact(),
            get(case, "answer").compact(),
            "{}",
            s(get(case, "name"))
        );
    }
}
