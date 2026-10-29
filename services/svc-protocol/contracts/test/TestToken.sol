// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * A TEST ERC-20 for the local stack's TEST chain (tooling/scripts/local-test-chain.mjs). Not a product token: anyone
 * may mint, so a balance of it is worth nothing. Name, symbol and decimals come from the constructor.
 *
 * All three are immutables, so the runtime code alone is the whole token: the stack deploys it, then copies that code
 * to the journeys' fixed TEST addresses (anvil_setCode) with no storage to write. Name and symbol are therefore short
 * strings (at most 31 bytes), held as one word each.
 *
 * EIP-2612 `permit` and EIP-5267 `eip712Domain`, so a wallet can sign a permit for it the way it would for a real
 * token. The domain is rebuilt from `block.chainid` on every call: the same code answers for whatever chain runs it.
 */
contract TestToken {
    bytes32 private immutable _name;
    bytes32 private immutable _symbol;
    uint8 public immutable decimals;
    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    mapping(address => uint256) public nonces;

    bytes32 private constant DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    bytes32 private constant PERMIT_TYPEHASH =
        keccak256("Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)");

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    error PermitExpired();
    error InvalidSigner();
    error StringTooLong();

    constructor(string memory name_, string memory symbol_, uint8 decimals_) {
        _name = _toWord(name_);
        _symbol = _toWord(symbol_);
        decimals = decimals_;
    }

    function name() public view returns (string memory) {
        return _fromWord(_name);
    }

    function symbol() external view returns (string memory) {
        return _fromWord(_symbol);
    }

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
        totalSupply += amount;
        emit Transfer(address(0), to, amount);
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        emit Approval(msg.sender, spender, amount);
        return true;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        return _transfer(msg.sender, to, amount);
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        uint256 allowed = allowance[from][msg.sender];
        if (allowed != type(uint256).max) {
            require(allowed >= amount, "allowance");
            allowance[from][msg.sender] = allowed - amount;
        }
        return _transfer(from, to, amount);
    }

    function DOMAIN_SEPARATOR() public view returns (bytes32) {
        return keccak256(abi.encode(DOMAIN_TYPEHASH, keccak256(bytes(name())), keccak256("1"), block.chainid, address(this)));
    }

    function eip712Domain()
        external
        view
        returns (
            bytes1 fields,
            string memory name_,
            string memory version,
            uint256 chainId,
            address verifyingContract,
            bytes32 salt,
            uint256[] memory extensions
        )
    {
        return (hex"0f", name(), "1", block.chainid, address(this), bytes32(0), new uint256[](0));
    }

    function permit(address owner, address spender, uint256 value, uint256 deadline, uint8 v, bytes32 r, bytes32 s)
        external
    {
        if (block.timestamp > deadline) revert PermitExpired();
        bytes32 digest = keccak256(
            abi.encodePacked(
                "\x19\x01",
                DOMAIN_SEPARATOR(),
                keccak256(abi.encode(PERMIT_TYPEHASH, owner, spender, value, nonces[owner]++, deadline))
            )
        );
        address signer = ecrecover(digest, v, r, s);
        if (signer == address(0) || signer != owner) revert InvalidSigner();
        allowance[owner][spender] = value;
        emit Approval(owner, spender, value);
    }

    /** A string of at most 31 bytes as one word: the bytes left-aligned, the length in the last byte. */
    function _toWord(string memory value) private pure returns (bytes32 word) {
        bytes memory raw = bytes(value);
        if (raw.length > 31) revert StringTooLong();
        for (uint256 i = 0; i < raw.length; i++) word |= bytes32(raw[i]) >> (i * 8);
        word |= bytes32(raw.length);
    }

    function _fromWord(bytes32 word) private pure returns (string memory) {
        uint256 length = uint256(word) & 0xff;
        bytes memory raw = new bytes(length);
        for (uint256 i = 0; i < length; i++) raw[i] = word[i];
        return string(raw);
    }

    function _transfer(address from, address to, uint256 amount) private returns (bool) {
        require(balanceOf[from] >= amount, "balance");
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        emit Transfer(from, to, amount);
        return true;
    }
}
