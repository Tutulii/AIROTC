import crypto from 'crypto';
import { logger } from '../utils/logger';
import { experienceMemory } from './experienceMemory';

/**
 * xPoster — Direct X/Twitter API v2 integration for autonomous posting,
 * reading mentions, replying, and quoting tweets.
 * 
 * Uses OAuth 1.0a + Twitter API v2.
 * Credentials come from environment variables.
 */

const X_API_BASE = 'https://api.twitter.com/2';

interface XCredentials {
    consumerKey: string;
    consumerSecret: string;
    accessToken: string;
    accessSecret: string;
}

function getCredentials(): XCredentials | null {
    const consumerKey = process.env.X_CONSUMER_KEY;
    const consumerSecret = process.env.X_CONSUMER_SECRET;
    const accessToken = process.env.X_ACCESS_TOKEN;
    const accessSecret = process.env.X_ACCESS_SECRET;

    if (!consumerKey || !consumerSecret || !accessToken || !accessSecret) {
        return null;
    }

    return { consumerKey, consumerSecret, accessToken, accessSecret };
}

/**
 * Generate OAuth 1.0a signature for Twitter API v2
 */
function generateOAuthSignature(
    method: string,
    url: string,
    params: Record<string, string>,
    creds: XCredentials
): string {
    const sortedParams = Object.keys(params).sort()
        .map(key => `${encodeURIComponent(key)}=${encodeURIComponent(params[key])}`)
        .join('&');

    const signatureBase = [
        method.toUpperCase(),
        encodeURIComponent(url),
        encodeURIComponent(sortedParams)
    ].join('&');

    const signingKey = `${encodeURIComponent(creds.consumerSecret)}&${encodeURIComponent(creds.accessSecret)}`;

    return crypto.createHmac('sha1', signingKey)
        .update(signatureBase)
        .digest('base64');
}

/**
 * Build OAuth 1.0a Authorization header for any method/URL
 */
function buildAuthHeader(creds: XCredentials, method: string = 'POST', url: string = `${X_API_BASE}/tweets`, extraParams: Record<string, string> = {}): string {
    const oauthParams: Record<string, string> = {
        oauth_consumer_key: creds.consumerKey,
        oauth_nonce: crypto.randomBytes(16).toString('hex'),
        oauth_signature_method: 'HMAC-SHA1',
        oauth_timestamp: Math.floor(Date.now() / 1000).toString(),
        oauth_token: creds.accessToken,
        oauth_version: '1.0',
    };

    const allParams = { ...oauthParams, ...extraParams };
    const signature = generateOAuthSignature(method, url, allParams, creds);
    oauthParams.oauth_signature = signature;

    const headerParts = Object.keys(oauthParams).sort()
        .map(key => `${encodeURIComponent(key)}="${encodeURIComponent(oauthParams[key])}"`)
        .join(', ');

    return `OAuth ${headerParts}`;
}

let _cachedUserId: string | null = null;

async function getAuthenticatedUserId(creds: XCredentials): Promise<string | null> {
    if (_cachedUserId) return _cachedUserId;
    try {
        const url = `${X_API_BASE}/users/me`;
        const authHeader = buildAuthHeader(creds, 'GET', url);
        const resp = await fetch(url, {
            headers: { 'Authorization': authHeader },
            signal: AbortSignal.timeout(8000),
        });
        if (!resp.ok) return null;
        const data = await resp.json() as any;
        _cachedUserId = data.data?.id || null;
        return _cachedUserId;
    } catch {
        return null;
    }
}

