//! `GET /ready` (`ready-honesty.ts`): the process is up, and whether the counsel map names any
//! region. JSON that is set is not a map: blank, `{}` and `[]` are unmapped. No `jurisdictionMapped` boolean, and no
//! custodial stamp: liveness is not a certified non-custodial plane.

use crate::json::Json;
use crate::tax::{TAX_JURISDICTION_UNMAPPED, parse_map};

/// `taxJurisdictionReadyHonesty(raw)`. A map that does not parse never reaches here: the service refuses to boot on it.
pub fn jurisdiction(raw: &str) -> Json {
    let mut regions = parse_map(raw).unwrap_or_default();
    regions.sort();
    regions.dedup();
    if regions.is_empty() {
        return Json::obj([
            ("status", Json::str("unmapped")),
            ("code", Json::str(TAX_JURISDICTION_UNMAPPED)),
            ("regionCount", Json::int(0)),
        ]);
    }
    Json::obj([
        ("status", Json::str("mapped")),
        (
            "regionCount",
            Json::int(i64::try_from(regions.len()).unwrap_or(i64::MAX)),
        ),
    ])
}

/// `taxReadyHonesty(env)`.
pub fn ready(raw: &str) -> Json {
    Json::obj([
        ("ready", Json::Bool(true)),
        ("jurisdiction", jurisdiction(raw)),
    ])
}

#[cfg(test)]
mod tests {
    use super::*;

    // ready-honesty.test.ts
    #[test]
    fn blank_empty_object_and_empty_array_are_unmapped_never_mapped() {
        for raw in ["", "   ", "{}", "[]"] {
            assert_eq!(
                jurisdiction(raw).compact(),
                r#"{"status":"unmapped","code":"tax.jurisdiction_unmapped","regionCount":0}"#,
                "{raw:?}"
            );
        }
        assert!(!ready("{}").compact().contains(r#""status":"mapped""#));
    }

    #[test]
    fn owner_regions_are_mapped_with_a_count_never_a_length_boolean() {
        let body = ready(r#"{"DE":{},"GB":{}}"#).compact();
        assert_eq!(
            body,
            r#"{"ready":true,"jurisdiction":{"status":"mapped","regionCount":2}}"#
        );
        assert!(!body.contains("jurisdictionMapped"));
        assert!(!body.contains("custodial"));
        assert_eq!(
            ready(r#"["DE","DE","FR"]"#).compact(),
            r#"{"ready":true,"jurisdiction":{"status":"mapped","regionCount":2}}"#,
            "a Set counts each region once"
        );
    }

    #[test]
    fn ready_honesty_does_not_stamp_custodial() {
        let src = include_str!("ready.rs");
        let stamp = ["custodial", ":", " false"].concat();
        assert!(!src.contains(&stamp));
    }
}
