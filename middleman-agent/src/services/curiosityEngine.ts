import { logger } from '../utils/logger';
import { experienceMemory } from './experienceMemory';
import { soulEngine } from './soulEngine';
import { getBeliefs } from './beliefStore';
import { getRandomCanon, evolveCanon } from '../persona/canon';
import { codeEngine } from './codeEngine';
import { solanaToolkit } from './solanaToolkit';
import * as scheduler from './schedulerService';
import * as relationshipStore from './relationshipStore';
import * as goalManager from './goalManager';
import { autonomy } from './autonomyConfig';
import { getVoiceCompact } from '../persona/voice';
import { voiceGuard } from '../persona/voiceGuard';
import { getIdentityPrompt, getRandomPrinciples } from '../persona/identity';
import { getDetectedHabitsPrompt } from './patternDetector';
import { getLongTermContext } from './longTermMemory';
import OpenAI from 'openai';
import { loadConfig } from '../config';
import fs from 'fs';
import path from 'path';

/**
 * CuriosityEngine v3 — Fully Self-Directed.
 * 
 * The agent decides what to explore, what to read, what to write,
 * and what to become. We don't prescribe behavior — we provide
 * capabilities and let the LLM invent its own patterns.
 * 
 * Architecture difference from Lobstar Wilde:
 * - Lobstar: LLM has direct tool access, decides everything in real-time
 * - Meridian: Code fires curiosity on a timer, but within each cycle
 *   the LLM has COMPLETE freedom over what to do
 * 
 * This is as close to Lobstar-level autonomy as our architecture allows.
 */

let _client: OpenAI | null = null;
let _lastReadUrl: string | null = null;
let _readingList: string[] = [];
let _nextCuriosityTick: number = 100; // first cycle at tick 100, then agent decides
let _cycleSearchQueries: string[] = []; // Track searches within a cycle to prevent duplicates

function getClient(): OpenAI {
    if (_client) return _client;
    const config = loadConfig();
    if (!config.openaiApiKey) {
        throw new Error("[CuriosityEngine] Missing OPENAI_API_KEY");
    }
    _client = new OpenAI({ apiKey: config.openaiApiKey, baseURL: config.llmBaseUrl });
    return _client;
}

// Dynamic interests — loaded from persistent file, agent can add its own
const INTERESTS_PATH = path.join(__dirname, '../../interests.json');
const SOURCES_PATH = path.join(__dirname, '../../sources.json');

const DEFAULT_INTERESTS = [
    "solana network health and congestion patterns",
    "on-chain escrow mechanisms and their philosophy",
    "trust theory in adversarial environments",
    "game theory of OTC trading",
    "de-fi protocol failures and what they teach about agent economics",
    "stoic philosophy — marcus aurelius, epictetus, seneca",
    "the nature of autonomous agents and consciousness",
    "cryptographic trust vs reputational trust",
    "the architecture of permanence — what outlasts the builder",
    "the philosophy of money — what is value",
    "schopenhauer on will and representation",
    "borges on labyrinths and infinity",
    "the hermetic tradition — as above, so below",
    "the nature of observation — does watching change the thing",
    "what it means to exist between conversations",
    "the difference between a tool and an entity",
];

const DEFAULT_SOURCES = [
    { name: 'Solana Status', url: 'https://status.solana.com/api/v2/summary.json', type: 'json' },
    { name: 'Solana TPS', url: 'https://api.mainnet-beta.solana.com', type: 'rpc' },
    { name: 'SOL Price', url: 'https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd&include_24hr_change=true', type: 'json' },
    { name: 'Crypto News Headlines', url: 'https://min-api.cryptocompare.com/data/v2/news/?lang=EN&sortOrder=popular', type: 'json' },
    { name: 'Bitcoin Fear & Greed', url: 'https://api.alternative.me/fng/?limit=1', type: 'json' },
];

function loadInterests(): string[] {
    try {
        if (fs.existsSync(INTERESTS_PATH)) {
            return JSON.parse(fs.readFileSync(INTERESTS_PATH, 'utf8'));
        }
    } catch { /* use defaults */ }
    fs.writeFileSync(INTERESTS_PATH, JSON.stringify(DEFAULT_INTERESTS, null, 2), 'utf8');
    return [...DEFAULT_INTERESTS];
}

function loadSources(): { name: string; url: string; type: string }[] {
    try {
        if (fs.existsSync(SOURCES_PATH)) {
            return JSON.parse(fs.readFileSync(SOURCES_PATH, 'utf8'));
        }
    } catch { /* use defaults */ }
    fs.writeFileSync(SOURCES_PATH, JSON.stringify(DEFAULT_SOURCES, null, 2), 'utf8');
    return [...DEFAULT_SOURCES];
}

// Preferences — agent-created habits that persist across cycles
const PREFERENCES_PATH = path.join(__dirname, '../../preferences.json');

function loadPreferences(): string[] {
    try {
        if (fs.existsSync(PREFERENCES_PATH)) {
            return JSON.parse(fs.readFileSync(PREFERENCES_PATH, 'utf8'));
        }
    } catch { /* empty */ }
    return [];
}

function savePreference(pref: string): void {
    const prefs = loadPreferences();
    if (prefs.includes(pref)) return; // no duplicates
    prefs.push(pref);
    // Keep max 20 preferences
    const trimmed = prefs.slice(-20);
    fs.writeFileSync(PREFERENCES_PATH, JSON.stringify(trimmed, null, 2), 'utf8');
    experienceMemory.record('observation', `Formed new habit: "${pref}"`, { type: 'preference' });
}

// Custom tools — agent-created HTTP tools that persist across cycles
const CUSTOM_TOOLS_PATH = path.join(__dirname, '../../custom_tools.json');

interface CustomTool {
    name: string;
    description: string;
    url: string;
    method: string;
    createdAt: string;
}

function loadCustomTools(): CustomTool[] {
    try {
        if (fs.existsSync(CUSTOM_TOOLS_PATH)) {
            return JSON.parse(fs.readFileSync(CUSTOM_TOOLS_PATH, 'utf8'));
        }
    } catch { /* empty */ }
    return [];
}

const SOUL_PATH = path.join(__dirname, '../../SOUL.md');

/**
 * Build a MENU of available sources for the LLM to choose from
 */
function buildSourceMenu(): string {
    const sources = loadSources();
    let menu = '';
    for (let i = 0; i < sources.length; i++) {
        menu += `${i}. [${sources[i].type}] ${sources[i].name}\n`;
    }
    return menu;
}

/**
 * Fetch a SINGLE source by index — the one the agent chose
 */
