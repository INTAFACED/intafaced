//! `assertProductionPosture` (`packages/config/src/production-posture.ts`), which `loadEnv` runs before any schema: a
//! process that is not explicitly dev or test refuses to start on development material (well-known dev keys, the
//! Anvil chain, published database passwords, placeholders) or on a migration-only service-call setting.

use std::collections::BTreeMap;

use crate::env::{EnvError, js_number};
use crate::money::js_trim;

pub const PRODUCTION_POSTURE_REFUSE_CODE: &str = "config.dev_material_in_production_posture";
pub const S2S_BODY_BIND_REFUSE_CODE: &str = "config.s2s_body_bind_not_required";

const KNOWN_DEV_PRIVATE_KEYS: [&str; 20] = [
    "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
    "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
    "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a",
    "0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6",
    "0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a",
    "0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba",
    "0x92db14e403b83dfe3df233f83dfa3a0d7096f21ca9b0d6d6b8d88b2b4ec1564e",
    "0x4bbbf85ce3377467afe5d46f804f221813b2bb87f24d81f60f1fcdbf7cbf4356",
    "0xdbda1821b80551c9d65939329250298aa3472ba22feea921c0cf5d620ea67b97",
    "0x2a871d0798f97d79848a013d4936a73bf4cc922c825d33c1cf7073dff6d409c6",
    "0xf214f2b2cd398c806f84e317254e0f0b801d0643303237d97a22a48e01628897",
    "0x701b615bbdfb9de65240bc28bd21bbc0d996645a3dd57e7b12bc2bdf6f192c82",
    "0xa267530f49f8280200edf313ee7af6b827f2a8bce2897751d06a843f644967b1",
    "0x47c99abed3324a2707c28affff1267e45918ec8c3f20b8aa892e8b065d2942dd",
    "0xc526ee95bf44d8fc405a158bb884d9d1238d99f0612e9f33d006bb0789009aaa",
    "0x8166f546bab6da521a8369cab06c5d2b9e46670292d85c875ee9ec20e84ffb61",
    "0xea6c44ac03bff858b476bba40716402b03e41b8e97e276d1baec7c37d42484a0",
    "0x689af8efa8c651a91ad287602527f3af2fe9f6501a7ac4b061667b5a93e037fd",
    "0xde9be858da4a475276426320d5e9262ecfc3ba460bfac56360bfa6c4c28b4ee0",
    "0xdf57089febbacf7ba0bc227dafbffa9fc08a93fdc68e1e42411a14efcf23656e",
];

const KNOWN_DEV_ADDRESSES: [&str; 30] = [
    "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266",
    "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
    "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC",
    "0x90F79bf6EB2c4f870365E785982E1f101E93b906",
    "0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65",
    "0x9965507D1a55bcC2695C58ba16FB37d819B0A4dc",
    "0x976EA74026E726554dB657fA54763abd0C3a0aa9",
    "0x14dC79964da2C08b23698B3D3cc7Ca32193d9955",
    "0x23618e81E3f5cdF7f54C3d65f7FBc0aBf5B21E8f",
    "0xa0Ee7A142d267C1f36714E4a8F75612F20a79720",
    "0xBcd4042DE499D14e55001CcbB24a551F3b954096",
    "0x71bE63f3384f5fb98995898A86B02Fb2426c5788",
    "0xFABB0ac9d68B0B445fB7357272Ff202C5651694a",
    "0x1CBd3b2770909D4e10f157cABC84C7264073C9Ec",
    "0xdF3e18d64BC6A983f673Ab319CCaE4f1a57C7097",
    "0xcd3B766CCDd6AE721141F452C550Ca635964ce71",
    "0x2546BcD3c84621e976D8185a91A922aE77ECEc30",
    "0xbDA5747bFD65F08deb54cb465eB87D40e51B197E",
    "0xdD2FD4581271e230360230F9337D5c0430Bf44C0",
    "0x8626f6940E2eb28930eFb4CeF49B2d1F2C9C1199",
    "0x5FbDB2315678afecb367f032d93F642f64180aa3",
    "0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512",
    "0x9fE46736679d2D9a65F0992F2272dE9f3c7fa6e0",
    "0xCf7Ed3AccA5a467e9e704C703E8D87F634fB0Fc9",
    "0xDc64a140Aa3E981100a9becA4E685f962f0cF6C9",
    "0x5FC8d32690cc91D4c39d9d3abcBD16989F875707",
    "0x0165878A594ca255338adfa4d48449f69242Eb8F",
    "0xa513E6E4b8f2a923D98304ec87F64353C4D5C853",
    "0x2279B7A0a67DB372996a5FaB50D91eAA73d2eBe6",
    "0x8A791620dd6260079BF849Dc5567aDC3F2FdC318",
];

