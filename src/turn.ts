// TURN relays as NebulaNet hands them out: the servers' lines, Cloudflare's credentials, and the monthly budget that
// keeps Cloudflare's TURN inside its free allowance. Pure functions with no Cloudflare APIs, so the tests run them
// under plain Node; relay.ts does the calls.

export interface TurnServer {
  host: string;
  port: number;
  username: string;
  password: string;
}

// Cloudflare's TURN egress (the bytes its relays send to the games that asked for them) is free up to 1,000 GB a
// month and costs $0.05/GB after that. NebulaNet stops at this many GB unless RELAY_BUDGET_GB says otherwise: the
// rest is room for the relays still in use while the next check comes (BUDGET_CHECK_MS).
export const DEFAULT_BUDGET_GB = 900;
// The free allowance itself: a budget is never above it.
export const FREE_GB = 1000;
// How long Cloudflare credentials last (its most is 48 hours): a relayed session longer than this ends.
export const CREDENTIAL_TTL_S = 86_400;
// How often the month's usage is asked while relays are in use, and how stale an answer a new relay may go by.
export const BUDGET_CHECK_MS = 10 * 60_000;
// Relays one address may ask for an hour (a household's games trying a few times, not a script).
export const RELAYS_PER_HOUR = 12;
// Credentials revoked in one go (a Worker's subrequests are limited); more wait for the next alarm.
export const REVOKE_BATCH = 40;

const GB = 1_000_000_000;

function hostPort(text: string): { host: string; port: number } | null {
  const colon = text.lastIndexOf(":");
  const port = Number(text.slice(colon + 1));
  const host = text.slice(0, colon);
  return colon > 0 && Number.isInteger(port) && port > 0 && port < 65536 && host.length > 0 ? { host, port } : null;
}

// CoopNet's turn-servers.cfg: one "host:user:pass:port" a line, or commas between them.
export function parseTurnServers(text: string | undefined): TurnServer[] {
  const out: TurnServer[] = [];
  for (const line of (text ?? "").split(/[\n,]/)) {
    const parts = line.trim().split(":");
    if (parts.length !== 4 || parts[0] === "") continue;
    const port = Number(parts[3]);
    if (!Number.isInteger(port) || port < 1 || port > 65535) continue;
    out.push({ host: parts[0], username: parts[1], password: parts[2], port });
  }
  return out;
}

// The UDP TURN servers in Cloudflare's answer to credentials/generate-ice-servers ({"iceServers":[…]}, or one
// object as credentials/generate answers), each once, with the username that revokes them.
export function parseIceServers(body: unknown): TurnServer[] {
  const root = body as { iceServers?: unknown } | null;
  const list = Array.isArray(root?.iceServers) ? root.iceServers : root?.iceServers ? [root.iceServers] : [];
  const out: TurnServer[] = [];
  for (const item of list) {
    const server = item as { urls?: unknown; username?: unknown; credential?: unknown };
    if (typeof server.username !== "string" || typeof server.credential !== "string") continue;
    const urls = Array.isArray(server.urls) ? server.urls : typeof server.urls === "string" ? [server.urls] : [];
    for (const url of urls) {
      if (typeof url !== "string") continue;
      // Plain UDP TURN only ("turn:turn.cloudflare.com:3478?transport=udp"): that's what Nebula relays over.
      const match = /^turn:([^?]+)(\?transport=udp)?$/.exec(url);
      const at = match === null ? null : hostPort(match[1]);
      if (at === null) continue;
      if (out.some((other) => other.host === at.host && other.port === at.port)) continue;
      out.push({ ...at, username: server.username, password: server.credential });
    }
  }
  return out;
}

// The budget in bytes: RELAY_BUDGET_GB when it's a number from 0 to the free allowance, else the default.
export function budgetBytes(setting: string | undefined): number {
  const gb = setting === undefined || setting.trim() === "" ? NaN : Number(setting);
  const chosen = Number.isFinite(gb) && gb >= 0 && gb <= FREE_GB ? gb : DEFAULT_BUDGET_GB;
  return chosen * GB;
}

// The month a time falls in, as the analytics take it: its first day and that time's day ("2026-11-01", "2026-11-18").
export function monthOf(now: number): { month: string; from: string; to: string } {
  const day = new Date(now).toISOString().slice(0, 10);
  return { month: day.slice(0, 7), from: `${day.slice(0, 7)}-01`, to: day };
}

// The GraphQL query for the account's TURN egress from `from` to `to` (inclusive days), or null when the account id
// isn't one (it goes into the query as text).
export function usageQuery(account: string, from: string, to: string): string | null {
  if (!/^[0-9a-f]{32}$/.test(account) || !/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) {
    return null;
  }
  return `{ viewer { accounts(filter: { accountTag: "${account}" }) { callsTurnUsageAdaptiveGroups(` +
    `filter: { date_geq: "${from}", date_leq: "${to}" }, limit: 1) { sum { egressBytes } } } } }`;
}

// The egress bytes in the analytics' answer, or null when it's an error or not that shape. No rows: none used.
export function parseUsage(body: unknown): number | null {
  const root = body as { data?: unknown; errors?: unknown } | null;
  if (root === null || typeof root !== "object" || (Array.isArray(root.errors) && root.errors.length > 0)) return null;
  const accounts = (root.data as { viewer?: { accounts?: unknown } } | undefined)?.viewer?.accounts;
  if (!Array.isArray(accounts) || accounts.length === 0) return null;
  const groups = (accounts[0] as { callsTurnUsageAdaptiveGroups?: unknown }).callsTurnUsageAdaptiveGroups;
  if (!Array.isArray(groups)) return null;
  let total = 0;
  for (const group of groups) {
    const bytes = (group as { sum?: { egressBytes?: unknown } }).sum?.egressBytes;
    if (typeof bytes !== "number" || !Number.isFinite(bytes) || bytes < 0) return null;
    total += bytes;
  }
  return total;
}

// Whether `asker` may have another relay this hour; `times` is when it had the others (kept, for the next ask).
export function mayRelay(times: number[], now: number): { ok: boolean; times: number[] } {
  const recent = times.filter((at) => now - at < 3_600_000);
  if (recent.length >= RELAYS_PER_HOUR) return { ok: false, times: recent };
  return { ok: true, times: [...recent, now] };
}
