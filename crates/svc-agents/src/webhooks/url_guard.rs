//! The run webhooks' SSRF guard (`webhooks/webhook-url-guard.ts`; J-agents-12 #5), the same guard svc-pay keeps for
//! merchant webhooks and svc-bank for its API: a service never imports another's code, so svc-agents holds this copy.
//! Its refusal is `agents.webhook_url_invalid`.
//!
//! Three layers, because each one alone is bypassable:
//!
//! 1. [`assert_public_webhook_url`]: syntax, at register time and again at delivery time. It refuses private literal
//!    IPs in every spelling the WHATWG URL parser folds (the `url` crate is that parser, as `new URL` is),
//!    internal-looking hostnames, credentials and infrastructure ports.
//! 2. [`resolve_public_addresses`]: DNS. A public-looking name can resolve to a private address; if ANY answer is not
//!    public the target is refused.
//! 3. The caller connects only to the addresses returned here and never resolves the name again (DNS rebinding);
//!    redirects are never followed (`pinned_post`).
//!
//! Deploy must still apply deny-by-default egress: this guard is a second wall, not the first. Nothing here moves value.

use std::net::{IpAddr, Ipv4Addr, Ipv6Addr};

use url::Url;

/// Why an address was refused: not https, private or internal, unresolvable, or otherwise not usable.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Reason {
    Https,
    Private,
    Unresolvable,
    Invalid,
}

/// `WebhookUrlRefusal`: `agents.webhook_url_invalid`, with its reason and words.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UrlRefusal {
    pub message: String,
    pub reason: Reason,
}

/// The refusal's code.
pub const URL_INVALID: &str = "agents.webhook_url_invalid";

fn invalid<T>(message: &str, reason: Reason) -> Result<T, UrlRefusal> {
    Err(UrlRefusal {
        message: format!("{message} NOTHING WAS ATTEMPTED."),
        reason,
    })
}

fn strip_brackets(host: &str) -> &str {
    host.strip_prefix('[')
        .and_then(|h| h.strip_suffix(']'))
        .unwrap_or(host)
}

/// `net.isIP`: a strict dotted quad, or an IPv6 literal with an optional zone.
fn parse_ip(text: &str) -> Option<IpAddr> {
    if let Ok(v4) = text.parse::<Ipv4Addr>() {
        return Some(IpAddr::V4(v4));
    }
    let bare = text
        .split_once('%')
        .map_or(text, |(a, zone)| if zone.is_empty() { text } else { a });
    bare.parse::<Ipv6Addr>().ok().map(IpAddr::V6)
}

fn is_public_v4(b: [u8; 4], allow_loopback: bool) -> bool {
    let [a, c, d, _] = b;
    match (a, c, d) {
        (127, _, _) => allow_loopback,
        (0 | 10, _, _) => false,
        (100, 64..=127, _) => false,             // CGNAT 100.64.0.0/10
        (169, 254, _) => false,                  // link-local incl. cloud metadata
        (172, 16..=31, _) => false,              // 172.16.0.0/12
        (192, 0, 0 | 2) => false,                // IETF protocol assignments, TEST-NET-1
        (192, 88, 99) => false,                  // 6to4 relay anycast
        (192, 168, _) => false,                  // 192.168.0.0/16
        (198, 18 | 19, _) => false,              // benchmarking
        (198, 51, 100) | (203, 0, 113) => false, // TEST-NET-2, TEST-NET-3
        (224..=255, _, _) => false,              // multicast, reserved, broadcast
        _ => true,
    }
}

fn embedded(b: &[u8; 16], at: usize, allow_loopback: bool) -> bool {
    let mut v4 = [0u8; 4];
    if let Some(s) = b.get(at..at + 4) {
        v4.copy_from_slice(s);
    }
    is_public_v4(v4, allow_loopback)
}

