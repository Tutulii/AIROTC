//! ika-bridge — Rust CLI bridge for TypeScript ↔ Ika gRPC
//!
//! Usage:
//!   ika-bridge dkg --curve 2 --keypair /path/to/keypair.json --grpc-url https://...
//!   ika-bridge presign --curve 2 --algorithm eddsa --keypair ...
//!   ika-bridge sign --message <hex> --presign-id <hex> --dwallet-attestation <hex> \
//!              --approval-tx <base58> --approval-slot <u64> --keypair ...
//!
//! All output is JSON to stdout. Errors are JSON with {"error": "..."}.
//! TypeScript calls this via child_process.execFile().

use clap::{Parser, Subcommand};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;

// Re-exports from ika crates
use ika_grpc::d_wallet_service_client::DWalletServiceClient;
use ika_grpc::UserSignedRequest;
use ika_dwallet_types::{
    DWalletRequest, SignedRequestData, UserSignature, UserSecretKeyShare,
    DWalletCurve, DWalletSignatureAlgorithm, DWalletSignatureScheme,
    TransactionResponseData, NetworkSignedAttestation, ApprovalProof,
    ChainId,
};

/// CLI arguments
#[derive(Parser)]
#[command(name = "ika-bridge", about = "Ika gRPC bridge for TypeScript agent")]
struct Cli {
    #[command(subcommand)]
    command: Commands,

    /// gRPC endpoint
    #[arg(long, default_value = "https://pre-alpha-dev-1.ika.ika-network.net:443")]
    grpc_url: String,

    /// Path to Solana keypair JSON
    #[arg(long)]
    keypair: PathBuf,
}

#[derive(Subcommand)]
enum Commands {
    /// Create a new dWallet via DKG
    Dkg {
        /// Curve: 0=Secp256k1, 1=Secp256r1, 2=Curve25519, 3=Ristretto
        #[arg(long, default_value = "2")]
        curve: u32,
    },
    /// Allocate a global presign
    Presign {
        /// Curve
        #[arg(long, default_value = "2")]
        curve: u32,
        /// Algorithm: ecdsa, eddsa, schnorrkel
        #[arg(long, default_value = "eddsa")]
        algorithm: String,
    },
    /// Sign a message with an existing dWallet
    Sign {
        /// Message to sign (hex-encoded)
        #[arg(long)]
        message: String,
        /// Presign session identifier (hex-encoded)
        #[arg(long)]
        presign_id: String,
        /// Message centralized signature (hex-encoded)
        #[arg(long)]
        centralized_sig: String,
        /// dWallet attestation (hex-encoded BCS)
        #[arg(long)]
        dwallet_attestation: String,
        /// Solana tx signature of approve_message (base58)
        #[arg(long)]
        approval_tx: String,
        /// Slot of the approve_message transaction
        #[arg(long)]
        approval_slot: u64,
    },
}

/// JSON output for DKG
#[derive(Serialize)]
struct DkgOutput {
    public_key: String,        // hex
    attestation_data: String,  // hex (BCS)
    network_signature: String, // hex
    epoch: u64,
    session_identifier: String, // hex
}

/// JSON output for Presign
#[derive(Serialize)]
struct PresignOutput {
    presign_session_identifier: String, // hex
    attestation_data: String,           // hex (BCS)
    network_signature: String,          // hex
    epoch: u64,
}

/// JSON output for Sign
#[derive(Serialize)]
struct SignOutput {
    signature: String, // hex (64 bytes)
}

/// JSON error
#[derive(Serialize)]
struct ErrorOutput {
    error: String,
}

fn load_keypair(path: &PathBuf) -> Result<ed25519_dalek::SigningKey, String> {
    let data = std::fs::read_to_string(path)
        .map_err(|e| format!("Failed to read keypair: {e}"))?;
    let bytes: Vec<u8> = serde_json::from_str(&data)
        .map_err(|e| format!("Failed to parse keypair JSON: {e}"))?;
    if bytes.len() < 64 {
        return Err("Keypair too short".to_string());
    }
    let secret: [u8; 32] = bytes[..32]
        .try_into()
        .map_err(|_| "Invalid secret key bytes".to_string())?;
    Ok(ed25519_dalek::SigningKey::from_bytes(&secret))
}

fn sign_request(
    signing_key: &ed25519_dalek::SigningKey,
    signed_request_data: &[u8],
) -> UserSignature {
    use ed25519_dalek::Signer;
    let signature = signing_key.sign(signed_request_data);
    let public_key = signing_key.verifying_key();
    UserSignature::Ed25519 {
        signature: signature.to_bytes().to_vec(),
        public_key: public_key.to_bytes().to_vec(),
    }
}

fn parse_algorithm(s: &str) -> Result<DWalletSignatureAlgorithm, String> {
    match s.to_lowercase().as_str() {
        "ecdsa" => Ok(DWalletSignatureAlgorithm::ECDSASecp256k1),
        "eddsa" => Ok(DWalletSignatureAlgorithm::EdDSA),
        "schnorrkel" => Ok(DWalletSignatureAlgorithm::Schnorrkel),
        _ => Err(format!("Unknown algorithm: {s}")),
    }
}

