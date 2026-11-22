//! Copy-Intel's port double: the real svc-trade copy leaders port over a fetch serving the case's recorded reply
//! (`{ status, body }`, `{ status, bodyText }` or `{ throws: true }`), signed as svc-agents with the recording's
//! placeholder secret. Each recorded port also holds what the TypeScript port made of the reply (`sample`) and the
//! request it sent (`sent`); `the_port_reads_every_reply_as_the_typescript_does` holds the Rust port to both.

use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use service_kit::http::{Fetch, FetchError, HttpRequest, HttpResponse};
use service_kit::json::{self, Json};
use service_kit::s2s::CallSigner;
use svc_agents::factories::Factories;
use svc_agents::factories::copy_intel::{LeaderFixtures, LeaderFixturesHttp};

const TRADE_URL: &str = "http://trade.test/";
const INTERNAL_SECRET: &str = "placeholder-agents-copy-intel-internal-secret";

/// A fetch answering with the recorded reply, keeping what it was sent.
pub struct ReplyFetch {
    reply: Json,
    pub sent: Mutex<Vec<HttpRequest>>,
}

impl Fetch for ReplyFetch {
    fn fetch(&self, req: &HttpRequest) -> Result<HttpResponse, FetchError> {
        self.sent.lock().unwrap().push(req.clone());
        if self.reply.get("throws") == Some(&Json::Bool(true)) {
            return Err(FetchError {
                message: "connect ECONNREFUSED".to_owned(),
            });
        }
        let status = match self.reply.get("status") {
            Some(Json::Number(n)) => format!("{n}").parse().unwrap(),
            _ => 200,
        };
        let body = match (self.reply.get("bodyText"), self.reply.get("body")) {
            (Some(Json::String(text)), _) => text.clone(),
            (_, Some(b)) => b.compact(),
            _ => String::new(),
        };
        Ok(HttpResponse { status, body })
    }
}

fn port_of(reply: &Json) -> (LeaderFixturesHttp, Arc<ReplyFetch>) {
    let fetch = Arc::new(ReplyFetch {
        reply: reply.clone(),
        sent: Mutex::new(Vec::new()),
    });
    let port = LeaderFixturesHttp::new(
        TRADE_URL,
        CallSigner::new("svc-agents", "svc-trade", INTERNAL_SECRET, None),
        fetch.clone(),
    );
    (port, fetch)
}

/// `createHttpCopyLeaderFixturesPort({ tradeUrl: 'http://trade.test/', internalSecret, fetchImpl })`.
pub fn ports(port: &Json) -> Factories {
    Factories {
        copy_leaders: Some(Box::new(port_of(port).0)),
        ..Factories::unwired()
    }
}

#[test]
fn the_port_reads_every_reply_as_the_typescript_does() {
    let file = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("tests/fixtures/factories/copyIntel.golden.json");
    let golden = json::parse(&std::fs::read_to_string(file).unwrap()).unwrap();
    let Some(Json::Array(cases)) = golden.get("cases") else {
        panic!("no cases")
    };
    let mut checked = 0;
    for c in cases {
        let Some(reply) = c.get("port") else { continue };
        let name = c.get("name").unwrap().compact();
        let (port, fetch) = port_of(reply);
        let got = Json::Array(port.sample().unwrap());
        assert_eq!(Some(&got), reply.get("sample"), "{name}: sample");
        let sent = fetch.sent.lock().unwrap();
        let [req] = sent.as_slice() else {
            panic!("{name}: one request")
        };
        let want = reply.get("sent").unwrap();
        assert_eq!(
            Some(&Json::str(req.method.clone())),
            want.get("method"),
            "{name}"
        );
        assert_eq!(Some(&Json::str(req.url.clone())), want.get("url"), "{name}");
        let mut names: Vec<String> = req.headers.iter().map(|(k, _)| k.clone()).collect();
        names.sort();
        let names = Json::Array(names.into_iter().map(Json::String).collect());
        assert_eq!(Some(&names), want.get("headers"), "{name}: header names");
        let accept = req
            .headers
            .iter()
            .find(|(k, _)| k == "accept")
            .map(|(_, v)| Json::str(v.clone()));
        assert_eq!(accept.as_ref(), want.get("accept"), "{name}: accept");
        assert!(req.body.is_none(), "{name}: a GET sends no body");
        checked += 1;
    }
    println!("copyIntel port: {checked} recorded replies read alike");
    assert!(checked >= 13, "every reply shape is recorded");
}
