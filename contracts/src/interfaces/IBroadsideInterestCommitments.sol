// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.8.24;

interface IBroadsideInterestCommitments {
    function interestRoot(address user) external view returns (bytes32);
    function lastSetBlock(address user) external view returns (uint256);
}
