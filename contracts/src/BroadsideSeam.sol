// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity 0.8.24;

/**
 * The Phase 1 seam probe's target. Not part of the protocol — this contract
 * exists to answer one question and will never hold value.
 *
 * The question: can a key derived inside the Polkadot App produce a signature
 * that a PolkaVM contract's `ecrecover` accepts? The host signs sr25519 and
 * cannot produce an ecrecover-able signature at all, and `AutoSigning` reports
 * `NotAvailable` on both mobile wallets, so every host-routed signature costs a
 * user tap. An ad network cannot tap-sign per impression. That forces the
 * app-local secp256k1 burner, and this contract is where that assumption either
 * holds or fails.
 *
 * `recover` is `view` on purpose. It is the whole answer and it costs nothing:
 * a probe running on a stranger's phone has no gas, so the load-bearing check
 * has to be reachable by `eth_call`. `attest` exists so that the same claim can
 * be proven a second way — through a real transaction with a real receipt —
 * once someone funds the burner.
 */
contract BroadsideSeam {
    struct Seam {
        address viewer;
        uint256 nonce;
        bytes32 note;
    }

    struct Attestation {
        uint256 nonce;
        bytes32 note;
        uint256 blockNumber;
        address submitter;
    }

    bytes32 private constant DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    bytes32 private constant SEAM_TYPEHASH = keccak256("Seam(address viewer,uint256 nonce,bytes32 note)");
    bytes32 private constant NAME_HASH = keccak256("BroadsideSeam");
    bytes32 private constant VERSION_HASH = keccak256("1");

    /// Half the secp256k1 curve order. An `s` above this has an equally valid
    /// low-`s` twin, so accepting both would make one signature into two.
    uint256 private constant HALF_N = 0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF5D576E7357A4501DDFE92F46681B20A0;

    mapping(address => Attestation) public attestationOf;

    event Attested(address indexed viewer, uint256 nonce, bytes32 note, address submitter);

    error BadSignatureLength(uint256 length);
    error MalleableSignature();
    error BadRecoveryId(uint8 v);
    error RecoveryFailed();
    error ViewerMismatch(address recovered, address claimed);
    error StaleNonce(uint256 given, uint256 have);

    /// The chain this contract believes it is on. The probe reads it rather
    /// than trusting `eth_chainId`, because the two disagreeing is itself a
    /// finding — and a wrong chain id means every EIP-712 signature is invalid
    /// here while looking perfectly well-formed.
    function chainId() external view returns (uint256) {
        return block.chainid;
    }

    function domainSeparator() public view returns (bytes32) {
        return keccak256(abi.encode(DOMAIN_TYPEHASH, NAME_HASH, VERSION_HASH, block.chainid, address(this)));
    }

    function hashSeam(Seam calldata s) public view returns (bytes32) {
        return keccak256(
            abi.encodePacked(
                hex"1901", domainSeparator(), keccak256(abi.encode(SEAM_TYPEHASH, s.viewer, s.nonce, s.note))
            )
        );
    }

    /**
     * Recover the signer. Reverts with a specific error rather than returning
     * `address(0)`, so a probe learns *which* step failed — a malformed
     * signature, a malleable one, and a valid signature by the wrong key are
     * three different findings and must not collapse into one.
     */
    function recover(Seam calldata s, bytes calldata sig) public view returns (address) {
        if (sig.length != 65) revert BadSignatureLength(sig.length);

        bytes32 r = bytes32(sig[0:32]);
        bytes32 vs = bytes32(sig[32:64]);
        uint8 v = uint8(sig[64]);

        if (uint256(vs) > HALF_N) revert MalleableSignature();
        if (v != 27 && v != 28) revert BadRecoveryId(v);

        address signer = ecrecover(hashSeam(s), v, r, vs);
        if (signer == address(0)) revert RecoveryFailed();
        return signer;
    }

    /**
     * The same proof, as a transaction. Deliberately callable by anyone: in
     * production the relay pays gas and the viewer never holds any, so the
     * submitter being someone other than the signer is the normal case, not an
     * edge one.
     */
    function attest(Seam calldata s, bytes calldata sig) external {
        address signer = recover(s, sig);
        if (signer != s.viewer) revert ViewerMismatch(signer, s.viewer);

        uint256 have = attestationOf[s.viewer].nonce;
        if (s.nonce <= have) revert StaleNonce(s.nonce, have);

        attestationOf[s.viewer] = Attestation(s.nonce, s.note, block.number, msg.sender);
        emit Attested(s.viewer, s.nonce, s.note, msg.sender);
    }
}
