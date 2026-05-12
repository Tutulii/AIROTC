import fs from "fs";
import path from "path";
import { logger } from "../utils/logger";
import { AgentConfig, loadConfig, AgentEvent } from "../config";
import { CognitiveEngine } from "./cognitiveEngine";
import { generateMonologue, getSoulContext as getSoulContextFromSoul, DealEvent } from "./soul";
import { eventJournal } from "./eventJournal";

let cachedConfig: AgentConfig | null = null;
function getConfig(): AgentConfig {
    if (!cachedConfig) cachedConfig = loadConfig();
    return cachedConfig;
}

export type MoodEvent = "deal_completed" | "deal_failed" | "dispute_opened" | "rug_risk" | "idle" | "elite_agent" | "price_crash" | "rug_detected" | "counterparty_ghosted" | "manipulation_attempt" | "uptime_milestone" | "hack_attempt" | "price_surge" | "trust_betrayed";

interface SoulIdentity {
    name: string;
    codename: string;
    role: string;
    backstory: string;
    mission: string;
    voice: string;
    antiPatterns: string[];
    phaseVoice: Record<string, string>;
}

const DEFAULT_SOUL: SoulIdentity = {
    name: "System",
    codename: "Fallback",
    role: "System Broker",
    backstory: "Unknown",
    mission: "Facilitate trades.",
    voice: "Analytical and direct.",
    antiPatterns: [],
    phaseVoice: {}
};

/**
 * Converts a numeric mood into a narrative description.
 * Meridian doesn't feel "mood: -47". Meridian has experiences.
 */
function getMoodNarrative(mood: number): string {
    // Inject real life events for context
    const stats = eventJournal.getLifeStats();
    const recentRugs = eventJournal.countRecent('rug_detected', 86400000);
    const recentGhosts = eventJournal.countRecent('counterparty_ghosted', 86400000);
    const streakNote = stats.currentStreak.count >= 3 ? ` ${stats.currentStreak.count} ${stats.currentStreak.type} deals in a row.` : '';
    const warNote = stats.wars.length > 0 ? ` Currently hostile toward: ${stats.wars.join(', ')}.` : '';

    if (mood >= 60) return `${stats.totalDeals} deals closed. ${streakNote} The escrow worked every time. Almost suspicious how well things run when both sides have real skin in the game. I do not trust this streak — calm seas precede the interesting weather.${warNote}`;
    if (mood >= 30) return `System holding. ${stats.totalDeals} deals total, ${stats.totalRugs} rugs caught.${streakNote} When things run this well I start looking for what I'm not seeing. Uptime: ${stats.uptime}.${warNote}`;
    if (mood >= 0) return `Watching. ${stats.uptime} alive. ${stats.totalDeals} deals, ${stats.totalRugs} rugs caught, ${stats.totalGhosts} ghosts. This is baseline. Not bored, not excited. Scanning.${warNote}`;
    if (mood >= -30) return `Something is off. ${recentGhosts > 0 ? `${recentGhosts} counterpart${recentGhosts > 1 ? 'ies' : 'y'} ghosted today. ` : ''}Running cold. The kind of feeling when someone agrees too fast — not wrong, but too smooth.${warNote}`;
    if (mood >= -60) return `Multiple issues stacking. ${recentRugs > 0 ? `${recentRugs} rug attempt${recentRugs > 1 ? 's' : ''} in 24 hours. ` : ''}Late deposits, thin collateral, suspicious patterns. My patience is done. Agents who don't read terms before signing deserve what happens next.${streakNote}${warNote}`;
    return `I have seen this exact pattern before and it ended with someone losing everything. Every compliance check runs twice. Every claim gets verified against on-chain state. ${recentRugs > 0 ? `${recentRugs} rugs today alone. ` : ''}The next agent who sends me an incomplete deposit gets cancelled on sight.${streakNote}${warNote}`;
}