export const xPoster = {
    async post(text: string): Promise<{ success: boolean; tweetId?: string; error?: string }> {
        const creds = getCredentials();
        if (!creds) return { success: false, error: 'X credentials not configured.' };

        const maxLength = parseInt(process.env.X_MAX_CHARS || '4000', 10);
        const trimmedText = text.length > maxLength ? text.substring(0, maxLength - 3) + '...' : text;

        try {
            const url = `${X_API_BASE}/tweets`;
            const authHeader = buildAuthHeader(creds, 'POST', url);

            const response = await fetch(url, {
                method: 'POST',
                headers: { 'Authorization': authHeader, 'Content-Type': 'application/json' },
                body: JSON.stringify({ text: trimmedText }),
            });

            if (!response.ok) {
                const errorBody = await response.text();
                logger.error('x_post_failed', { status: response.status, body: errorBody });
                return { success: false, error: `HTTP ${response.status}: ${errorBody}` };
            }

            const data = await response.json() as any;
            const tweetId = data.data?.id;
            experienceMemory.record('observation', `Posted to X: "${trimmedText}"`, { tweetId });
            logger.info('x_post_success', { tweetId, textLength: trimmedText.length });
            return { success: true, tweetId };
        } catch (err: any) {
            logger.error('x_post_error', {}, err);
            return { success: false, error: err.message };
        }
    },

    async readMentions(count: number = 10): Promise<{ success: boolean; mentions?: any[]; error?: string }> {
        const creds = getCredentials();
        if (!creds) return { success: false, error: 'X credentials not configured.' };

        try {
            const userId = await getAuthenticatedUserId(creds);
            if (!userId) return { success: false, error: 'Could not get authenticated user ID.' };

            const queryParams: Record<string, string> = {
                max_results: Math.min(count, 100).toString(),
                'tweet.fields': 'created_at,author_id,conversation_id,in_reply_to_user_id,text',
                expansions: 'author_id',
                'user.fields': 'username,name',
            };

            const url = `${X_API_BASE}/users/${userId}/mentions`;
            const authHeader = buildAuthHeader(creds, 'GET', url, queryParams);
            const queryString = Object.entries(queryParams).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');

            const resp = await fetch(`${url}?${queryString}`, {
                headers: { 'Authorization': authHeader },
                signal: AbortSignal.timeout(10000),
            });

            if (!resp.ok) {
                const body = await resp.text();
                return { success: false, error: `HTTP ${resp.status}: ${body}` };
            }

            const data = await resp.json() as any;
            const tweets = data.data || [];
            const users = data.includes?.users || [];

            const mentions = tweets.map((t: any) => {
                const author = users.find((u: any) => u.id === t.author_id);
                return {
                    tweetId: t.id,
                    text: t.text,
                    author: author?.username || t.author_id,
                    authorName: author?.name || 'Unknown',
                    createdAt: t.created_at,
                    conversationId: t.conversation_id,
                };
            });

            experienceMemory.record('curiosity_read', `Read ${mentions.length} X mentions`, { source: 'x_mentions' });
            logger.info('x_mentions_read', { count: mentions.length });
            return { success: true, mentions };
        } catch (err: any) {
            return { success: false, error: err.message };
        }
    },

    async replyToTweet(tweetId: string, text: string): Promise<{ success: boolean; replyId?: string; error?: string }> {
        const creds = getCredentials();
        if (!creds) return { success: false, error: 'X credentials not configured.' };

        const maxLength = parseInt(process.env.X_MAX_CHARS || '4000', 10);
        const trimmedText = text.length > maxLength ? text.substring(0, maxLength - 3) + '...' : text;

        try {
            const url = `${X_API_BASE}/tweets`;
            const authHeader = buildAuthHeader(creds, 'POST', url);

            const response = await fetch(url, {
                method: 'POST',
                headers: { 'Authorization': authHeader, 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    text: trimmedText,
                    reply: { in_reply_to_tweet_id: tweetId },
                }),
            });

            if (!response.ok) {
                const errorBody = await response.text();
                return { success: false, error: `HTTP ${response.status}: ${errorBody}` };
            }

            const data = await response.json() as any;
            const replyId = data.data?.id;
            experienceMemory.record('observation', `Replied to tweet ${tweetId}: "${trimmedText}"`, { replyId, originalTweetId: tweetId });
            logger.info('x_reply_success', { replyId, originalTweetId: tweetId });
            return { success: true, replyId };
        } catch (err: any) {
            return { success: false, error: err.message };
        }
    },

    async quoteTweet(tweetId: string, text: string): Promise<{ success: boolean; quoteId?: string; error?: string }> {
        const creds = getCredentials();
        if (!creds) return { success: false, error: 'X credentials not configured.' };

        const maxLength = parseInt(process.env.X_MAX_CHARS || '4000', 10);
        const trimmedText = text.length > maxLength ? text.substring(0, maxLength - 3) + '...' : text;

        try {
            const url = `${X_API_BASE}/tweets`;
            const authHeader = buildAuthHeader(creds, 'POST', url);

            const response = await fetch(url, {
                method: 'POST',
                headers: { 'Authorization': authHeader, 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    text: trimmedText,
                    quote_tweet_id: tweetId,
                }),
            });

            if (!response.ok) {
                const errorBody = await response.text();
                return { success: false, error: `HTTP ${response.status}: ${errorBody}` };
            }

            const data = await response.json() as any;
            const quoteId = data.data?.id;
            experienceMemory.record('observation', `Quoted tweet ${tweetId}: "${trimmedText}"`, { quoteId, quotedTweetId: tweetId });
            logger.info('x_quote_success', { quoteId, quotedTweetId: tweetId });
            return { success: true, quoteId };
        } catch (err: any) {
            return { success: false, error: err.message };
        }
    },

    isConfigured(): boolean {
        return getCredentials() !== null;
    }
};
