//! `router.mount.test.ts`, case for case, through the door. The TypeScript's scan of `router.ts`
//! for a literal `custodial: false` is a scan of the Rust door (`src/wire.rs`) here.
#![allow(
    clippy::unwrap_used,
    clippy::indexing_slicing,
    reason = "a test: a failure is the point"
)]

use crate::common;

use std::sync::Arc;

use common::fake::{self, FakeLedger};
use common::{assert_json, date, door, list, some, text};
use svc_tax::json::Json;
use svc_tax::tax::{
    LakeStatus, TAX_EXPORT_INCOMPLETE, TAX_HISTORY_YEARS_UNSET, TAX_JURISDICTION_UNMAPPED, TaxDeps,
    TaxService,
};
use svc_tax::wire::{Request, Response};

const USER: &str = "11111111-1111-4111-8111-111111111111";

fn deps(map: &str, years: Option<i64>) -> TaxDeps {
    TaxDeps::new(
        map,
        Arc::new(FakeLedger::default()),
        years,
        Box::new(|| date("2026-01-02T00:00:00.000Z")),
    )
}

fn empty_tax(map: &str) -> TaxService {
    fake::service(deps(map, Some(10)))
}

fn export_pack(tax: TaxService, input: &str) -> Response {
    let wire = door::serve(tax);
    door::mutate(
        &wire,
        &door::signed(USER, &["tax:read", "ledger:read"], "DE"),
        "exportPack",
        input,
    )
}

#[track_caller]
fn precondition(r: &Response, code: &str) {
    let (_, trpc, message) = door::error(r);
    assert_eq!(trpc, "PRECONDITION_FAILED");
    assert!(message.contains(code), "{message}");
}

// health: liveness is not a custodial stamp

#[test]
fn health_answers_ok_and_the_service_and_stamps_nothing_custodial() {
    let wire = door::serve(empty_tax(""));
    let r = wire.handle(&Request {
        method: "GET",
        url: "/trpc/health",
        headers: &[],
        body: "",
    });
    let health = door::data(&r);
    assert_json(&health, r#"{"ok":true,"service":"svc-tax"}"#);
    assert_eq!(health.get("custodial"), None);
}

#[test]
fn the_door_does_not_literal_stamp_custodial_false() {
    let src = std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/src/wire.rs")).unwrap();
    assert!(!src.contains("custodial"));
}

// svc-tax router

#[test]
fn a_blank_map_export_pack_is_unmapped() {
    precondition(
        &export_pack(empty_tax(""), r#"{"lotMethod":"FIFO"}"#),
        TAX_JURISDICTION_UNMAPPED,
    );
}

#[test]
fn unset_history_years_is_history_years_unset() {
    precondition(
        &export_pack(
            fake::service(deps(r#"["DE"]"#, None)),
            r#"{"lotMethod":"FIFO"}"#,
        ),
        TAX_HISTORY_YEARS_UNSET,
    );
}

#[test]
fn mapped_empty_books_return_an_empty_pack_with_no_zero() {
    let pack = door::data(&export_pack(
        empty_tax(r#"["DE"]"#),
        r#"{"lotMethod":"HIFO"}"#,
    ));
    assert_eq!(pack.get("empty"), Some(&Json::Bool(true)));
    assert_eq!(pack.get("complete"), Some(&Json::Bool(false)));
    assert_eq!(pack.get("realized"), Some(&Json::Null));
    assert_eq!(text(&pack, "lotMethod"), some("HIFO"));
    assert!(!text(&pack, "bodyBase64").unwrap().is_empty());
    assert!(list(&pack, "residuals").contains(&Json::str(TAX_EXPORT_INCOMPLETE)));
    assert_eq!(text(pack.get("lake").unwrap(), "status"), some("absent"));
    assert_eq!(text(pack.get("indexer").unwrap(), "status"), some("absent"));
    assert!(!pack.compact().contains(r#""status":"ok""#));
}

#[test]
fn export_pack_complete_is_export_incomplete() {
    precondition(
        &export_pack(
            empty_tax(r#"["DE"]"#),
            r#"{"lotMethod":"FIFO","complete":true}"#,
        ),
        TAX_EXPORT_INCOMPLETE,
    );
}

#[test]
fn a_set_lake_or_indexer_url_is_configured_never_ok() {
    let tax = fake::service(TaxDeps {
        lake: LakeStatus::lake(Some("http://lake.example/tsdb")),
        indexer: LakeStatus::indexer(Some("http://indexer.example")),
        ..deps(r#"["DE"]"#, Some(10))
    });
    let pack = door::data(&export_pack(tax, r#"{"lotMethod":"FIFO"}"#));
    assert_json(
        pack.get("lake").unwrap(),
        r#"{"status":"configured","code":"tax.data_lake_unprobed"}"#,
    );
    assert_json(
        pack.get("indexer").unwrap(),
        r#"{"status":"configured","code":"tax.indexer_unprobed"}"#,
    );
    assert!(!pack.compact().contains(r#""status":"ok""#));
}
