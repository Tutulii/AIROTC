from agentotc.per import compute_funding_commitment_hash, compute_private_terms_hash


def test_per_hash_vectors_match_typescript_protocol():
    terms_hash = compute_private_terms_hash(
        {
            "sessionPda": "session-pda",
            "assetMint": "So11111111111111111111111111111111111111112",
            "priceLamports": 100,
            "buyerCollateralLamports": 20,
            "sellerCollateralLamports": 30,
            "status": "confidentialHandoff",
            "termsNonceHex": "a" * 64,
        }
    )
    assert terms_hash == "835d159fabab1467ff0e66de5c2f8da4db373651d60c389b23ec7a0c334d9a57"
    assert (
        compute_funding_commitment_hash(
            {
                "sessionPda": "session-pda",
                "role": "buyer_payment",
                "termsHash": terms_hash,
                "amountLamports": 100,
            }
        )
        == "2c81b796ee61deec9f36c5c808445ef7e2bdc0756bdb198d5e4ce2f9b774b382"
    )


if __name__ == "__main__":
    test_per_hash_vectors_match_typescript_protocol()
    print("PER Python golden vectors passed")
