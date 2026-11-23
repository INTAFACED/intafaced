//! The shapes of a withdrawal address (`withdraw-destination.ts`) and the keys the fraud and sanctions lists match it
//! under (`fraud-list.ts`): an EVM address, an IBAN, an IFSC.

use crate::errors::Refusal;
use crate::partner::refuse;

/// `ANY_NETWORK`: a listing on every network.
pub const ANY_NETWORK: &str = "*";

/// JavaScript's `trim()`: the whitespace and line terminators ECMAScript names.
pub fn js_trim(s: &str) -> &str {
    service_kit::money::js_trim(s)
}

/// `isEvmAddressRef`: `0x` and 40 hex digits, after trimming. The checksum is not read here.
pub fn is_evm_address_ref(r: &str) -> bool {
    let t = js_trim(r);
    let b = t.as_bytes();
    b.len() == 42 && t.starts_with("0x") && b.iter().skip(2).all(u8::is_ascii_hexdigit)
}

/// `ref.replace(/\s+/g, '').toUpperCase()`: JavaScript's `\s` is the same set `trim` strips.
pub fn compact_upper(r: &str) -> String {
    r.chars()
        .filter(|c| !js_trim(c.encode_utf8(&mut [0; 4])).is_empty())
        .flat_map(char::to_uppercase)
        .collect()
}

/// `isIbanRef`: country, check digits and BBAN, 15 to 34 characters, mod 97 is 1. Spaces ignored.
pub fn is_iban_ref(r: &str) -> bool {
    let c = compact_upper(r);
    let b = c.as_bytes();
    let shaped = b.len() >= 5
        && b.iter().take(2).all(u8::is_ascii_uppercase)
        && b.iter().skip(2).take(2).all(u8::is_ascii_digit)
        && b.iter()
            .skip(4)
            .all(|x| x.is_ascii_uppercase() || x.is_ascii_digit());
    if !shaped || !(15..=34).contains(&b.len()) {
        return false;
    }
    let mut remainder: u32 = 0;
    for &ch in b.iter().skip(4).chain(b.iter().take(4)) {
        if ch.is_ascii_uppercase() {
            let n = u32::from(ch - b'A') + 10;
            remainder = (remainder * 10 + n / 10) % 97;
            remainder = (remainder * 10 + n % 10) % 97;
        } else {
            remainder = (remainder * 10 + u32::from(ch - b'0')) % 97;
        }
    }
    remainder == 1
}

/// `isIfscRef`: four letters, a zero and six letters or digits. Spaces ignored.
pub fn is_ifsc_ref(r: &str) -> bool {
    let c = compact_upper(r);
    let b = c.as_bytes();
    b.len() == 11
        && b.iter().take(4).all(u8::is_ascii_uppercase)
        && b.get(4) == Some(&b'0')
        && b.iter()
            .skip(5)
            .all(|x| x.is_ascii_uppercase() || x.is_ascii_digit())
}

/// `isBankDestinationRef`.
pub fn is_bank_destination_ref(r: &str) -> bool {
    is_iban_ref(r) || is_ifsc_ref(r)
}

/// `fraudAddressKey`: an EVM address in lower case, anything else exactly as written (trimmed).
pub fn address_key(r: &str) -> String {
    let t = js_trim(r);
    if is_evm_address_ref(t) {
        t.to_ascii_lowercase()
    } else {
        t.to_owned()
    }
}

/// `fraudNetworkKey`: `*`, or a network id in lower case (`[a-z0-9_-]{1,32}`); anything else refuses.
pub fn network_key(network: &str) -> Result<String, Refusal> {
    let t = js_trim(network);
    if t == ANY_NETWORK {
        return Ok(ANY_NETWORK.to_owned());
    }
    let key = t.to_lowercase();
    let ok = (1..=32).contains(&key.chars().count())
        && key
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_' || b == b'-');
    if ok {
        Ok(key)
    } else {
        Err(refuse(
            "bank.validation_failed",
            format!("\"{network}\" is not a network id or {ANY_NETWORK}"),
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shapes_are_read_as_the_typescript_reads_them() {
        assert!(is_evm_address_ref(
            " 0x52908400098527886E0F7030069857D2E4169EE7 "
        ));
        assert!(!is_evm_address_ref(
            "0x52908400098527886E0F7030069857D2E4169EE"
        ));
        assert!(!is_evm_address_ref(
            "0X52908400098527886E0F7030069857D2E4169EE7"
        ));
        assert!(is_iban_ref("GB82 WEST 1234 5698 7654 32"));
        assert!(!is_iban_ref("GB83 WEST 1234 5698 7654 32"));
        assert!(is_ifsc_ref("sbin0001234"));
        assert!(!is_ifsc_ref("SBIN1001234"));
        assert_eq!(
            address_key(" 0xABCDEF0000000000000000000000000000000001"),
            "0xabcdef0000000000000000000000000000000001"
        );
        assert_eq!(address_key(" TXyz "), "TXyz");
        assert_eq!(network_key(" Ethereum ").ok().as_deref(), Some("ethereum"));
        assert!(network_key("eth net").is_err());
    }
}
