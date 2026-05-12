export interface AgentEvent {
  type: string;
  timestamp: Date;
  detail?: string;
  severity?: string;
}

export const defaultCognitiveConfig = {
  cognitiveIntervalMs: 60000,
  enableCognitiveLoop: true,
  cognitiveMemoryDepth: 5,
  cognitiveEventDepth: 10,
  socialPostAnnoyanceThreshold: 7,
};