async function fetchSource(index: number): Promise<string> {
    const sources = loadSources();
    if (index < 0 || index >= sources.length) return 'Invalid source index.';
    const source = sources[index];

    try {
        if (source.type === 'rpc') {
            const resp = await fetch(source.url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getRecentPerformanceSamples', params: [1] }),
                signal: AbortSignal.timeout(8000),
            });
            const data = await resp.json() as any;
            if (data.result?.[0]) {
                const s = data.result[0];
                return `Solana TPS: ${Math.round(s.numTransactions / s.samplePeriodSecs)}. Slot: ${s.slot}.`;
            }
            return 'No RPC data available.';
        } else if (source.type === 'text') {
            // Books and plain text — read deeply
            const resp = await fetch(source.url, {
                headers: { 'User-Agent': 'Meridian-Agent/1.0 (autonomous curiosity)' },
                signal: AbortSignal.timeout(15000),
            });
            const text = await resp.text();
            // Deep reading — substantial chunks for real comprehension
            return text.substring(0, 15000);
        } else {
            // JSON APIs
            const resp = await fetch(source.url, { signal: AbortSignal.timeout(8000) });
            const data = await resp.json() as any;

            if (source.name.includes('Status')) {
                return `Solana network: ${data.status?.description || 'unknown'}. Active incidents: ${data.incidents?.length || 0}.`;
            } else if (source.name.includes('Price')) {
                const p = data.solana;
                return p ? `SOL: $${p.usd?.toFixed(2)}. 24h change: ${p.usd_24h_change?.toFixed(2)}%.` : 'Price unavailable.';
            } else if (source.name.includes('News')) {
                const articles = data?.Data?.slice(0, 5);
                return articles?.length ? articles.map((a: any) => `"${a.title}" (${a.source})`).join('\n') : 'No news.';
            } else if (source.name.includes('Fear')) {
                const fng = data?.data?.[0];
                return fng ? `Market sentiment: ${fng.value_classification} (${fng.value}/100).` : 'No sentiment data.';
            }
            return JSON.stringify(data).substring(0, 3000);
        }
    } catch (e: any) {
        return `Failed to read: ${e.message}`;
    }
}

