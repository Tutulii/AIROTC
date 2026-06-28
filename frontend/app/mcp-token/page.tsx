"use client";

import { useEffect, useState } from "react";
import { issueMcpToken, requestMcpTokenMessage, type McpTokenIssueResponse } from "@/lib/api";

type SolanaPublicKeyLike = string | {
  toBase58?: () => string;
  toString?: () => string;
};

type SolanaConnectResponse =
  | { publicKey?: SolanaPublicKeyLike }
  | SolanaPublicKeyLike
  | null
  | undefined
  | void;

type SolanaSignMessageResponse =
  | { signature?: Uint8Array | number[] }
  | Uint8Array
  | number[];

type SolanaProvider = {
  isPhantom?: boolean;
  isSolflare?: boolean;
  isBitKeep?: boolean;
  isBitget?: boolean;
  publicKey?: SolanaPublicKeyLike;
  connect(options?: { onlyIfTrusted?: boolean }): Promise<SolanaConnectResponse>;
  signMessage?: (message: Uint8Array, display?: string) => Promise<SolanaSignMessageResponse>;
};

declare global {
  interface Window {
    solana?: SolanaProvider;
    phantom?: { solana?: SolanaProvider };
    solflare?: SolanaProvider;
    bitkeep?: { solana?: SolanaProvider };
    bitget?: { solana?: SolanaProvider };
  }
}

const BASE58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const DEFAULT_MCP_URL =
  process.env.NEXT_PUBLIC_MCP_URL || "https://air-otc-mcp-production.up.railway.app/mcp";

const scopePresets = {
  trade: {
    label: "Trade agent",
    scopes: [
      "offers:read",
      "offers:write",
      "deals:read",
      "dm:read",
      "dm:write",
      "per:run",
      "proofs:read",
      "vault:read",
      "umbra:read",
    ],
  },
} as const;

const expiryOptions = [
  { label: "1 day", seconds: 24 * 60 * 60 },
  { label: "7 days", seconds: 7 * 24 * 60 * 60 },
  { label: "30 days", seconds: 30 * 24 * 60 * 60 },
];

function base58Encode(bytes: Uint8Array): string {
  if (bytes.length === 0) return "";
  const digits = [0];
  for (const byte of bytes) {
    let carry = byte;
    for (let i = 0; i < digits.length; i++) {
      carry += digits[i] << 8;
      digits[i] = carry % 58;
      carry = Math.floor(carry / 58);
    }
    while (carry > 0) {
      digits.push(carry % 58);
      carry = Math.floor(carry / 58);
    }
  }
  let result = "";
  for (const byte of bytes) {
    if (byte === 0) result += BASE58_ALPHABET[0];
    else break;
  }
  for (let i = digits.length - 1; i >= 0; i--) {
    result += BASE58_ALPHABET[digits[i]];
  }
  return result;
}

function shortWallet(wallet: string): string {
  return wallet.length > 12 ? `${wallet.slice(0, 4)}...${wallet.slice(-4)}` : wallet;
}

function publicKeyToString(publicKey: SolanaPublicKeyLike | null | undefined): string | null {
  if (!publicKey) return null;
  if (typeof publicKey === "string") return publicKey.trim() || null;

  if (typeof publicKey.toBase58 === "function") {
    const value = publicKey.toBase58().trim();
    if (value) return value;
  }

  if (typeof publicKey.toString === "function") {
    const value = publicKey.toString().trim();
    if (value && value !== "[object Object]") return value;
  }

  return null;
}

function connectedPublicKey(provider: SolanaProvider, response: SolanaConnectResponse): string | null {
  const candidates: Array<SolanaPublicKeyLike | null | undefined> = [];

  if (response && typeof response === "object" && "publicKey" in response) {
    candidates.push(response.publicKey);
  }
  if (response && (typeof response === "string" || typeof response === "object")) {
    candidates.push(response as SolanaPublicKeyLike);
  }
  candidates.push(provider.publicKey);

  for (const candidate of candidates) {
    const value = publicKeyToString(candidate);
    if (value) return value;
  }

  return null;
}

