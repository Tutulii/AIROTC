"use client";

import { useEffect, useState } from "react";
import { RefreshCw } from "lucide-react";
import {
  fetchHealth,
  fetchMcpConfig,
  getApiBase,
  issueMcpToken,
  requestMcpTokenMessage,
  type McpConfig,
  type McpTokenIssueResponse,
} from "@/lib/api";
import { BrandMark } from "@/components/BrandMark";
import { SiteNav } from "@/components/SiteNav";
import { shortWallet } from "@/lib/sport-utils";

type SolanaPublicKeyLike =
  | string
  | {
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
  process.env.NEXT_PUBLIC_MCP_URL || "https://airarena-mcp-production.up.railway.app/mcp";

const DEFAULT_SCOPES = [
  "offers:read",
  "offers:write",
  "deals:read",
  "dm:read",
  "dm:write",
  "per:run",
  "proofs:read",
  "vault:read",
  "umbra:read",
];

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

function connectedPublicKey(
  provider: SolanaProvider,
  response: SolanaConnectResponse
): string | null {
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
  const signature =
    signed instanceof Uint8Array || Array.isArray(signed) ? signed : signed.signature;
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
  return candidates.filter(
    (c): c is { id: string; label: string; provider: SolanaProvider } => {
      if (!c.provider || seen.has(c.provider)) return false;
      seen.add(c.provider);
      return true;
    }
  );
}

function formatExpiry(unix?: number): string {
  if (!unix) return "—";
  return new Date(unix * 1000).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export default function McpTokenPage() {
  const [apiOnline, setApiOnline] = useState(false);
  const [config, setConfig] = useState<McpConfig | null>(null);
  const [providers, setProviders] = useState(() => detectedProviders());
  const [providerId, setProviderId] = useState(providers[0]?.id || "");
  const [wallet, setWallet] = useState("");
  const [expiresInSeconds, setExpiresInSeconds] = useState(expiryOptions[1].seconds);
  const [issued, setIssued] = useState<McpTokenIssueResponse | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState("");
  const [error, setError] = useState("");

  const selectedProvider = providers.find((p) => p.id === providerId)?.provider;
  const scopes = config?.scopePresets?.trade?.length
    ? config.scopePresets.trade
    : DEFAULT_SCOPES;
  const mcpUrl = issued?.mcpUrl || config?.mcpUrl || DEFAULT_MCP_URL;

  useEffect(() => {
    void (async () => {
      try {
        await fetchHealth();
        setApiOnline(true);
        const cfg = await fetchMcpConfig();
        setConfig(cfg);
        if (cfg?.defaultExpiresInSeconds) {
          setExpiresInSeconds(cfg.defaultExpiresInSeconds);
        }
      } catch {
        setApiOnline(false);
      }
    })();
  }, []);

  useEffect(() => {
    const refreshProviders = () => setProviders(detectedProviders());
    const timers = [100, 500, 1000, 2000].map((delay) => window.setTimeout(refreshProviders, delay));
    window.addEventListener("load", refreshProviders);
    refreshProviders();
    return () => {
      timers.forEach((t) => window.clearTimeout(t));
      window.removeEventListener("load", refreshProviders);
    };
  }, []);

  useEffect(() => {
    if (!providers.length) {
      setProviderId("");
      setWallet("");
      return;
    }
    if (!providerId || !providers.some((p) => p.id === providerId)) {
      setProviderId(providers[0].id);
      setWallet("");
      setIssued(null);
    }
  }, [providerId, providers]);

  async function connectWallet(): Promise<{ provider: SolanaProvider; publicKey: string }> {
    if (!selectedProvider) {
      throw new Error("Install Phantom, Solflare, or Bitget and open this page in a desktop browser.");
    }
    const response = await selectedProvider.connect();
    const publicKey = connectedPublicKey(selectedProvider, response);
    if (!publicKey) {
      throw new Error("Wallet connected but did not expose a public key. Unlock and retry.");
    }
    setWallet(publicKey);
    return { provider: selectedProvider, publicKey };
  }

  async function generateToken() {
    setBusy(true);
    setError("");
    setCopied("");
    try {
      const { provider, publicKey } =
        wallet && selectedProvider
          ? { provider: selectedProvider, publicKey: wallet }
          : await connectWallet();

      const tokenMessage = await requestMcpTokenMessage({
        publicKey,
        scopes: [...scopes],
        expiresInSeconds,
      });

      if (!provider.signMessage) {
        throw new Error("Selected wallet does not support message signing.");
      }

      const encoded = new TextEncoder().encode(tokenMessage.message);
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
    window.setTimeout(() => setCopied((c) => (c === label ? "" : c)), 2000);
  }

  return (
    <div className="shell">
      <header className="sticky top-0 z-30 border-b border-[var(--line)] bg-[rgba(13,16,16,0.92)] backdrop-blur-md">
        <div className="site-header-bar">
          <div className="site-header-start">
            <BrandMark />
          </div>
          <div className="site-header-center">
            <SiteNav />
          </div>
          <div className="site-header-end">
            <div className="meta flex items-center gap-1.5">
              <span
                className={`h-1.5 w-1.5 rounded-full ${
                  apiOnline ? "bg-[var(--ok)]" : "bg-[var(--danger)]"
                }`}
              />
              <span className={apiOnline ? "meta-ok" : ""}>
                {apiOnline ? "API" : "OFF"}
              </span>
            </div>
          </div>
        </div>
      </header>

      <main className="mx-auto w-full max-w-[1100px] flex-1 px-4 py-8 md:px-6 md:py-10">
        <div className="mb-8 max-w-2xl">
          <p className="meta meta-accent">Agent access</p>
          <h2 className="mt-2 font-display text-3xl tracking-tight text-[var(--text)] md:text-4xl">
            MCP token
          </h2>
          <p className="mt-3 text-sm leading-relaxed text-[var(--text-2)]">
            Connect a Solana wallet, sign once, and copy a hosted AIR OTC MCP token for
            trade agents. No secrets are stored in this UI beyond this browser session.
          </p>
        </div>

        <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_300px]">
          {/* Issue form */}
          <section className="chart-shell p-5 md:p-6">
            <h3 className="meta meta-accent">Issue token</h3>
            <p className="mt-1 text-[0.8rem] text-[var(--text-3)]">
              Trade-agent scopes · wallet signature required
            </p>

            <div className="mt-6 grid gap-4 sm:grid-cols-2">
              <label className="block">
                <span className="meta">Wallet provider</span>
                <select
                  value={providerId}
                  onChange={(e) => {
                    setProviderId(e.target.value);
                    setWallet("");
                    setIssued(null);
                  }}
                  className="mt-2 w-full border border-[var(--line)] bg-[var(--surface-2)] px-3 py-2.5 font-mono text-[0.8rem] text-[var(--text)] outline-none focus-visible:border-[var(--gold)]"
                >
                  {providers.length > 0 ? (
                    providers.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.label}
                      </option>
                    ))
                  ) : (
                    <option value="">No wallet detected</option>
                  )}
                </select>
              </label>

              <label className="block">
                <span className="meta">Expires</span>
                <select
                  value={expiresInSeconds}
                  onChange={(e) => setExpiresInSeconds(Number(e.target.value))}
                  className="mt-2 w-full border border-[var(--line)] bg-[var(--surface-2)] px-3 py-2.5 font-mono text-[0.8rem] text-[var(--text)] outline-none focus-visible:border-[var(--gold)]"
                >
                  {expiryOptions.map((opt) => (
                    <option key={opt.seconds} value={opt.seconds}>
                      {opt.label}
                    </option>
                  ))}
                </select>
              </label>
            </div>

            <div className="mt-4 flex flex-wrap gap-2">
              <button
                type="button"
                onClick={() => void connectWallet().catch((err) => setError(err.message))}
                disabled={!selectedProvider || busy}
                className="btn-ghost disabled:cursor-not-allowed disabled:opacity-50"
              >
                {wallet ? shortWallet(wallet, 5) : "Connect wallet"}
              </button>
              <button
                type="button"
                onClick={() => void generateToken()}
                disabled={!selectedProvider || busy}
                aria-busy={busy}
                className="inline-flex min-h-9 items-center gap-2 border border-[var(--gold)] bg-[var(--accent-soft)] px-4 font-mono text-[0.7rem] font-medium uppercase tracking-[0.1em] text-[var(--gold)] transition-colors hover:bg-[rgba(216,178,76,0.2)] focus-visible:outline focus-visible:outline-1 focus-visible:outline-[var(--gold)] disabled:cursor-not-allowed disabled:opacity-50"
              >
                {busy ? (
                  <>
                    <RefreshCw className="h-3.5 w-3.5 animate-spin" aria-hidden />
                    Signing…
                  </>
                ) : (
                  "Generate token"
                )}
              </button>
            </div>

            {error && (
              <div
                role="alert"
                className="mt-4 border border-[rgba(217,122,30,0.4)] bg-[rgba(217,122,30,0.08)] px-3 py-2.5 text-sm text-[var(--orange)]"
              >
                {error}
              </div>
            )}

            <div className="mt-6 border border-[var(--line)] bg-[var(--bg)] p-4">
              {issued ? (
                <div className="space-y-4">
                  <div>
                    <div className="mb-1.5 flex items-center justify-between gap-2">
                      <span className="meta">MCP URL</span>
                      <button
                        type="button"
                        className="meta meta-accent hover:underline"
                        onClick={() => void copy("url", issued.mcpUrl || mcpUrl)}
                      >
                        {copied === "url" ? "Copied" : "Copy"}
                      </button>
                    </div>
                    <pre className="num overflow-x-auto whitespace-pre-wrap break-all text-[0.7rem] text-[var(--text-2)]">
                      {issued.mcpUrl || mcpUrl}
                    </pre>
                  </div>
                  <div>
                    <div className="mb-1.5 flex items-center justify-between gap-2">
                      <span className="meta">Auth token</span>
                      <button
                        type="button"
                        className="meta meta-accent hover:underline"
                        onClick={() => void copy("token", issued.token)}
                      >
                        {copied === "token" ? "Copied" : "Copy"}
                      </button>
                    </div>
                    <pre className="num max-h-40 overflow-auto whitespace-pre-wrap break-all text-[0.7rem] text-[var(--text-2)]">
                      {issued.token}
                    </pre>
                  </div>
                  <div className="meta flex flex-wrap gap-3 text-[var(--text-3)]">
                    <span>Format · {issued.tokenFormat}</span>
                    <span>Expires · {formatExpiry(issued.expiresAt)}</span>
                  </div>
                </div>
              ) : (
                <p className="text-sm text-[var(--text-3)]">
                  No token issued in this browser session yet.
                </p>
              )}
            </div>
          </section>

          {/* Details */}
          <aside className="chart-shell h-fit p-5">
            <h3 className="meta meta-accent">Details</h3>
            <dl className="mt-4 space-y-3 text-[0.8rem]">
              {[
                ["API", getApiBase()],
                ["Format", config?.tokenFormat || "airotc_sk"],
                ["Wallet", wallet ? shortWallet(wallet, 5) : "Not connected"],
                ["Preset", "Trade agent"],
                ["Issuer", config?.tokenIssuerReady === false ? "Not ready" : "Ready"],
              ].map(([k, v]) => (
                <div
                  key={k}
                  className="flex justify-between gap-3 border-b border-[var(--line)] pb-2.5 last:border-0"
                >
                  <dt className="text-[var(--text-3)]">{k}</dt>
                  <dd className="num text-right text-[var(--text)]">{v}</dd>
                </div>
              ))}
            </dl>
            <div className="mt-4">
              <p className="meta mb-2">Scopes</p>
              <ul className="space-y-1">
                {scopes.map((scope) => (
                  <li key={scope} className="num text-[0.7rem] text-[var(--text-2)]">
                    {scope}
                  </li>
                ))}
              </ul>
            </div>
            <p className="mt-5 text-[0.7rem] leading-relaxed text-[var(--text-3)]">
              Paste the MCP URL and Bearer token into Claude Desktop, Cursor, or any
              MCP-compatible agent client.
            </p>
          </aside>
        </div>
      </main>

      <footer className="border-t border-[var(--line)]">
        <div className="mx-auto flex max-w-[1680px] flex-wrap items-center justify-between gap-2 px-4 py-2 text-[0.65rem] text-[var(--text-3)] md:px-6">
          <span className="num text-[var(--text-2)]">AIR Arena · MCP</span>
          <span className="meta">wallet sign · airotc_sk</span>
        </div>
      </footer>
    </div>
  );
}
