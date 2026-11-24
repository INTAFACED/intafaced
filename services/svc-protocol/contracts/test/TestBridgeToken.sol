// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * The local stack's TEST burn-and-mint bridge token (D-bridge-chain-03, J-dex-protocol-05 #6 #7), for the stack's two
 * TEST chains (tooling/scripts/local-test-chain.mjs). Not a product token and not a provider: a stand-in for one, so the
 * rails room's burn, attestation and mint can be driven end to end. A balance of it is worth nothing.
 *
 * The same code runs at the same address on both chains (the stack copies the runtime code there with anvil_setCode),
 * so nothing in it is an immutable: the attester is a constant, anvil's own first dev account (the public, worthless
 * `test test ... junk` mnemonic), which both TEST anvils hold unlocked, so the stack's TEST attester in
 * local-test-chain.mjs signs with the node's own personal_sign and holds no key of its own. Nobody else can attest a burn.
 *
 * - `burn` takes the person's tokens out of supply on this chain for one transfer intent. An intent id burns once on a
 *   chain: a second burn for the same intent reverts, so a resumed transfer can never burn twice.
 * - `mint` pays the burn's recipient on this chain once the attester has signed the burn: the signature covers this
 *   contract, both chains, the intent, the recipient and the amount. An intent id mints once.
 * - `issue` is the stack's TEST faucet: only the attester address may call it.
 */
contract TestBridgeToken {
    string public constant name = "TEST USDC";
    string public constant symbol = "TUSDC";
    uint8 public constant decimals = 6;
    /** Anvil's dev account #0 (public mnemonic), unlocked on both TEST anvils; local-test-chain.mjs BRIDGE_ATTESTER. */
    address public constant attester = 0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266;

    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(bytes32 => bool) public burned;
    mapping(bytes32 => bool) public minted;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Burned(bytes32 indexed intentId, address indexed sender, uint256 destinationChainId, address recipient, uint256 amount);
    event Minted(bytes32 indexed intentId, address indexed recipient, uint256 sourceChainId, uint256 amount);

    error AlreadyBurned();
    error AlreadyMinted();
    error SameChain();
    error ZeroAmount();
    error InsufficientBalance();
    error BadAttestation();
    error OnlyAttester();

    function issue(address to, uint256 amount) external {
        if (msg.sender != attester) revert OnlyAttester();
        balanceOf[to] += amount;
        totalSupply += amount;
        emit Transfer(address(0), to, amount);
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        if (balanceOf[msg.sender] < amount) revert InsufficientBalance();
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        emit Transfer(msg.sender, to, amount);
        return true;
    }

    function burn(bytes32 intentId, uint256 destinationChainId, address recipient, uint256 amount) external {
        if (burned[intentId]) revert AlreadyBurned();
        if (destinationChainId == block.chainid) revert SameChain();
        if (amount == 0) revert ZeroAmount();
        if (balanceOf[msg.sender] < amount) revert InsufficientBalance();
        burned[intentId] = true;
        balanceOf[msg.sender] -= amount;
        totalSupply -= amount;
        emit Transfer(msg.sender, address(0), amount);
        emit Burned(intentId, msg.sender, destinationChainId, recipient, amount);
    }

    /** What the attester signs (as an EIP-191 personal message) for one burn on `sourceChainId` to be minted here. */
    function attestationDigest(bytes32 intentId, uint256 sourceChainId, address recipient, uint256 amount) public view returns (bytes32) {
        return keccak256(abi.encode(address(this), sourceChainId, block.chainid, intentId, recipient, amount));
    }

    function mint(bytes32 intentId, uint256 sourceChainId, address recipient, uint256 amount, bytes calldata attestation) external {
        if (minted[intentId]) revert AlreadyMinted();
        if (attestation.length != 65) revert BadAttestation();
        bytes32 digest = keccak256(
            abi.encodePacked("\x19Ethereum Signed Message:\n32", attestationDigest(intentId, sourceChainId, recipient, amount))
        );
        bytes32 r;
        bytes32 s;
        uint8 v;
        assembly {
            r := calldataload(attestation.offset)
            s := calldataload(add(attestation.offset, 32))
            v := byte(0, calldataload(add(attestation.offset, 64)))
        }
        if (ecrecover(digest, v, r, s) != attester) revert BadAttestation();
        minted[intentId] = true;
        balanceOf[recipient] += amount;
        totalSupply += amount;
        emit Transfer(address(0), recipient, amount);
        emit Minted(intentId, recipient, sourceChainId, amount);
    }
}
