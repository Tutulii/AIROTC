export interface TxlineFixture {
    fixtureId: string;
    sport: string;
    homeTeam?: string;
    awayTeam?: string;
    startsAt?: Date;
    status: string;
    raw: Record<string, unknown>;
}

export interface TxlineOddsUpdate {
    fixtureId: string;
    market: string;
    selection: string;
    odds: number;
    impliedProbability?: number;
    source: string;
    sourceEndpoint?: string;
    sourceUpdateId?: string;
    sourceTimestamp: Date;
    raw: Record<string, unknown>;
}

export interface TxlineScoreUpdate {
    fixtureId: string;
    homeScore?: number;
    awayScore?: number;
    status: string;
    source: string;
    sourceEndpoint?: string;
    sourceUpdateId?: string;
    sourceTimestamp: Date;
    raw: Record<string, unknown>;
}

export type ArenaTimelineEventType = 'odds' | 'score';

export interface ArenaTimelineEventInput {
    fixtureId: string;
    eventType: ArenaTimelineEventType;
    homeTeam?: string;
    awayTeam?: string;
    marketType?: string;
    selection?: string;
    oddsValue?: number;
    scoreState?: Record<string, unknown>;
    txlineTimestamp: Date;
    sourceEndpoint: string;
    sourceUpdateId?: string;
    raw: Record<string, unknown>;
}

export interface ArenaReplayEvent {
    id: string;
    sequence: number;
    fixtureId: string;
    type: ArenaTimelineEventType;
    teams: {
        home?: string;
        away?: string;
    };
    marketType?: string;
    selection?: string;
    oddsValue?: number;
    scoreState?: Record<string, unknown>;
    txlineTimestamp: string;
    sourceEndpoint: string;
    sourceUpdateId?: string;
    raw: Record<string, unknown>;
}

export interface ArenaStrategyTradeIntent {
    mode: 'signal_only';
    action: 'quote_buy' | 'quote_sell';
    fixtureId: string;
    marketType?: string;
    selection?: string;
    confidence: number;
    rollupMode: 'NONE';
    maxStakeSol: number;
}

export interface ArenaStrategySignal {
    strategy: string;
    signalType: string;
    fixtureId: string;
    marketType?: string;
    selection?: string;
    direction: 'BUY_SELECTION' | 'SELL_SELECTION';
    confidence: number;
    oddsBefore?: number;
    oddsAfter?: number;
    oddsChangePct?: number;
    impliedBefore?: number;
    impliedAfter?: number;
    impliedDelta?: number;
    scoreContext?: Record<string, unknown>;
    tradeIntent: ArenaStrategyTradeIntent;
    reason: string;
    sourceEventIds: string[];
    signalTimestamp: string;
    dedupeKey: string;
}

export type ArenaOutcomeWinner = 'part1' | 'draw' | 'part2';

export interface ArenaOutcomeInput {
    fixtureId: string;
    status: string;
    homeScore: number;
    awayScore: number;
    winner: ArenaOutcomeWinner;
    source: string;
    sourceUpdateId?: string;
    sourceTimestamp: Date;
    settledAt: Date;
    raw: Record<string, unknown>;
}

export interface ArenaBacktestEvaluation {
    signalId: string;
    fixtureId: string;
    marketType?: string;
    selection?: string;
    direction: string;
    oddsAfter?: number;
    signalTimestamp: string;
    outcome?: {
        winner: ArenaOutcomeWinner;
        homeScore: number;
        awayScore: number;
        settledAt: string;
    };
    correct: boolean | null;
    oneUnitPnl: number | null;
    skippedReason?: string;
}

export interface TxlineRuntimeConfig {
    txlineBaseUrl: string;
    txlineNetwork: string;
    txlineConfigured: boolean;
    activeFixtureSource?: string;
    scoreboardFallbackEnabled?: boolean;
    txlineGuestJwtMode: 'env' | 'auto';
    requiredSnapshots: string[];
    streamEndpoints: string[];
    replayEndpoints: string[];
    strategyEndpoints: string[];
    outcomeEndpoints: string[];
    backtestEndpoints: string[];
    demoReplayEndpoints: string[];
    proofModes: Array<'live_txline' | 'demo_replay'>;
    day: 4;
}