const KNOWN_DEV_MNEMONIC: &str = "test test test test test test test test test test test junk";

const SERVICE_ROLE_NAMES: [&str; 26] = [
    "identity",
    "ledger",
    "token",
    "matching",
    "trade",
    "pay",
    "p2p",
    "blueprint",
    "bank",
    "launch",
    "academy",
    "market",
    "mining_pool",
    "agents",
    "core_ops",
    "ops",
    "notify",
    "support",
    "quant",
    "tax",
    "campaigns",
    "chain",
    "indexer",
    "bridge",
    "protocol",
    "connect_lake",
];

fn published_password(p: &str) -> bool {
    let p = p.to_lowercase();
    [
        "intafaced",
        "intafaced_ops",
        "postgres",
        "password",
        "changeme",
    ]
    .contains(&p.as_str())
        || p.strip_prefix("svc_")
            .is_some_and(|name| SERVICE_ROLE_NAMES.contains(&name))
}

const LOCAL_CHAIN_HOSTNAMES: [&str; 5] =
    ["evm", "anvil", "hardhat", "ganache", "host.docker.internal"];

/// `isExplicitDevOrTest`.
fn explicit_dev_or_test(app_env: Option<&str>) -> bool {
    matches!(app_env, Some("dev" | "test"))
}

/// `isProductionPosture(env)`.
pub fn is_production_posture(env: &BTreeMap<String, String>) -> bool {
    let app_env = env.get("APP_ENV").map(String::as_str);
    if explicit_dev_or_test(app_env) {
        return false;
    }
    if app_env.is_some_and(|a| !js_trim(a).is_empty()) {
        return true;
    }
    env.get("NODE_ENV").map(String::as_str) == Some("production")
}

fn word_char(c: Option<char>) -> bool {
    c.is_some_and(|c| c.is_ascii_alphanumeric())
}

/// `PLACEHOLDER`: `dev-only-`/`test-only-` (also `_`) at a word start, or a whole-word `replace-me`/`change-me`.
fn placeholder(value: &str) -> bool {
    let lower = value.to_ascii_lowercase();
    let chars: Vec<char> = lower.chars().collect();
    let at = |i: usize| chars.get(i).copied();
    let starts = |i: usize, w: &str| w.chars().enumerate().all(|(k, c)| at(i + k) == Some(c));
    for i in 0..chars.len() {
        let boundary = i == 0 || !word_char(at(i - 1));
        if !boundary {
            continue;
        }
        for prefix in ["dev", "test"] {
            let n = prefix.len();
            if starts(i, prefix)
                && matches!(at(i + n), Some('-' | '_'))
                && starts(i + n + 1, "only")
                && matches!(at(i + n + 5), Some('-' | '_'))
            {
                return true;
            }
        }
        for word in ["replace", "change"] {
            let n = word.len();
            if !starts(i, word) {
                continue;
            }
            let mut j = i + n;
            if matches!(at(j), Some('-' | '_')) {
                j += 1;
            }
            if starts(j, "me") && !word_char(at(j + 2)) {
                return true;
            }
        }
    }
    false
}