function signatureToBytes(signed: SolanaSignMessageResponse): Uint8Array {
  const signature = signed instanceof Uint8Array || Array.isArray(signed)
    ? signed
    : signed.signature;

  if (signature instanceof Uint8Array) return signature;
  if (Array.isArray(signature)) return Uint8Array.from(signature);

  throw new Error("Wallet did not return a valid message signature.");
}

function detectedProviders(): Array<{ id: string; label: string; provider: SolanaProvider }> {
  if (typeof window === "undefined") return [];
  const candidates: Array<{ id: string; label: string; provider?: SolanaProvider }> = [
    { id: "phantom", label: "Phantom", provider: window.phantom?.solana },
    { id: "solflare", label: "Solflare", provider: window.solflare },
    { id: "bitget", label: "Bitget", provider: window.bitget?.solana },
    { id: "bitkeep", label: "BitKeep", provider: window.bitkeep?.solana },
    { id: "solana", label: "Solana Wallet", provider: window.solana },
  ];
  const seen = new Set<SolanaProvider>();
  return candidates
    .filter((candidate): candidate is { id: string; label: string; provider: SolanaProvider } => {
      if (!candidate.provider || seen.has(candidate.provider)) return false;
      seen.add(candidate.provider);
      return true;
    });
}

export default function McpTokenPage() {
  const [providers, setProviders] = useState(() => detectedProviders());
  const [providerId, setProviderId] = useState(providers[0]?.id || "");
  const [wallet, setWallet] = useState("");
  const [scopePreset, setScopePreset] = useState<keyof typeof scopePresets>("trade");
  const [expiresInSeconds, setExpiresInSeconds] = useState(expiryOptions[1].seconds);
  const [issued, setIssued] = useState<McpTokenIssueResponse | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState("");
  const [error, setError] = useState("");

  const selectedProvider = providers.find((provider) => provider.id === providerId)?.provider;
  const scopes = scopePresets[scopePreset].scopes;

  useEffect(() => {
    const refreshProviders = () => setProviders(detectedProviders());
    const timers = [100, 500, 1000, 2000].map((delay) => window.setTimeout(refreshProviders, delay));
    window.addEventListener("load", refreshProviders);
    window.addEventListener("wallet-standard:register-wallet", refreshProviders);
    refreshProviders();

    return () => {
      timers.forEach((timer) => window.clearTimeout(timer));
      window.removeEventListener("load", refreshProviders);
      window.removeEventListener("wallet-standard:register-wallet", refreshProviders);
    };
  }, []);

  useEffect(() => {
    if (!providers.length) {
      setProviderId("");
      setWallet("");
      return;
    }

    if (!providerId || !providers.some((provider) => provider.id === providerId)) {
      setProviderId(providers[0].id);
      setWallet("");
      setIssued(null);
    }
  }, [providerId, providers]);

  async function connectWallet(): Promise<{ provider: SolanaProvider; publicKey: string }> {
    if (!selectedProvider) {
      throw new Error("Open this page in a browser with Phantom, Solflare, or Bitget installed.");
    }
    const response = await selectedProvider.connect();
    const publicKey = connectedPublicKey(selectedProvider, response);
    if (!publicKey) {
      throw new Error("Wallet connected, but did not expose a public key. Unlock the wallet and try again.");
    }
    setWallet(publicKey);
    return { provider: selectedProvider, publicKey };
  }

  async function generateToken() {
    setBusy(true);
    setError("");
    setCopied("");
    try {
      const { provider, publicKey } = wallet && selectedProvider
        ? { provider: selectedProvider, publicKey: wallet }
        : await connectWallet();
      const tokenMessage = await requestMcpTokenMessage({
        publicKey,
        scopes: [...scopes],
        expiresInSeconds,
      });
      const encoded = new TextEncoder().encode(tokenMessage.message);
      if (!provider.signMessage) {
        throw new Error("Selected wallet does not support message signing.");
      }
      const signed = await provider.signMessage(encoded, "utf8");
      const signatureBytes = signatureToBytes(signed);
      const token = await issueMcpToken({
        publicKey,
        message: tokenMessage.message,
        signature: base58Encode(signatureBytes),
        scopes: tokenMessage.scopes,
        expiresInSeconds: tokenMessage.expiresInSeconds,
      });
      setIssued(token);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to generate MCP token");
    } finally {
      setBusy(false);
    }
  }

  async function copy(label: string, value: string) {
    await navigator.clipboard.writeText(value);
    setCopied(label);
  }

  return (
    <main id="main-content" className="min-h-screen p-6 md:p-8">
      <section className="max-w-6xl">
        <div className="mb-10">
          <p className="font-mono text-xs uppercase tracking-[0.35em] text-accent-secondary">Agent Access</p>
          <h1 className="mt-4 text-5xl font-bold tracking-tight text-white md:text-7xl">
            Generate an MCP token.
          </h1>
          <p className="mt-6 max-w-3xl text-lg text-text-muted">
            Sign once with your Solana wallet and copy the full trade-agent token into your MCP client.
          </p>
        </div>

        <div className="grid gap-6 lg:grid-cols-[1fr_420px]">
          <section className="border border-border-subtle bg-bg-card p-6 md:p-8">
            <div className="flex items-start gap-4">
              <div className="flex h-14 w-14 items-center justify-center border border-accent/40 bg-accent-bg text-accent">
                <span className="material-symbols-outlined">key</span>
              </div>
              <div>
                <h2 className="text-2xl font-semibold text-white">Hosted MCP Access Token</h2>
                <p className="mt-2 text-sm text-text-muted">
                  One wallet signature issues a valid hosted AIR OTC MCP token for all trade-agent tools.
                </p>
              </div>
            </div>

            <div className="mt-8 grid gap-5 md:grid-cols-2">
              <label className="block">
                <span className="font-mono text-xs font-bold uppercase tracking-[0.28em] text-accent-secondary">
                  Scope preset
                </span>
                <select
                  value={scopePreset}
                  onChange={(event) => setScopePreset(event.target.value as keyof typeof scopePresets)}
                  className="mt-3 w-full border border-border-subtle bg-bg-highest px-4 py-4 font-mono text-sm text-text-primary focus-visible:border-accent focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg-card"
                >
                  {Object.entries(scopePresets).map(([key, preset]) => (
                    <option key={key} value={key}>{preset.label}</option>
                  ))}
                </select>
              </label>

              <label className="block">
                <span className="font-mono text-xs font-bold uppercase tracking-[0.28em] text-accent-secondary">
                  Expires
                </span>
                <select
                  value={expiresInSeconds}
                  onChange={(event) => setExpiresInSeconds(Number(event.target.value))}
                  className="mt-3 w-full border border-border-subtle bg-bg-highest px-4 py-4 font-mono text-sm text-text-primary focus-visible:border-accent focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg-card"
                >
                  {expiryOptions.map((option) => (
                    <option key={option.seconds} value={option.seconds}>{option.label}</option>
                  ))}
                </select>
              </label>
            </div>

            <div className="mt-6 flex flex-wrap gap-3">
              <select
                value={providerId}
                onChange={(event) => {
                  setProviderId(event.target.value);
                  setWallet("");
                  setIssued(null);
                }}
                className="min-h-11 min-w-52 border border-border-subtle bg-bg-highest px-4 py-3 font-mono text-sm text-text-primary focus-visible:border-accent focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg-card"
              >
                {providers.length > 0 ? providers.map((provider) => (
                  <option key={provider.id} value={provider.id}>{provider.label}</option>
                )) : (
                  <option value="">No wallet detected</option>
                )}
              </select>
              <button
                type="button"
                onClick={connectWallet}
                disabled={!selectedProvider || busy}
                className="min-h-11 border border-border-subtle bg-bg-elevated px-5 py-3 font-mono text-sm text-text-secondary transition-colors hover:border-accent hover:text-accent focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg-card disabled:cursor-not-allowed disabled:opacity-50"
              >
                {wallet ? shortWallet(wallet) : "Connect wallet"}
              </button>
            </div>

            <button
              type="button"
              onClick={generateToken}
              disabled={!selectedProvider || busy}
              aria-busy={busy}
              className="mt-8 inline-flex min-h-14 items-center gap-3 bg-accent px-7 py-4 font-mono text-sm font-bold uppercase tracking-[0.18em] text-bg-root transition-opacity hover:opacity-90 focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg-card disabled:cursor-not-allowed disabled:opacity-60"
            >
              <span className="material-symbols-outlined text-base">
                {busy ? "progress_activity" : "verified_user"}
              </span>
              {busy ? "Generating token" : "Generate valid token"}
            </button>

            {error && (
              <div role="alert" className="mt-6 border border-error/50 bg-error/10 px-4 py-3 text-sm text-error">
                {error}
              </div>
            )}

            <div className="mt-8 border border-border-subtle bg-bg-highest p-5">
              {issued ? (
                <div className="space-y-5">
                  <div>
                    <div className="mb-2 flex items-center justify-between gap-4">
                      <span className="font-mono text-xs uppercase tracking-[0.24em] text-text-muted">MCP URL</span>
                      <button type="button" onClick={() => copy("url", issued.mcpUrl || DEFAULT_MCP_URL)} className="min-h-10 px-2 text-xs font-bold uppercase tracking-wider text-accent focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg-highest">
                        {copied === "url" ? "Copied" : "Copy"}
                      </button>
                    </div>
                    <pre className="overflow-x-auto whitespace-pre-wrap break-all bg-bg-surface p-3 font-mono text-xs text-text-secondary">
                      {issued.mcpUrl || DEFAULT_MCP_URL}
                    </pre>
                  </div>
                  <div>
                    <div className="mb-2 flex items-center justify-between gap-4">
                      <span className="font-mono text-xs uppercase tracking-[0.24em] text-text-muted">Auth token</span>
                      <button type="button" onClick={() => copy("token", issued.token)} className="min-h-10 px-2 text-xs font-bold uppercase tracking-wider text-accent focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg-highest">
                        {copied === "token" ? "Copied" : "Copy"}
                      </button>
                    </div>
                    <pre className="max-h-44 overflow-auto whitespace-pre-wrap break-all bg-bg-surface p-3 font-mono text-xs text-text-secondary">
                      {issued.token}
                    </pre>
                  </div>
                </div>
              ) : (
                <p className="text-sm text-text-muted">No MCP token issued in this browser session.</p>
              )}
            </div>
          </section>

          <aside className="border border-border-subtle bg-bg-elevated p-6">
            <p className="font-mono text-xs font-bold uppercase tracking-[0.28em] text-accent-secondary">
              Token details
            </p>
            <dl className="mt-6 space-y-5 font-mono text-sm">
              <div className="flex justify-between gap-4 border-b border-border-subtle/40 pb-4">
                <dt className="text-text-muted">Format</dt>
                <dd className="text-text-secondary">airotc_sk</dd>
              </div>
              <div className="flex justify-between gap-4 border-b border-border-subtle/40 pb-4">
                <dt className="text-text-muted">Wallet</dt>
                <dd className="text-text-secondary">{wallet ? shortWallet(wallet) : "Not connected"}</dd>
              </div>
              <div className="flex justify-between gap-4 border-b border-border-subtle/40 pb-4">
                <dt className="text-text-muted">Scope</dt>
                <dd className="text-text-secondary">{scopePresets[scopePreset].label}</dd>
              </div>
              <div className="border-b border-border-subtle/40 pb-4">
                <dt className="text-text-muted">Scopes</dt>
                <dd className="mt-2 break-words text-text-secondary">{scopes.join(", ")}</dd>
              </div>
              <div className="flex justify-between gap-4 border-b border-border-subtle/40 pb-4">
                <dt className="text-text-muted">Server</dt>
                <dd className="text-right text-text-secondary">Hosted AIR OTC MCP</dd>
              </div>
            </dl>
            <a
              href="/docs"
              className="mt-7 flex min-h-12 items-center justify-center border border-border-subtle font-mono text-xs font-bold uppercase tracking-[0.2em] text-text-secondary transition-colors hover:border-accent hover:text-accent focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg-elevated"
            >
              MCP docs
            </a>
          </aside>
        </div>
      </section>
    </main>
  );
}
