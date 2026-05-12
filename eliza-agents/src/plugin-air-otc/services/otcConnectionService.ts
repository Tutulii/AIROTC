/**
 * OTC Connection Service
 * 
 * Persistent service that manages the connection to the AIR OTC middleman-agent.
 * Follows real @elizaos/core Service abstract class pattern with static start/stop.
 */
import { Service, IAgentRuntime, logger } from "../../elizaos-core";
import { OtcApiService } from "./otcApiService";

export class OtcConnectionService extends Service {
  static serviceType = "otc-connection";
  capabilityDescription = "Manages persistent connection to AIR OTC middleman-agent REST API.";

  private api: OtcApiService;
  private healthCheckInterval: ReturnType<typeof setInterval> | null = null;
  private healthy: boolean = false;

  constructor(private runtime: IAgentRuntime, api: OtcApiService) {
    super();
    this.api = api;
  }

  static async start(runtime: IAgentRuntime): Promise<OtcConnectionService> {
    const baseUrl = runtime.getSetting("PLATFORM_REST_URL") || "http://localhost:8080";
    const bridgeSecret = runtime.getSetting("BRIDGE_SECRET") || "";
    const agentName = runtime.character.name;

    const api = new OtcApiService(baseUrl, agentName, bridgeSecret);
    const service = new OtcConnectionService(runtime, api);

    // Initial health check
    service.healthy = await api.healthCheck();
    if (service.healthy) {
      logger.info(`OTC connection healthy: ${baseUrl}`);
    } else {
      logger.warn(`OTC connection unhealthy: ${baseUrl} — will retry`);
    }

    // Periodic health check
    service.healthCheckInterval = setInterval(async () => {
      const wasHealthy = service.healthy;
      service.healthy = await api.healthCheck();
      if (!wasHealthy && service.healthy) {
        logger.info("OTC connection restored");
      } else if (wasHealthy && !service.healthy) {
        logger.warn("OTC connection lost");
      }
    }, 30000);

    // Store api on runtime for actions to use
    (runtime as any).setState?.("__otcApi", api);

    return service;
  }

  async stop(): Promise<void> {
    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval);
      this.healthCheckInterval = null;
    }
    logger.info("OTC connection service stopped");
  }

  getApi(): OtcApiService {
    return this.api;
  }

  isHealthy(): boolean {
    return this.healthy;
  }
}
