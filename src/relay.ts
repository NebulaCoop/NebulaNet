// The relays (CoopNet's TURN servers, for joins that can't punch through) and their budget: one Durable Object that
// hands out TURN credentials to joiners who asked, and keeps Cloudflare's TURN inside its free allowance. It asks
// Cloudflare's analytics how many bytes its relays sent this month before each new relay (at most every
// BUDGET_CHECK_MS) and, while any relay is in use, every BUDGET_CHECK_MS; past the budget it hands out no more and
// revokes the credentials in use, which ends those relays (turn.ts has the numbers).
//
// Without CF_ACCOUNT_ID and CF_ANALYTICS_TOKEN it can't know the usage, so it hands out no Cloudflare credentials at
// all: a relay never costs money by surprise. TURN_SERVERS (a server of one's own) need neither.
import { DurableObject } from "cloudflare:workers";
import {
  BUDGET_CHECK_MS,
  CREDENTIAL_TTL_S,
  REVOKE_BATCH,
  type TurnServer,
  budgetBytes,
  mayRelay,
  monthOf,
  parseIceServers,
  parseTurnServers,
  parseUsage,
  usageQuery,
} from "./turn.ts";

export interface RelayEnv {
  TURN_SERVERS?: string;
  TURN_KEY_ID?: string;
  TURN_KEY_API_TOKEN?: string;
  CF_ACCOUNT_ID?: string;
  CF_ANALYTICS_TOKEN?: string;
  RELAY_BUDGET_GB?: string;
}

export type RelayAnswer = { turn: TurnServer[] } | { error: "busy" | "no_relay" };

export interface RelayUsage {
  month: string;
  used_gb: number | null;  // null: not known (no analytics token, or Cloudflare didn't answer)
  budget_gb: number;
  live: number;            // credentials handed out and not yet expired
  open: boolean;           // whether a joiner asking now would get a Cloudflare relay
}

export class RelayBudget extends DurableObject<RelayEnv> {
  private asked = new Map<string, number[]>();

