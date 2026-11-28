//! The owner's destination sanctions list (`ramps/sanctions-list.ts`), as an own move screens its wallet
//! (`RampService.screenWallet`: `assertNotSanctioned(list, null, address)`). One owner setting,
//! `BANK_DESTINATION_SANCTIONS`: a comma-separated list of `<network>:<address>` (`*` for every network). Blank, unset or
//! unreadable refuses every address with `bank.destination_sanctions_unset`; nothing here supplies entries. An EVM
//! address is matched in lower case, any other exactly as written. The ramps slice's address book will share this.

use crate::errors::Refusal;
use crate::partner::refuse;

/// `ANY_NETWORK`.
const ANY_NETWORK: &str = "*";

/// `isEvmAddressRef`: `^0x[0-9a-fA-F]{40}$` on the trimmed ref.
fn is_evm(r: &str) -> bool {
    let t = service_kit::money::js_trim(r);
    t.len() == 42 && t.starts_with("0x") && t.bytes().skip(2).all(|b| b.is_ascii_hexdigit())
}

/// `fraudAddressKey`.
fn address_key(r: &str) -> String {
    let t = service_kit::money::js_trim(r);
    if is_evm(t) {
        t.to_lowercase()
    } else {
        t.to_owned()
    }
}

/// `fraudNetworkKey`: `*`, or a network id (`^[a-z0-9_-]{1,32}$` once lower-cased); anything else is none.
fn network_key(n: &str) -> Option<String> {
    let t = service_kit::money::js_trim(n);
    if t == ANY_NETWORK {
        return Some(ANY_NETWORK.to_owned());
    }
    let key = t.to_lowercase();
    let ok = (1..=32).contains(&key.len())
        && key
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_' || b == b'-');
    ok.then_some(key)
}

/// `readSanctionsList`: the entries, or none when the setting is unset, blank or unreadable.
pub fn read_list(raw: Option<&str>) -> Option<Vec<(String, String)>> {
    let raw = raw?;
    if service_kit::money::js_trim(raw).is_empty() {
        return None;
    }
    let mut entries = Vec::new();
    for part in raw.split(',') {
        let (network, r) = part.split_once(':')?;
        let r = service_kit::money::js_trim(r);
        if r.is_empty() {
            return None;
        }
        entries.push((network_key(network)?, address_key(r)));
    }
    Some(entries)
}

/// `screenWallet`: `assertNotSanctioned(list, null, address)` with the owner's setting read now.
pub fn screen_wallet(raw: Option<&str>, address: &str) -> Result<(), Refusal> {
    let Some(list) = read_list(raw) else {
        return Err(refuse(
            "bank.destination_sanctions_unset",
            "The destination sanctions list is not set, so no address can be screened, saved or sent to. Nothing was saved or sent",
        ));
    };
    let key = address_key(address);
    // A null network matches a listing on any network.
    if list.iter().any(|(_, r)| *r == key) {
        return Err(refuse(
            "bank.destination_sanctions_listed",
            "This address is on the sanctions list, so it cannot be saved or sent to. Nothing was saved or sent",
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    #![allow(clippy::panic, reason = "a test")]
    use super::*;

    fn code(r: Result<(), Refusal>) -> String {
        match r {
            Ok(()) => "clear".to_owned(),
            Err(Refusal::Bank(e)) => e.row.code.to_owned(),
            Err(other) => panic!("{other:?}"),
        }
    }

    #[test]
    fn a_blank_or_unreadable_list_refuses_every_address_and_a_listed_one_is_refused_in_any_case() {
        let a = "0xF39FD6E51AAD88F6F4CE6AB8827279CFFFB92266";
        for raw in [
            None,
            Some(""),
            Some("  "),
            Some("eth"),
            Some("eth:"),
            Some("Not A Net!:0x1"),
        ] {
            assert_eq!(
                code(screen_wallet(raw, a)),
                "bank.destination_sanctions_unset"
            );
        }
        assert_eq!(
            code(screen_wallet(
                Some("eth:0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266"),
                a
            )),
            "bank.destination_sanctions_listed"
        );
        assert_eq!(
            code(screen_wallet(
                Some("*:0x00000000000000000000000000000000005a1c7d, base:bc1q"),
                a
            )),
            "clear"
        );
    }
}
