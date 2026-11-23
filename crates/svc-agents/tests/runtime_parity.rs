//! The runtime slice's fixed lists that the platform's TypeScript also holds: a list changed on one side fails here.
//! Each list is read from its source file as written (\`export const NAME = [ ... ]\`), comments left out.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    reason = "a test: a failure is the point"
)]

use svc_agents::runtime::guardrails;

fn source(path: &str) -> String {
    let root = concat!(env!("CARGO_MANIFEST_DIR"), "/../../");
    std::fs::read_to_string(format!("{root}{path}")).unwrap_or_else(|e| panic!("{path}: {e}"))
}

/// The quoted strings of \`export const <name>... = [ ... ]\`, in order, with line comments dropped. For a list of
/// objects, only the values of \`key\`.
fn list(text: &str, name: &str, key: Option<&str>) -> Vec<String> {
    let start = text
        .find(&format!("export const {name}"))
        .unwrap_or_else(|| panic!("{name} is not exported"));
    let rest = &text[start..];
    let open = rest
        .find("= [")
        .unwrap_or_else(|| panic!("{name} is not a list"))
        + 3;
    // A list on one line closes on that line; a longer one on a line of its own.
    let line_end = rest[open..].find('\n').unwrap() + open;
    let close = match rest[open..line_end].rfind(']') {
        Some(c) => c + open,
        None => rest[open..].find("\n]").unwrap() + open,
    };
    let body: String = rest[open..close]
        .lines()
        .map(|l| l.split("//").next().unwrap_or(""))
        .collect::<Vec<_>>()
        .join("\n");
    let mut out = Vec::new();
    let mut s = body.as_str();
    while let Some(q) = s.find('\'') {
        let before = &s[..q];
        let after = &s[q + 1..];
        let end = after.find('\'').unwrap();
        let value = &after[..end];
        let keyed = key.is_none_or(|k| before.trim_end().ends_with(&format!("{k}:")));
        if keyed {
            out.push(value.to_owned());
        }
        s = &after[end + 1..];
    }
    out
}

fn owned(list: &[&str]) -> Vec<String> {
    list.iter().map(|s| (*s).to_owned()).collect()
}

#[test]
fn the_module_ids_are_the_platforms() {
    let ts = source("packages/config/src/modules.ts");
    assert_eq!(
        owned(&guardrails::MODULE_IDS),
        list(&ts, "MODULE_IDS", None)
    );
}