/// `isLocalChainHost`.
fn local_chain_host(hostname: &str) -> bool {
    let lower = hostname.to_lowercase();
    let host = lower.trim_start_matches('[').trim_end_matches(']');
    let host = host.strip_suffix('.').unwrap_or(host);
    if host == "localhost"
        || host.ends_with(".localhost")
        || ["0.0.0.0", "::", "::1"].contains(&host)
    {
        return true;
    }
    let parts: Vec<&str> = host.split('.').collect();
    if parts.len() == 4
        && parts.first() == Some(&"127")
        && parts
            .iter()
            .all(|p| (1..=3).contains(&p.len()) && p.bytes().all(|b| b.is_ascii_digit()))
    {
        return true;
    }
    if host.starts_with("::ffff:127.") || host.starts_with("::ffff:7f") {
        return true;
    }
    LOCAL_CHAIN_HOSTNAMES.contains(&host)
}

/// `decodeURIComponent`, falling back to the text as written.
fn decoded(value: &str) -> String {
    let b = value.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while let Some(&c) = b.get(i) {
        if c == b'%' {
            let hex = |at: usize| b.get(at).and_then(|h| char::from(*h).to_digit(16));
            match (hex(i + 1), hex(i + 2)) {
                (Some(h), Some(l)) => {
                    out.push(u8::try_from(h * 16 + l).unwrap_or(0));
                    i += 3;
                    continue;
                }
                _ => return value.to_owned(),
            }
        }
        out.push(c);
        i += 1;
    }
    String::from_utf8(out).unwrap_or_else(|_| value.to_owned())
}

fn db_url(text: &str) -> bool {
    let lower = text.to_lowercase();
    [
        "postgres",
        "postgresql",
        "redis",
        "rediss",
        "nats",
        "tls",
        "amqp",
        "amqps",
    ]
    .iter()
    .any(|s| lower.starts_with(&format!("{s}://")))
}

/// `credentialIssues`.
fn credential_issues(key: &str, value: &str, env: &BTreeMap<String, String>) -> Vec<String> {
    let mut issues = Vec::new();
    for part in value.split(',') {
        let text = js_trim(part);
        if !db_url(text) {
            continue;
        }
        let Ok(url) = url::Url::parse(text) else {
            continue;
        };
        let query = |k: &str| {
            url.query_pairs()
                .find(|(n, _)| n == k)
                .map(|(_, v)| v.into_owned())
        };
        let user = decoded(url.username());
        let mut password = decoded(url.password().unwrap_or(""));
        if password.is_empty() {
            password = query("password").unwrap_or_default();
        }
        let is_postgres = text.to_lowercase().starts_with("postgres:")
            || text.to_lowercase().starts_with("postgresql:");
        if password.is_empty() {
            let pg_password = env
                .get("PGPASSWORD")
                .is_some_and(|p| !js_trim(p).is_empty());
            if is_postgres
                && !user.is_empty()
                && !pg_password
                && query("sslcert").is_none_or(|c| c.is_empty())
            {
                issues.push(format!(
                    "{key} has no database password (and no PGPASSWORD or client certificate)"
                ));
            }
        } else if password == user || published_password(&password) {
            issues.push(format!(
                "{key} uses a connection password that is published in this repo (or equals the user name)"
            ));
        }
    }
    issues
}

fn test_runner_key(key: &str) -> bool {
    key.strip_prefix("TEST_DATABASE_URL").is_some_and(|rest| {
        rest.is_empty()
            || rest.strip_prefix('_').is_some_and(|r| {
                !r.is_empty()
                    && r.bytes()
                        .all(|b| b.is_ascii_uppercase() || b.is_ascii_digit() || b == b'_')
            })
    })
}

/// `/(?:^|_)(?:RPC|BUNDLER)(?:_|$)|(?:^|_)(?:INDEXER|PROTOCOL|CHAIN)_WS_URL$|CHAIN_URL$/i`.
fn chain_url_key(key: &str) -> bool {
    let k = key.to_uppercase();
    let segments: Vec<&str> = k.split('_').collect();
    if segments.contains(&"RPC") || segments.contains(&"BUNDLER") {
        return true;
    }
    let chain_ws = ["INDEXER_WS_URL", "PROTOCOL_WS_URL", "CHAIN_WS_URL"]; // shape-not-a-call: keys to refuse
    for p in chain_ws {
        if k == p || k.ends_with(&format!("_{p}")) {
            return true;
        }
    }
    k.ends_with("CHAIN_URL")
}

