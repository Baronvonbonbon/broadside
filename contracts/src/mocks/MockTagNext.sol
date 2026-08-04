// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.8.24;
import "../BroadsideTagSystem.sol";
import "../BroadsideTagRegistry.sol";
contract MockTagSystemNext is BroadsideTagSystem {
    function version() public pure override returns (uint256) { return 2; }
}
contract MockTagRegistryNext is BroadsideTagRegistry {
    constructor(IERC20 d) BroadsideTagRegistry(d) {}
    function version() public pure override returns (uint256) { return 2; }
}
