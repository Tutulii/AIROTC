export const getExplorerBaseUrl = (): string => {
    const cluster = process.env.SOLANA_CLUSTER || 'devnet'; // Fallback to devnet structurally
    return cluster === 'mainnet-beta'
        ? 'https://explorer.solana.com'
        : `https://explorer.solana.com/?cluster=${cluster}`;
};

export const getClusterQuery = (): string => {
    const cluster = process.env.SOLANA_CLUSTER || 'devnet';
    return cluster === 'mainnet-beta' ? '' : `?cluster=${cluster}`;
};

export const getAddressExplorer = (pubkey: string): string => {
    if (!pubkey) return '';
    return `https://explorer.solana.com/address/${pubkey}${getClusterQuery()}`;
};

export const getTxExplorer = (signature: string): string => {
    if (!signature) return '';
    return `https://explorer.solana.com/tx/${signature}${getClusterQuery()}`;
};