/// `productionPostureIssues(env)`.
pub fn production_posture_issues(env: &BTreeMap<String, String>) -> Vec<String> {
    if !is_production_posture(env) {
        return Vec::new();
    }
    let mut issues = Vec::new();
    for (key, raw) in env {
        let value = js_trim(raw);
        if value.is_empty() || test_runner_key(key) {
            continue;
        }
        let lower = value.to_lowercase();
        if placeholder(value) {
            issues.push(format!(
                "{key} holds a dev/test placeholder value (\"dev-only-\", \"test-only-\", \"replace-me\" or \"change-me\")"
            ));
        }
        if KNOWN_DEV_PRIVATE_KEYS
            .iter()
            .any(|k| lower.contains(k) || k.get(2..).is_some_and(|bare| lower.contains(bare)))
        {
            issues.push(format!(
                "{key} holds a well-known Anvil/Hardhat private key (public, anyone can spend from it)"
            ));
        }
        if lower.contains(KNOWN_DEV_MNEMONIC) {
            issues.push(format!(
                "{key} holds the well-known Anvil/Hardhat test mnemonic (public, anyone can derive its keys)"
            ));
        }
        if KNOWN_DEV_ADDRESSES
            .iter()
            .any(|a| lower.contains(&a.to_lowercase()))
        {
            issues.push(format!(
                "{key} holds a well-known Anvil/Hardhat address (its keys are public, so anyone controls it on a real chain)"
            ));
        }
        let upper = key.to_uppercase();
        if upper.ends_with("CHAIN_ID") || upper.ends_with("CHAIN_IDS") {
            for part in value.split([',', ' ', '\t', '\n', '\r']) {
                if part.is_empty() {
                    continue;
                }
                if js_number(part).is_some_and(|id| id == 31337.0 || id == 1337.0) {
                    issues.push(format!(
                        "{key} includes {part}, a local development chain id"
                    ));
                }
            }
        }
        if chain_url_key(key) {
            for part in value.split(',') {
                if let Ok(u) = url::Url::parse(js_trim(part))
                    && let Some(host) = u.host_str()
                    && local_chain_host(host)
                {
                    issues.push(format!(
                        "{key} points at a local chain node ({})",
                        host.to_lowercase()
                    ));
                }
            }
        }
        issues.extend(credential_issues(key, value, env));
        if key.eq_ignore_ascii_case("PGPASSWORD") && published_password(value) {
            issues.push(format!(
                "{key} is a database password that is published in this repo"
            ));
        }
    }
    issues
}

/// `productionPostureS2sIssues(env)`.
pub fn production_posture_s2s_issues(env: &BTreeMap<String, String>) -> Vec<String> {
    if !is_production_posture(env) {
        return Vec::new();
    }
    let mode = env.get("S2S_AUTH_MODE").map(String::as_str);
    let mut issues = Vec::new();
    if !matches!(mode, None | Some("off" | "keypair")) {
        issues.push(format!(
            "S2S_AUTH_MODE must be exactly \"off\" or \"keypair\" here: \"{}\" is the migration setting \
             (dual accepts the shared secret as well as the key) or is not a known mode, and neither may run on a real server",
            if mode == Some("dual") { "dual" } else { "that value" }
        ));
    }
    let secret = env
        .get("INTERNAL_SERVICE_SECRET")
        .filter(|s| !js_trim(s).is_empty());
    if secret.is_none()
        || env.get("INTERNAL_SERVICE_BODY_BIND").map(String::as_str) == Some("require")
    {
        return issues;
    }
    issues.push(
        "INTERNAL_SERVICE_BODY_BIND must be exactly \"require\" where INTERNAL_SERVICE_SECRET is set: any other value (or none) \
         leaves signed service calls replayable against any body for 300 seconds. Fix: set INTERNAL_SERVICE_BODY_BIND=require \
         (docs/decisions/s2s-body-bind.md)"
            .to_owned(),
    );
    issues
}