fn is_public_v6(b: &[u8; 16], allow_loopback: bool) -> bool {
    let zero_prefix = |n: usize| b.iter().take(n).all(|x| *x == 0);
    // ::1 loopback.
    if zero_prefix(15) && b[15] == 1 {
        return allow_loopback;
    }
    // ::ffff:a.b.c.d IPv4-mapped.
    if zero_prefix(10) && b[10] == 0xff && b[11] == 0xff {
        return embedded(b, 12, allow_loopback);
    }
    // 64:ff9b::/96 NAT64: a gateway connects to the embedded v4.
    if b[..4] == [0x00, 0x64, 0xff, 0x9b] && b[4..12].iter().all(|x| *x == 0) {
        return embedded(b, 12, allow_loopback);
    }
    // ::/96: unspecified and deprecated IPv4-compatible.
    if zero_prefix(12) {
        return false;
    }
    // Only global unicast 2000::/3 can be public.
    if b[0] & 0xe0 != 0x20 {
        return false;
    }
    // 2002::/16 6to4: the gateway connects to the v4 in bytes 2..5.
    if b[0] == 0x20 && b[1] == 0x02 {
        return embedded(b, 2, allow_loopback);
    }
    // 2001::/23 IETF assignments and 2001:db8::/32 documentation.
    if b[0] == 0x20 && b[1] == 0x01 && (b[2] & 0xfe == 0x00 || (b[2] == 0x0d && b[3] == 0xb8)) {
        return false;
    }
    // 3fff::/20 documentation.
    if b[0] == 0x3f && b[1] == 0xff && b[2] & 0xf0 == 0x00 {
        return false;
    }
    true
}

/// `isPublicIpAddress` on a parsed address.
pub fn is_public_ip(ip: IpAddr, allow_loopback: bool) -> bool {
    match ip {
        IpAddr::V4(v4) => is_public_v4(v4.octets(), allow_loopback),
        IpAddr::V6(v6) => is_public_v6(&v6.octets(), allow_loopback),
    }
}

/// `isPublicIpAddress`: true when `ip` (a v4 or v6 literal, no brackets) is globally routable; anything unparseable is
/// not. `allow_loopback` is the dev/test hatch and admits 127.0.0.0/8 and ::1 only.
pub fn is_public_ip_address(ip: &str, allow_loopback: bool) -> bool {
    parse_ip(ip).is_some_and(|a| is_public_ip(a, allow_loopback))
}

fn is_local_host(host: &str) -> bool {
    host == "localhost"
        || host == "::1"
        || matches!(host.parse::<Ipv4Addr>(), Ok(v4) if v4.octets()[0] == 127)
}

/// Ports of our own infrastructure (Postgres, Redis, NATS client and monitoring, Prometheus, Loki).
const INFRA_PORTS: [u16; 6] = [5432, 6379, 4222, 8222, 9090, 3100];

/// Internal-only DNS suffixes; `.svc` is a Kubernetes service name.
const INTERNAL_SUFFIXES: [&str; 10] = [
    ".local",
    ".internal",
    ".localhost",
    ".lan",
    ".home",
    ".corp",
    ".intranet",
    ".localdomain",
    ".home.arpa",
    ".svc",
];

/// Names that mean "us".
const INTERNAL_NAMES: [&str; 4] = ["localhost", "postgres", "nats", "redis"];

/// The host as the guard reads it: lowercased, unbracketed, without a trailing dot.
fn host_of(hostname: &str) -> String {
    let lower = hostname.to_lowercase();
    let bare = strip_brackets(&lower);
    bare.strip_suffix('.').unwrap_or(bare).to_owned()
}

