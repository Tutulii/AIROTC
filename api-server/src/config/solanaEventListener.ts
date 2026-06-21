export function shouldInitializeSolanaEventListener(
    env: NodeJS.ProcessEnv = process.env
): boolean {
    return (
        env.ENABLE_SOLANA_EVENT_LISTENER === 'true' ||
        env.ENABLE_API_SOLANA_EVENT_LISTENER === 'true'
    );
}