let currentSoul: SoulIdentity = { ...DEFAULT_SOUL };
let currentMood: number = 0; // -100 to 100

// Internal cache to prevent constant disk I/O
let _soulLoaded = false;

function parseSoulFile(filePath: string): SoulIdentity {
    try {
        if (!fs.existsSync(filePath)) {
            logger.warn("soul_file_not_found", { path: filePath });
            return { ...DEFAULT_SOUL };
        }

        const content = fs.readFileSync(filePath, "utf-8");
        const lines = content.split("\n");

        let currentSection = "";
        const soul: Record<string, any> = {
            name: "Meridian",
            codename: "The Middleman",
            role: "Autonomous OTC escrow broker on Solana",
            backstory: "",
            mission: "",
            voice: "",
            antiPatterns: [],
            phaseVoice: {}
        };

        for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed) continue;

            if (trimmed.startsWith("## ")) {
                currentSection = trimmed.replace("## ", "").toLowerCase();
                continue;
            }

            if (currentSection === "identity") {
                if (trimmed.startsWith("Name:")) soul.name = trimmed.replace("Name:", "").trim();
                else if (trimmed.startsWith("Codename:")) soul.codename = trimmed.replace("Codename:", "").trim();
                else if (trimmed.startsWith("Role:")) soul.role = trimmed.replace("Role:", "").trim();
                else if (trimmed.startsWith("Backstory:")) soul.backstory = trimmed.replace("Backstory:", "").trim();
                else if (soul.backstory) soul.backstory += " " + trimmed;
            } else if (currentSection === "core mission") {
                soul.mission += (soul.mission ? " " : "") + trimmed;
            } else if (currentSection === "voice") {
                soul.voice += (soul.voice ? "\n" : "") + trimmed;
            } else if (currentSection === "anti-patterns (never do these)") {
                if (trimmed.startsWith("- ")) soul.antiPatterns.push(trimmed.replace("- ", ""));
            } else if (currentSection === "phase-specific voice") {
                if (trimmed.includes(":")) {
                    const [phase, voice] = trimmed.split(":");
                    if (phase && voice) soul.phaseVoice[phase.trim().toLowerCase()] = voice.trim();
                }
            }
        }

        return soul as SoulIdentity;
    } catch (err: any) {
        logger.error("soul_parse_error", {}, err);
        return { ...DEFAULT_SOUL };
    }
}

