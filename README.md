# NebulaNet

Online services for Nebula co-op. NebulaNet lets friends join a room by a short code with no port forwarding, the
way sm64coopdx's CoopNet does. The world still runs on the host's PC and play goes straight between the players:
NebulaNet only introduces them.

## How a join works

1. The host's game asks a STUN server (`stun.cloudflare.com`) which public address its game socket has, and opens a
   WebSocket to NebulaNet with that address and its addresses on its own network. NebulaNet answers with a room code.
2. A friend types the code. Their game asks STUN for its own public address and sends it with the code to NebulaNet.
3. NebulaNet gives the friend the host's addresses and tells the host the friend's.
4. Both games send packets at each other at once, so both routers open a path, and the join carries on as a direct
   one. Nebula's `DirectTransport` does this part (`discover_public_address`, `punch`, `JoinConfig::alternates`).
5. When nothing gets through for a few seconds (a strict router, mobile data, CGNAT), the friend's game asks
   NebulaNet for a TURN relay (`POST /v1/relay`), takes an address on it, and NebulaNet tells the host to punch
   toward that address. The host's packets then reach the friend through the relay, and the friend's reach the host
   from it. Only the friend's game speaks TURN: to the host the relay is one more address to punch toward, so
   nothing on the host's side has to let anyone in first.

Hosts can still skip NebulaNet and share `address:port` as before.

## What it does, next to CoopNet

NebulaNet is sm64coopdx's CoopNet made for Nebula, on Cloudflare instead of a server of its own:

| CoopNet | NebulaNet |
| --- | --- |
| Lobbies with game, version, host name, mode, description, password, max players (`LOBBY_CREATE`) | Rooms with the same (`open`), each named by a 6-character code |
| Public lobbies, listed for everyone (`LOBBY_LIST_GET`) | `POST /v1/list` without a password: the rooms whose host asked for `public` (shown locked when they also have a password) |
| Private lobbies, found by their password (`LOBBY_LIST_GET` with a password) | `POST /v1/list` with the password. A room that is neither public nor has a password is joined by its code only |
| The owner updates its lobby (`LOBBY_UPDATE`) | The host sends `update` (players, name, mode, description, and its addresses when its router moves them) |
| Join errors: not found, full, wrong password, old CoopNet (`MERR_*`) | `404 not_found`, `409 full`, `403 wrong_password`, `426 old_game` |
| STUN and TURN servers handed out (`STUN_TURN`, `turn-servers.cfg`) | `ice` in `room` and the join's answer (STUN, from `STUN_SERVERS`); TURN only to a join that couldn't punch through (`POST /v1/relay`), from `TURN_SERVERS` or a Cloudflare TURN key kept inside a monthly budget |
| Keepalive every 180 s, dead after 240 s | The game pings every 30 s; a host silent for 240 s is closed |
| `PEER_FAILED`: the lobby owner always wins | `POST /v1/report`: a joiner that couldn't reach the host says so and the host hears `joiner_failed` |
| Metrics (`hourly.json`, `daily.json`, `current.json`) | `GET /v1/stats` |
| SDP and ICE candidates relayed through the server, every member peered with every other | The host's and the joiner's addresses swapped once: Nebula's players form a star around the host, so joiners never connect to each other |

CoopNet's reputation (which of two players to drop when they can't reach each other) has no counterpart: in a star
the host always stays, which is what CoopNet does for a lobby's owner too. Its load balancing has none either:
Cloudflare answers from the place nearest each player.

## Protocol (version 2)

The full message list is at the top of [`src/protocol.ts`](src/protocol.ts). In short:

- `GET /v1/host`, a WebSocket kept open while the room is open. The host sends `open` (protocol, game, version,
  name, mode, description, password, public, players, max, candidates) and gets `room` with the code, whether the
  room is in the public list, and the `ice` servers;
  NebulaNet sends `joiner` with a joiner's candidates and `joiner_failed` when one couldn't get through; the host
  sends `update` when its player count, name, mode, description or addresses change (its router moved its public port); `ping` is answered `pong`. The room ends
  when the socket closes. A host whose connection dropped reconnects with `?code=` to get the same code back while no
  other room has taken it.
- `POST /v1/join` with `{"code","candidates","password","protocol"}` answers the room's name, version, mode,
  description, players, max, the host's candidates and the `ice` servers, or `404 not_found`, `409 full`,
  `403 wrong_password`, `426 old_game`, `400 bad_request`, `429 busy`. A room without a password takes any password,
  as its host does.
- `POST /v1/list` with `{"game"}` answers `{"rooms":[…]}`: the public rooms. With `{"game","password"}`: the rooms
  that have the password, public or not. Rooms never show their addresses there.
- `POST /v1/relay` with `{"code","password","protocol"}`, from a joiner that heard nothing back: `{"turn":[{"host",
  "port","username","password"}…]}`, or `503 no_relay` (none set up, or this month's budget is used), `429 busy`
  (an address gets 12 an hour), and a join's errors. Then with `"relay":"1.2.3.4:5678"` added, its address on the
  relay: the host hears `joiner` with that candidate, `"relay":true` and `"via"`, the joiner's own address, which
  the host's bans go by.
- `POST /v1/report` with `{"code","ok","candidates","relayed"}`: how a join went.
- `GET /v1/stats`: rooms and players open now, the most at once each hour (48 hours) and day (30 days), the joins
  made, failed and relayed in each, and `relay`: this month's relay use (`used_gb`, `budget_gb`, relays in use, and
  whether a new one would be handed out).

