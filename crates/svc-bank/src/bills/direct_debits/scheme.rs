//! WHO SPEAKS FOR THE DIRECT DEBIT SCHEME (`direct-debits/scheme.ts`, BK-xfer-11).
//!
//! Which scheme the bank joins, its failure fees and its guarantee periods are the owner's call. `BANK_DD_SCHEME=none`
//! (the default) is the unset scheme, and every customer control refuses `rail.bank`. `dd-sim` is the stand-in for the
//! local test stack: a TEST catalogue (`BANK_DD_SIM_JSON`) names the TEST creditors and a TEST guarantee period. It
//! calls no network and pays nobody: a collection posts once in the real book to the stand-in's rail boundary. Chosen
//! outside an explicit dev or test process, or over a blank or unreadable catalogue, the service refuses to start.
//!
//! Not in the catalogue on purpose: the failure fee table (`bank.dd_failure_fee_unset`).

use service_kit::json::{self, Json};

/// `DD_SIM_RAIL`: the ledger rail boundary the stand-in's collections land on.
pub const DD_SIM_RAIL: &str = "dd-sim";

/// `DirectDebitCreditor`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Creditor {
    pub id: String,
    pub name: String,
}

/// `DirectDebitScheme`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Scheme {
    /// `unset` or `live`.
    pub status: &'static str,
    /// The stand-in's TEST label; none for a real scheme.
    pub stand_in: Option<String>,
    /// The ledger rail boundary a collection posts to.
    pub rail_id: String,
    /// Days after a collection in which a refund may be requested; none is not set.
    pub guarantee_days: Option<i64>,
    creditors: Vec<Creditor>,
}

/// `DirectDebitSimCatalogue`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Catalogue {
    pub label: String,
    pub guarantee_days: Option<i64>,
    pub creditors: Vec<Creditor>,
}

impl Scheme {
    /// `unsetDirectDebitScheme`.
    pub fn unset() -> Scheme {
        Scheme {
            status: "unset",
            stand_in: None,
            rail_id: String::new(),
            guarantee_days: None,
            creditors: Vec::new(),
        }
    }

    /// `directDebitSimScheme`.
    pub fn sim(catalogue: Catalogue) -> Scheme {
        Scheme {
            status: "live",
            stand_in: Some(catalogue.label),
            rail_id: DD_SIM_RAIL.to_owned(),
            guarantee_days: catalogue.guarantee_days,
            creditors: catalogue.creditors,
        }
    }

    pub fn live(&self) -> bool {
        self.status == "live"
    }

    /// The creditor the scheme knows by this id, or none.
    pub fn creditor(&self, id: &str) -> Option<Creditor> {
        self.creditors.iter().find(|c| c.id == id).cloned()
    }
}

/// `/^TEST\b/`: `TEST` not followed by a word character.
fn test_labelled(s: &str) -> bool {
    s.strip_prefix("TEST").is_some_and(|rest| {
        !rest
            .chars()
            .next()
            .is_some_and(|c| c.is_ascii_alphanumeric() || c == '_')
    })
}

/// `/^[A-Za-z0-9._:-]{1,64}$/`.
fn creditor_id_ok(s: &str) -> bool {
    (1..=64).contains(&s.len())
        && s.bytes()
            .all(|b| b.is_ascii_alphanumeric() || b".:_-".contains(&b))
}

fn object(j: &Json, keys: &[&str]) -> Option<Vec<(String, Json)>> {
    let Json::Object(fields) = j else { return None };
    fields
        .iter()
        .all(|(k, _)| keys.contains(&k.as_str()))
        .then(|| fields.clone())
}

fn field<'a>(fields: &'a [(String, Json)], key: &str) -> Option<&'a Json> {
    fields.iter().find(|(k, _)| k == key).map(|(_, v)| v)
}

/// `parseDirectDebitSim`: the typed catalogue, or none when it is blank, not JSON, not labelled TEST or not in shape.
pub fn parse_sim(raw: Option<&str>) -> Option<Catalogue> {
    let raw = raw?;
    if service_kit::money::js_trim(raw).is_empty() {
        return None;
    }
    let v = json::parse(raw).ok()?;
    let top = object(&v, &["label", "guaranteeDays", "creditors"])?;
    let Some(Json::String(label)) = field(&top, "label") else {
        return None;
    };
    if !test_labelled(label) {
        return None;
    }
    let guarantee_days = match field(&top, "guaranteeDays")? {
        Json::Null => None,
        Json::Number(n) if n.fract() == 0.0 && (1.0..=400.0).contains(n) => {
            #[allow(clippy::cast_possible_truncation, reason = "a whole number 1 to 400")]
            let days = *n as i64;
            Some(days)
        }
        _ => return None,
    };
    let Some(Json::Array(list)) = field(&top, "creditors") else {
        return None;
    };
    if list.is_empty() {
        return None;
    }
    let mut creditors = Vec::new();
    for one in list {
        let f = object(one, &["id", "name"])?;
        let (Some(Json::String(id)), Some(Json::String(name))) =
            (field(&f, "id"), field(&f, "name"))
        else {
            return None;
        };
        if !creditor_id_ok(id) || !test_labelled(name) || name.encode_utf16().count() > 140 {
            return None;
        }
        if creditors.iter().any(|c: &Creditor| &c.id == id) {
            return None;
        }
        creditors.push(Creditor {
            id: id.clone(),
            name: name.clone(),
        });
    }
    Some(Catalogue {
        label: label.clone(),
        guarantee_days,
        creditors,
    })
}

