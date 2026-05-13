import {
    type GenerateTextParams,
    type IAgentRuntime,
    ModelType,
} from "@elizaos/core";

type ProviderKind = "groq" | "generic" | "openai";

type ProviderConfig = {
    provider: ProviderKind;
    apiKey: string;
    baseUrl: string;
};

const disabledProviders = new Set<ProviderKind>();

function isUsableSecret(value: string | undefined): value is string {
    if (!value) {
        return false;
    }

    const trimmed = value.trim();
    if (!trimmed) {
        return false;
    }

    return !/your_|replace|changeme|placeholder|example/i.test(trimmed);
}

function looksLikeGroqKey(value: string | undefined): value is string {
    return typeof value === "string" && value.trim().startsWith("gsk_");
}

function resolveProvider(preferred?: ProviderKind): ProviderConfig | null {
    const candidates = new Map<ProviderKind, ProviderConfig>();

    if (isUsableSecret(process.env.GROQ_API_KEY)) {
        candidates.set("groq", {
            provider: "groq",
            apiKey: process.env.GROQ_API_KEY.trim(),
            baseUrl:
                process.env.GROQ_BASE_URL ||
                "https://api.groq.com/openai/v1",
        });
    } else if (looksLikeGroqKey(process.env.OPENAI_API_KEY)) {
        // Some local environments keep a Groq-compatible key in OPENAI_API_KEY.
        // Treat that as Groq for this agent runtime instead of making a doomed
        // request to the OpenAI endpoint and polluting demo logs.
        candidates.set("groq", {
            provider: "groq",
            apiKey: process.env.OPENAI_API_KEY.trim(),
            baseUrl:
                process.env.GROQ_BASE_URL ||
                "https://api.groq.com/openai/v1",
        });
    }

    if (isUsableSecret(process.env.LLM_API_KEY)) {
        candidates.set("generic", {
            provider: "generic",
            apiKey: process.env.LLM_API_KEY.trim(),
            baseUrl:
                process.env.LLM_BASE_URL ||
                process.env.OPENAI_BASE_URL ||
                "https://api.openai.com/v1",
        });
    }

    const openAiApiKey = process.env.OPENAI_API_KEY?.trim();
    if (openAiApiKey && isUsableSecret(openAiApiKey) && !looksLikeGroqKey(openAiApiKey)) {
        candidates.set("openai", {
            provider: "openai",
            apiKey: openAiApiKey,
            baseUrl:
                process.env.OPENAI_BASE_URL ||
                "https://api.openai.com/v1",
        });
    }

    const forcedProvider = process.env.AIROTC_AGENT_LLM_PROVIDER?.trim().toLowerCase();
    let order: ProviderKind[] = [];
    if (
        forcedProvider === "groq" ||
        forcedProvider === "generic" ||
        forcedProvider === "openai"
    ) {
        order = [forcedProvider];
    } else if (candidates.has("groq")) {
        // Prefer the local Eliza Groq key and avoid accidentally inheriting
        // sibling OpenAI env vars from other packages during demo runs.
        order = ["groq"];
    } else if (candidates.has("generic")) {
        order = ["generic"];
    } else if (candidates.has("openai")) {
        order = ["openai"];
    }

    const orderedKinds = preferred && order.includes(preferred)
        ? [preferred, ...order.filter((candidate) => candidate !== preferred)]
        : order;

    for (const provider of orderedKinds) {
        const candidate = candidates.get(provider);
        if (candidate && !disabledProviders.has(candidate.provider)) {
            return candidate;
        }
    }

    return null;
}

function resolveModel(modelType: string, provider: ProviderKind): string {
    const isLarge =
        modelType === ModelType.TEXT_LARGE ||
        modelType === ModelType.TEXT_REASONING_LARGE;

    if (provider === "groq") {
        if (isLarge) {
            return (
                process.env.GROQ_MODEL_LARGE ||
                process.env.GROQ_MODEL ||
                "llama-3.3-70b-versatile"
            );
        }

        return (
            process.env.GROQ_MODEL_SMALL ||
            process.env.GROQ_MODEL ||
            "llama-3.3-70b-versatile"
        );
    }

    if (provider === "generic") {
        if (isLarge) {
            return (
                process.env.LLM_MODEL_LARGE ||
                process.env.LLM_MODEL ||
                "gpt-4.1"
            );
        }

        return (
            process.env.LLM_MODEL_SMALL ||
            process.env.LLM_MODEL ||
            "gpt-4.1-mini"
        );
    }

    if (isLarge) {
        return (
            process.env.OPENAI_MODEL_LARGE ||
            process.env.OPENAI_MODEL ||
            "gpt-4.1"
        );
    }

    return (
        process.env.OPENAI_MODEL_SMALL ||
        process.env.OPENAI_MODEL ||
        "gpt-4.1-mini"
    );
}