  constructor(ctx: DurableObjectState, env: RelayEnv) {
    super(ctx, env);
    ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS credentials (username TEXT PRIMARY KEY, expires INTEGER NOT NULL)`);
    ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS usage (
      id INTEGER PRIMARY KEY CHECK (id = 1), month TEXT NOT NULL, bytes INTEGER NOT NULL, checked INTEGER NOT NULL)`);
  }

  private cloudflare(): boolean {
    return Boolean(this.env.TURN_KEY_ID && this.env.TURN_KEY_API_TOKEN);
  }

  private analytics(): boolean {
    return Boolean(this.env.CF_ACCOUNT_ID && this.env.CF_ANALYTICS_TOKEN);
  }

  // The month's egress as last asked: { month, bytes, checked }, or null.
  private stored(): { month: string; bytes: number; checked: number } | null {
    return this.ctx.storage.sql.exec<{ month: string; bytes: number; checked: number }>(
      "SELECT month, bytes, checked FROM usage WHERE id = 1").toArray()[0] ?? null;
  }

  // This month's egress in bytes, asked again when the last answer is older than `fresh` ms (or from another month).
  // Null when it can't be known: then no Cloudflare relay is handed out.
  private async used(now: number, fresh: number): Promise<number | null> {
    if (!this.analytics()) return null;
    const { month, from, to } = monthOf(now);
    const last = this.stored();
    if (last !== null && last.month === month && now - last.checked < fresh) return last.bytes;
    const query = usageQuery(this.env.CF_ACCOUNT_ID ?? "", from, to);
    if (query === null) return null;
    try {
      const answer = await fetch("https://api.cloudflare.com/client/v4/graphql", {
        method: "POST",
        headers: { authorization: `Bearer ${this.env.CF_ANALYTICS_TOKEN}`, "content-type": "application/json" },
        body: JSON.stringify({ query }),
      });
      const bytes = answer.ok ? parseUsage(await answer.json()) : null;
      if (bytes === null) {
        console.log(`relay: Cloudflare's TURN analytics answered ${answer.status} without a usage`);
        // A month already known to be over stays over; otherwise unknown means closed.
        return last !== null && last.month === month && last.bytes >= this.budget() ? last.bytes : null;
      }
      this.ctx.storage.sql.exec(
        `INSERT INTO usage (id, month, bytes, checked) VALUES (1, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET month = excluded.month, bytes = excluded.bytes, checked = excluded.checked`,
        month, bytes, now);
      return bytes;
    } catch (error) {
      console.log(`relay: Cloudflare's TURN analytics could not be reached: ${String(error)}`);
      return null;
    }
  }

  private budget(): number {
    return budgetBytes(this.env.RELAY_BUDGET_GB);
  }

  private live(now: number): number {
    return this.ctx.storage.sql.exec<{ n: number }>(
      "SELECT COUNT(*) AS n FROM credentials WHERE expires > ?", now).one().n;
  }

  // A joiner's relays: TURN_SERVERS, and a fresh Cloudflare credential while the month is inside its budget.
  // `asker` is its address, hashed.
  async issue(asker: string): Promise<RelayAnswer> {
    const now = Date.now();
    const rate = mayRelay(this.asked.get(asker) ?? [], now);
    this.asked.set(asker, rate.times);
    if (this.asked.size > 10_000) this.asked.clear();  // memory stays bounded; the limit is a courtesy
    if (!rate.ok) return { error: "busy" };
    const turn = parseTurnServers(this.env.TURN_SERVERS);
    if (this.cloudflare()) {
      const used = await this.used(now, BUDGET_CHECK_MS);
      if (used === null) {
        if (!this.analytics()) console.log("relay: CF_ACCOUNT_ID and CF_ANALYTICS_TOKEN aren't set: no Cloudflare relays");
      } else if (used >= this.budget()) {
        console.log(`relay: this month's TURN budget is used (${used} bytes): no Cloudflare relays until next month`);
      } else {
        turn.push(...await this.generate(now));
      }
    }
    return turn.length === 0 ? { error: "no_relay" } : { turn };
  }

  private async generate(now: number): Promise<TurnServer[]> {
    try {
      const answer = await fetch(
        `https://rtc.live.cloudflare.com/v1/turn/keys/${this.env.TURN_KEY_ID}/credentials/generate-ice-servers`, {
          method: "POST",
          headers: { authorization: `Bearer ${this.env.TURN_KEY_API_TOKEN}`, "content-type": "application/json" },
          body: JSON.stringify({ ttl: CREDENTIAL_TTL_S }),
        });
      if (!answer.ok) {
        console.log(`relay: Cloudflare TURN answered ${answer.status} for credentials`);
        return [];
      }
      const servers = parseIceServers(await answer.json());
      for (const username of new Set(servers.map((server) => server.username))) {
        this.ctx.storage.sql.exec(
          "INSERT OR REPLACE INTO credentials (username, expires) VALUES (?, ?)", username,
          now + CREDENTIAL_TTL_S * 1000);
      }
      if (servers.length > 0 && (await this.ctx.storage.getAlarm()) === null) {
        await this.ctx.storage.setAlarm(now + BUDGET_CHECK_MS);
      }
      return servers;
    } catch (error) {
      console.log(`relay: Cloudflare TURN could not be reached: ${String(error)}`);
      return [];
    }
  }

  // While relays are in use: the month's usage again, and past the budget their credentials revoked.
  override async alarm(): Promise<void> {
    const now = Date.now();
    this.ctx.storage.sql.exec("DELETE FROM credentials WHERE expires <= ?", now);
    if (this.live(now) === 0) return;
    const used = await this.used(now, 0);
    let next = now + BUDGET_CHECK_MS;
    if (used !== null && used >= this.budget()) {
      const rows = this.ctx.storage.sql.exec<{ username: string }>(
        "SELECT username FROM credentials WHERE expires > ? LIMIT ?", now, REVOKE_BATCH).toArray();
      console.log(`relay: this month's TURN budget is used (${used} bytes): ending ${rows.length} relays`);
      for (const { username } of rows) {
        try {
          const answer = await fetch(
            `https://rtc.live.cloudflare.com/v1/turn/keys/${this.env.TURN_KEY_ID}/credentials/` +
              `${encodeURIComponent(username)}/revoke`,
            { method: "POST", headers: { authorization: `Bearer ${this.env.TURN_KEY_API_TOKEN}` } });
          // 204: revoked; 404: already gone. Anything else is tried again next time.
          if (answer.status === 204 || answer.status === 404) {
            this.ctx.storage.sql.exec("DELETE FROM credentials WHERE username = ?", username);
          }
        } catch {
          // tried again next time
        }
      }
      if (this.live(now) > 0) next = now + 60_000;
    }
    if (this.live(now) > 0) await this.ctx.storage.setAlarm(next);
  }

  // For /v1/stats: the month's relay use as last known.
  usage(): RelayUsage {
    const now = Date.now();
    const { month } = monthOf(now);
    const last = this.stored();
    const used = last !== null && last.month === month ? last.bytes : null;
    const budget = this.budget();
    return {
      month,
      used_gb: used === null ? null : Math.round(used / 1e7) / 100,
      budget_gb: budget / 1e9,
      live: this.live(now),
      open: (this.cloudflare() && this.analytics() && (used === null || used < budget)) ||
        parseTurnServers(this.env.TURN_SERVERS).length > 0,
    };
  }
}
