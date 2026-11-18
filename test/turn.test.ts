import assert from "node:assert/strict";
import { test } from "node:test";
import { parseRelayRequest, parseReport } from "../src/protocol.ts";
import {
  DEFAULT_BUDGET_GB,
  RELAYS_PER_HOUR,
  budgetBytes,
  mayRelay,
  monthOf,
  parseIceServers,
  parseTurnServers,
  parseUsage,
  usageQuery,
} from "../src/turn.ts";

test("a joiner asks for a relay, then says where it is", () => {
  assert.deepEqual(parseRelayRequest('{"code":"k7qx2m","password":"pw","protocol":2}'),
    { code: "K7QX2M", password: "pw", protocol: 2, relay: null });
  assert.deepEqual(parseRelayRequest('{"code":"K7QX2M","relay":"104.30.1.2:40000"}'),
    { code: "K7QX2M", password: "", protocol: 1, relay: "104.30.1.2:40000" });
  assert.equal(parseRelayRequest('{"code":"K7QX2M","relay":"turn.cloudflare.com:3478"}'), null, "addresses only");
  assert.equal(parseRelayRequest('{"code":"K7QX2M","relay":5}'), null);
  assert.equal(parseRelayRequest('{"relay":"1.2.3.4:5"}'), null, "a code is needed");
});

test("a report may say the join was relayed", () => {
  assert.equal(parseReport('{"code":"K7QX2M","ok":true,"relayed":true}')?.relayed, true);
  assert.equal(parseReport('{"code":"K7QX2M","ok":true}')?.relayed, false);
});

test("TURN_SERVERS reads CoopNet's turn-servers.cfg lines", () => {
  assert.deepEqual(parseTurnServers("turn.example.com:user:pass:3478\nbad line, other.example:u:p:70000,b.example:u:p:3479"), [
    { host: "turn.example.com", username: "user", password: "pass", port: 3478 },
    { host: "b.example", username: "u", password: "p", port: 3479 },
  ]);
  assert.deepEqual(parseTurnServers(undefined), []);
});

test("Cloudflare's credentials give the UDP TURN servers", () => {
  const answer = {
    iceServers: [
      { urls: ["stun:stun.cloudflare.com:3478"] },
      {
        urls: [
          "turn:turn.cloudflare.com:3478?transport=udp",
          "turn:turn.cloudflare.com:3478?transport=tcp",
          "turns:turn.cloudflare.com:443?transport=tcp",
          "turn:turn.cloudflare.com:443?transport=udp",
          "turn:turn.cloudflare.com:3478",
        ],
        username: "u1",
        credential: "c1",
      },
    ],
  };
  assert.deepEqual(parseIceServers(answer), [
    { host: "turn.cloudflare.com", port: 3478, username: "u1", password: "c1" },
    { host: "turn.cloudflare.com", port: 443, username: "u1", password: "c1" },
  ]);
  // credentials/generate answers one object.
  assert.equal(parseIceServers({ iceServers: { urls: "turn:a.example:3478?transport=udp", username: "u", credential: "c" } })
    .length, 1);
  assert.deepEqual(parseIceServers({}), []);
  assert.deepEqual(parseIceServers(null), []);
});

test("the budget stays inside the free allowance", () => {
  assert.equal(budgetBytes(undefined), DEFAULT_BUDGET_GB * 1e9);
  assert.equal(budgetBytes("500"), 500e9);
  assert.equal(budgetBytes("0"), 0, "0 turns Cloudflare relays off");
  assert.equal(budgetBytes("5000"), DEFAULT_BUDGET_GB * 1e9, "never past the free 1,000 GB");
  assert.equal(budgetBytes("lots"), DEFAULT_BUDGET_GB * 1e9);
});

test("the month's usage is asked from its first day", () => {
  assert.deepEqual(monthOf(Date.UTC(2026, 10, 18, 20, 0)), { month: "2026-11", from: "2026-11-01", to: "2026-11-18" });
  const query = usageQuery("0123456789abcdef0123456789abcdef", "2026-11-01", "2026-11-18");
  assert.ok(query?.includes('accountTag: "0123456789abcdef0123456789abcdef"'));
  assert.ok(query?.includes('date_geq: "2026-11-01"') && query.includes("egressBytes"));
  assert.equal(usageQuery('x" } evil', "2026-11-01", "2026-11-18"), null);
});

test("the analytics' answer gives the egress, or nothing when it failed", () => {
  const groups = (bytes: unknown[]) => ({
    data: { viewer: { accounts: [{ callsTurnUsageAdaptiveGroups: bytes.map((b) => ({ sum: { egressBytes: b } })) }] } },
    errors: null,
  });
  assert.equal(parseUsage(groups([160040068147])), 160040068147);
  assert.equal(parseUsage(groups([])), 0, "no rows: nothing used yet");
  assert.equal(parseUsage(groups(["1"])), null);
  assert.equal(parseUsage({ data: null, errors: [{ message: "not authorized" }] }), null);
  assert.equal(parseUsage(null), null);
});

test("an address gets a few relays an hour", () => {
  let times: number[] = [];
  for (let i = 0; i < RELAYS_PER_HOUR; ++i) {
    const rate = mayRelay(times, 1_000 + i);
    assert.ok(rate.ok);
    times = rate.times;
  }
  assert.equal(mayRelay(times, 2_000).ok, false);
  assert.ok(mayRelay(times, 1_000 + 3_600_000).ok, "an hour later");
});
