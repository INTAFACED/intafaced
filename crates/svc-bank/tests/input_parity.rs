//! Every svc-bank input schema (each call's, and the REST doors' contract bodies) against zod's own verdicts:
//! `tests/fixtures/input-parity/<slice>.golden.json`, recorded from the TypeScript schemas by `scripts/record-door.mjs` (thousands of inputs: each schema's sample, wrong types, extra keys,
//! and one fault at a time at each place in it). The Rust door's verdict must be the same, byte for byte: the same
//! output, or the same issues, or the same message from a refine that threw.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing,
    reason = "a test"
)]

use service_kit::json::{self, Json};
use service_kit::schema;
use svc_bank::door::inputs::{self, Refused};

/// The fixture of each slice, `<slice>.golden.json`: its verdicts and base inputs once, then its cases.
fn slice_files() -> Vec<(String, Json)> {
    let dir =
        std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/input-parity");
    let mut files: Vec<_> = std::fs::read_dir(&dir)
        .unwrap()
        .map(|e| e.unwrap().path())
        .collect();
    files.sort();
    files
        .into_iter()
        .map(|f| {
            let name = f
                .file_name()
                .unwrap()
                .to_string_lossy()
                .replace(".golden.json", "");
            (
                name,
                json::parse(&std::fs::read_to_string(&f).unwrap()).unwrap(),
            )
        })
        .collect()
}

fn text(j: &Json) -> String {
    match j {
        Json::String(s) => s.clone(),
        other => panic!("not text: {}", other.compact()),
    }
}

fn index(j: &Json) -> usize {
    match j {
        Json::Number(n) => format!("{n}").parse().unwrap(),
        other => panic!("not an index: {}", other.compact()),
    }
}

/// A probe written short: `["repeat", before, unit, count, after]` or `["many", element, count]`.
fn probe(v: &Json) -> Option<Json> {
    match v {
        Json::Null => None,
        Json::String(t) => Some(json::parse(t).unwrap()),
        Json::Array(a) => match a.as_slice() {
            [
                Json::String(k),
                Json::String(before),
                Json::String(unit),
                count,
                Json::String(after),
            ] if k == "repeat" => Some(Json::String(format!(
                "{before}{}{after}",
                unit.repeat(index(count))
            ))),
            [Json::String(k), Json::String(el), count] if k == "many" => {
                let el = json::parse(el).unwrap();
                Some(Json::Array(vec![el; index(count)]))
            }
            _ => panic!("an unknown probe {}", v.compact()),
        },
        other => panic!("an unknown probe {}", other.compact()),
    }
}

/// `setAt`: the value at `at` replaced (or removed: an array element removed reads back as null).
fn set_at(base: &mut Json, at: &[Json], value: Option<Json>) {
    let (last, parents) = at.split_last().unwrap();
    let mut here = base;
    for k in parents {
        here = match (here, k) {
            (Json::Object(o), Json::String(k)) => {
                &mut o.iter_mut().find(|(x, _)| x == k).unwrap().1
            }
            (Json::Array(a), Json::Number(_)) => &mut a[index(k)],
            _ => panic!("no place"),
        };
    }
    match (here, last) {
        (Json::Object(o), Json::String(k)) => {
            let at = o.iter().position(|(x, _)| x == k);
            match (at, value) {
                (Some(i), Some(v)) => o[i].1 = v,
                (Some(i), None) => {
                    o.remove(i);
                }
                (None, Some(v)) => {
                    o.push((k.clone(), v));
                    let fields = std::mem::take(o);
                    *o = json::js_key_order(fields);
                }
                (None, None) => {}
            }
        }
        (Json::Array(a), Json::Number(_)) => {
            let i = index(last);
            while a.len() <= i {
                a.push(Json::Null);
            }
            a[i] = value.unwrap_or(Json::Null);
        }
        _ => panic!("no place"),
    }
}

/// `[path, input, verdict]` against one file's verdicts and bases: a difference, or `None`.
fn judge(case: &Json, verdicts: &[String], bases: &[Json]) -> (String, Option<String>) {
    let Json::Array(c) = case else { panic!() };
    let path = text(&c[0]);
    let input = match &c[1] {
        Json::Null => None,
        Json::String(t) => Some(json::parse(t).unwrap()),
        Json::Array(m) => {
            let mut b = bases[index(&m[0])].clone();
            let Json::Array(at) = &m[1] else { panic!() };
            set_at(&mut b, at, probe(&m[2]));
            Some(b)
        }
        other => panic!("an unknown input {}", other.compact()),
    };
    let want = &verdicts[index(&c[2])];
    let got = match inputs::parse(&path, input.as_ref()).unwrap() {
        Ok(v) => {
            let out = v.to_json().map_or("undefined".to_owned(), |j| j.compact());
            let sent = input.as_ref().map_or("null".to_owned(), Json::compact);
            if out == sent {
                "ok =".to_owned()
            } else {
                format!("ok {out}")
            }
        }
        Err(Refused::Issues(i)) => format!("issues {}", schema::issues_json(&i).compact()),
        Err(Refused::Thrown(m)) => format!("throws {m}"),
    };
    let differs = (&got != want).then(|| {
        format!(
            "{path} {}\n  zod:  {want}\n  rust: {got}",
            input.as_ref().map_or("(none)".to_owned(), Json::compact)
        )
    });
    (path, differs)
}

#[test]
fn every_schema_answers_as_zod_does() {
    let mut wrong = Vec::new();
    let mut paths = std::collections::BTreeSet::new();
    let mut total = 0;
    let files = slice_files();
    for (slice, file) in &files {
        let list = |k: &str| match file.get(k) {
            Some(Json::Array(a)) => a.clone(),
            _ => panic!("{slice}: no {k}"),
        };
        let verdicts: Vec<String> = list("verdicts").iter().map(text).collect();
        let bases: Vec<Json> = list("bases")
            .iter()
            .map(|b| json::parse(&text(b)).unwrap())
            .collect();
        for case in &list("cases") {
            total += 1;
            let (path, differs) = judge(case, &verdicts, &bases);
            paths.insert(path);
            wrong.extend(differs);
        }
    }
    println!(
        "{total} inputs over {} calls and doors, in {} slice files; {} differ",
        paths.len(),
        files.len(),
        wrong.len()
    );
    for w in wrong.iter().take(25) {
        println!("{w}");
    }
    assert!(
        wrong.is_empty(),
        "{} of {total} inputs answer differently from zod",
        wrong.len()
    );
    let mut want: std::collections::BTreeSet<String> = svc_bank::door::calls::CALLS
        .iter()
        .map(|c| c.path.to_owned())
        .collect();
    for d in svc_bank::door::rest::DOORS
        .iter()
        .filter(|d| d.body == svc_bank::door::rest::BodyCheck::Schema)
    {
        want.insert(d.name());
    }
    assert_eq!(
        paths, want,
        "every call and schema-checked door has its cases"
    );
}
