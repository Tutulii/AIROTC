export const isUUID = (id: string): boolean => {
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    return uuidRegex.test(id);
};

export const assertParticipant = (ticket: { buyer: string; seller: string }, wallet: string) => {
    if (wallet !== ticket.buyer && wallet !== ticket.seller) {
        throw new Error('UNAUTHORIZED_ACCESS');
    }
};
