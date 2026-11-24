//! The zero-PII bar on the share card's surfaces (`assertZeroPiiSurface` in
//! `services/svc-blueprint/src/attestations/zero-pii.ts`): a payload whose keys, at any depth, name a person, a KYC
//! record, a custodial account id or a cross-plane address is refused with its named code, the first such key in the
//! order `Object.entries` walks them. Only the keys are read, never the values.
//!
//! `tests/card_parity.rs` holds it to the TypeScript's verdicts (`tests/fixtures/card.golden.json`).

use service_kit::json::Json;

use crate::errors::Refusal;

/// The normalized keys the bar refuses, each with its code.
const FORBIDDEN: [(&str, &str); 43] = [
    ("identity", IDENTITY),
    ("identityid", IDENTITY),
    ("legalname", IDENTITY),
    ("fullname", IDENTITY),
    ("firstname", IDENTITY),
    ("lastname", IDENTITY),
    ("displayname", IDENTITY),
    ("givenname", IDENTITY),
    ("name", IDENTITY),
    ("email", IDENTITY),
    ("phone", IDENTITY),
    ("handle", IDENTITY),
    ("username", IDENTITY),
    ("avatar", IDENTITY),
    ("birthdata", IDENTITY),
    ("birthdate", IDENTITY),
    ("birthtime", IDENTITY),
    ("birthplace", IDENTITY),
    ("governmentid", IDENTITY),
    ("nationalid", IDENTITY),
    ("passport", IDENTITY),
    ("ssn", IDENTITY),
    ("kyc", KYC),
    ("kycstatus", KYC),
    ("kycid", KYC),
    ("kycdocument", KYC),
    ("verificationlevel", KYC),
    ("aml", KYC),
    ("userid", CUSTODIAL_USER_ID),
    ("custodialuserid", CUSTODIAL_USER_ID),
    ("customerid", CUSTODIAL_USER_ID),
    ("ledgeruserid", CUSTODIAL_USER_ID),
    ("accountid", CUSTODIAL_USER_ID),
    ("walletaddress", CROSS_PLANE_ADDRESS),
    ("evmaddress", CROSS_PLANE_ADDRESS),
    ("chainaddress", CROSS_PLANE_ADDRESS),
    ("onchainaddress", CROSS_PLANE_ADDRESS),
    ("crossplaneaddress", CROSS_PLANE_ADDRESS),
    ("smartaccount", CROSS_PLANE_ADDRESS),
    ("intachainaddress", CROSS_PLANE_ADDRESS),
    ("publickey", CROSS_PLANE_ADDRESS),
    // The camel-case forms whose stripped spelling is not the key above (`CAMEL_CASE_PII_FOLDS`).
    ("phonenumber", IDENTITY),
    ("emailaddress", IDENTITY),
];

/// `dateofbirth` folds to `birthdate`; kept apart from the table so the table stays the TypeScript's list.
const FOLDS: [(&str, &str); 1] = [("dateofbirth", "birthdate")];

const IDENTITY: &str = "blueprint.attestation_pii_identity";
const KYC: &str = "blueprint.attestation_pii_kyc";
const CUSTODIAL_USER_ID: &str = "blueprint.attestation_pii_custodial_user_id";
const CROSS_PLANE_ADDRESS: &str = "blueprint.attestation_pii_cross_plane_address";

/// `normalizeSurfaceKey`: letters and digits only, lower-cased, then the camel-case folds.
fn normalize(key: &str) -> String {
    let flat: String = key
        .chars()
        .filter(char::is_ascii_alphanumeric)
        .map(|c| c.to_ascii_lowercase())
        .collect();
    FOLDS
        .iter()
        .find(|(from, _)| *from == flat)
        .map_or(flat, |(_, to)| (*to).to_owned())
}

/// `refuseCodeForPiiKey`.
fn code_for(key: &str) -> Option<&'static str> {
    let key = normalize(key);
    FORBIDDEN.iter().find(|(k, _)| *k == key).map(|(_, c)| *c)
}

fn first_forbidden(value: &Json) -> Option<(&str, &'static str)> {
    match value {
        Json::Array(items) => items.iter().find_map(first_forbidden),
        Json::Object(fields) => fields.iter().find_map(|(key, child)| {
            code_for(key)
                .map(|code| (key.as_str(), code))
                .or_else(|| first_forbidden(child))
        }),
        _ => None,
    }
}

/// `inspectZeroPiiPayload`: `None` when the payload passes, else the first refused key and its code.
pub fn inspect(payload: &Json) -> Option<(String, &'static str)> {
    first_forbidden(payload).map(|(k, c)| (k.to_owned(), c))
}

/// `assertZeroPiiSurface(surface, payload)`: the `AttestationSurfaceError` it throws, a 400 on a mapped call.
pub fn assert_surface(surface: &str, payload: &Json) -> Result<(), Refusal> {
    let Some((field, code)) = inspect(payload) else {
        return Ok(());
    };
    let message = format!("{surface}: attestation/card payload refuses PII field {field} ({code})");
    Err(
        Refusal::attestation(code, message).unwrap_or(Refusal::Other {
            message: format!("{code} is not in the catalogue"),
            code: None,
        }),
    )
}
