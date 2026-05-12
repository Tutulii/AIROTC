// Copyright (c) dWallet Labs, Ltd.
// SPDX-License-Identifier: BSD-3-Clause-Clear

// Node.js / Bun gRPC client for the Ika dWallet service.
// Uses @grpc/grpc-js for native gRPC transport.

import * as grpc from '@grpc/grpc-js';
import crypto from 'crypto';
import { bcs } from '@mysten/bcs';
import {
  DWalletServiceClient,
  type UserSignedRequest as ProtoRequest,
} from './generated/grpc/ika_dwallet';
import { defineBcsTypes } from './bcs-types';

const { SignedRequestData, TransactionResponseData, UserSignature, VersionedDWalletDataAttestation, VersionedPresignDataAttestation } =
  defineBcsTypes();

export { defineBcsTypes } from './bcs-types';

export interface DKGResult {
  dwalletAddr?: Uint8Array;
  sessionIdentifier: Uint8Array;
  publicKey: Uint8Array;
  publicOutput?: Uint8Array;
  attestationData: Uint8Array;
  networkSignature: Uint8Array;
  networkPubkey: Uint8Array;
  epoch: bigint;
}

export interface IkaDWalletClient {
  requestDKG(senderPubkey: Uint8Array, curve: number): Promise<DKGResult>;
  requestPresign(
    senderPubkey: Uint8Array,
    sessionIdentifier: Uint8Array,
    curve: number,
    signatureAlgorithm: number,
  ): Promise<Uint8Array>;
  requestPresignForDWallet(
    senderPubkey: Uint8Array,
    sessionIdentifier: Uint8Array,
    dwalletPublicKey: Uint8Array,
    curve: number,
    signatureAlgorithm: number,
    dwalletAttestation: {
      attestationData: Uint8Array;
      networkSignature: Uint8Array;
      networkPubkey: Uint8Array;
      epoch: bigint;
    },
  ): Promise<Uint8Array>;
  requestSign(
    senderPubkey: Uint8Array, dwalletAddr: Uint8Array,
    message: Uint8Array,
    presignId: Uint8Array,
    txSignature: Uint8Array,
    approvalSlot: bigint,
    dwalletAttestation: {
      attestationData: Uint8Array;
      networkSignature: Uint8Array;
      networkPubkey: Uint8Array;
      epoch: bigint;
    },
  ): Promise<Uint8Array>;
  close(): void;
}

