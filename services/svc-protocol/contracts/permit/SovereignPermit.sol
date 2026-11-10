// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20Minimal} from "../amm/IERC20Minimal.sol";

interface IERC1271 {
    function isValidSignature(bytes32 hash, bytes calldata signature) external view returns (bytes4);
}

/**
 * SOVEREIGN PERMIT: signature approvals for tokens that the owner has approved to this contract once
 * (D-swap-intents-01, ENGINE PRM-2 and PRM-3). Behaviour follows Uniswap's Permit2 (MIT) as a reference; the code is
 * written here, nothing is copied.
 *
 * - Signature transfer (PRM-2): one signature names token, amount, spender, nonce and deadline. The spender may pull at
 *   most that amount once, before the deadline. The nonce is a bit in an unordered bitmap, spent on use, so a signature
 *   can never be used twice (`NonceUsed`).
 * - Standing allowance (PRM-3): one signature sets (amount, expiration) for a spender. The spender may pull while
 *   `block.timestamp <= expiration` and up to the amount left; after the expiration every pull reverts
 *   (`AllowanceExpired`). The allowance's own nonce is spent each time a signature sets it.
 *
 * No admin, no pause, no owner, no fee: it holds nothing and moves tokens straight from the owner to the named receiver.
 * "Unlimited" is never a default here: an amount is always the one signed. A smart-account owner signs through
 * ERC-1271. TEST deployments only (Base Sepolia stand-in); the audit is external.
 */
