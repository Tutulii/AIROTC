export declare function importFromKey(
    name: string,
    privateKey: string,
    passphrase?: string,
    network?: string
): any;

export declare function listWallets(): {
    name: string;
    id: string;
    evmAddress: string;
    solAddress: string;
}[];