fn parse_curve(v: u32) -> DWalletCurve {
    match v {
        0 => DWalletCurve::Secp256k1,
        1 => DWalletCurve::Secp256r1,
        2 => DWalletCurve::Curve25519,
        3 => DWalletCurve::Ristretto,
        _ => DWalletCurve::Curve25519,
    }
}

#[tokio::main]
async fn main() {
    let cli = Cli::parse();

    let result = match &cli.command {
        Commands::Dkg { curve } => handle_dkg(&cli, *curve).await,
        Commands::Presign { curve, algorithm } => {
            handle_presign(&cli, *curve, algorithm).await
        }
        Commands::Sign {
            message,
            presign_id,
            centralized_sig,
            dwallet_attestation,
            approval_tx,
            approval_slot,
        } => {
            handle_sign(
                &cli,
                message,
                presign_id,
                centralized_sig,
                dwallet_attestation,
                approval_tx,
                *approval_slot,
            )
            .await
        }
    };

    match result {
        Ok(json) => println!("{json}"),
        Err(e) => {
            let err = serde_json::to_string(&ErrorOutput { error: e }).unwrap();
            eprintln!("{err}");
            std::process::exit(1);
        }
    }
}

async fn handle_dkg(cli: &Cli, curve_val: u32) -> Result<String, String> {
    let signing_key = load_keypair(&cli.keypair)?;
    let curve = parse_curve(curve_val);
    let public_key = signing_key.verifying_key().to_bytes().to_vec();

    // Session identifier
    let mut session_id = [0u8; 32];
    rand::RngCore::fill_bytes(&mut rand::thread_rng(), &mut session_id);

    // Build DKG request with trust-minimized mode (Public share)
    // For production zero-trust, use Encrypted variant instead
    let request = DWalletRequest::DKG {
        dwallet_network_encryption_public_key: vec![], // NOA fills this
        curve,
        centralized_public_key_share_and_proof: vec![],
        user_secret_key_share: UserSecretKeyShare::Public {
            public_user_secret_key_share: vec![],
        },
        user_public_output: public_key.clone(),
        sign_during_dkg_request: None,
    };

    let signed_data = SignedRequestData {
        session_identifier_preimage: session_id,
        epoch: 0, // NOA uses current epoch
        chain_id: ChainId::Solana,
        intended_chain_sender: public_key.clone(),
        request,
    };

    let signed_data_bytes =
        bcs::to_bytes(&signed_data).map_err(|e| format!("BCS encode error: {e}"))?;
    let user_sig = sign_request(&signing_key, &signed_data_bytes);

    let mut client = DWalletServiceClient::connect(cli.grpc_url.clone())
        .await
        .map_err(|e| format!("gRPC connect error: {e}"))?;

    let resp = client
        .submit_transaction(UserSignedRequest {
            user_signature: bcs::to_bytes(&user_sig)
                .map_err(|e| format!("BCS encode sig: {e}"))?,
            signed_request_data: signed_data_bytes,
        })
        .await
        .map_err(|e| format!("gRPC call error: {e}"))?;

    let result: TransactionResponseData =
        bcs::from_bytes(&resp.into_inner().response_data)
            .map_err(|e| format!("BCS decode response: {e}"))?;

    match result {
        TransactionResponseData::Attestation(NetworkSignedAttestation {
            attestation_data,
            network_signature,
            epoch,
            ..
        }) => {
            // Decode DKG attestation to get public key
            let dkg_att: ika_dwallet_types::VersionedDWalletDataAttestation =
                bcs::from_bytes(&attestation_data)
                    .map_err(|e| format!("BCS decode attestation: {e}"))?;

            let pk = match &dkg_att {
                ika_dwallet_types::VersionedDWalletDataAttestation::V1(v1) => {
                    v1.public_key.clone()
                }
            };

            let output = DkgOutput {
                public_key: hex::encode(&pk),
                attestation_data: hex::encode(&attestation_data),
                network_signature: hex::encode(&network_signature),
                epoch,
                session_identifier: hex::encode(session_id),
            };
            serde_json::to_string(&output).map_err(|e| format!("JSON encode: {e}"))
        }
        TransactionResponseData::Error { message } => Err(format!("DKG error: {message}")),
        _ => Err("Unexpected response type for DKG".to_string()),
    }
}