contract SovereignPermit {
    struct Allowance {
        uint160 amount;
        uint48 expiration;
        uint48 nonce;
    }

    bytes32 private constant DOMAIN_TYPEHASH = keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    bytes32 public constant PERMIT_TRANSFER_TYPEHASH =
        keccak256("PermitTransferFrom(address token,uint256 amount,address spender,uint256 nonce,uint256 deadline)");
    bytes32 public constant PERMIT_ALLOWANCE_TYPEHASH = keccak256(
        "PermitAllowance(address token,address spender,uint160 amount,uint48 expiration,uint48 nonce,uint256 sigDeadline)"
    );
    /// secp256k1n / 2: a signature with a higher `s` is the malleable twin of a lower one and is refused.
    uint256 private constant HALF_N = 0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0;

    /// owner => word index => bitmap of spent signature-transfer nonces.
    mapping(address => mapping(uint256 => uint256)) public nonceBitmap;
    /// owner => token => spender => standing allowance.
    mapping(address => mapping(address => mapping(address => Allowance))) public allowance;

    event NonceSpent(address indexed owner, uint256 nonce);
    event NoncesInvalidated(address indexed owner, uint256 word, uint256 mask);
    event AllowanceSet(
        address indexed owner, address indexed token, address indexed spender, uint160 amount, uint48 expiration
    );

    error SignatureExpired();
    error AmountOverPermit();
    error NonceUsed();
    error BadSignature();
    error AllowanceExpired();
    error AllowanceTooLow();
    error ExpirationInPast();
    error BadNonce();
    error TransferFailed();
    error ZeroAddress();

    function DOMAIN_SEPARATOR() public view returns (bytes32) {
        return keccak256(abi.encode(DOMAIN_TYPEHASH, keccak256("SovereignPermit"), keccak256("1"), block.chainid, address(this)));
    }

    // ---------------------------------------------------------------- signature transfer (PRM-2)

    /// The digest an owner signs for a one-time transfer of at most `amount` of `token` to `spender`.
    function transferDigest(address token, uint256 amount, address spender, uint256 nonce, uint256 deadline)
        public
        view
        returns (bytes32)
    {
        return _digest(keccak256(abi.encode(PERMIT_TRANSFER_TYPEHASH, token, amount, spender, nonce, deadline)));
    }

    /**
     * Pulls `requested` of `token` from `owner` to `to`, on the owner's one-time signature naming the caller as spender.
     * Reverts after the deadline, above the signed amount, on a spent nonce or a signature that is not the owner's.
     */
    function permitTransferFrom(
        address token,
        uint256 amount,
        uint256 nonce,
        uint256 deadline,
        address owner,
        address to,
        uint256 requested,
        bytes calldata signature
    ) external {
        if (block.timestamp > deadline) revert SignatureExpired();
        if (requested > amount) revert AmountOverPermit();
        if (to == address(0) || owner == address(0)) revert ZeroAddress();
        _spendNonce(owner, nonce);
        _verify(owner, transferDigest(token, amount, msg.sender, nonce, deadline), signature);
        _pull(token, owner, to, requested);
    }

    /// The owner spends nonces without using them (a one-tap revoke of signed, unused permits).
    function invalidateNonces(uint256 word, uint256 mask) external {
        nonceBitmap[msg.sender][word] |= mask;
        emit NoncesInvalidated(msg.sender, word, mask);
    }

    // ---------------------------------------------------------------- standing allowance (PRM-3)

    /// The digest an owner signs to set a standing allowance for `spender`.
    function allowanceDigest(
        address token,
        address spender,
        uint160 amount,
        uint48 expiration,
        uint48 nonce,
        uint256 sigDeadline
    ) public view returns (bytes32) {
        return _digest(
            keccak256(abi.encode(PERMIT_ALLOWANCE_TYPEHASH, token, spender, amount, expiration, nonce, sigDeadline))
        );
    }

    /**
     * Sets `owner`'s standing allowance for `spender` from the owner's signature. Anyone may submit it; only the
     * owner's key (or its ERC-1271 account) makes it valid, and its nonce makes it count once.
     */
    function permit(
        address owner,
        address token,
        address spender,
        uint160 amount,
        uint48 expiration,
        uint48 nonce,
        uint256 sigDeadline,
        bytes calldata signature
    ) external {
        if (owner == address(0)) revert ZeroAddress();
        if (block.timestamp > sigDeadline) revert SignatureExpired();
        if (expiration <= block.timestamp) revert ExpirationInPast();
        Allowance storage current = allowance[owner][token][spender];
        if (nonce != current.nonce) revert BadNonce();
        _verify(owner, allowanceDigest(token, spender, amount, expiration, nonce, sigDeadline), signature);
        current.amount = amount;
        current.expiration = expiration;
        unchecked {
            current.nonce = nonce + 1;
        }
        emit AllowanceSet(owner, token, spender, amount, expiration);
    }

    /**
     * The owner sets or clears (amount 0) a standing allowance directly, with no signature. It also spends the
     * allowance's nonce, so a standing-allowance signature signed earlier and never submitted can no longer set it back.
     */
    function approve(address token, address spender, uint160 amount, uint48 expiration) external {
        Allowance storage current = allowance[msg.sender][token][spender];
        current.amount = amount;
        current.expiration = expiration;
        unchecked {
            current.nonce += 1;
        }
        emit AllowanceSet(msg.sender, token, spender, amount, expiration);
    }

    /// The spender pulls `amount` of `token` from `owner` to `to` under the owner's standing allowance.
    function transferFrom(address owner, address to, uint160 amount, address token) external {
        Allowance storage current = allowance[owner][token][msg.sender];
        if (block.timestamp > current.expiration) revert AllowanceExpired();
        if (current.amount < amount) revert AllowanceTooLow();
        if (to == address(0)) revert ZeroAddress();
        unchecked {
            current.amount -= amount;
        }
        _pull(token, owner, to, amount);
    }

    // ---------------------------------------------------------------- internals

    function _digest(bytes32 structHash) private view returns (bytes32) {
        return keccak256(abi.encodePacked("\x19\x01", DOMAIN_SEPARATOR(), structHash));
    }

    function _spendNonce(address owner, uint256 nonce) private {
        uint256 bit = 1 << (nonce & 0xff);
        uint256 word = nonce >> 8;
        uint256 before = nonceBitmap[owner][word];
        if (before & bit != 0) revert NonceUsed();
        nonceBitmap[owner][word] = before | bit;
        emit NonceSpent(owner, nonce);
    }

    function _verify(address owner, bytes32 digest, bytes calldata signature) private view {
        if (owner.code.length > 0) {
            // A smart account signs through ERC-1271.
            (bool ok, bytes memory out) =
                owner.staticcall(abi.encodeCall(IERC1271.isValidSignature, (digest, signature)));
            if (!ok || out.length < 32 || abi.decode(out, (bytes4)) != IERC1271.isValidSignature.selector) {
                // An EIP-7702 delegated EOA still signs with its own key: accept that key's signature too.
                if (_recover(digest, signature) != owner) revert BadSignature();
            }
            return;
        }
        if (_recover(digest, signature) != owner) revert BadSignature();
    }

    function _recover(bytes32 digest, bytes calldata signature) private pure returns (address signer) {
        if (signature.length != 65) return address(0);
        bytes32 r = bytes32(signature[0:32]);
        bytes32 s = bytes32(signature[32:64]);
        uint8 v = uint8(signature[64]);
        if (uint256(s) > HALF_N) return address(0);
        signer = ecrecover(digest, v, r, s);
    }

    function _pull(address token, address from, address to, uint256 amount) private {
        (bool ok, bytes memory out) =
            token.call(abi.encodeCall(IERC20Minimal.transferFrom, (from, to, amount)));
        if (!ok || (out.length > 0 && !abi.decode(out, (bool)))) revert TransferFailed();
    }
}