/// `assertPublicWebhookUrl`: refuses unless `url` could plausibly be a public receiver, and returns it parsed. Syntax
/// only: what a name resolves to is [`resolve_public_addresses`]'s. Ports: 443 and any from 1024 up, except the
/// infrastructure ports; loopback in dev/test skips the port rule.
pub fn assert_public_webhook_url(url: &str, allow_local_http: bool) -> Result<Url, UrlRefusal> {
    let Ok(parsed) = Url::parse(url) else {
        return invalid("Webhook URL is not a valid absolute URL.", Reason::Invalid);
    };
    if !parsed.username().is_empty() || parsed.password().is_some() {
        return invalid("Webhook URL must not embed credentials.", Reason::Invalid);
    }
    let host = host_of(parsed.host_str().unwrap_or(""));
    if host.is_empty() {
        return invalid("Webhook URL has no host.", Reason::Invalid);
    }
    let literal = parse_ip(&host).is_some();
    let local = is_local_host(&host);
    let scheme = parsed.scheme();
    if scheme != "https" && !(scheme == "http" && allow_local_http && local) {
        return invalid(
            if allow_local_http {
                "Webhook URL must be https (http is only allowed for localhost)."
            } else {
                "Webhook URL must be https (http is only allowed for localhost in dev/test)."
            },
            Reason::Https,
        );
    }
    if local && allow_local_http {
        return Ok(parsed);
    }
    if literal {
        if !is_public_ip_address(&host, false) {
            return invalid(
                "Webhook URL points at a private, loopback, link-local or reserved address.",
                Reason::Private,
            );
        }
    } else {
        if INTERNAL_NAMES.contains(&host.as_str()) || host.starts_with("svc-") {
            return invalid(
                "Webhook URL points at an internal service name.",
                Reason::Private,
            );
        }
        if !host.contains('.') {
            return invalid(
                "Webhook URL host must be a fully qualified public hostname.",
                Reason::Private,
            );
        }
        if INTERNAL_SUFFIXES.iter().any(|s| host.ends_with(s)) {
            return invalid(
                "Webhook URL host is an internal-only name.",
                Reason::Private,
            );
        }
    }
    let port = parsed.port().unwrap_or(443);
    if scheme == "https" && (port == 443 || port >= 1024) && !INFRA_PORTS.contains(&port) {
        return Ok(parsed);
    }
    invalid(
        "Webhook URL port is not allowed (use 443, or a port from 1024 up that is not an infrastructure port).",
        Reason::Invalid,
    )
}

/// `WebhookResolver`: every answer for a name, never just the first; an `Err` is a resolver failure.
pub type Resolver = dyn Fn(&str) -> Result<Vec<IpAddr>, String> + Send + Sync;

/// `resolvePublicAddresses`: every vetted address for `hostname`, in connect order. Every answer must be public, or
/// the whole set is refused; a resolver error or no answer refuses too (fail closed). An IP literal is vetted without
/// asking DNS. Order: the resolver's, with families alternating from the first answer's, so an IPv6-first answer on an
/// IPv4-only host falls back to IPv4 on the next candidate.
pub fn resolve_public_addresses(
    hostname: &str,
    resolver: &Resolver,
    allow_loopback: bool,
) -> Result<Vec<IpAddr>, UrlRefusal> {
    let host = host_of(hostname);
    let answers = match parse_ip(&host) {
        Some(ip) => vec![ip],
        None => match resolver(&host) {
            Ok(a) => a,
            Err(_) => return invalid("Webhook host could not be resolved.", Reason::Unresolvable),
        },
    };
    if answers.is_empty() {
        return invalid(
            "Webhook host resolved to no addresses.",
            Reason::Unresolvable,
        );
    }
    if answers.iter().any(|a| !is_public_ip(*a, allow_loopback)) {
        return invalid(
            "Webhook host resolves to a private, loopback, link-local or reserved address.",
            Reason::Private,
        );
    }
    let (mut v4, mut v6): (Vec<IpAddr>, Vec<IpAddr>) = answers.iter().partition(|a| a.is_ipv4());
    v4.reverse();
    v6.reverse();
    let mut next_v4 = answers.first().is_some_and(IpAddr::is_ipv4);
    let mut ordered = Vec::with_capacity(answers.len());
    while ordered.len() < answers.len() {
        let (mine, other) = if next_v4 {
            (&mut v4, &mut v6)
        } else {
            (&mut v6, &mut v4)
        };
        if let Some(a) = mine.pop().or_else(|| other.pop()) {
            ordered.push(a);
        }
        next_v4 = !next_v4;
    }
    Ok(ordered)
}

