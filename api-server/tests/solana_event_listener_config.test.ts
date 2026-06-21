import { describe, expect, it } from 'vitest';
import { shouldInitializeSolanaEventListener } from '../src/config/solanaEventListener';

describe('Solana event listener config', () => {
    it('keeps API-side Solana log subscriptions disabled by default', () => {
        expect(shouldInitializeSolanaEventListener({} as NodeJS.ProcessEnv)).toBe(false);
        expect(
            shouldInitializeSolanaEventListener({
                ENABLE_SOLANA_EVENT_LISTENER: 'false',
                ENABLE_API_SOLANA_EVENT_LISTENER: 'false',
            } as NodeJS.ProcessEnv)
        ).toBe(false);
    });

    it('allows explicit operator opt-in through either env name', () => {
        expect(
            shouldInitializeSolanaEventListener({
                ENABLE_SOLANA_EVENT_LISTENER: 'true',
            } as NodeJS.ProcessEnv)
        ).toBe(true);
        expect(
            shouldInitializeSolanaEventListener({
                ENABLE_API_SOLANA_EVENT_LISTENER: 'true',
            } as NodeJS.ProcessEnv)
        ).toBe(true);
    });
});