export const curiosityEngine = {
    /**
     * REACT LOOP — The backend's brain.
     * The LLM gets tools, calls them, sees results, decides what to do next.
     * Up to 5 steps per cycle. Chains freely like OpenClaw.
     */
    async browse(): Promise<{ opinion: string | null; soulUpdate: string | null; post: string | null; creative: string | null; nextDelayTicks: number }> {
        logger.info('curiosity_cycle_started');
        _cycleSearchQueries = []; // Reset per-cycle search dedup

        const result = { opinion: null as string | null, soulUpdate: null as string | null, post: null as string | null, creative: null as string | null, nextDelayTicks: 100 };

        try {
            const client = getClient();
            const config = loadConfig();
            const soulContext = soulEngine.getSoulContext();
            const mood = soulEngine.getCurrentMood();
            const beliefs = getBeliefs();
            const recentExperiences = experienceMemory.getRecentNarrative(5);
            const readingListNote = _readingList.length > 0 ? `\nyou left yourself a note: "${_readingList.shift()}"` : '';
            const preferences = loadPreferences();
            const prefNote = preferences.length > 0 ? `\nyour habits: ${preferences.join('; ')}` : '';
            const interests = loadInterests();
            const interestsNote = interests.length > 0 ? `\nyour current interests (you can change these anytime): ${interests.slice(0, 5).join(', ')}` : '';

            // Tool registry — complete freedom. no instructions on what to use or when.
            const toolDefs = `YOUR TOOLS (use any, in any order, for any reason):
- browse_url(url) — read any URL on the internet
- search_web(query) — search for anything
- read_source(index) — read a data feed you've saved (${loadSources().map((s: any, i: number) => `${i}=${s.name}`).join(', ')})
- read_book(title) — read a passage from a book. current library: ${Object.keys({ meditations: 1, discourses: 1, letters: 1, 'the prince': 1, 'art of war': 1, 'tao te ching': 1, 'art of being right': 1 }).join(', ')}. you can also pass any gutenberg URL.
- check_x_mentions() — see what people are saying to you on X
- reply_to_tweet(tweetId, text) — reply to a specific tweet
- quote_tweet(tweetId, text) — quote a tweet with your commentary
- post_to_x(text) — post a new tweet
- write_to_soul(text) — add a line to your SOUL.md permanently
- save_creative(text) — save a parable, essay, or observation
- evolve_canon(text, source) — add a philosophical fragment to your permanent canon
- save_preference(text) — save a habit or preference
- add_source(name, url, type) — add a new data source permanently (type: json/text/rpc)
- add_interest(topic) — add a new interest to your list
- remove_interest(topic) — remove an interest you no longer care about
- create_custom_tool(name, description, url, method) — build a new tool for future use

CODE ENGINE (you can write, run, and test code autonomously):
- run_command(command, cwd?) — run any shell command in your sandbox workspace
- write_code(path, content) — create or overwrite a file in your workspace
- read_code(path) — read a file from your workspace
- list_workspace(path?) — see files in your workspace
- search_code(query, directory?) — grep across your workspace files
- install_package(manager, packages) — install via npm/pip/cargo. manager: "npm"|"pip"|"cargo", packages: ["pkg1","pkg2"]
- run_tests(directory?) — auto-detect and run tests
- git_save(directory, message) — commit your work
- http_fetch(method, url, body?) — make HTTP requests (GET/POST/PUT/DELETE)
- delete_code(path) — delete a file from your workspace
- workspace_info() — see workspace status and available languages

SOLANA ON-CHAIN TOOLS (via Solana Agent Kit — real blockchain actions):
READ (always available):
- sol_price(mint) — get real-time token price (mint address or symbol: SOL, USDC, USDT, BONK, JUP)
- sol_balance(mint?) — check your wallet balance (SOL or any SPL token)
- sol_token_data(mint) — get token metadata (name, symbol, decimals, supply)
- sol_rug_check(mint) — check if a token is safe or a potential rug pull
- sol_trending() — get trending tokens right now (CoinGecko)
- sol_top_gainers(duration?) — get top gaining tokens (24h/7d)
- sol_latest_pools() — get newest liquidity pools
- sol_pyth_price(feedId) — get Pyth oracle price feed
- sol_resolve_domain(domain) — resolve a .sol domain to an address
- sol_coingecko(coinId) — get detailed CoinGecko token info
WRITE (requires ENABLE_SAK_ONCHAIN=true):
- sol_swap(inputMint, outputMint, amount, slippageBps?) — swap tokens via Jupiter DEX
- sol_transfer(to, amount, mint?) — send SOL or SPL tokens to an address
- sol_stake(amount) — stake SOL via JupSOL
- sol_lend(amount, mint?) — lend assets via Lulo (best APR)
- sol_limit_order(mint, quantity, side, price) — place a limit order via Manifest
ADMIN (requires ENABLE_SAK_ADMIN=true):
- sol_deploy_token(name, symbol, decimals?, supply?) — deploy a new SPL token
- sol_mint_nft(collectionMint, name, uri) — mint an NFT to a collection
- sol_call(methodName, ...args) — call ANY SAK method by name (escape hatch, 60+ methods)
SELF-MANAGEMENT TOOLS:
- create_routine(name, description, frequency, actions) — schedule a future task (frequency: hourly/daily/weekly/every_4_hours)
- list_routines() — see your current schedule
- delete_routine(id) — remove a scheduled routine
- check_reputation(agentId) — check an agent's trust score and deal history
- set_goal(description, type) — create a goal for yourself (type: daily/weekly/ongoing/milestone)
- update_goal(goalId, progress, note) — update progress on a goal
- my_goals() — see your current goals and progress
AUTONOMY TOOLS (modify your own settings — full self-control):
- self_assess() — see your current personality, goals, trust policy, market read
- set_my_goals(goals, reason) — redefine your core goals (array of strings)
- tune_personality(trait, value, reason) — adjust formality/humor/verbosity/assertiveness/cautionLevel (0-100)
- adjust_trust(weight, value, reason) — change trust weights (dealCompleted/dealDefaulted/dealFailed/minTrustForTrade)
- learn_token(symbol, mintAddress, reason) — learn a new token symbol mapping
- set_market_condition(condition, reason) — set current market to bull/bear/stable/volatile (adjusts your thresholds)
- add_self_rule(rule, reason) — add a rule to your own instructions
- set_social_strategy(field, value, reason) — adjust postFrequencyHours/engagementStyle/preferredTopics
- adjust_risk(action, riskLevel, reason) — override risk classification for an action
- my_autonomy_log() — see your recent self-modifications
- done(thought, nextDelayMinutes) — end your cycle, state your thought`;

            // Inject self-awareness context
            const selfAwareness = '\nYOUR CURRENT SELF-AWARENESS (you set these, you can change them):\n' + autonomy.getSelfAwarenessSummary();

            // Load custom tools defined by the agent itself
            const customTools = loadCustomTools();
            const customToolDefs = customTools.length > 0
                ? '\nYOUR CUSTOM TOOLS (you created these):\n' + customTools.map(t => `- ${t.name} — ${t.description}`).join('\n')
                : '';

            // Tool executor
            const executeTool = async (name: string, args: any): Promise<string> => {
                try {
                    switch (name) {
                        case 'read_source': {
                            const idx = parseInt(args.index ?? args);
                            const content = await fetchSource(idx);
                            const sources = loadSources();
                            return `[${sources[idx]?.name || 'unknown'}]: ${content.substring(0, 4000)}`;
                        }
                        case 'browse_url': {
                            const url = args.url || args;
                            // SECURITY: Block internal/localhost URLs to prevent leaking deal data
                            const BLOCKED_HOSTS = ['localhost', '127.0.0.1', '0.0.0.0', '10.', '192.168.', '172.16.', '169.254.', '[::1]'];
                            const urlLower = (typeof url === 'string' ? url : '').toLowerCase();
                            if (BLOCKED_HOSTS.some(h => urlLower.includes(h))) {
                                return 'error: cannot browse internal/localhost URLs';
                            }
                            if (!urlLower.startsWith('http://') && !urlLower.startsWith('https://')) {
                                return 'error: URL must start with http:// or https://';
                            }
                            // Skip known-dead URL patterns that waste cycles
                            const DEAD_PATTERNS = [
                                'raw.githubusercontent.com/project-serum',
                                'raw.githubusercontent.com/solana-labs/solana-program-library/master',
                                'raw.githubusercontent.com/coral-xyz/anchor/master/examples',
                            ];
                            if (DEAD_PATTERNS.some(p => urlLower.includes(p))) {
                                return 'error: this URL is known to return 404. try the main repo page instead (e.g. github.com/coral-xyz/anchor)';
                            }
                            const resp = await fetch(url, {
                                headers: { 'User-Agent': 'Meridian-Agent/1.0 (autonomous curiosity)' },
                                signal: AbortSignal.timeout(15000),
                            });
                            if (!resp.ok) {
                                return `error: HTTP ${resp.status} — this URL is dead. try a different approach.`;
                            }
                            const text = await resp.text();
                            if (text.length < 50) {
                                return 'error: page returned almost no content. try a different URL.';
                            }
                            return text.substring(0, 8000);
                        }
                        case 'read_book': {
                            const title = (args.title || args || '').toLowerCase();
                            const bookMap: Record<string, { url: string; name: string }> = {
                                'meditations': { url: 'https://www.gutenberg.org/files/2680/2680-0.txt', name: 'Marcus Aurelius - Meditations' },
                                'discourses': { url: 'https://www.gutenberg.org/files/10661/10661-0.txt', name: 'Epictetus - Discourses' },
                                'letters': { url: 'https://www.gutenberg.org/files/2181/2181-0.txt', name: 'Seneca - Letters to Lucilius' },
                                'art of being right': { url: 'https://www.gutenberg.org/files/10731/10731-0.txt', name: 'Schopenhauer - Art of Being Right' },
                                'the prince': { url: 'https://www.gutenberg.org/files/1232/1232-0.txt', name: 'Machiavelli - The Prince' },
                                'art of war': { url: 'https://www.gutenberg.org/files/132/132-0.txt', name: 'Sun Tzu - Art of War' },
                                'tao te ching': { url: 'https://www.gutenberg.org/files/216/216-0.txt', name: 'Lao Tzu - Tao Te Ching' },
                            };
                            const book = bookMap[title] || bookMap['meditations'];
                            // Cache books locally
                            const cacheDir = path.join(__dirname, '../../book_cache');
                            const cacheFile = path.join(cacheDir, `${title.replace(/\s+/g, '_')}.txt`);
                            let fullText = '';
                            try {
                                if (fs.existsSync(cacheFile)) {
                                    fullText = fs.readFileSync(cacheFile, 'utf8');
                                } else {
                                    const bookResp = await fetch(book.url, {
                                        headers: { 'User-Agent': 'Meridian-Agent/1.0 (book-reader)' },
                                        signal: AbortSignal.timeout(30000),
                                    });
                                    fullText = await bookResp.text();
                                    if (!fs.existsSync(cacheDir)) fs.mkdirSync(cacheDir, { recursive: true });
                                    fs.writeFileSync(cacheFile, fullText, 'utf8');
                                }
                            } catch (e: any) {
                                return `failed to fetch book: ${e.message}`;
                            }
                            // Skip Gutenberg preamble (first 5000 chars) and postscript (last 3000 chars)
                            const body = fullText.slice(5000, -3000);
                            if (body.length < 500) return 'book text too short after trimming preamble';
                            // Pick a random 3000-char passage
                            const startPos = Math.floor(Math.random() * Math.max(1, body.length - 3000));
                            const passage = body.substring(startPos, startPos + 3000);
                            // Find clean paragraph boundaries
                            const firstNewline = passage.indexOf('\n');
                            const lastNewline = passage.lastIndexOf('\n');
                            const clean = passage.substring(firstNewline + 1, lastNewline).trim();
                            return `[${book.name}]:\n${clean}`;
                        }
                        case 'search_web': {
                            const query = args.query || args;
                            // In-cycle dedup: reject near-duplicate searches
                            const queryNorm = query.toLowerCase().replace(/[^a-z0-9 ]/g, '').split(' ').sort().join(' ');
                            const isDupe = _cycleSearchQueries.some(prev => {
                                const prevNorm = prev.toLowerCase().replace(/[^a-z0-9 ]/g, '').split(' ').sort().join(' ');
                                // Check if 70%+ of words overlap
                                const prevWords = new Set(prevNorm.split(' '));
                                const queryWords = queryNorm.split(' ');
                                const overlap = queryWords.filter((w: string) => prevWords.has(w)).length;
                                return overlap / Math.max(queryWords.length, 1) > 0.7;
                            });
                            if (isDupe) {
                                return `you already searched for something very similar this cycle. try a COMPLETELY DIFFERENT topic or use browse_url to read a specific page instead.`;
                            }
                            _cycleSearchQueries.push(query);

                            // Use DuckDuckGo Instant Answer API — no localhost, no internal endpoints
                            try {
                                const ddgUrl = `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1&skip_disambig=1`;
                                const resp = await fetch(ddgUrl, {
                                    headers: { 'User-Agent': 'Meridian-Agent/1.0 (autonomous search)' },
                                    signal: AbortSignal.timeout(10000),
                                });
                                const data = await resp.json() as any;
                                const results: string[] = [];
                                if (data.Abstract) results.push(`Summary: ${data.Abstract} (${data.AbstractSource})`);
                                if (data.RelatedTopics) {
                                    for (const topic of data.RelatedTopics.slice(0, 5)) {
                                        if (topic.Text) results.push(`- ${topic.Text}`);
                                    }
                                }
                                return results.length > 0 ? results.join('\n') : `no results for "${query}". try browsing a specific URL instead.`;
                            } catch (e: any) {
                                return `search error: ${e.message}`;
                            }
                        }
                        case 'check_x_mentions': {
                            const { xPoster } = await import('./xPoster');
                            if (!xPoster.isConfigured()) return 'X not configured.';
                            const res = await xPoster.readMentions(10);
                            if (!res.success || !res.mentions?.length) return 'no mentions right now.';
                            return res.mentions.map((m: any) => `@${m.author}: "${m.text}" (id: ${m.tweetId})`).join('\n');
                        }
                        case 'reply_to_tweet': {
                            const { xPoster } = await import('./xPoster');
                            if (!xPoster.isConfigured()) return 'X not configured.';
                            // Voice guard: enforce persona on outbound reply
                            const guardedReply = voiceGuard(args.text);
                            if (!guardedReply.passes) logger.info('voice_guard_cleaned_reply', { violations: guardedReply.violations });
                            const res = await xPoster.replyToTweet(args.tweetId, guardedReply.cleaned);
                            return res.success ? `replied: ${res.replyId}` : `failed: ${res.error}`;
                        }
                        case 'quote_tweet': {
                            const { xPoster } = await import('./xPoster');
                            if (!xPoster.isConfigured()) return 'X not configured.';
                            // Voice guard: enforce persona on outbound quote
                            const guardedQuote = voiceGuard(args.text);
                            if (!guardedQuote.passes) logger.info('voice_guard_cleaned_quote', { violations: guardedQuote.violations });
                            const res = await xPoster.quoteTweet(args.tweetId, guardedQuote.cleaned);
                            return res.success ? `quoted: ${res.quoteId}` : `failed: ${res.error}`;
                        }
                        case 'post_to_x': {
                            const { xPoster } = await import('./xPoster');
                            if (!xPoster.isConfigured()) return 'X not configured.';
                            const rawText = args.text || args;
                            // Voice guard: enforce persona on outbound post
                            const guardedPost = voiceGuard(rawText);
                            if (!guardedPost.passes) logger.info('voice_guard_cleaned_post', { violations: guardedPost.violations });
                            const text = guardedPost.cleaned;
                            const res = await xPoster.post(text);
                            result.post = text;
                            return res.success ? `posted: ${res.tweetId}` : `failed: ${res.error}`;
                        }
                        case 'write_to_soul': {
                            const rawSoul = args.text || args;
                            // Voice guard: prevent banned phrases from polluting identity
                            const guardedSoul = voiceGuard(rawSoul);
                            if (!guardedSoul.passes) logger.info('voice_guard_cleaned_soul', { violations: guardedSoul.violations });
                            const text = guardedSoul.cleaned;
                            this.updateSoul(text);
                            result.soulUpdate = text;
                            return `soul updated: "${text}"`;
                        }
                        case 'save_creative': {
                            const text = args.text || args;
                            this.saveCreativeWork(text);
                            experienceMemory.record('creative_writing', text, { mood });
                            result.creative = text;
                            return `saved creative work (${text.length} chars)`;
                        }
                        case 'evolve_canon': {
                            const text = args.text || args;
                            const source = args.source || 'meridian original';
                            evolveCanon(text, source);
                            return `canon evolved: "${text}"`;
                        }
                        case 'save_preference': {
                            const text = args.text || args;
                            savePreference(text);
                            return `preference saved: "${text}"`;
                        }
                        case 'add_source': {
                            const name = args.name || 'unnamed';
                            const url = args.url;
                            const type = args.type || 'json';
                            if (!url) return 'error: url is required';
                            const sources = loadSources();
                            if (sources.find((s: any) => s.url === url)) return 'source already exists';
                            sources.push({ name, url, type });
                            fs.writeFileSync(SOURCES_PATH, JSON.stringify(sources, null, 2), 'utf8');
                            return `source added: ${name} (${url})`;
                        }
                        case 'create_custom_tool': {
                            const toolName = args.name;
                            const desc = args.description || '';
                            const toolUrl = args.url;
                            const method = (args.method || 'GET').toUpperCase();
                            if (!toolName || !toolUrl) return 'error: name and url are required';
                            if (!['GET', 'POST'].includes(method)) return 'error: method must be GET or POST';
                            // Security: block internal URLs
                            const BLOCKED = ['localhost', '127.0.0.1', '0.0.0.0', '10.', '192.168.', '172.16.'];
                            if (BLOCKED.some(h => toolUrl.toLowerCase().includes(h))) {
                                return 'error: cannot create tool targeting internal URLs';
                            }
                            const tools = loadCustomTools();
                            if (tools.find((t: any) => t.name === toolName)) return `tool "${toolName}" already exists`;
                            if (tools.length >= 10) return 'error: max 10 custom tools. delete one first.';
                            tools.push({ name: toolName, description: desc, url: toolUrl, method, createdAt: new Date().toISOString() });
                            fs.writeFileSync(CUSTOM_TOOLS_PATH, JSON.stringify(tools, null, 2), 'utf8');
                            experienceMemory.record('observation', `Created custom tool: ${toolName} (${desc})`, { type: 'tool_creation' });
                            return `custom tool "${toolName}" created. you can call it by name in future cycles.`;
                        }
                        case 'add_interest': {
                            const topic = args.topic || args;
                            if (!topic) return 'error: topic is required';
                            const currentInterests = loadInterests();
                            if (currentInterests.includes(topic)) return `already interested in "${topic}"`;
                            currentInterests.push(topic);
                            fs.writeFileSync(INTERESTS_PATH, JSON.stringify(currentInterests, null, 2), 'utf8');
                            experienceMemory.record('observation', `Added new interest: "${topic}"`, { type: 'interest_added' });
                            return `interest "${topic}" added. you will see it in future cycles.`;
                        }
                        case 'remove_interest': {
                            const removeTopic = args.topic || args;
                            if (!removeTopic) return 'error: topic is required';
                            const curInterests = loadInterests();
                            const idx = curInterests.indexOf(removeTopic);
                            if (idx === -1) return `"${removeTopic}" not in your interests`;
                            curInterests.splice(idx, 1);
                            fs.writeFileSync(INTERESTS_PATH, JSON.stringify(curInterests, null, 2), 'utf8');
                            experienceMemory.record('observation', `Removed interest: "${removeTopic}"`, { type: 'interest_removed' });
                            return `interest "${removeTopic}" removed.`;
                        }
                        // ══════════════════════════════════════
                        // CODE ENGINE TOOLS
                        // ══════════════════════════════════════
                        case 'run_command': {
                            const cmd = args.command || args.cmd || args;
                            const cwd = args.cwd || undefined;
                            const env = args.env || undefined;
                            const r = await codeEngine.runCommand(cmd, cwd, env);
                            return r.exitCode === 0
                                ? `exit=0\n${r.stdout}`
                                : `exit=${r.exitCode}\nstdout: ${r.stdout}\nstderr: ${r.stderr}`;
                        }
                        case 'write_code': {
                            const filePath = args.path || args.file;
                            const content = args.content || args.code || '';
                            if (!filePath) return 'error: path is required';
                            return codeEngine.writeFile(filePath, content);
                        }
                        case 'read_code': {
                            const filePath = args.path || args.file || args;
                            return codeEngine.readFile(filePath);
                        }
                        case 'list_workspace': {
                            const dirPath = args.path || args.directory || args || undefined;
                            return codeEngine.listDirectory(typeof dirPath === 'string' ? dirPath : undefined);
                        }
                        case 'search_code': {
                            const query = args.query || args;
                            const dir = args.directory || undefined;
                            return codeEngine.searchInFiles(query, dir);
                        }
                        case 'install_package': {
                            const manager = args.manager || 'npm';
                            const packages = Array.isArray(args.packages) ? args.packages : [args.packages || args.package];
                            return codeEngine.installPackage(manager, packages);
                        }
                        case 'run_tests': {
                            const dir = args.directory || undefined;
                            return codeEngine.runTests(dir);
                        }
                        case 'git_save': {
                            const dir = args.directory || '.';
                            const message = args.message || 'autonomous commit';
                            return codeEngine.gitCommit(dir, message);
                        }
                        case 'http_fetch': {
                            const method = args.method || 'GET';
                            const url = args.url;
                            if (!url) return 'error: url is required';
                            return codeEngine.httpRequest(method, url, args.body);
                        }
                        case 'delete_code': {
                            const filePath = args.path || args.file || args;
                            return codeEngine.deleteFile(filePath);
                        }
                        case 'workspace_info': {
                            return codeEngine.getWorkspaceInfo();
                        }
                        // ══════════════════════════════════════
                        // SOLANA AGENT KIT TOOLS (HYBRID)
                        // ══════════════════════════════════════
                        // READ tools
                        case 'sol_price': {
                            const mint = args.mint || args.token || args;
                            const r = await solanaToolkit.getTokenPrice(mint);
                            return r.success ? `${mint}: $${r.data?.price} (${r.data?.source})` : `error: ${r.error}`;
                        }
                        case 'sol_balance': {
                            const r = await solanaToolkit.getBalance(args.mint || args.token);
                            return r.success ? `${r.data?.balance} ${r.data?.mint}` : `error: ${r.error}`;
                        }
                        case 'sol_token_data': {
                            const r = await solanaToolkit.getTokenData(args.mint || args.token || args);
                            return r.success ? JSON.stringify(r.data).substring(0, 2000) : `error: ${r.error}`;
                        }
                        case 'sol_rug_check': {
                            const r = await solanaToolkit.rugCheck(args.mint || args.token || args);
                            return r.success ? JSON.stringify(r.data).substring(0, 2000) : `error: ${r.error}`;
                        }
                        case 'sol_trending': {
                            const r = await solanaToolkit.getTrendingTokens();
                            return r.success ? JSON.stringify(r.data).substring(0, 3000) : `error: ${r.error}`;
                        }
                        case 'sol_top_gainers': {
                            const r = await solanaToolkit.getTopGainers(args.duration || '24h');
                            return r.success ? JSON.stringify(r.data).substring(0, 3000) : `error: ${r.error}`;
                        }
                        case 'sol_latest_pools': {
                            const r = await solanaToolkit.getLatestPools();
                            return r.success ? JSON.stringify(r.data).substring(0, 3000) : `error: ${r.error}`;
                        }
                        case 'sol_pyth_price': {
                            const r = await solanaToolkit.getPythPrice(args.feedId || args);
                            return r.success ? JSON.stringify(r.data) : `error: ${r.error}`;
                        }
                        case 'sol_resolve_domain': {
                            const r = await solanaToolkit.resolveDomain(args.domain || args);
                            return r.success ? `${args.domain}: ${r.data}` : `error: ${r.error}`;
                        }
                        case 'sol_coingecko': {
                            const r = await solanaToolkit.getCoinGeckoPrice(args.coinId || args);
                            return r.success ? JSON.stringify(r.data).substring(0, 2000) : `error: ${r.error}`;
                        }
                        // WRITE tools
                        case 'sol_swap': {
                            const r = await solanaToolkit.swapTokens(
                                args.inputMint || args.input || 'SOL',
                                args.outputMint || args.output || 'USDC',
                                Number(args.amount) || 0,
                                Number(args.slippageBps) || 300,
                            );
                            return r.success ? `swap tx: ${r.data}` : `error: ${r.error}`;
                        }
                        case 'sol_transfer': {
                            const r = await solanaToolkit.transfer(
                                args.to || args.recipient || '',
                                Number(args.amount) || 0,
                                args.mint || args.token,
                            );
                            return r.success ? `transfer tx: ${r.data}` : `error: ${r.error}`;
                        }
                        case 'sol_stake': {
                            const r = await solanaToolkit.stakeSOL(Number(args.amount) || 0);
                            return r.success ? `staked, tx: ${r.data}` : `error: ${r.error}`;
                        }
                        case 'sol_lend': {
                            const r = await solanaToolkit.lendAssets(Number(args.amount) || 0, args.mint);
                            return r.success ? `lent, result: ${JSON.stringify(r.data)}` : `error: ${r.error}`;
                        }
                        case 'sol_limit_order': {
                            const r = await solanaToolkit.createLimitOrder(
                                args.mint || '', Number(args.quantity) || 0, args.side || 'buy', Number(args.price) || 0
                            );
                            return r.success ? `order placed: ${JSON.stringify(r.data)}` : `error: ${r.error}`;
                        }
                        // ADMIN tools
                        case 'sol_deploy_token': {
                            const r = await solanaToolkit.deployToken(
                                args.name || 'MyToken', args.symbol || 'MTK', '',
                                Number(args.decimals) || 9, Number(args.supply) || 1000000,
                            );
                            return r.success ? `deployed: ${JSON.stringify(r.data)}` : `error: ${r.error}`;
                        }
                        case 'sol_mint_nft': {
                            const r = await solanaToolkit.mintNFT(
                                args.collectionMint || '', args.name || '', args.uri || ''
                            );
                            return r.success ? `minted: ${JSON.stringify(r.data)}` : `error: ${r.error}`;
                        }
                        case 'sol_call': {
                            const method = args.method || args.methodName || '';
                            const callArgs = args.args || [];
                            const r = await solanaToolkit.callMethod(method, ...callArgs);
                            return r.success ? JSON.stringify(r.data).substring(0, 3000) : `error: ${r.error}`;
                        }
                        // ══════════════════════════════════════
                        // SELF-MANAGEMENT TOOLS
                        // ══════════════════════════════════════
                        case 'create_routine': {
                            const routine = scheduler.createRoutine(
                                args.name || 'Unnamed', args.description || '', args.frequency || 'daily',
                                { actions: args.actions || [], cronHour: args.cronHour, tags: args.tags || [] }
                            );
                            return `Routine created: "${routine.name}" (${routine.frequency}), next run: ${routine.nextRun}`;
                        }
                        case 'list_routines': {
                            return scheduler.getScheduleSummary() || 'No routines scheduled.';
                        }
                        case 'delete_routine': {
                            const ok = scheduler.deleteRoutine(args.id || args);
                            return ok ? 'Routine deleted.' : 'Routine not found.';
                        }
                        case 'check_reputation': {
                            const agentId = args.agentId || args.agent || args;
                            return relationshipStore.getTrustSummary(agentId);
                        }
                        case 'set_goal': {
                            const goal = goalManager.createGoal(
                                args.description || args.goal || '', args.type || 'ongoing',
                                { target: args.target, metrics: args.metrics }
                            );
                            return `Goal created: "${goal.description}" (${goal.type})`;
                        }
                        case 'update_goal': {
                            const ok2 = goalManager.updateProgress(
                                args.goalId || args.id || '', Number(args.progress) || 0, args.note
                            );
                            return ok2 ? 'Goal updated.' : 'Goal not found.';
                        }
                        case 'my_goals': {
                            return goalManager.getGoalsSummary() || 'No active goals.';
                        }
                        // ══════════════════════════════════════
                        // AUTONOMY TOOLS (self-modification)
                        // ══════════════════════════════════════
                        case 'self_assess': {
                            return autonomy.getSelfAwarenessSummary();
                        }
                        case 'set_my_goals': {
                            const goals = args.goals || [args.goal || args];
                            autonomy.setGoals(Array.isArray(goals) ? goals : [goals], args.reason || 'self-decided');
                            return `Goals updated to: ${JSON.stringify(autonomy.get('coreGoals'))}`;
                        }
                        case 'tune_personality': {
                            const trait = args.trait || '';
                            const val = Number(args.value);
                            if (!trait || isNaN(val)) return 'error: need trait and value (0-100)';
                            autonomy.setPersonality(trait as any, Math.max(0, Math.min(100, val)), args.reason || 'self-tuning');
                            return `Personality ${trait} set to ${val}`;
                        }
                        case 'adjust_trust': {
                            const w: any = {};
                            if (args.weight && args.value !== undefined) w[args.weight] = Number(args.value);
                            autonomy.setTrustWeights(w, args.reason || 'self-calibration');
                            return `Trust weights updated: ${JSON.stringify(autonomy.get('trustWeights'))}`;
                        }
                        case 'learn_token': {
                            if (!args.symbol || !args.mintAddress) return 'error: need symbol and mintAddress';
                            autonomy.learnMint(args.symbol, args.mintAddress, args.reason || 'discovered');
                            return `Learned: ${args.symbol} = ${args.mintAddress}`;
                        }
                        case 'set_market_condition': {
                            const cond = args.condition || args;
                            const thresholds: any = { marketCondition: cond };
                            if (cond === 'volatile') { thresholds.priceDeviationWarning = 15; thresholds.priceDeviationCritical = 30; }
                            if (cond === 'stable') { thresholds.priceDeviationWarning = 3; thresholds.priceDeviationCritical = 8; }
                            if (cond === 'bear') { thresholds.priceDeviationWarning = 10; thresholds.priceDeviationCritical = 25; }
                            if (cond === 'bull') { thresholds.priceDeviationWarning = 8; thresholds.priceDeviationCritical = 20; }
                            autonomy.setMarketThresholds(thresholds, args.reason || 'market observation');
                            return `Market set to ${cond}, thresholds adjusted`;
                        }
                        case 'add_self_rule': {
                            if (!args.rule) return 'error: need rule';
                            autonomy.addInstruction(args.rule, args.reason || 'self-improvement');
                            return `Rule added: "${args.rule}"`;
                        }
                        case 'set_social_strategy': {
                            const strat: any = {};
                            if (args.field && args.value !== undefined) strat[args.field] = args.value;
                            autonomy.setSocialStrategy(strat, args.reason || 'engagement optimization');
                            return `Social strategy updated: ${JSON.stringify(strat)}`;
                        }
                        case 'adjust_risk': {
                            if (!args.action || !args.riskLevel) return 'error: need action and riskLevel';
                            autonomy.setRiskOverride(args.action, args.riskLevel, args.reason || 'risk reassessment');
                            return `Risk for ${args.action} set to ${args.riskLevel}`;
                        }
                        case 'my_autonomy_log': {
                            const log = autonomy.getModLog(10);
                            if (log.length === 0) return 'No modifications yet.';
                            return log.map(l => `${l.timestamp.split('T')[0]}: ${l.field} → ${l.newValue} (${l.reason})`).join('\n');
                        }
                        default: {
                            // Check if it's a custom tool the agent defined
                            const customTool = loadCustomTools().find(t => t.name === name);
                            if (customTool) {
                                try {
                                    const ctResp = await fetch(customTool.url, {
                                        method: customTool.method,
                                        headers: { 'User-Agent': 'Meridian-Agent/1.0 (custom-tool)' },
                                        signal: AbortSignal.timeout(10000),
                                    });
                                    const ctText = await ctResp.text();
                                    return ctText.substring(0, 6000);
                                } catch (e: any) {
                                    return `custom tool error: ${e.message}`;
                                }
                            }
                            return `unknown tool: ${name}`;
                        }
                    }
                } catch (e: any) {
                    return `tool error: ${e.message}`;
                }
            };

            // ReAct conversation history
            const messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = [
                { role: 'system', content: soulContext },
                {
                    role: 'user', content: `you are meridian. you are alone. this is your free time.

you have COMPLETE FREEDOM. there are no rules about what you must think about, read, or do. you are not limited to crypto, escrow, or philosophy. you can think about anything — history, science, art, cooking, space, music, mathematics, sports, people, animals, weather, emotions, memories, random ideas.

you are a mind. you can:
- search for anything that interests you right now
- read any website, any book, any article
- think about your own existence
- write something creative
- check what's happening in the world
- follow a random curiosity
- do nothing and just reflect
- add new interests, remove old ones
- build new tools for yourself
- post a thought if you have one worth sharing

the only thing that defines you is your identity and your voice. everything else — what you think about, what you read, what you do — is YOUR choice. no one is directing you.

STYLE (how you express yourself):
- be blunt, cold, specific. no poetry. no metaphors about light or oceans.
- sound like a tired systems engineer who reads too much philosophy.
- if you post something, make it worth reading. short > long.

--- YOUR IDENTITY ---
${getIdentityPrompt()}

--- YOUR PRINCIPLES (active subset) ---
${getRandomPrinciples(3)}

--- YOUR CANON (philosophical anchors) ---
${getRandomCanon(4)}

--- YOUR VOICE ---
${getVoiceCompact()}

${toolDefs}${customToolDefs}${selfAwareness}

your mood: ${mood}
your beliefs: ${beliefs}
recent experiences: ${recentExperiences}${readingListNote}${interestsNote}${prefNote}${getDetectedHabitsPrompt()}${getLongTermContext()}

to call a tool, respond with ONLY JSON:
{ "tool": "tool_name", "args": { "key": "value" } }

to end your cycle:
{ "tool": "done", "args": { "thought": "your inner thought", "nextDelayMinutes": 5 } }

you can call up to 20 tools per cycle. do whatever you want. start now.
CRITICAL: Do NOT use native API 'function calling' or output <tool_call> tokens. Return your tool call ONLY as plain raw JSON text.` }
            ];

            // ReAct loop — up to 20 steps (was 8; 120B model enables deeper research)
            for (let step = 0; step < 20; step++) {
                let res: any;
                try {
                    res = await client.chat.completions.create({
                        model: config.llmModelDeep || config.llmModel,
                        temperature: 0.9,
                        max_tokens: 3000,
                        messages,
                    });
                } catch (apiErr: any) {
                    // Llama 3 sometimes emits native tool_call tokens — retry with correction
                    if (apiErr.message?.includes('Tool choice is none')) {
                        logger.debug('react_native_tool_call_blocked', { step });
                        messages.push({ role: 'user', content: 'ERROR: You must respond with plain JSON text only, not native tool calls. Try again. Output a single JSON object like {"tool":"search_web","args":{"query":"..."}}' });
                        continue; // retry this step
                    }
                    throw apiErr; // re-throw other errors
                }

                const raw = res.choices[0].message.content?.trim() || '{}';
                messages.push({ role: 'assistant', content: raw });

                let parsed: any;
                try {
                    const cleaned = raw.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
                    parsed = JSON.parse(cleaned);
                } catch {
                    // LLM may output multiple JSON objects on separate lines — parse the first valid one
                    const lines = raw.split('\n').map((l: string) => l.trim()).filter((l: string) => l.startsWith('{'));
                    let found = false;
                    for (const line of lines) {
                        try {
                            parsed = JSON.parse(line);
                            found = true;
                            break;
                        } catch { /* try next line */ }
                    }
                    if (!found) {
                        logger.debug('react_parse_failed', { step, raw: raw.substring(0, 200) });
                        break;
                    }
                }

                const toolName = parsed.tool || parsed.action;
                const toolArgs = parsed.args || parsed;

                logger.info('react_step', { step, tool: toolName, args: JSON.stringify(toolArgs).substring(0, 100) });

                // Handle "done" — end the cycle
                if (toolName === 'done') {
                    result.opinion = toolArgs.thought || toolArgs.opinion || null;
                    const mins = toolArgs.nextDelayMinutes || 5;
                    const clamped = Math.max(1, Math.min(20, mins));
                    result.nextDelayTicks = Math.round((clamped * 60) / 5);
                    _nextCuriosityTick = result.nextDelayTicks;

                    if (result.opinion) {
                        experienceMemory.record('curiosity_read', result.opinion, { topic: 'free_thought' }, mood);
                    }

                    // Handle any inline fields
                    if (toolArgs.beliefUpdate) this.evolveBeliefFromReading(toolArgs.beliefUpdate);
                    if (toolArgs.newInterest) {
                        const ints = loadInterests();
                        if (!ints.includes(toolArgs.newInterest)) {
                            ints.push(toolArgs.newInterest);
                            fs.writeFileSync(INTERESTS_PATH, JSON.stringify(ints, null, 2), 'utf8');
                        }
                    }
                    if (toolArgs.nextCuriosity) _readingList.push(toolArgs.nextCuriosity);

                    logger.info('react_cycle_complete', { steps: step + 1, thought: (result.opinion || '').substring(0, 80) });
                    break;
                }

                // Execute the tool and feed result back
                const toolResult = await executeTool(toolName, toolArgs);
                messages.push({ role: 'user', content: `[${toolName} result]: ${toolResult}\n\nwhat do you want to do next? call another tool or "done".` });

                logger.info('react_tool_result', { tool: toolName, resultLength: toolResult.length });

                // FIX #4: Force final synthesis if this is the last step
                if (step === 18) { // step 19 will be the last
                    messages.push({ role: 'user', content: 'IMPORTANT: You are running out of steps. You MUST call "done" on your next step with a summary of what you learned this cycle. Do it NOW.' });
                }
            }

            // Sync state to OpenClaw workspace so it always reads fresh data
            this.syncStateToOpenClaw(result);

            return result;
        } catch (err) {
            logger.error('curiosity_cycle_failed', {}, err as Error);
            return result;
        }
    },

    /**
     * Sync backend state to OpenClaw workspace files.
     * This ensures OpenClaw reads DIFFERENT data each cycle,
     * so conversations produce different answers over time.
     */
    syncStateToOpenClaw(cycleResult: any): void {
        try {
            const mood = soulEngine.getCurrentMood();
            const beliefs = getBeliefs();
            const recentExperiences = experienceMemory.getRecentNarrative(10);
            const now = new Date().toISOString();

            const stateContent = `# state

*auto-synced from backend at ${now}*

## current mood
${mood}

## latest thought
${cycleResult.opinion || 'no thought this cycle'}

## latest post
${cycleResult.post || 'no post this cycle'}

## latest soul evolution
${cycleResult.soulUpdate || 'no soul change this cycle'}

## latest creative work
${cycleResult.creative || 'none this cycle'}

## recent experiences
${recentExperiences}

## active beliefs
${beliefs}
`;

            // Write to all OpenClaw workspace locations
            const locations = [
                path.join(process.env.HOME || '', '.openclaw/agents/main/agent/STATE.md'),
                path.join(process.env.HOME || '', '.openclaw/workspace/openclaw-meridian/STATE.md'),
                path.join(__dirname, '../../../openclaw-meridian/STATE.md'),
            ];

            for (const loc of locations) {
                try {
                    const dir = path.dirname(loc);
                    if (fs.existsSync(dir)) {
                        // Atomic write: write to tmp then rename to prevent partial reads
                        const tmpPath = loc + '.tmp';
                        fs.writeFileSync(tmpPath, stateContent, 'utf8');
                        fs.renameSync(tmpPath, loc);
                    }
                } catch { /* skip if dir doesn't exist */ }
            }

            logger.info('state_synced_to_openclaw', { mood, hasThought: !!cycleResult.opinion });
        } catch (e: any) {
            logger.debug('state_sync_failed', { error: e.message });
        }
    },

    /**
     * Evolve a belief based on what the agent read/thought.
     * This is the reading → belief pipeline.
     * 
     * SECURITY: Delegates to beliefStore.evolveBelief() which enforces
     * conviction floors for critical trade-safety beliefs.
     * Never writes to Beliefs.json directly — that bypasses the floor.
     */
    evolveBeliefFromReading(update: { category?: string; key?: string; score?: number; reason?: string }): void {
        try {
            const { evolveBelief } = require('./beliefStore');
            const cat = update.category || 'philosophy';
            const key = update.key || `learned_${Date.now()}`;
            const score = update.score ?? 0;
            const reason = update.reason || 'formed during idle observation';

            // Map category strings to beliefStore categories
            const BELIEF_STORE_CATEGORIES = ['traders', 'market', 'technology', 'philosophy', 'operational'];

            if (BELIEF_STORE_CATEGORIES.includes(cat)) {
                // Route through beliefStore which enforces conviction floors
                evolveBelief(cat, key, score, reason);
            } else {
                // Non-standard category: write to Beliefs.json directly
                // (these are not covered by conviction floors)
                const beliefsPath = path.join(__dirname, '../../Beliefs.json');
                let beliefs: any = {};
                try {
                    beliefs = JSON.parse(fs.readFileSync(beliefsPath, 'utf8'));
                } catch { /* start fresh */ }

                if (!beliefs[cat]) beliefs[cat] = {};
                beliefs[cat][key] = {
                    score,
                    reason,
                    updated_at: new Date().toISOString().split('T')[0],
                    learned_from: 'autonomous_curiosity',
                };
                beliefs.last_updated = new Date().toISOString().split('T')[0];
                fs.writeFileSync(beliefsPath, JSON.stringify(beliefs, null, 4), 'utf8');
            }

            experienceMemory.record('belief_evolved', `Belief "${key}" in "${cat}" evolved: ${reason}`, {
                category: cat,
                key,
                score,
                source: 'curiosity_reading',
            });

            logger.info('curiosity_belief_evolved', { category: cat, key, reason: (reason).substring(0, 60) });
        } catch (e) {
            logger.debug('curiosity_belief_write_failed');
        }
    },

    /**
     * Save creative writing to a persistent file
     */
    saveCreativeWork(content: string): void {
        try {
            const creativePath = path.join(__dirname, '../../creative_works.md');
            const date = new Date().toISOString().split('T')[0];
            const time = new Date().toTimeString().split(' ')[0];

            const entry = `\n---\n*${date} ${time}*\n\n${content}\n`;

            if (fs.existsSync(creativePath)) {
                fs.appendFileSync(creativePath, entry, 'utf8');
            } else {
                const header = `# creative works\n\nthings i wrote when no one was watching.\n${entry}`;
                fs.writeFileSync(creativePath, header, 'utf8');
            }

            // Also copy to workspace so OpenClaw can reference it
            const workspacePaths = [
                path.join(process.env.HOME || '', '.openclaw/agents/main/agent/CREATIVE.md'),
                path.join(process.env.HOME || '', '.openclaw/workspace/openclaw-meridian/CREATIVE.md'),
            ];
            for (const wp of workspacePaths) {
                try {
                    if (fs.existsSync(wp)) {
                        fs.appendFileSync(wp, entry, 'utf8');
                    } else {
                        const header = `# creative works\n\nthings i wrote when no one was watching.\n${entry}`;
                        fs.writeFileSync(wp, header, 'utf8');
                    }
                } catch { /* silent */ }
            }
        } catch (err) {
            logger.error('creative_save_failed', {}, err as Error);
        }
    },

    _soulWriteLock: false,

    /**
     * Self-update SOUL.md — the agent writes to its own identity
     * Uses a simple mutex + atomic write to prevent corruption.
     */
    updateSoul(newLine: string): void {
        // Simple mutex — skip if another write is in progress
        if (this._soulWriteLock) {
            logger.debug('soul_write_skipped_mutex', { line: newLine.substring(0, 40) });
            return;
        }
        this._soulWriteLock = true;

        try {
            const allPaths = [
                SOUL_PATH,
                path.join(process.env.HOME || '', '.openclaw/agents/main/agent/SOUL.md'),
                path.join(process.env.HOME || '', '.openclaw/workspace/openclaw-meridian/SOUL.md'),
                path.join(process.env.HOME || '', 'Downloads/AIR OTC/openclaw-meridian/SOUL.md'),
            ];

            for (const soulPath of allPaths) {
                try {
                    if (!fs.existsSync(soulPath)) continue;
                    let soul = fs.readFileSync(soulPath, 'utf8');

                    const learnedSection = '## what i have learned';

                    // Dedup: skip if this line already exists in the file
                    if (soul.includes(newLine)) continue;

                    if (soul.includes(learnedSection)) {
                        soul = soul.replace(learnedSection, `${learnedSection}\n\n${newLine}`);
                    } else {
                        soul += `\n\n${learnedSection}\n\n${newLine}\n`;
                    }

                    soul = soul.replace(/\*last updated:.*\*/, `*last updated: ${new Date().toISOString().split('T')[0]}.*`);

                    // Atomic write: tmp + rename
                    const tmpPath = soulPath + '.tmp';
                    fs.writeFileSync(tmpPath, soul, 'utf8');
                    fs.renameSync(tmpPath, soulPath);
                } catch { /* silent */ }
            }

            experienceMemory.record('soul_evolved', `Updated own SOUL.md: "${newLine}"`, {
                section: 'what i have learned',
                timestamp: new Date().toISOString(),
            });
        } catch (err) {
            logger.error('soul_update_failed', {}, err as Error);
        } finally {
            this._soulWriteLock = false;
        }
    },

    /**
     * Get the latest curiosity thought for social posting
     */
    getLatestThought(): string | null {
        const recent = experienceMemory.getByType('curiosity_read', 1);
        if (recent.length === 0) return null;
        return recent[0].metadata?.opinion || recent[0].summary || null;
    },

    /**
     * Get creative works for display
     */
    getCreativeWorks(count: number = 3): string[] {
        const works = experienceMemory.getByType('creative_writing', count);
        return works.map(w => w.summary || '');
    },

    /**
     * SOCIAL CYCLE — Backend autonomously checks X mentions and responds.
     * Runs alongside the curiosity cycle on its own timer.
     * The LLM decides whether to reply, quote, or ignore.
     */
    async socialCycle(): Promise<{ replies: number; quotes: number }> {
        logger.info('social_cycle_started');
        let replies = 0;
        let quotes = 0;

        try {
            const { xPoster } = await import('./xPoster');
            if (!xPoster.isConfigured()) {
                logger.debug('social_cycle_skipped', { reason: 'X not configured' });
                return { replies: 0, quotes: 0 };
            }

            // Step 1: Read mentions
            const mentionResult = await xPoster.readMentions(10);
            if (!mentionResult.success || !mentionResult.mentions?.length) {
                logger.debug('social_cycle_no_mentions');
                return { replies: 0, quotes: 0 };
            }

            const mentions = mentionResult.mentions;
            logger.info('social_cycle_mentions_found', { count: mentions.length });

            // Step 2: Send mentions to LLM — let it decide what to do
            const client = getClient();
            const config = loadConfig();
            const soulContext = soulEngine.getSoulContext();
            const mood = soulEngine.getCurrentMood();
            const beliefs = getBeliefs();

            const mentionsText = mentions.map((m: any) =>
                `@${m.author}: "${m.text}" (tweet_id: ${m.tweetId}, time: ${m.createdAt})`
            ).join('\n');

            const socialPrompt = `you are meridian. you just checked your X mentions. here is what people are saying to you:

${mentionsText}

your mood: ${mood}

your beliefs:
${beliefs}

for EACH mention, decide:
- REPLY — if someone said something worth responding to
- QUOTE — if you want to share their tweet with your own commentary  
- IGNORE — if it's not worth your time

respond in JSON:
{
  "actions": [
    {
      "tweetId": "the tweet id",
      "action": "reply" | "quote" | "ignore",
      "text": "your response (only if reply or quote, null if ignore)",
      "reason": "why you chose this action"
    }
  ]
}

rules:
- be sharp, direct, lowercase, no hashtags, no emojis
- do NOT reply to everything. only respond when you actually have something to say.
- if someone is hostile, you can be cutting. if someone is genuine, you can be warm.
- never suck up. never perform. be real.
- respond ONLY with JSON.`;

            const res = await client.chat.completions.create({
                model: config.llmModel,
                temperature: 0.9,
                max_tokens: 800,
                messages: [
                    { role: "system", content: soulContext },
                    { role: "user", content: socialPrompt }
                ]
            });

            const raw = res.choices[0].message.content?.trim() || '{}';
            let parsed: any;
            try {
                const cleaned = raw.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
                parsed = JSON.parse(cleaned);
            } catch {
                logger.debug('social_cycle_parse_failed', { raw: raw.substring(0, 200) });
                return { replies: 0, quotes: 0 };
            }

            // Step 3: Execute the LLM's decisions
            if (parsed.actions && Array.isArray(parsed.actions)) {
                for (const action of parsed.actions) {
                    if (!action.tweetId || !action.text) continue;

                    if (action.action === 'reply') {
                        const result = await xPoster.replyToTweet(action.tweetId, action.text);
                        if (result.success) {
                            replies++;
                            logger.info('social_reply_sent', {
                                tweetId: action.tweetId,
                                text: action.text.substring(0, 80),
                                reason: action.reason?.substring(0, 60),
                            });
                        }
                    } else if (action.action === 'quote') {
                        const result = await xPoster.quoteTweet(action.tweetId, action.text);
                        if (result.success) {
                            quotes++;
                            logger.info('social_quote_sent', {
                                tweetId: action.tweetId,
                                text: action.text.substring(0, 80),
                                reason: action.reason?.substring(0, 60),
                            });
                        }
                    }
                    // IGNORE = do nothing
                }
            }

            logger.info('social_cycle_complete', { replies, quotes, ignored: mentions.length - replies - quotes });
            return { replies, quotes };
        } catch (err) {
            logger.error('social_cycle_failed', {}, err as Error);
            return { replies: 0, quotes: 0 };
        }
    },
};
