//! `services/svc-tax/src/jurisdiction-map.test.ts`, case for case. In Rust the map is parsed when the service is
//! built and its two checks run inside the export, so each is asked through the service: a map that maps nothing
//! refuses every region, a mapped one admits exactly its regions.
#![allow(
    clippy::unwrap_used,
    clippy::indexing_slicing,
    reason = "a test: a failure is the point"
)]

mod common;

use std::sync::Arc;

use common::fake::{self, FakeLedger};
use common::{date, some, text};
use svc_tax::json::Json;
use svc_tax::tax::{
    Failure, TAX_EXPORT_INCOMPLETE, TAX_JURISDICTION_MAP_INVALID, TAX_JURISDICTION_UNMAPPED,
    TaxDeps, TaxError, TaxService,
};

const USER: &str = "11111111-1111-4111-8111-111111111111";

fn built(map: &str) -> Result<TaxService, TaxError> {
    TaxService::new(TaxDeps::new(
        map,
        Arc::new(FakeLedger::default()),
        Some(10),
        Box::new(|| date("2026-01-02T00:00:00.000Z")),
    ))
}

fn export(map: &str, region: &str, complete: Option<bool>) -> Result<Json, Failure> {
    built(map)
        .unwrap()
        .export(USER, region, "FIFO", complete)
        .map(|x| x.preview())
}

fn admits(map: &str, region: &str) -> bool {
    match export(map, region, None) {
        Ok(_) => true,
        Err(Failure::Refused(e)) if e.code == TAX_JURISDICTION_UNMAPPED => false,
        other => panic!("{map} {region}: {other:?}"),
    }
}

// parseJurisdictionMap

#[test]
fn blank_empty_object_and_empty_array_are_unmapped() {
    for map in ["", "   ", "{}", "[]"] {
        for region in ["DE", "US", "GB"] {
            assert!(!admits(map, region), "{map:?} {region}");
        }
    }
}

#[test]
fn object_keys_and_array_entries_become_the_mapped_set() {
    for (map, mapped) in [
        (r#"{"DE":{},"GB":{}}"#, ["DE", "GB"]),
        (r#"["DE","FR"]"#, ["DE", "FR"]),
    ] {
        for region in ["DE", "GB", "FR", "US"] {
            assert_eq!(
                admits(map, region),
                mapped.contains(&region),
                "{map} {region}"
            );
        }
    }
}

#[test]
fn invalid_json_is_a_named_refusal() {
    match built("{de}") {
        Err(e) => assert_eq!(e.code, TAX_JURISDICTION_MAP_INVALID),
        Ok(_) => panic!("built over invalid JSON"),
    }
}

// requireMappedRegion

#[test]
fn refuses_unmapped_and_unknown_regions() {
    assert_eq!(
        fake::refused(export("", "DE", None)).code,
        TAX_JURISDICTION_UNMAPPED
    );
    assert_eq!(
        fake::refused(export(r#"["DE"]"#, "US", None)).code,
        TAX_JURISDICTION_UNMAPPED
    );
}

#[test]
fn accepts_a_mapped_region_in_any_case() {
    let p = export(r#"["DE"]"#, "de", None).unwrap();
    assert_eq!(text(&p, "jurisdiction"), some("DE"));
}

// refuseExportCompleteness

#[test]
fn lets_a_pack_proceed_when_completeness_is_not_claimed() {
    assert!(export(r#"["DE"]"#, "DE", None).is_ok());
    assert!(export(r#"["DE"]"#, "DE", Some(false)).is_ok());
}

#[test]
fn refuses_complete_and_never_invents_jurisdictions() {
    let e = fake::refused(export(r#"["DE"]"#, "DE", Some(true)));
    assert_eq!(e.code, TAX_EXPORT_INCOMPLETE);
    for word in ["US", "GB", "FR"] {
        assert!(
            !e.message
                .split(|c: char| !c.is_ascii_alphanumeric())
                .any(|w| w == word),
            "{}",
            e.message
        );
    }
    assert!(!admits("", "DE"));
}