Protocol 1 games still work: what they leave out reads as empty, so their rooms have no password and are joined by
code. So do protocol 2 games from before public rooms: they never ask for `public`, so their rooms stay off the public
list.

A candidate is `"1.2.3.4:5678"` or `"[2001:db8::1]:5678"`. Codes are 6 characters from
`23456789ABCDEFGHJKLMNPQRSTUVWXYZ` (no 0/O or 1/I), with case and dashes ignored.

Each room is a Durable Object named by its code. The host's socket uses the WebSocket hibernation API, so an open room
that nobody is joining costs nothing while it waits; every 5 minutes it wakes to check its host and, for a listed
room (public or with a password), refresh its place in the list. The list and the numbers are one more Durable Object,
`LobbyDirectory` (`src/directory.ts`), which drops a room it hasn't heard from for 16 minutes. Joins are limited to 30
a minute per room (so are a password's guesses), lists to 30 a minute per address, and public rooms to 4 at once per
address (a household's games; more are joined by code, and their `room` says `"public":false`). Passwords and
addresses are kept only as hashes.

## Cost

NebulaNet fits Cloudflare's Workers Free plan, with no card needed. Over a free limit, requests fail until the daily
reset (00:00 UTC); nothing is billed. Each open room wakes every 5 minutes (about 12 Durable Object requests and 12
rows written an hour, twice that for a public or private room, which also refreshes its listing), well inside the free plan's
100,000 requests and 100,000 rows written a day. Pings cost nothing: Cloudflare answers them without waking the room.
Game traffic never passes through NebulaNet.

Only Cloudflare's TURN relays could cost money: their first 1,000 GB a month are free, then $0.05/GB. Cloudflare
counts only what its relays send to the games that asked for them (the joiners): the host's game sends to the relay
like to any address. A relayed player's traffic hasn't been measured yet; at 30 KB/s (about 100 MB an hour), the free
1,000 GB would be about 10,000 relayed player-hours a month, and most joins never need a relay. NebulaNet keeps it
free with a budget (below): past it, relays stop until the next month and joins go back to punching through only.
`GET /v1/stats` shows the month's use.

## TURN relays

For joins that can't punch through, NebulaNet hands out TURN servers, as CoopNet does, but only to a joiner that asked
for one after trying for a few seconds (`POST /v1/relay`). Set these as secrets (dashboard, the Worker, Settings,
Variables and Secrets):

- `TURN_SERVERS`: CoopNet's `turn-servers.cfg` lines, `host:user:pass:port`, one a line or commas between them (a TURN
  server of your own: no budget is kept for it).
- A Cloudflare TURN key, and what keeps it free. NebulaNet makes a credential for each relay (it lasts a day), asks
  Cloudflare's analytics how much this month's relays sent before handing one out (at most every 10 minutes) and,
  while any are in use, every 10 minutes. Past the budget it hands out no more and revokes those in use, which ends
  them. Without the analytics token it can't know, so it hands out no Cloudflare relays at all.
  1. Cloudflare dashboard, Realtime, TURN Server, Create: name it `NebulaNet`. Set its Turn Token ID as
     `TURN_KEY_ID` and its API Token as `TURN_KEY_API_TOKEN`.
  2. My Profile, API Tokens, Create Token, Custom token: permission Account, Account Analytics, Read, for your
     account. Set it as `CF_ANALYTICS_TOKEN`.
  3. Your account ID (dashboard, the account's home page, Account details) as `CF_ACCOUNT_ID`.
  4. Optional: `RELAY_BUDGET_GB` (a plain variable), the GB a month to stop at, 900 when unset and never above the
     free 1,000. The 100 GB left is room for the relays in use between checks. `0` turns Cloudflare relays off.

`STUN_SERVERS` (`host:port`, commas between) replaces the default `stun.cloudflare.com:3478`.

## Developing

```sh
npm install
npm run check   # TypeScript
npm test        # protocol tests (Node 22)
npm run dev     # the Worker locally on http://127.0.0.1:8787
```

## Deploying

Cloudflare deploys it from GitHub by itself (Workers Builds), with no API token to make: in the Cloudflare dashboard,
Workers & Pages, Create, Import a repository, pick this repository, keep the deploy command `npx wrangler deploy`, and
save. Every push to `main` deploys from then on. By hand instead:

```sh
npx wrangler login
npm run deploy
```

It answers at `https://nebulanet.mackery.com` (the custom domain in `wrangler.jsonc`; `mackery.com` has to be a zone
on the same Cloudflare account, and deploying adds the DNS record) and at `nebulanet.<your-subdomain>.workers.dev`.
That address is Nebula's default; its `coop_nebulanet` setting points a game at another NebulaNet.

## Coming next

- Discord Join button carrying the room code (on Nebula's side).