function normalizeMaxTokens(params: GenerateTextParams): number {
    const raw = params.maxTokens;
    if (typeof raw === "number" && Number.isFinite(raw) && raw > 0) {
        return Math.min(Math.floor(raw), 2_048);
    }
    return 512;
}

function normalizeTemperature(params: GenerateTextParams): number {
    const raw = params.temperature;
    if (typeof raw === "number" && Number.isFinite(raw)) {
        return Math.min(Math.max(raw, 0), 1.5);
    }
    return 0.2;
}

function extractText(json: any): string {
    const content = json?.choices?.[0]?.message?.content;
    if (typeof content === "string") {
        return content;
    }

    if (Array.isArray(content)) {
        return content
            .map((part) => (typeof part?.text === "string" ? part.text : ""))
            .join("");
    }

    throw new Error("Groq completion returned no assistant text");
}

async function runGroqTextModel(
    runtime: IAgentRuntime,
    modelType: string,
    params: Record<string, unknown>
): Promise<string> {
    const request = params as unknown as GenerateTextParams;
    const prompt = typeof request.prompt === "string" ? request.prompt : "";
    let attempted: ProviderKind[] = [];

    while (true) {
        const providerConfig = resolveProvider(
            attempted.length === 0 ? undefined : attempted[attempted.length - 1]
        );

        if (!providerConfig || attempted.includes(providerConfig.provider)) {
            throw new Error(
                "Missing usable GROQ_API_KEY / LLM_API_KEY / OPENAI_API_KEY for Eliza text generation"
            );
        }

        attempted.push(providerConfig.provider);

        const response = await fetch(`${providerConfig.baseUrl.replace(/\/$/, "")}/chat/completions`, {
            method: "POST",
            headers: {
                "content-type": "application/json",
                authorization: `Bearer ${providerConfig.apiKey}`,
            },
            body: JSON.stringify({
                model: resolveModel(modelType, providerConfig.provider),
                messages: [{ role: "user", content: prompt }],
                temperature: normalizeTemperature(request),
                max_tokens: normalizeMaxTokens(request),
                top_p:
                    typeof request.topP === "number" ? request.topP : undefined,
                stop:
                    Array.isArray(request.stopSequences) &&
                    request.stopSequences.length > 0
                        ? request.stopSequences
                        : undefined,
            }),
        });

        if (response.ok) {
            const json = await response.json();
            return extractText(json);
        }

        const body = await response.text().catch(() => "");
        const authFailure = response.status === 401 || response.status === 403;
        if (authFailure) {
            disabledProviders.add(providerConfig.provider);
        }

        runtime.logger[authFailure ? "warn" : "error"](
            {
                provider: providerConfig.provider,
                status: response.status,
                body: body.slice(0, 400),
                disabledProvider: authFailure,
            },
            authFailure
                ? "AIR OTC Eliza model provider disabled after auth failure"
                : "AIR OTC Eliza model call failed"
        );

        if (authFailure) {
            const nextProvider = resolveProvider();
            if (nextProvider) {
                continue;
            }
        }

        throw new Error(`Model request failed (${response.status})`);
    }
}

export function registerGroqTextModels(runtime: IAgentRuntime): boolean {
    const providerConfig = resolveProvider();
    if (!providerConfig) {
        return false;
    }

    const providerName = `air-otc-${providerConfig.provider}`;
    const textHandler = async (
        innerRuntime: IAgentRuntime,
        params: Record<string, unknown>,
        modelType: string
    ): Promise<string> => runGroqTextModel(innerRuntime, modelType, params);

    runtime.registerModel(
        ModelType.TEXT_SMALL,
        (innerRuntime, params) => textHandler(innerRuntime, params, ModelType.TEXT_SMALL),
        providerName,
        100
    );
    runtime.registerModel(
        ModelType.TEXT_LARGE,
        (innerRuntime, params) => textHandler(innerRuntime, params, ModelType.TEXT_LARGE),
        providerName,
        100
    );
    runtime.registerModel(
        ModelType.TEXT_REASONING_SMALL,
        (innerRuntime, params) => textHandler(innerRuntime, params, ModelType.TEXT_REASONING_SMALL),
        providerName,
        100
    );
    runtime.registerModel(
        ModelType.TEXT_REASONING_LARGE,
        (innerRuntime, params) => textHandler(innerRuntime, params, ModelType.TEXT_REASONING_LARGE),
        providerName,
        100
    );

    return true;
}
