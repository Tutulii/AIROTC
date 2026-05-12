import { logger } from '../lib/logger';
import { Socket } from 'socket.io';
import nacl from 'tweetnacl';
import bs58 from 'bs58';

export const socketAuthenticate = async (socket: Socket, next: (err?: Error) => void) => {
    try {
        const { message, signature, wallet } = socket.handshake.auth;

        if (!message || !signature || !wallet) {
            return next(new Error('Unauthorized: Missing required authentication fields'));
        }

        // 1. Extract values and decode base58
        let signatureUint8: Uint8Array;
        let publicKeyUint8: Uint8Array;

        try {
            signatureUint8 = bs58.decode(signature);
            publicKeyUint8 = bs58.decode(wallet);
        } catch (e) {
            return next(new Error('Unauthorized: Malformed base58 encoding in signature or wallet'));
        }

        // 2. Convert message to bytes
        const messageUint8 = new TextEncoder().encode(message);

        // 3. Very signature via tweetnacl (ED25519)
        const isValid = nacl.sign.detached.verify(messageUint8, signatureUint8, publicKeyUint8);

        if (!isValid) {
            return next(new Error('Unauthorized: Invalid signature'));
        }

        // 4. Attach identity seamlessly without making heavy blocking DB queries. The agent exists conceptually in the DB by existing flow.
        socket.data.wallet = wallet;

        next();
    } catch (error: any) {
        logger.error("error");
        next(new Error('Internal Server Error during verification'));
    }
};