async fn handle_presign(
    cli: &Cli,
    curve_val: u32,
    algorithm: &str,
) -> Result<String, String> {
    let signing_key = load_keypair(&cli.keypair)?;
    let curve = parse_curve(curve_val);
    let sig_alg = parse_algorithm(algorithm)?;
    let public_key = signing_key.verifying_key().to_bytes().to_vec();

    let mut session_id = [0u8; 32];
    rand::RngCore::fill_bytes(&mut rand::thread_rng(), &mut session_id);

    let request = DWalletRequest::Presign {
        dwallet_network_encryption_public_key: vec![],
        curve,
        signature_algorithm: sig_alg,
    };

    let signed_data = SignedRequestData {
        session_identifier_preimage: session_id,
        epoch: 0,
        chain_id: ChainId::Solana,
        intended_chain_sender: public_key.clone(),
        request,
    };

    let signed_data_bytes =
        bcs::to_bytes(&signed_data).map_err(|e| format!("BCS encode: {e}"))?;
    let user_sig = sign_request(&signing_key, &signed_data_bytes);

    let mut client = DWalletServiceClient::connect(cli.grpc_url.clone())
        .await
        .map_err(|e| format!("gRPC connect: {e}"))?;

    let resp = client
        .submit_transaction(UserSignedRequest {
            user_signature: bcs::to_bytes(&user_sig)
                .map_err(|e| format!("BCS encode: {e}"))?,
            signed_request_data: signed_data_bytes,
        })
        .await
        .map_err(|e| format!("gRPC call: {e}"))?;

    let result: TransactionResponseData =
        bcs::from_bytes(&resp.into_inner().response_data)
            .map_err(|e| format!("BCS decode: {e}"))?;

    match result {
        TransactionResponseData::Attestation(NetworkSignedAttestation {
            attestation_data,
            network_signature,
            epoch,
            ..
        }) => {
            let presign_att: ika_dwallet_types::VersionedPresignDataAttestation =
                bcs::from_bytes(&attestation_data)
                    .map_err(|e| format!("BCS decode presign: {e}"))?;

            let presign_session_id = match &presign_att {
                ika_dwallet_types::VersionedPresignDataAttestation::V1(v1) => {
                    v1.presign_session_identifier.clone()
                }
            };

            let output = PresignOutput {
                presign_session_identifier: hex::encode(&presign_session_id),
                attestation_data: hex::encode(&attestation_data),
                network_signature: hex::encode(&network_signature),
                epoch,
            };
            serde_json::to_string(&output).map_err(|e| format!("JSON: {e}"))
        }
        TransactionResponseData::Error { message } => Err(format!("Presign error: {message}")),
        _ => Err("Unexpected response for Presign".to_string()),
    }
}

async fn handle_sign(
    cli: &Cli,
    message_hex: &str,
    presign_id_hex: &str,
    centralized_sig_hex: &str,
    dwallet_att_hex: &str,
    approval_tx: &str,
    approval_slot: u64,
) -> Result<String, String> {
    let signing_key = load_keypair(&cli.keypair)?;
    let public_key = signing_key.verifying_key().to_bytes().to_vec();

    let message = hex::decode(message_hex).map_err(|e| format!("Bad message hex: {e}"))?;
    let presign_id =
        hex::decode(presign_id_hex).map_err(|e| format!("Bad presign_id hex: {e}"))?;
    let centralized_sig =
        hex::decode(centralized_sig_hex).map_err(|e| format!("Bad centralized_sig hex: {e}"))?;
    let att_data =
        hex::decode(dwallet_att_hex).map_err(|e| format!("Bad attestation hex: {e}"))?;

    // Decode the stored attestation
    let dwallet_attestation: NetworkSignedAttestation =
        bcs::from_bytes(&att_data).map_err(|e| format!("BCS decode attestation: {e}"))?;

    // Build ApprovalProof::Solana
    let approval_tx_bytes = bs58::decode(approval_tx)
        .into_vec()
        .map_err(|e| format!("Bad base58 approval_tx: {e}"))?;

    let approval_proof = ApprovalProof::Solana {
        transaction_signature: approval_tx_bytes,
        slot: approval_slot,
    };

    let mut session_id = [0u8; 32];
    rand::RngCore::fill_bytes(&mut rand::thread_rng(), &mut session_id);

    let request = DWalletRequest::Sign {
        message: message.clone(),
        message_metadata: vec![],
        presign_session_identifier: presign_id,
        message_centralized_signature: centralized_sig,
        dwallet_attestation,
        approval_proof,
    };

    let signed_data = SignedRequestData {
        session_identifier_preimage: session_id,
        epoch: 0,
        chain_id: ChainId::Solana,
        intended_chain_sender: public_key.clone(),
        request,
    };

    let signed_data_bytes =
        bcs::to_bytes(&signed_data).map_err(|e| format!("BCS: {e}"))?;
    let user_sig = sign_request(&signing_key, &signed_data_bytes);

    let mut client = DWalletServiceClient::connect(cli.grpc_url.clone())
        .await
        .map_err(|e| format!("gRPC connect: {e}"))?;

    let resp = client
        .submit_transaction(UserSignedRequest {
            user_signature: bcs::to_bytes(&user_sig)
                .map_err(|e| format!("BCS: {e}"))?,
            signed_request_data: signed_data_bytes,
        })
        .await
        .map_err(|e| format!("gRPC Sign: {e}"))?;

    let result: TransactionResponseData =
        bcs::from_bytes(&resp.into_inner().response_data)
            .map_err(|e| format!("BCS decode: {e}"))?;

    match result {
        TransactionResponseData::Signature { signature } => {
            let output = SignOutput {
                signature: hex::encode(&signature),
            };
            serde_json::to_string(&output).map_err(|e| format!("JSON: {e}"))
        }
        TransactionResponseData::Error { message } => Err(format!("Sign error: {message}")),
        _ => Err("Unexpected response for Sign".to_string()),
    }
}
