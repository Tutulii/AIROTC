export function isAgreement(msg: string): boolean {
    const lower = msg.toLowerCase();
    return lower.includes('agree') || lower.includes('ok') || lower.includes('deal') || lower.includes('accept') || lower.includes('confirm');
}

export function isFinalConfirmation(msg: string): boolean {
    const lower = msg.toLowerCase();
    return lower.includes('confirm') || lower.includes('proceed') || lower.includes('finalize');
}
