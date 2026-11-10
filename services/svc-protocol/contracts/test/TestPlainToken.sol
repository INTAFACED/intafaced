// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * A TEST ERC-20 with no permit (J-dex-protocol-03 #2): the same TEST token as TestToken (anyone may mint, name, symbol and
 * decimals as immutables so its runtime code can be copied to a fixed TEST address) but with no EIP-2612 `permit`, no
 * `nonces` and no EIP-5267 `eip712Domain`, so it reads as a token that needs an approve transaction. TEST only.
 */
contract TestPlainToken {
    bytes32 private immutable _name;
    bytes32 private immutable _symbol;
    uint8 public immutable decimals;
    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;


    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

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
