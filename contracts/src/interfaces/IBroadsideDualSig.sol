// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.8.24;

import "./IBroadsideSettlement.sol";

/// @title  IBroadsideDualSig
/// @notice External surface for the carved-out dual-signature settlement
///         path. Verifies publisher + advertiser EIP-712 signatures over
///         a `ClaimBatch` envelope, then forwards the batch to Settlement
///         via the gated `processVerifiedBatch` entry. The non-signed
///         settle paths (settleClaims / settleClaimsMulti) remain on
///         Settlement.
interface IBroadsideDualSig {
    function settleSignedClaims(IBroadsideSettlement.SignedClaimBatch[] calldata batches)
        external returns (IBroadsideSettlement.SettlementResult memory);
}
