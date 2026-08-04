// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.8.24;
import "../BroadsidePublisherStake.sol";
/// @dev Test-only successor exercising migrate() against BroadsidePublisherStake.
contract MockPublisherStakeV2 is BroadsidePublisherStake {
    constructor(uint256 b, uint256 p, uint256 d) BroadsidePublisherStake(b, p, d) {}
    function version() public pure override returns (uint256) { return 2; }
}
