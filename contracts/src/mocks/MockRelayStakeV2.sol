// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.8.24;
import "../BroadsideRelayStake.sol";
/// @dev Test-only successor exercising migrate() against BroadsideRelayStake.
contract MockRelayStakeV2 is BroadsideRelayStake {
    constructor(uint256 m, uint64 d) BroadsideRelayStake(m, d) {}
    function version() public pure override returns (uint256) { return 2; }
}