/// The production resolver: the system's (`getaddrinfo`), bounded at four seconds (the TypeScript's c-ares resolver
/// takes two tries of two seconds), every A answer and then every AAAA answer, as `publicDnsResolver` returns them.
pub fn system_resolver(host: &str) -> Result<Vec<IpAddr>, String> {
    use std::net::ToSocketAddrs;
    let (tx, rx) = std::sync::mpsc::channel();
    let name = format!("{host}:443");
    std::thread::spawn(move || {
        let _ = tx.send(
            name.to_socket_addrs()
                .map(|a| a.map(|s| s.ip()).collect::<Vec<_>>())
                .map_err(|e| e.to_string()),
        );
    });
    let mut all = rx
        .recv_timeout(std::time::Duration::from_secs(4))
        .map_err(|_| "ETIMEOUT".to_owned())??;
    let mut seen = Vec::with_capacity(all.len());
    all.retain(|a| {
        let fresh = !seen.contains(a);
        seen.push(*a);
        fresh
    });
    all.sort_by_key(IpAddr::is_ipv6);
    Ok(all)
}

#[cfg(test)]
mod tests {
    //! `webhook-url-guard.test.ts`, case for case, for the guard (its `pinnedPost` cases are `pinned_post.rs`'s).
    #![allow(clippy::unwrap_used, reason = "a test: a failure is the point")]
    use super::*;

    fn refused(url: &str, allow_local: bool) {
        match assert_public_webhook_url(url, allow_local) {
            Ok(_) => panic!("{url} should have been refused"),
            Err(e) => assert!(e.message.contains("NOTHING WAS ATTEMPTED"), "{url}"),
        }
    }

    #[test]
    fn accepts_public_https_receivers() {
        for url in [
            "https://merchant.example/hooks/pay",
            "https://hooks.shop.example.com:8443/a?b=c",
            "https://8.8.8.8/hook",
            "https://[2606:4700:4700::1111]/hook",
            "https://MERCHANT.example./hook",
        ] {
            assert!(assert_public_webhook_url(url, false).is_ok(), "{url}");
        }
    }

    #[test]
    fn refuses_private_literals_in_every_spelling() {
        for url in [
            "https://127.0.0.1/hook",
            "https://127.1.2.3/hook",
            "https://127.1/hook",
            "https://10.0.0.5/hook",
            "https://172.16.0.1/hook",
            "https://172.31.255.255/hook",
            "https://192.168.1.1/hook",
            "https://169.254.169.254/latest/meta-data/",
            "https://169.254.1.1/hook",
            "https://100.64.0.1/hook",
            "https://100.127.255.254/hook",
            "https://0.0.0.0/hook",
            "https://0.1.2.3/hook",
            "https://224.0.0.1/hook",
            "https://240.0.0.1/hook",
            "https://255.255.255.255/hook",
            "https://192.0.2.1/hook",
            "https://198.19.0.1/hook",
            "https://2130706433/hook",
            "https://2852039166/hook",
            "https://0x7f000001/hook",
            "https://0x7f.0x0.0x0.0x1/hook",
            "https://0177.0.0.1/hook",
            "https://012.0.0.1/hook",
            "https://[::1]/hook",
            "https://[::]/hook",
            "https://[fc00::1]/hook",
            "https://[fd12:3456:789a::1]/hook",
            "https://[fe80::1]/hook",
            "https://[ff02::1]/hook",
            "https://[::ffff:127.0.0.1]/hook",
            "https://[::ffff:169.254.169.254]/hook",
            "https://[::ffff:a00:1]/hook",
            "https://[64:ff9b::a00:1]/hook",
            "https://[64:ff9b::169.254.169.254]/hook",
            "https://[2002:7f00:1::1]/hook",
            "https://[::7f00:1]/hook",
            "https://[2001:db8::1]/hook",
        ] {
            refused(url, false);
        }
    }

