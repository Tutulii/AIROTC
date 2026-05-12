/**
 * Program IDL in camelCase format in order to be used in JS/TS.
 *
 * Note that this is only a type helper and is not the actual IDL. The original
 * IDL can be found at `target/idl/magicblock_negotiation.json`.
 */
export type MagicblockNegotiation = {
  "address": "BfFvxgysVSGdP2TwAjBRSFhDYtK2JA1VBd8BUqh8nGGq",
  "metadata": {
    "name": "magicblockNegotiation",
    "version": "0.1.0",
    "spec": "0.1.0",
    "description": "AIR OTC MagicBlock Negotiation Session — delegation-compatible via ephemeral-rollups-sdk"
  },
  "instructions": [
    {
      "name": "closePrivatePermission",
      "docs": [
        "4c. Close the PER permission account after it has been undelegated."
      ],
      "discriminator": [
        124,
        56,
        62,
        211,
        7,
        246,
        19,
        144
      ],
      "accounts": [
        {
          "name": "payer",
          "writable": true,
          "signer": true
        },
        {
          "name": "session",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  115,
                  101,
                  115,
                  115,
                  105,
                  111,
                  110
                ]
              },
              {
                "kind": "arg",
                "path": "sessionId"
              }
            ]
          }
        },
        {
          "name": "permission",
          "writable": true
        },
        {
          "name": "permissionProgram",
          "address": "ACLseoPoyC3cBqoUtkbjZ4aDrkurZW86v19pXz2XQnp1"
        }
      ],
      "args": [
        {
          "name": "sessionId",
          "type": "u64"
        }
      ]
    },
    {
      "name": "commitPrivatePermission",
      "docs": [
        "4b. Commit the scrubbed PER session back to L1 through the permission",
        "program, with the session PDA signing via seeds."
      ],
      "discriminator": [
        195,
        227,
        218,
        104,
        230,
        7,
        51,
        212
      ],
      "accounts": [
        {
          "name": "payer",
          "writable": true,
          "signer": true
        },
        {
          "name": "session",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  115,
                  101,
                  115,
                  115,
                  105,
                  111,
                  110
                ]
              },
              {
                "kind": "arg",
                "path": "sessionId"
              }
            ]
          }
        },
        {
          "name": "permission",
          "writable": true
        },
        {
          "name": "permissionProgram",
          "address": "ACLseoPoyC3cBqoUtkbjZ4aDrkurZW86v19pXz2XQnp1"
        },
        {
          "name": "magicProgram",
          "address": "Magic11111111111111111111111111111111111111"
        },
        {
          "name": "magicContext",
          "writable": true,
          "address": "MagicContext1111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "sessionId",
          "type": "u64"
        }
      ]
    },
    {
      "name": "createPrivatePermission",
      "docs": [
        "2b. Create the PER permission account via on-chain CPI so the session",
        "PDA can sign with seeds."
      ],
      "discriminator": [
        21,
        217,
        118,
        76,
        48,
        144,
        174,
        253
      ],
      "accounts": [
        {
          "name": "payer",
          "writable": true,
          "signer": true
        },
        {
          "name": "session",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  115,
                  101,
                  115,
                  115,
                  105,
                  111,
                  110
                ]
              },
              {
                "kind": "arg",
                "path": "sessionId"
              }
            ]
          }
        },
        {
          "name": "permission",
          "writable": true
        },
        {
          "name": "permissionProgram"
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "sessionId",
          "type": "u64"
        },
        {
          "name": "buyerMember",
          "type": "pubkey"
        },
        {
          "name": "sellerMember",
          "type": "pubkey"
        }
      ]
    },
    {
      "name": "delegatePrivatePermission",
      "docs": [
        "2c. Delegate the PER permission account via on-chain CPI so the session",
        "PDA can sign with seeds during permission activation."
      ],
      "discriminator": [
        111,
        240,
        5,
        39,
        139,
        20,
        37,
        191
      ],
      "accounts": [
        {
          "name": "payer",
          "writable": true,
          "signer": true
        },
        {
          "name": "session",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  115,
                  101,
                  115,
                  115,
                  105,
                  111,
                  110
                ]
              },
              {
                "kind": "arg",
                "path": "sessionId"
              }
            ]
          }
        },
        {
          "name": "permission",
          "writable": true
        },
        {
          "name": "permissionProgram",
          "address": "ACLseoPoyC3cBqoUtkbjZ4aDrkurZW86v19pXz2XQnp1"
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        },
        {
          "name": "delegationBuffer",
          "writable": true
        },
        {
          "name": "delegationRecord",
          "writable": true
        },
        {
          "name": "delegationMetadata",
          "writable": true
        },
        {
          "name": "delegationProgram",
          "address": "DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh"
        },
        {
          "name": "validator"
        }
      ],
      "args": [
        {
          "name": "sessionId",
          "type": "u64"
        }
      ]
    },
    {
      "name": "delegateSession",
      "docs": [
        "2. Delegate the Session PDA to a MagicBlock validator.",
        "The `#[delegate]` macro on `DelegateSession` auto-generates",
        "the `delegate_session` method which handles all CPI wiring —",
        "buffer creation, PDA signing, and delegation program invocation."
      ],
      "discriminator": [
        82,
        83,
        119,
        119,
        196,
        219,
        5,
        197
      ],
      "accounts": [
        {
          "name": "payer",
          "writable": true,
          "signer": true
        },
        {
          "name": "validator",
          "optional": true
        },
        {
          "name": "bufferSession",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  98,
                  117,
                  102,
                  102,
                  101,
                  114
                ]
              },
              {
                "kind": "account",
                "path": "session"
              }
            ],
            "program": {
              "kind": "const",
              "value": [
                158,
                97,
                210,
                97,
                228,
                137,
                50,
                58,
                53,
                140,
                70,
                124,
                106,
                30,
                31,
                53,
                215,
                90,
                186,
                108,
                178,
                28,
                140,
                104,
                13,
                198,
                111,
                160,
                77,
                214,
                197,
                170
              ]
            }
          }
        },
        {
          "name": "delegationRecordSession",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  100,
                  101,
                  108,
                  101,
                  103,
                  97,
                  116,
                  105,
                  111,
                  110
                ]
              },
              {
                "kind": "account",
                "path": "session"
              }
            ],
            "program": {
              "kind": "account",
              "path": "delegationProgram"
            }
          }
        },
        {
          "name": "delegationMetadataSession",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  100,
                  101,
                  108,
                  101,
                  103,
                  97,
                  116,
                  105,
                  111,
                  110,
                  45,
                  109,
                  101,
                  116,
                  97,
                  100,
                  97,
                  116,
                  97
                ]
              },
              {
                "kind": "account",
                "path": "session"
              }
            ],
            "program": {
              "kind": "account",
              "path": "delegationProgram"
            }
          }
        },
        {
          "name": "session",
          "writable": true
        },
        {
          "name": "ownerProgram",
          "address": "BfFvxgysVSGdP2TwAjBRSFhDYtK2JA1VBd8BUqh8nGGq"
        },
        {
          "name": "delegationProgram",
          "address": "DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh"
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": []
    },
    {
      "name": "initializeSession",
      "docs": [
        "1. Create an on-chain Negotiation Session PDA.",
        "This account will be delegated to a MagicBlock ER/PER validator",
        "for sub-100ms state updates during the negotiation phase."
      ],
      "discriminator": [
        69,
        130,
        92,
        236,
        107,
        231,
        159,
        129
      ],
      "accounts": [
        {
          "name": "session",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  115,
                  101,
                  115,
                  115,
                  105,
                  111,
                  110
                ]
              },
              {
                "kind": "arg",
                "path": "sessionId"
              }
            ]
          }
        },
        {
          "name": "buyer",
          "writable": true,
          "signer": true
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "sessionId",
          "type": "u64"
        }
      ]
    },
    {
      "name": "negotiateTerms",
      "docs": [
        "3. Update negotiation terms (runs at sub-100ms on the ephemeral validator).",
        "Called via ER RPC. The `agreed_asset` string is capped at 64 chars."
      ],
      "discriminator": [
        16,
        4,
        251,
        171,
        151,
        115,
        211,
        70
      ],
      "accounts": [
        {
          "name": "session",
          "writable": true
        }
      ],
      "args": [
        {
          "name": "newPrice",
          "type": "u64"
        },
        {
          "name": "newAsset",
          "type": "string"
        },
        {
          "name": "newBuyerCollateral",
          "type": "u64"
        },
        {
          "name": "newSellerCollateral",
          "type": "u64"
        }
      ]
    },
    {
      "name": "preparePrivateHandoff",
      "docs": [
        "4. PER-only safety step: scrub negotiated terms before any final L1 sync.",
        "",
        "This keeps the delegated session usable as a coordination record while",
        "removing sensitive price/collateral fields before the permission program",
        "commits the account back to Solana during the Encrypt handoff."
      ],
      "discriminator": [
        109,
        60,
        204,
        14,
        90,
        201,
        149,
        66
      ],
      "accounts": [
        {
          "name": "payer",
          "writable": true,
          "signer": true
        },
        {
          "name": "session",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  115,
                  101,
                  115,
                  115,
                  105,
                  111,
                  110
                ]
              },
              {
                "kind": "arg",
                "path": "sessionId"
              }
            ]
          }
        }
      ],
      "args": [
        {
          "name": "sessionId",
          "type": "u64"
        }
      ]
    },
    {
      "name": "processUndelegation",
      "discriminator": [
        196,
        28,
        41,
        206,
        48,
        37,
        51,
        167
      ],
      "accounts": [
        {
          "name": "baseAccount",
          "writable": true
        },
        {
          "name": "buffer"
        },
        {
          "name": "payer",
          "writable": true
        },
        {
          "name": "systemProgram"
        }
      ],
      "args": [
        {
          "name": "accountSeeds",
          "type": {
            "vec": "bytes"
          }
        }
      ]
    },
    {
      "name": "reachConsensus",
      "docs": [
        "5. Mark consensus and commit+undelegate — commits state back to Solana L1.",
        "Uses `commit_and_undelegate_accounts` from the SDK's `ephem` module,",
        "which routes through the Magic Program (no raw buffer/signer required)."
      ],
      "discriminator": [
        153,
        212,
        136,
        217,
        18,
        118,
        215,
        116
      ],
      "accounts": [
        {
          "name": "payer",
          "writable": true,
          "signer": true
        },
        {
          "name": "session",
          "docs": [
            "the delegated account is temporarily owned by the delegation program."
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  115,
                  101,
                  115,
                  115,
                  105,
                  111,
                  110
                ]
              },
              {
                "kind": "arg",
                "path": "sessionId"
              }
            ]
          }
        },
        {
          "name": "magicProgram",
          "address": "Magic11111111111111111111111111111111111111"
        },
        {
          "name": "magicContext",
          "writable": true,
          "address": "MagicContext1111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "sessionId",
          "type": "u64"
        }
      ]
    },
    {
      "name": "recordPrivateHandoffProof",
      "docs": [
        "4a. Record the canonical confidential handoff proof directly inside the",
        "delegated session PDA while it is still running on the attested TEE.",
        "",
        "This makes the session PDA itself the source of truth for:",
        "- the real counterparties",
        "- the hashed negotiated terms",
        "- the Encrypt ciphertext accounts that downstream escrow will use",
        "",
        "The plaintext negotiation fields are scrubbed in the same state",
        "transition so the session can later be committed back to L1 without",
        "exposing price/collateral terms."
      ],
      "discriminator": [
        236,
        189,
        67,
        246,
        27,
        202,
        91,
        232
      ],
      "accounts": [
        {
          "name": "payer",
          "writable": true,
          "signer": true
        },
        {
          "name": "session",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  115,
                  101,
                  115,
                  115,
                  105,
                  111,
                  110
                ]
              },
              {
                "kind": "arg",
                "path": "sessionId"
              }
            ]
          }
        }
      ],
      "args": [
        {
          "name": "sessionId",
          "type": "u64"
        },
        {
          "name": "buyerParticipant",
          "type": "pubkey"
        },
        {
          "name": "sellerParticipant",
          "type": "pubkey"
        },
        {
          "name": "termsHash",
          "type": {
            "array": [
              "u8",
              32
            ]
          }
        },
        {
          "name": "buyerPaymentFundingHash",
          "type": {
            "array": [
              "u8",
              32
            ]
          }
        },
        {
          "name": "buyerCollateralFundingHash",
          "type": {
            "array": [
              "u8",
              32
            ]
          }
        },
        {
          "name": "sellerCollateralFundingHash",
          "type": {
            "array": [
              "u8",
              32
            ]
          }
        },
        {
          "name": "buyerCollateralCiphertext",
          "type": "pubkey"
        },
        {
          "name": "sellerCollateralCiphertext",
          "type": "pubkey"
        },
        {
          "name": "paymentAmountCiphertext",
          "type": "pubkey"
        },
        {
          "name": "settlementResultCiphertext",
          "type": "pubkey"
        },
        {
          "name": "networkEncryptionKey",
          "type": "pubkey"
        }
      ]
    }
  ],
  "accounts": [
    {
      "name": "session",
      "discriminator": [
        243,
        81,
        72,
        115,
        214,
        188,
        72,
        144
      ]
    }
  ],
  "errors": [
    {
      "code": 6000,
      "name": "assetNameTooLong",
      "msg": "Asset name exceeds 64 character limit"
    },
    {
      "code": 6001,
      "name": "sessionIdMismatch",
      "msg": "Session id did not match the provided session PDA"
    },
    {
      "code": 6002,
      "name": "permissionPdaMismatch",
      "msg": "The provided permission PDA did not match the session account"
    },
    {
      "code": 6003,
      "name": "invalidPermissionProgram",
      "msg": "The provided permission program was invalid"
    },
    {
      "code": 6004,
      "name": "invalidDelegationProgram",
      "msg": "The provided delegation program was invalid"
    },
    {
      "code": 6005,
      "name": "delegationPdaMismatch",
      "msg": "The provided delegation PDA did not match the permission account"
    },
    {
      "code": 6006,
      "name": "invalidCounterparties",
      "msg": "The buyer and seller counterparties must be distinct non-default public keys"
    },
    {
      "code": 6007,
      "name": "missingPrivateHandoffProof",
      "msg": "The private handoff proof must include a non-zero terms hash"
    },
    {
      "code": 6008,
      "name": "invalidCiphertextHandle",
      "msg": "The private handoff proof included an invalid ciphertext handle or network encryption key"
    }
  ],
  "types": [
    {
      "name": "negotiationStatus",
      "type": {
        "kind": "enum",
        "variants": [
          {
            "name": "open"
          },
          {
            "name": "consensusReached"
          },
          {
            "name": "failed"
          },
          {
            "name": "confidentialHandoff"
          }
        ]
      }
    },
    {
      "name": "session",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "sessionId",
            "type": "u64"
          },
          {
            "name": "buyer",
            "type": "pubkey"
          },
          {
            "name": "agreedPrice",
            "type": "u64"
          },
          {
            "name": "agreedAsset",
            "type": "string"
          },
          {
            "name": "buyerCollateral",
            "type": "u64"
          },
          {
            "name": "sellerCollateral",
            "type": "u64"
          },
          {
            "name": "status",
            "type": {
              "defined": {
                "name": "negotiationStatus"
              }
            }
          },
          {
            "name": "buyerParticipant",
            "type": "pubkey"
          },
          {
            "name": "sellerParticipant",
            "type": "pubkey"
          },
          {
            "name": "termsHash",
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "buyerPaymentFundingHash",
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "buyerCollateralFundingHash",
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "sellerCollateralFundingHash",
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "buyerCollateralCiphertext",
            "type": "pubkey"
          },
          {
            "name": "sellerCollateralCiphertext",
            "type": "pubkey"
          },
          {
            "name": "paymentAmountCiphertext",
            "type": "pubkey"
          },
          {
            "name": "settlementResultCiphertext",
            "type": "pubkey"
          },
          {
            "name": "networkEncryptionKey",
            "type": "pubkey"
          },
          {
            "name": "proofRecordedAt",
            "type": "i64"
          }
        ]
      }
    }
  ]
};
