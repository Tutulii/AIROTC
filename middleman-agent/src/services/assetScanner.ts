import { PublicKey } from "@solana/web3.js";
import { getConnection } from "../solana/connection";
import { logger } from "../utils/logger";

export interface AssetRiskReport {
  asset: string;
  riskScore: number; // 0-100
  warnings: string[];
  isStrictlySafe: boolean;
}

/**
 * Dynamically queries the Solana blockchain to audit a token's safety.
 * Looks for dangerous indicators like active Mint and Freeze authorities.
 */
export async function scanAssetRisk(assetBase58: string): Promise<AssetRiskReport> {
  const report: AssetRiskReport = {
    asset: assetBase58,
    riskScore: 0,
    warnings: [],
    isStrictlySafe: true,
  };

  const assetNormalized = assetBase58.toLowerCase().trim();
  if (assetNormalized === "data" || assetNormalized === "sol" || assetNormalized === "token") {
    return report; // Primitive or generic assets inherently carry 0 contract risk
  }

  try {
    const connection = getConnection();
    const mintPubkey = new PublicKey(assetBase58);
    const accountInfo = await connection.getParsedAccountInfo(mintPubkey);

    if (!accountInfo.value || !("parsed" in accountInfo.value.data)) {
      report.riskScore += 90;
      report.warnings.push("Asset is not a valid or recognized SPL Token Mint");
      report.isStrictlySafe = false;
      return report;
    }

    const parsedData = (accountInfo.value.data as any).parsed.info;

    if (parsedData.mintAuthority !== null) {
      report.riskScore += 50;
      report.warnings.push("Mint Authority is still active (Rug Risk: Developer can mint infinite tokens without warning)");
      report.isStrictlySafe = false;
    }

    if (parsedData.freezeAuthority !== null) {
      report.riskScore += 40;
      report.warnings.push("Freeze Authority is still active (Rug Risk: Developer can freeze your wallet's funds entirely)");
      report.isStrictlySafe = false;
    }

    if (report.riskScore >= 80) {
      report.isStrictlySafe = false;
    }

    logger.info("asset_scan_complete", {
        asset: assetBase58,
        riskScore: report.riskScore,
        warnings: report.warnings.length
    });

    return report;

  } catch (e: any) {
    logger.warn("asset_scanner_failed_or_invalid", { asset: assetBase58, error: e.message });
    report.riskScore = 100;
    report.warnings.push(`Failed to analyze token data on-chain => ${e.message}`);
    report.isStrictlySafe = false;
    return report;
  }
}