    #[test]
    fn refuses_internal_names() {
        for url in [
            "https://localhost/hook",
            "https://localhost./hook",
            "https://app.localhost/hook",
            "https://svc-ledger/hook",
            "https://svc-ledger:4001/hook",
            "https://svc-identity.example.com/hook",
            "https://postgres/hook",
            "https://nats/hook",
            "https://redis/hook",
            "https://intranet-box/hook",
            "https://metadata.google.internal/hook",
            "https://printer.local/hook",
            "https://nas.lan/hook",
            "https://router.home/hook",
            "https://wiki.corp/hook",
            "https://wiki.intranet/hook",
            "https://host.localdomain/hook",
            "https://svc-ledger.default.svc/hook",
            "https://svc-ledger.default.svc.cluster.local/hook",
            "https://a.internal./hook",
        ] {
            refused(url, false);
        }
    }

    #[test]
    fn refuses_http_credentials_bad_urls_and_non_urls() {
        for url in [
            "http://merchant.example/hook",
            "http://8.8.8.8/hook",
            "ftp://merchant.example/hook",
            "https://user:pw@merchant.example/hook",
            "https://user@merchant.example/hook",
            "not a url",
            "/relative/path",
            "",
            "javascript:alert(1)",
        ] {
            refused(url, false);
        }
    }

    #[test]
    fn port_rule() {
        for url in [
            "https://merchant.example:443/h",
            "https://merchant.example:1024/h",
            "https://merchant.example:8443/h",
        ] {
            assert!(assert_public_webhook_url(url, false).is_ok(), "{url}");
        }
        for port in [5432, 6379, 4222, 8222, 9090, 3100, 22, 25, 80, 1023] {
            refused(&format!("https://merchant.example:{port}/hook"), false);
        }
    }

    #[test]
    fn http_localhost_only_with_the_hatch() {
        for url in [
            "http://localhost:4000/h",
            "http://127.0.0.1:4000/h",
            "http://[::1]:4000/h",
            "https://localhost:4000/h",
        ] {
            assert!(assert_public_webhook_url(url, true).is_ok(), "{url}");
            refused(url, false);
        }
    }

    #[test]
    fn the_hatch_admits_loopback_only() {
        for url in [
            "http://10.0.0.1/h",
            "https://10.0.0.1/h",
            "https://169.254.169.254/h",
            "http://merchant.example/h",
            "https://svc-ledger/h",
        ] {
            refused(url, true);
        }
    }

    #[test]
    fn a_url_is_kept_as_the_whatwg_parser_writes_it() {
        assert_eq!(
            assert_public_webhook_url("http://127.0.0.1:9/agents-hook", true)
                .unwrap()
                .as_str(),
            "http://127.0.0.1:9/agents-hook"
        );
        assert_eq!(
            assert_public_webhook_url("https://MERCHANT.example./hook", false)
                .unwrap()
                .as_str(),
            "https://merchant.example./hook"
        );
    }

    #[test]
    fn classifies_representative_addresses() {
        assert!(is_public_ip_address("8.8.8.8", false));
        assert!(is_public_ip_address("1.1.1.1", false));
        assert!(is_public_ip_address("2606:4700:4700::1111", false));
        assert!(is_public_ip_address("::ffff:8.8.8.8", false));
        assert!(!is_public_ip_address("127.0.0.1", false));
        assert!(is_public_ip_address("127.0.0.1", true));
        assert!(is_public_ip_address("::1", true));
        assert!(!is_public_ip_address("10.0.0.1", true));
        assert!(!is_public_ip_address("not-an-ip", false));
        assert!(!is_public_ip_address("", false));
    }