/// `assertProductionPosture(env)`.
pub fn assert_production_posture(env: &BTreeMap<String, String>) -> Result<(), EnvError> {
    let material = production_posture_issues(env);
    let s2s = production_posture_s2s_issues(env);
    if material.is_empty() && s2s.is_empty() {
        return Ok(());
    }
    let shown = match env.get("APP_ENV").map(String::as_str) {
        None | Some("") => "APP_ENV=<unset>".to_owned(),
        Some(a) => format!("APP_ENV={a}"),
    };
    let s2s_only = material.is_empty();
    let issues: Vec<String> = material.into_iter().chain(s2s).collect();
    let message = if s2s_only {
        format!(
            "SERVICE-CALL SETTINGS ARE NOT ALLOWED HERE ({shown}, {S2S_BODY_BIND_REFUSE_CODE}). Refusing to start.\n\
             Only APP_ENV exactly \"dev\" or \"test\" may run on a migration setting.\n  - {}",
            issues.join("\n  - ")
        )
    } else {
        format!(
            "DEVELOPMENT MATERIAL IS NOT ALLOWED HERE ({shown}, {PRODUCTION_POSTURE_REFUSE_CODE}). Refusing to start.\n\
             Only APP_ENV exactly \"dev\" or \"test\" may run on dev keys, the Anvil chain or published passwords.\n  - {}",
            issues.join("\n  - ")
        )
    };
    Err(EnvError { message, issues })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn env(pairs: &[(&str, &str)]) -> BTreeMap<String, String> {
        pairs
            .iter()
            .map(|(k, v)| ((*k).to_owned(), (*v).to_owned()))
            .collect()
    }

    #[test]
    fn dev_and_test_run_on_anything() {
        assert!(
            assert_production_posture(&env(&[("APP_ENV", "dev"), ("X", "dev-only-secret")]))
                .is_ok()
        );
        assert!(
            assert_production_posture(&env(&[("NODE_ENV", "test"), ("X", "dev-only-secret")]))
                .is_ok()
        );
    }

    #[test]
    fn a_real_server_refuses_development_material() {
        let refused = |pairs: &[(&str, &str)]| assert_production_posture(&env(pairs)).unwrap_err();
        let e = refused(&[
            ("APP_ENV", "prod"),
            ("EDGE_PRINCIPAL_SECRET", "dev-only-edge-secret"),
        ]);
        assert!(e.message.contains(PRODUCTION_POSTURE_REFUSE_CODE));
        let e = refused(&[
            ("APP_ENV", "staging"),
            (
                "DATABASE_URL",
                "postgres://svc_tax:svc_tax@postgres:5432/intafaced",
            ),
            ("INTERNAL_SERVICE_BODY_BIND", "require"),
        ]);
        assert_eq!(
            e.issues,
            vec![
                "DATABASE_URL uses a connection password that is published in this repo (or equals the user name)"
            ]
        );
        let e = refused(&[
            ("NODE_ENV", "production"),
            ("INTERNAL_SERVICE_SECRET", "x".repeat(40).as_str()),
        ]);
        assert!(e.message.contains(S2S_BODY_BIND_REFUSE_CODE));
        assert!(
            refused(&[("APP_ENV", "prod"), ("RPC_URL", "http://127.0.0.1:8545")]).issues[0]
                .contains("local chain node (127.0.0.1)")
        );
        assert!(
            refused(&[("APP_ENV", "prod"), ("CHAIN_ID", "0x7a69")]).issues[0].contains("0x7a69")
        );
        assert!(
            refused(&[("APP_ENV", "prod"), ("NOTE", "please change-me")]).issues[0]
                .contains("placeholder")
        );
        assert!(
            assert_production_posture(&env(&[("APP_ENV", "prod"), ("NOTE", "exchange-metrics")]))
                .is_ok()
        );
        assert!(
            assert_production_posture(&env(&[
                ("APP_ENV", "prod"),
                ("TEST_DATABASE_URL", "postgres://a:a@h/x_test")
            ]))
            .is_ok()
        );
    }
}
