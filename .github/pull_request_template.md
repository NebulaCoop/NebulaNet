## Summary

<!-- What does this change, and why? Link the issue it fixes, e.g. "Fixes #12". -->

## Testing

- [ ] `npm run check` and `npm test` pass
- [ ] Tried with `npm run dev` (`wrangler dev`) and a game: <!-- host, join, list... -->
- [ ] Tried against a deployed Worker: <!-- which -->

## Checklist

- [ ] Games that speak an older NebulaNet protocol still host, join and list as before (a new field is optional; an
      old one is never repurposed).
- [ ] If the protocol changed, the message list at the top of `src/protocol.ts` and README's "Protocol" section say so,
      and nebula-coop has a matching change.
- [ ] It still fits Cloudflare's Workers Free plan (no new per-ping work, no extra Durable Object wake-ups for an idle
      room), and README's "Cost" section matches.
- [ ] Passwords and addresses are still stored only as hashes and never appear in `/v1/list` or `/v1/stats`.
