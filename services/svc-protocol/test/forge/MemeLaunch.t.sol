// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20Minimal} from "../../contracts/amm/IERC20Minimal.sol";
import {PoolFactory} from "../../contracts/amm/PoolFactory.sol";
import {MemeLaunch} from "../../contracts/launch/MemeLaunch.sol";
import {TokenFactory} from "../../contracts/launch/TokenFactory.sol";
import {MockERC20} from "../../contracts/test/MockERC20.sol";

interface Vm {
    function prank(address) external;
}

Vm constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

/// A copy that repeats the token parameters and userSalt, with a smaller
/// tokenAmount, must not deploy the user's token or receive its leftover supply.
contract MemeLaunchForgeTest {
    // Same figures the meme-launch on-chain test already uses.
    uint256 constant SUPPLY = 100_000 ether;
    uint256 constant USER_TOKEN_AMOUNT = 10_000 ether;
    uint256 constant QUOTE_AMOUNT = 10_000 ether;
    uint16 constant FEE_BPS = 30;
    uint64 constant UNLOCK = 2_000_000_000;
    bytes32 constant SALT = hex"1111111111111111111111111111111111111111111111111111111111111111";

    function test_smaller_copy_cannot_take_the_user_token() public {
        TokenFactory tokens = new TokenFactory();
        MemeLaunch meme = new MemeLaunch(address(tokens), address(new PoolFactory()));
        MockERC20 quote = new MockERC20();

        address user = address(0xA11CE);
        address copy = address(0xB0B);
        uint256 copyTokenAmount = USER_TOKEN_AMOUNT - 1;

        quote.mint(user, QUOTE_AMOUNT);
        quote.mint(copy, QUOTE_AMOUNT);
        vm.prank(user);
        quote.approve(address(meme), QUOTE_AMOUNT);
        vm.prank(copy);
        quote.approve(address(meme), QUOTE_AMOUNT);

        TokenFactory.TokenParams memory created = TokenFactory.TokenParams({
            name: "Meme",
            symbol: "MEME",
            decimals: 18,
            totalSupply: SUPPLY,
            recipient: address(meme)
        });
        bytes32 userBound = meme.tokenSalt(user, SALT);
        address userPredicted = tokens.getAddress(address(meme), userBound, created);

        vm.prank(copy);
        address squat = tokens.createToken(userBound, created);
        require(squat != userPredicted, "factory caller is a different creator");
        require(userPredicted.code.length == 0, "user address still empty");

        vm.prank(copy);
        (address copyToken,,,) = meme.launch(_params(quote, copyTokenAmount));
        vm.prank(user);
        (address userToken,,,) = meme.launch(_params(quote, USER_TOKEN_AMOUNT));

        require(userToken == userPredicted, "salt binds the end user");
        require(userToken != tokens.getAddress(address(meme), SALT, created), "unbound salt is a different token");
        require(copyToken == tokens.getAddress(address(meme), meme.tokenSalt(copy, SALT), created), "copy binds its own sender");
        require(copyToken != userToken, "copy deployed a different token");
        require(IERC20Minimal(userToken).balanceOf(copy) == 0, "copy holds none of the user supply");
        require(IERC20Minimal(userToken).balanceOf(user) == SUPPLY - USER_TOKEN_AMOUNT, "user receives the leftover");
        require(IERC20Minimal(copyToken).balanceOf(copy) == SUPPLY - copyTokenAmount, "copy leftover stays on the copy token");
        require(IERC20Minimal(userToken).balanceOf(address(meme)) == 0, "launch keeps none of the user token");
    }

    function _params(MockERC20 quote, uint256 tokenAmount) private pure returns (MemeLaunch.LaunchParams memory p) {
        p.existingToken = address(0);
        p.name = "Meme";
        p.symbol = "MEME";
        p.decimals = 18;
        p.totalSupply = SUPPLY;
        p.quoteToken = address(quote);
        p.feeBps = FEE_BPS;
        p.tokenAmount = tokenAmount;
        p.quoteAmount = QUOTE_AMOUNT;
        p.unlockTime = UNLOCK;
        p.userSalt = SALT;
    }
}