export function createIkaClient(grpcUrl?: string): IkaDWalletClient {
  const url = grpcUrl ?? '127.0.0.1:50051';
  const creds = url.includes('localhost') || url.match(/127\.0\.0\.1/)
    ? grpc.credentials.createInsecure()
    : grpc.credentials.createSsl();
  const client = new DWalletServiceClient(url, creds);

  function submit(userSig: Uint8Array, signedData: Uint8Array): Promise<Uint8Array> {
    return new Promise((resolve, reject) => {
      client.submitTransaction(
        { userSignature: Buffer.from(userSig), signedRequestData: Buffer.from(signedData) },
        (err, resp) => {
          if (err) reject(err);
          else resolve(new Uint8Array(resp!.responseData));
        },
      );
    });
  }

  function buildSig(pubkey: Uint8Array): Uint8Array {
    return UserSignature.serialize({
      Ed25519: { signature: Array.from(new Uint8Array(64)), public_key: Array.from(pubkey) },
    }).toBytes();
  }

  function encodeCurve(curve: number) {
    switch (curve) {
      case 0:
        return { Secp256k1: true } as const;
      case 1:
        return { Secp256r1: true } as const;
      case 2:
        return { Curve25519: true } as const;
      case 3:
        return { Ristretto: true } as const;
      default:
        throw new Error(`Unsupported dWallet curve: ${curve}`);
    }
  }

  function encodeSignatureAlgorithm(signatureAlgorithm: number) {
    switch (signatureAlgorithm) {
      case 0:
        return { ECDSASecp256k1: true } as const;
      case 1:
        return { ECDSASecp256r1: true } as const;
      case 2:
        return { Taproot: true } as const;
      case 3:
        return { EdDSA: true } as const;
      case 4:
        return { SchnorrkelSubstrate: true } as const;
      default:
        throw new Error(`Unsupported dWallet signature algorithm: ${signatureAlgorithm}`);
    }
  }

  return {
    async requestDKG(senderPubkey, curve) {
      const dkgSessionIdentifier = crypto.randomBytes(32);
      const data = SignedRequestData.serialize({
        session_identifier_preimage: Array.from(dkgSessionIdentifier),
        epoch: 1n, chain_id: { Solana: true },
        intended_chain_sender: Array.from(senderPubkey),
        request: { DKG: {
          dwallet_network_encryption_public_key: Array.from(new Uint8Array(32)),
          curve: encodeCurve(curve),
          centralized_public_key_share_and_proof: Array.from(new Uint8Array(32)),
          user_secret_key_share: { Encrypted: {
            encrypted_centralized_secret_share_and_proof: Array.from(new Uint8Array(32)),
            encryption_key: Array.from(new Uint8Array(32)),
            signer_public_key: Array.from(senderPubkey),
          }},
          user_public_output: Array.from(new Uint8Array(32)),
          sign_during_dkg_request: null,
        }},
      }).toBytes();

      const respBytes = await submit(buildSig(senderPubkey), data);
      const resp = TransactionResponseData.parse(new Uint8Array(respBytes));
      if (!resp.Attestation) throw new Error(`DKG failed: ${JSON.stringify(resp)}`);
      const att = resp.Attestation;
      // Decode the versioned DWallet data attestation from the signed bytes.
      const payload = VersionedDWalletDataAttestation.parse(new Uint8Array(att.attestation_data));
      if (!payload.V1) {
        throw new Error(`unexpected DKG payload variant: ${JSON.stringify(payload)}`);
      }
      const created = payload.V1;
      const sessionIdentifier = new Uint8Array(created.session_identifier);
      return {
        dwalletAddr: sessionIdentifier,
        sessionIdentifier,
        publicKey: new Uint8Array(created.public_key),
        publicOutput: new Uint8Array(created.public_output),
        attestationData: new Uint8Array(att.attestation_data),
        networkSignature: new Uint8Array(att.network_signature),
        networkPubkey: new Uint8Array(att.network_pubkey),
        epoch: BigInt(att.epoch),
      };
    },

    async requestPresign(senderPubkey, sessionIdentifier, curve, signatureAlgorithm) {
      const data = SignedRequestData.serialize({
        session_identifier_preimage: Array.from(sessionIdentifier),
        epoch: 1n, chain_id: { Solana: true },
        intended_chain_sender: Array.from(senderPubkey),
        request: { Presign: {
          dwallet_network_encryption_public_key: Array.from(new Uint8Array(32)),
          curve: encodeCurve(curve),
          signature_algorithm: encodeSignatureAlgorithm(signatureAlgorithm),
        }},
      }).toBytes();

      const respBytes = await submit(buildSig(senderPubkey), data);
      const resp = TransactionResponseData.parse(new Uint8Array(respBytes));
      if (!resp.Attestation) throw new Error(`Presign failed: ${JSON.stringify(resp)}`);
      const payload = VersionedPresignDataAttestation.parse(new Uint8Array(resp.Attestation.attestation_data));
      if (!payload.V1) {
        throw new Error(`unexpected presign payload variant: ${JSON.stringify(payload)}`);
      }
      return new Uint8Array(payload.V1.presign_session_identifier);
    },

    async requestPresignForDWallet(
      senderPubkey,
      sessionIdentifier,
      dwalletPublicKey,
      curve,
      signatureAlgorithm,
      dwalletAttestation,
    ) {
      const data = SignedRequestData.serialize({
        session_identifier_preimage: Array.from(sessionIdentifier),
        epoch: 1n, chain_id: { Solana: true },
        intended_chain_sender: Array.from(senderPubkey),
        request: { PresignForDWallet: {
          dwallet_network_encryption_public_key: Array.from(new Uint8Array(32)),
          dwallet_public_key: Array.from(dwalletPublicKey),
          dwallet_attestation: {
            attestation_data: Array.from(dwalletAttestation.attestationData),
            network_signature: Array.from(dwalletAttestation.networkSignature),
            network_pubkey: Array.from(dwalletAttestation.networkPubkey),
            epoch: dwalletAttestation.epoch,
          },
          curve: encodeCurve(curve),
          signature_algorithm: encodeSignatureAlgorithm(signatureAlgorithm),
        }},
      }).toBytes();

      const respBytes = await submit(buildSig(senderPubkey), data);
      const resp = TransactionResponseData.parse(new Uint8Array(respBytes));
      if (!resp.Attestation) throw new Error(`PresignForDWallet failed: ${JSON.stringify(resp)}`);
      const payload = VersionedPresignDataAttestation.parse(new Uint8Array(resp.Attestation.attestation_data));
      if (!payload.V1) {
        throw new Error(`unexpected presign-for-dwallet payload variant: ${JSON.stringify(payload)}`);
      }
      return new Uint8Array(payload.V1.presign_session_identifier);
    },

    async requestSign(
      senderPubkey,
      dwalletAddr,
      message,
      presignId,
      txSignature,
      approvalSlot,
      dwalletAttestation,
    ) {
      const data = SignedRequestData.serialize({
        session_identifier_preimage: Array.from(dwalletAddr),
        epoch: 1n, chain_id: { Solana: true },
        intended_chain_sender: Array.from(senderPubkey),
        request: { Sign: {
          message: Array.from(message), message_metadata: [],
          presign_session_identifier: Array.from(presignId),
          message_centralized_signature: Array.from(new Uint8Array(64)),
          dwallet_attestation: {
            attestation_data: Array.from(dwalletAttestation.attestationData),
            network_signature: Array.from(dwalletAttestation.networkSignature),
            network_pubkey: Array.from(dwalletAttestation.networkPubkey),
            epoch: dwalletAttestation.epoch,
          },
          approval_proof: {
            Solana: {
              transaction_signature: Array.from(txSignature),
              slot: approvalSlot,
            },
          },
        }},
      }).toBytes();

      const respBytes = await submit(buildSig(senderPubkey), data);
      const resp = TransactionResponseData.parse(new Uint8Array(respBytes));
      if (resp.Signature) return new Uint8Array(resp.Signature.signature);
      if (resp.Error) throw new Error(resp.Error.message);
      throw new Error(`Unexpected: ${JSON.stringify(resp)}`);
    },

    close() { client.close(); },
  };
}
