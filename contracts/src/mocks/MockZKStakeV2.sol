// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.8.24;
import "../BroadsideZKStake.sol";
/// @dev Test-only successor exercising migrate() against BroadsideZKStake.
contract MockZKStakeV2 is BroadsideZKStake {
    constructor(address t) BroadsideZKStake(t) {}
    function version() public pure override returns (uint256) { return 2; }
}
