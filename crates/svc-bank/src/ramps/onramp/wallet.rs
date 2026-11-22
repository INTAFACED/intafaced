//! The EIP-191 signer of a `personal_sign` message (`recoverPersonalSignAddress` of `ramps/wallet-ownership.ts`): who
//! signed a buy-to-wallet request's own message (`walletDeliveryMessage` of `add-money.ts`).

use k256::ecdsa::{RecoveryId, Signature, VerifyingKey};
use sha3::{Digest, Keccak256};

fn keccak(bytes: &[u8]) -> [u8; 32] {
    Keccak256::digest(bytes).into()
}

/// `personalMessageHash`: the digest a wallet signs for `personal_sign`.
fn personal_message_hash(message: &str) -> [u8; 32] {
    let body = message.as_bytes();
    let mut joined = format!("\x19Ethereum Signed Message:\n{}", body.len()).into_bytes();
    joined.extend_from_slice(body);
    keccak(&joined)
}

fn hex_byte(pair: &[u8]) -> Option<u8> {
    let digit = |c: u8| char::from(c).to_digit(16);
    let (hi, lo) = (digit(*pair.first()?)?, digit(*pair.get(1)?)?);
    u8::try_from(hi * 16 + lo).ok()
}

/// The address that signed `message` (a 65-byte `r || s || v` signature, `v` 27/28 or 0/1), lower case, or `None` when
/// the signature is not one. A signature with a high `s` is recovered as its low twin with the other parity, which is
/// the same key, as the TypeScript's library recovers it.
pub fn recover_personal_sign_address(message: &str, signature: &str) -> Option<String> {
    let sig = service_kit::money::js_trim(signature);
    let hex = sig.strip_prefix("0x")?;
    if hex.len() != 130 || !hex.bytes().all(|b| b.is_ascii_hexdigit()) {
        return None;
    }
    let bytes: Vec<u8> = hex.as_bytes().chunks(2).filter_map(hex_byte).collect();
    let (rs, v) = (bytes.get(..64)?, *bytes.get(64)?);
    let bit = if v >= 27 { v - 27 } else { v };
    if bit > 1 {
        return None;
    }
    let mut signature = Signature::from_slice(rs).ok()?;
    let mut parity = bit == 1;
    let low = signature.normalize_s();
    if low.to_bytes() != signature.to_bytes() {
        signature = low;
        parity = !parity;
    }
    let id = RecoveryId::new(parity, false);
    let key =
        VerifyingKey::recover_from_prehash(&personal_message_hash(message), &signature, id).ok()?;
    let point = key.to_sec1_point(false);
    let hash = keccak(point.as_bytes().get(1..)?);
    let tail = hash.get(12..)?;
    Some(format!(
        "0x{}",
        tail.iter().map(|b| format!("{b:02x}")).collect::<String>()
    ))
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used, reason = "a test")]
    use super::*;
    use k256::ecdsa::SigningKey;

    fn sign(message: &str, key_hex: &str) -> String {
        let key: Vec<u8> = key_hex.as_bytes().chunks(2).filter_map(hex_byte).collect();
        let key = SigningKey::from_slice(&key).unwrap();
        let (sig, id) = key.sign_prehash_recoverable(&personal_message_hash(message));
        let mut out = sig.to_bytes().to_vec();
        out.push(id.to_byte() + 27);
        format!(
            "0x{}",
            out.iter().map(|b| format!("{b:02x}")).collect::<String>()
        )
    }

    const KEY: &str = "ac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
    const WALLET: &str = "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266";

    #[test]
    fn recovers_the_well_known_development_key() {
        let sig = sign("hello", KEY);
        assert_eq!(
            recover_personal_sign_address("hello", &sig).as_deref(),
            Some(WALLET)
        );
        assert_ne!(
            recover_personal_sign_address("other", &sig).as_deref(),
            Some(WALLET)
        );
    }

    #[test]
    fn the_high_s_twin_and_a_zero_one_v_are_the_same_signer() {
        let sig = sign("hello", KEY);
        let bytes: Vec<u8> = sig.as_bytes()[2..].chunks(2).filter_map(hex_byte).collect();
        let parsed = Signature::from_slice(&bytes[..64]).unwrap();
        let (r, s) = parsed.split_scalars();
        let high = Signature::from_scalars(r, -*s).unwrap();
        let mut twin = high.to_bytes().to_vec();
        twin.push(if bytes[64] == 27 { 1 } else { 0 });
        let twin = format!(
            "0x{}",
            twin.iter().map(|b| format!("{b:02x}")).collect::<String>()
        );
        assert_eq!(
            recover_personal_sign_address("hello", &twin).as_deref(),
            Some(WALLET)
        );
    }

    #[test]
    fn refuses_what_is_not_a_signature() {
        assert_eq!(recover_personal_sign_address("hello", "0x12"), None);
        let bad_v = format!("0x{}{}", "11".repeat(64), "05");
        assert_eq!(recover_personal_sign_address("hello", &bad_v), None);
    }
}