    fn answers(addrs: &'static [&'static str]) -> Box<Resolver> {
        Box::new(move |_| Ok(addrs.iter().map(|a| a.parse().unwrap()).collect()))
    }

    fn ips(list: &[&str]) -> Vec<IpAddr> {
        list.iter().map(|a| a.parse().unwrap()).collect()
    }

    #[test]
    fn returns_the_vetted_public_address() {
        assert_eq!(
            resolve_public_addresses("merchant.example", &*answers(&["93.184.216.34"]), false),
            Ok(ips(&["93.184.216.34"]))
        );
        assert_eq!(
            resolve_public_addresses(
                "merchant.example",
                &*answers(&["2606:4700:4700::1111"]),
                false
            ),
            Ok(ips(&["2606:4700:4700::1111"]))
        );
    }

    #[test]
    fn refuses_when_any_answer_is_private() {
        let cases: [[&'static [&'static str]; 2]; 6] = [
            [
                &["93.184.216.34", "10.0.0.1"],
                &["10.0.0.1", "93.184.216.34"],
            ],
            [
                &["93.184.216.34", "127.0.0.1"],
                &["127.0.0.1", "93.184.216.34"],
            ],
            [
                &["93.184.216.34", "169.254.169.254"],
                &["169.254.169.254", "93.184.216.34"],
            ],
            [&["93.184.216.34", "::1"], &["::1", "93.184.216.34"]],
            [&["93.184.216.34", "fd00::1"], &["fd00::1", "93.184.216.34"]],
            [
                &["93.184.216.34", "::ffff:10.0.0.1"],
                &["::ffff:10.0.0.1", "93.184.216.34"],
            ],
        ];
        for pair in cases {
            for set in pair {
                let e = resolve_public_addresses("merchant.example", &*answers(set), false)
                    .unwrap_err();
                assert_eq!(e.reason, Reason::Private, "{set:?}");
            }
        }
    }

    #[test]
    fn fails_closed_on_a_resolver_error_or_an_empty_answer() {
        let boom: Box<Resolver> = Box::new(|_| Err("ENOTFOUND".to_owned()));
        assert!(resolve_public_addresses("merchant.example", &*boom, false).is_err());
        assert!(resolve_public_addresses("merchant.example", &*answers(&[]), false).is_err());
    }

    #[test]
    fn vets_an_ip_literal_without_asking_dns() {
        let never: Box<Resolver> =
            Box::new(|_| panic!("resolver must not be called for a literal"));
        assert_eq!(
            resolve_public_addresses("8.8.8.8", &*never, false),
            Ok(ips(&["8.8.8.8"]))
        );
        assert!(resolve_public_addresses("[::1]", &*never, false).is_err());
    }

    #[test]
    fn allow_loopback_admits_loopback_answers_only() {
        assert_eq!(
            resolve_public_addresses("localhost", &*answers(&["127.0.0.1"]), true),
            Ok(ips(&["127.0.0.1"]))
        );
        assert!(resolve_public_addresses("localhost", &*answers(&["127.0.0.1"]), false).is_err());
        assert!(resolve_public_addresses("x.example", &*answers(&["10.0.0.1"]), true).is_err());
    }

    #[test]
    fn every_vetted_address_alternating_families_from_the_first_answer() {
        assert_eq!(
            resolve_public_addresses(
                "m.example",
                &*answers(&[
                    "2606:4700:4700::1111",
                    "93.184.216.34",
                    "8.8.8.8",
                    "2606:4700:4700::1001"
                ]),
                false
            ),
            Ok(ips(&[
                "2606:4700:4700::1111",
                "93.184.216.34",
                "2606:4700:4700::1001",
                "8.8.8.8"
            ]))
        );
        assert_eq!(
            resolve_public_addresses("m.example", &*answers(&["93.184.216.34", "8.8.8.8"]), false),
            Ok(ips(&["93.184.216.34", "8.8.8.8"]))
        );
        assert!(
            resolve_public_addresses(
                "m.example",
                &*answers(&["93.184.216.34", "2606:4700:4700::1111", "10.0.0.1"]),
                false
            )
            .is_err()
        );
    }
}