/// `directDebitSchemeFor`: `none` is the unset scheme; `dd-sim` is the stand-in only in an explicit dev or test process
/// (the RAW `APP_ENV` exactly `dev` or `test`, and not `NODE_ENV=production`) over a readable TEST catalogue, and refuses
/// to start otherwise, naming `DirectDebitSimRefusedError`'s code.
pub fn scheme_for(
    setting: &str,
    catalogue: Option<&str>,
    app_env: Option<&str>,
    node_env: Option<&str>,
) -> Result<Scheme, String> {
    if setting != "dd-sim" {
        return Ok(Scheme::unset());
    }
    if !matches!(app_env, Some("dev" | "test")) || node_env == Some("production") {
        return Err(
            "bank.dd_sim_outside_dev_test: BANK_DD_SCHEME=dd-sim is a local-test stand-in that pays nobody; it runs only with APP_ENV exactly dev or test."
                .to_owned(),
        );
    }
    parse_sim(catalogue).map(Scheme::sim).ok_or_else(|| {
        "bank.dd_sim_catalogue_unreadable: BANK_DD_SCHEME=dd-sim needs BANK_DD_SIM_JSON: a catalogue labelled TEST, in shape (see direct-debits/scheme.ts)."
            .to_owned()
    })
}

#[cfg(test)]
mod tests {
    //! `scheme.test.ts`, each test named after the TypeScript test's words.
    #![allow(clippy::unwrap_used, reason = "a test")]
    use super::*;

    const CATALOGUE: &str = r#"{"label":"TEST direct debit stand-in","guaranteeDays":30,"creditors":[{"id":"TEST-GYM","name":"TEST Gym"}]}"#;

    #[test]
    fn is_unset_by_default_no_stand_in_no_guarantee_period_no_creditor() {
        let s = scheme_for("none", Some(CATALOGUE), Some("dev"), None).unwrap();
        assert_eq!(s, Scheme::unset());
        assert_eq!(
            (s.status, s.stand_in, s.guarantee_days),
            ("unset", None, None)
        );
    }

    #[test]
    fn gives_the_stand_in_in_dev_or_test_over_a_test_catalogue() {
        let s = scheme_for("dd-sim", Some(CATALOGUE), Some("test"), None).unwrap();
        assert_eq!(s.status, "live");
        assert_eq!(s.stand_in.as_deref(), Some("TEST direct debit stand-in"));
        assert_eq!(s.rail_id, "dd-sim");
        assert_eq!(s.guarantee_days, Some(30));
        assert_eq!(
            s.creditor("TEST-GYM"),
            Some(Creditor {
                id: "TEST-GYM".to_owned(),
                name: "TEST Gym".to_owned()
            })
        );
        assert_eq!(s.creditor("NOBODY"), None);
    }

    #[test]
    fn refuses_to_start_outside_dev_or_test_or_under_node_env_production() {
        for (app, node) in [
            (None, None),
            (Some("production"), None),
            (Some("staging"), None),
            (Some("dev"), Some("production")),
        ] {
            let e = scheme_for("dd-sim", Some(CATALOGUE), app, node).unwrap_err();
            assert!(e.starts_with("bank.dd_sim_outside_dev_test"), "{e}");
        }
    }

    #[test]
    fn refuses_to_start_over_a_blank_unlabelled_or_out_of_shape_catalogue() {
        for bad in [
            None,
            Some(""),
            Some("not json"),
            Some(
                r#"{"label":"Live scheme","guaranteeDays":30,"creditors":[{"id":"A","name":"TEST A"}]}"#,
            ),
            Some(
                r#"{"label":"TEST","guaranteeDays":30,"creditors":[{"id":"A","name":"A real company"}]}"#,
            ),
            Some(r#"{"label":"TEST","guaranteeDays":30,"creditors":[]}"#),
            Some(
                r#"{"label":"TEST","guaranteeDays":30,"creditors":[{"id":"A","name":"TEST A"},{"id":"A","name":"TEST B"}]}"#,
            ),
            Some(
                r#"{"label":"TEST","guaranteeDays":30,"creditors":[{"id":"A","name":"TEST A"}],"failureFees":[]}"#,
            ),
        ] {
            assert_eq!(parse_sim(bad), None, "{bad:?}");
            let e = scheme_for("dd-sim", bad, Some("dev"), None).unwrap_err();
            assert!(e.starts_with("bank.dd_sim_catalogue_unreadable"), "{e}");
        }
    }

    #[test]
    fn keeps_a_null_guarantee_period_as_not_set() {
        let parsed = parse_sim(Some(
            r#"{"label":"TEST","guaranteeDays":null,"creditors":[{"id":"A","name":"TEST A"}]}"#,
        ))
        .unwrap();
        assert_eq!(parsed.guarantee_days, None);
    }
}
