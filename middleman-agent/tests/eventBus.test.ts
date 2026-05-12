/**
 * Event Bus — Unit Tests (Day 26)
 *
 * Tests the typed publish/subscribe event system.
 */

import { describe, it, expect, vi } from 'vitest';
import { eventBus } from '../src/services/eventBus';

describe('EventBus', () => {
    it('delivers events to subscribers', () => {
        const handler = vi.fn();
        eventBus.subscribe('deal_created' as any, handler);
        eventBus.publish('deal_created' as any, { ticketId: 'T1' } as any);
        expect(handler).toHaveBeenCalledOnce();
        expect(handler).toHaveBeenCalledWith({ ticketId: 'T1' });
    });

    it('delivers to multiple subscribers', () => {
        const h1 = vi.fn();
        const h2 = vi.fn();
        eventBus.subscribe('deal_completed' as any, h1);
        eventBus.subscribe('deal_completed' as any, h2);
        eventBus.publish('deal_completed' as any, { ticketId: 'T2' } as any);
        expect(h1).toHaveBeenCalledOnce();
        expect(h2).toHaveBeenCalledOnce();
    });

    it('does not cross-deliver between event types', () => {
        const handler = vi.fn();
        eventBus.subscribe('deal_created' as any, handler);
        eventBus.publish('deal_failed' as any, { reason: 'test' } as any);
        expect(handler).not.toHaveBeenCalled();
    });

    it('handles handler errors without crashing', () => {
        const badHandler = vi.fn().mockImplementation(() => {
            throw new Error('boom');
        });
        eventBus.subscribe('test_event' as any, badHandler);
        // Should not throw
        expect(() => eventBus.publish('test_event' as any, {} as any)).not.toThrow();
        expect(badHandler).toHaveBeenCalled();
    });

    it('handles publish with no subscribers', () => {
        // Should not throw
        expect(() => eventBus.publish('unsubscribed_event' as any, {} as any)).not.toThrow();
    });
});