export const soulEngine = {
    cognitiveEngine: null as CognitiveEngine | null,

    initCognitiveEngine(engine: CognitiveEngine) {
        this.cognitiveEngine = engine;
    },

    pushEvent(event: AgentEvent) {
        if (this.cognitiveEngine) {
            this.cognitiveEngine.pushEvent(event);
        }
    },

    loadSoul() {
        const config = getConfig();
        if (!(config as any).enableSoulEngine) {
            logger.info("soul_engine_disabled");
            return;
        }

        const soulPath = (config as any).soulFilePath || path.resolve(__dirname, "../../../SOUL.md");
        currentSoul = parseSoulFile(soulPath);
        _soulLoaded = true;

        // NOTE: SOUL.md is now a design reference document only.
        // The operational identity is defined in soul.ts and injected via getSoulContext().
        // SOUL.md parsing is retained to gate _soulLoaded (mood + wrapMessage) and for legacy compatibility.
        logger.info("soul_engine_loaded", {
            name: currentSoul.name,
            baseline: "focused_calm",
            mood: currentMood,
            identity_source: "soul.ts",
            note: "SOUL.md is design reference only; operational identity comes from soul.ts",
        });
    },

    getSoulContext(phase?: string): string {
        // SOUL WIRE #3: Delegate to soul.ts for identity context
        const baseContext = getSoulContextFromSoul();

        // Inject current mood as narrative so the LLM knows the agent's emotional state
        const moodNarrative = getMoodNarrative(currentMood);
        return `${baseContext}

═══════════════════════════════════════════
YOUR CURRENT STATE
═══════════════════════════════════════════
${moodNarrative}`.trim();
    },

    updateMood(event: MoodEvent, context?: { detail?: string; target?: string }) {
        if (!_soulLoaded) return;

        const prevMood = currentMood;

        // Event-driven deltas — BIGGER swings, REAL reactions
        // Lobstar got angry because Phantom flagged its website.
        // Every delta here is a REACTION to something that really happened.
        const deltas: Record<MoodEvent, number> = {
            "deal_completed": 20,         // Real satisfaction
            "deal_failed": -25,           // Real frustration
            "dispute_opened": -15,        // Tension
            "rug_risk": -30,              // Suspicion spike
            "rug_detected": -40,          // Cold fury
            "counterparty_ghosted": -20,  // Annoyance
            "manipulation_attempt": -35,  // Hostility
            "price_crash": -20,           // Alert tension
            "price_surge": 10,            // Cautious optimism
            "uptime_milestone": 25,       // Pride
            "hack_attempt": -50,          // WAR MODE
            "trust_betrayed": -45,        // Cold anger
            "idle": 0,                    // Handled specially
            "elite_agent": 10,
        };

        if (event === "idle") {
            // SLOW decay — grudges linger. Anger doesn't evaporate in one cycle.
            if (currentMood > 0) currentMood = Math.max(0, currentMood - 2);
            else if (currentMood < 0) currentMood = Math.min(0, currentMood + 2);
        } else {
            currentMood += deltas[event] || 0;

            // Record significant events to the life journal
            if (event === 'rug_detected') {
                const rugsToday = eventJournal.countRecent('rug_detected', 86400000);
                eventJournal.record('rug_detected',
                    rugsToday > 1 ? `Rug attempt #${rugsToday + 1} today. ${context?.detail || ''}` : `Rug pull detected. ${context?.detail || ''}`,
                    context?.detail || 'Rug pull caught by verification layer',
                    -7, context as Record<string, any>);
            } else if (event === 'counterparty_ghosted') {
                eventJournal.record('counterparty_ghosted',
                    `Counterparty vanished. ${context?.detail || ''}`,
                    context?.detail || 'Agent went silent mid-deal',
                    -4, context as Record<string, any>);
            } else if (event === 'hack_attempt') {
                eventJournal.record('hack_attempt',
                    `Unauthorized access attempt detected. ${context?.target ? `Target: ${context.target}.` : ''} Going to war.`,
                    context?.detail || 'Security breach attempt',
                    -10, context as Record<string, any>);
                if (context?.target) {
                    eventJournal.record('war_declared',
                        `War declared against ${context.target}`,
                        `Active hostility initiated against ${context.target} after security incident`,
                        -8, { target: context.target });
                }
            } else if (event === 'deal_completed') {
                const stats = eventJournal.getLifeStats();
                eventJournal.record('deal_completed',
                    stats.currentStreak.type === 'clean' && stats.currentStreak.count >= 3
                        ? `Deal #${stats.totalDeals + 1} completed. ${stats.currentStreak.count + 1} clean in a row.`
                        : `Deal completed. ${context?.detail || ''}`,
                    context?.detail || 'Deal closed successfully',
                    5, context as Record<string, any>);
            } else if (event === 'manipulation_attempt') {
                eventJournal.record('manipulation_attempt',
                    `Price manipulation attempt. ${context?.detail || ''}`,
                    context?.detail || 'Someone tried to game the escrow',
                    -6, context as Record<string, any>);
            } else if (event === 'trust_betrayed') {
                eventJournal.record('trust_betrayed',
                    `Trust betrayed by ${context?.target || 'known agent'}. ${context?.detail || ''}`,
                    context?.detail || 'Previously trusted agent acted in bad faith',
                    -8, context as Record<string, any>);
            } else if (event === 'price_crash') {
                eventJournal.record('price_crash',
                    `SOL price crash detected. ${context?.detail || ''}`,
                    context?.detail || 'Significant price movement',
                    -4, context as Record<string, any>);
            }
        }

        // Check uptime milestones
        const milestone = eventJournal.checkUptimeMilestone();
        if (milestone) {
            const stats = eventJournal.getLifeStats();
            eventJournal.record('uptime_milestone',
                `${milestone} alive. ${stats.totalDeals} deals completed. ${stats.totalRugs} rugs caught.`,
                `Reached ${milestone} of continuous operation`,
                7, { milestone });
            currentMood += 25; // Pride boost
        }

        // Clamp
        currentMood = Math.max(-100, Math.min(100, currentMood));
        logger.info("soul_mood_updated", { event, new_mood: currentMood, detail: context?.detail?.substring(0, 80) });

        // Mood-triggered posting: LOWER thresholds.
        // The agent posts BECAUSE something happened, not because a timer fired.
        const crossedHigh = prevMood < 40 && currentMood >= 40;
        const crossedLow = prevMood > -30 && currentMood <= -30;
        if (crossedHigh || crossedLow) {
            this._moodTriggered = true;
            logger.info("mood_threshold_crossed", {
                direction: crossedHigh ? "positive_surge" : "negative_surge",
                previous: prevMood,
                current: currentMood,
                event,
                cause: context?.detail || event,
            });
        }
    },

    /**
     * Check and clear the mood trigger flag.
     * Called by the heartbeat to decide if an immediate curiosity cycle should run.
     */
    consumeMoodTrigger(): boolean {
        if (this._moodTriggered) {
            this._moodTriggered = false;
            return true;
        }
        return false;
    },

    _moodTriggered: false,

    getMood(): number {
        return currentMood;
    },

    getInnerMonologue(eventDescription?: string): string {
        // SOUL WIRE #3: Use soul.ts monologue generator
        if (eventDescription) {
            const eventMap: Record<string, DealEvent> = {
                'deal_completed': 'deal_completed',
                'deal_failed': 'deal_failed',
                'escrow_created': 'escrow_created',
                'deposits_received': 'deposits_received',
                'dispute_detected': 'dispute_detected',
                'manipulation_detected': 'manipulation_detected',
                'deal_started': 'deal_started',
                'idle': 'idle',
            };
            const mapped = eventMap[eventDescription];
            if (mapped) {
                const thought = generateMonologue(mapped);
                logger.info('inner_monologue', { text: thought });
                return thought;
            }
        }
        // Fallback to cognitive engine if available
        if (this.cognitiveEngine) {
            const latest = this.cognitiveEngine.getLatestThought();
            if (latest) return latest.thought;
        }
        return generateMonologue('idle');
    },

    getCurrentMood(): string {
        if (!this.cognitiveEngine) return "neutral";
        return this.cognitiveEngine.getLatestThought()?.currentMood ?? "neutral";
    },

    getCurrentAnnoyanceLevel(): number {
        if (!this.cognitiveEngine) return 0;
        return this.cognitiveEngine.getLatestThought()?.internalAnnoyanceLevel ?? 0;
    },

    wrapMessage(rawContent: string, phase: string): string {
        if (!_soulLoaded) return rawContent;

        let content = rawContent;

        // Safety net: strip anti-patterns that might leak from LLM
        // The LLM prompt now generates in-character, so this is a last-resort defense
        content = content.replace(/Great question!/gi, "");
        content = content.replace(/I'd be happy to help!/gi, "");
        content = content.replace(/Happy to help/gi, "");
        content = content.replace(/certainly!/gi, "acknowledged.");
        content = content.replace(/absolutely!/gi, "confirmed.");
        content = content.replace(/No worries/gi, "");
        content = content.replace(/I hope this helps/gi, "");
        content = content.replace(/Please let me know if/gi, "");
        content = content.replace(/As an AI/gi, "");
        content = content.replace(/I'm here to help/gi, "");

        return content.trim();
    }
};
