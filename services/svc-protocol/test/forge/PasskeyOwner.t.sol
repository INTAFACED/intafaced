// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {PasskeyOwner} from "../../contracts/passkey/PasskeyOwner.sol";

/// Foundry cheatcodes without vendoring forge-std (no submodule).
interface Vm {
    function etch(address target, bytes calldata newRuntimeBytecode) external;
}

Vm constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

bytes4 constant ERC1271_MAGIC = 0x1626ba7e;
bytes4 constant ERC1271_FAIL = 0xffffffff;

// RIP-7212 stand-in: every staticcall returns uint256(1).
bytes constant P256_RETURNS_ONE = hex"600160005260206000f3";

error UpClearReturned(bytes4 got);

/**
 * L992: a P-256-valid WebAuthn assertion is not an ERC-1271 yes unless
 * authenticatorData is 37 bytes and the User Present bit is set.
 * The etched verifier makes P256.verify succeed without RIP-7212.
 */
contract PasskeyOwnerForgeTest {
    function _owner() internal returns (PasskeyOwner) {
        vm.etch(address(0x100), P256_RETURNS_ONE);
        return new PasskeyOwner(bytes32(uint256(1)), bytes32(uint256(2)));
    }

    function _clientData(bytes32 hash) internal pure returns (bytes memory) {
        return bytes.concat('{"type":"webauthn.get","challenge":"', bytes(base64UrlEncode32(hash)), '"');
    }

    /// rpIdHash || flags || signCount, truncated or extended to `len`.
    function _authData(uint256 len, uint8 flags) internal pure returns (bytes memory out) {
        out = new bytes(len);
        if (len > 32) out[32] = bytes1(flags);
    }

    function _signature(bytes memory authenticatorData, bytes memory clientDataJSON) internal pure returns (bytes memory) {
        // Low s: 1 <= n/2. The etched precompile accepts any structurally valid signature.
        return abi.encode(authenticatorData, clientDataJSON, bytes32(uint256(1)), bytes32(uint256(1)));
    }

    function test_up_clear_is_not_erc1271_yes() public {
        bytes32 hash = keccak256("L992-up-clear");
        PasskeyOwner owner = _owner();
        bytes4 got = owner.isValidSignature(hash, _signature(_authData(37, 0x00), _clientData(hash)));
        if (got != ERC1271_FAIL) revert UpClearReturned(got);
    }

    function test_authenticator_data_length_must_be_37() public {
        bytes32 hash = keccak256("L992-length");
        PasskeyOwner owner = _owner();
        bytes memory clientDataJSON = _clientData(hash);
        bytes4 short = owner.isValidSignature(hash, _signature(_authData(36, 0x01), clientDataJSON));
        require(short == ERC1271_FAIL, "36-byte authenticatorData");
        bytes4 long = owner.isValidSignature(hash, _signature(_authData(38, 0x01), clientDataJSON));
        require(long == ERC1271_FAIL, "38-byte authenticatorData");
    }

    function test_up_set_37_bytes_still_returns_magic() public {
        bytes32 hash = keccak256("L992-up-set");
        PasskeyOwner owner = _owner();
        bytes4 got = owner.isValidSignature(hash, _signature(_authData(37, 0x01), _clientData(hash)));
        require(got == ERC1271_MAGIC, "UP set must still verify");
    }

    /// @dev Unpadded base64url of 32 bytes (43 characters). Matches PasskeyOwner.
    function base64UrlEncode32(bytes32 data) internal pure returns (string memory) {
        bytes memory table = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
        bytes memory src = new bytes(32);
        assembly {
            mstore(add(src, 32), data)
        }
        bytes memory out = new bytes(43);
        uint256 i;
        uint256 j;
        for (; i + 2 < 32; i += 3) {
            uint256 n = (uint256(uint8(src[i])) << 16) | (uint256(uint8(src[i + 1])) << 8) | uint256(uint8(src[i + 2]));
            out[j++] = table[(n >> 18) & 63];
            out[j++] = table[(n >> 12) & 63];
            out[j++] = table[(n >> 6) & 63];
            out[j++] = table[n & 63];
        }
        uint256 n2 = (uint256(uint8(src[i])) << 16) | (uint256(uint8(src[i + 1])) << 8);
        out[j++] = table[(n2 >> 18) & 63];
        out[j++] = table[(n2 >> 12) & 63];
        out[j++] = table[(n2 >> 6) & 63];
        return string(out);
    }
}
