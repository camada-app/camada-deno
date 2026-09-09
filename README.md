# @camada/deno

camada for [Deno](https://deno.com) `Deno.serve`: enforces the tenant snapshot inline (your
ordered custom rules, then block, allow, challenge), serves a first-party proof-of-work challenge
page and beacon, records the outcomes your handler knows (`track()`), and ships wire events in
batches off the response path. A thin binding over `@camada/core/fetch`, the pipeline every
Web-fetch adapter shares. Fails open by design — a camada outage or bug never 5xxes your app.

Not yet on npm — consumed via a `file:` dependency from a sibling checkout. Built with tsup like
the rest of the workspace; there is no `deno.json` this round. From Deno, once published it is
`npm:@camada/deno`; locally, an import-map entry pointing at the sibling build works:

```json
{ "imports": { "@camada/deno": "../camada-deno/dist/index.js" } }
```

## Quickstart

```ts
import { camada } from '@camada/deno';

Deno.serve(camada()((req, info) => new Response('hello')));
```

Env (printed by camada onboarding / `npm run seed` in dev), read through `Deno.env` — run with
`--allow-env` (or `--allow-env=CAMADA_KEY,CAMADA_INGEST_URL,CAMADA_SNAPSHOT_URL`):

```
CAMADA_KEY=<ingest_token>.<snap_token>
CAMADA_INGEST_URL=http://localhost:8787        # dev only; defaults to production ingest
```

`camada()` reads the env on each request and builds its engine on the first configured one; a
denied env read (no `--allow-env`) is caught, logged once, and leaves the wrapper inert — the app
still answers. An app that reads its own config can pass the values instead:

```ts
Deno.serve(camada({ key: MY_KEY, ingestUrl: MY_INGEST })(handler));
```

Call `camada()` once and reuse the wrapper. Engines are cached per resolved configuration, so
wrapping two handlers with the same config shares one snapshot poller and one event queue,
while two wrappers with different keys or URLs each get their own — a process hosting several
apps never enforces one tenant's snapshot on another, nor signs its cookies with another's
secret. Without `CAMADA_KEY` the wrapper is inert (one log line, no requests, no enforcement).

## What it does per request

1. Keeps the snapshot fresh. Deno is a long-lived process, so the default is `mode: 'timer'`: an
   interval poll at the cadence your tenant config sets. `CAMADA_SERVERLESS=1` (or
   `mode: 'lazy'`) switches to a per-request staleness check for Deno Deploy, where an isolate
   may be frozen between requests. Every poll and event batch carries
   `x-camada-sdk: @camada/deno/<version>`, and polls ask for snapshot v5
   (`x-camada-snapshot: 5`) — the container that carries your ordered custom rules.
2. Resolves the client from `info.remoteAddr` — the TCP peer Deno vouches for — combined with
   `X-Forwarded-For` only under your tenant's trusted-proxy config. A client header on its own
   (`x-forwarded-for`, `x-real-ip`, `cf-connecting-ip`) is never the ip: any caller can set it.
   Over a unix socket there is no peer, so the ip is null: the request is still captured, but
   ip rules cannot match it and it is never challenged.
3. Runs your ordered custom rules, then the allow, block and challenge lists.
4. **Block** → `403` with `x-block-reason` before your handler; the event still ships, with
   `st: 403` and `blk: <reason>` so the analyst counts SDK blocks apart from your own 403s.
5. **Skip** → a skip rule or the allow list wins over a wider block.
6. **Challenge** → a `403` proof-of-work page (HTML navigations) or `403 {"error":"challenge_required"}`
   (everything else), verified at `POST /__camada/challenge`, which sets `_cch` and 302s back.
7. Otherwise your handler runs; the settled response ships one batched, redacted event with its
   real status. A handler that throws ships `st: null` and rethrows — `Deno.serve`'s `onError`
   decides that status, and camada cannot see it. A first visit is given the `_sfp` session
   cookie (appended even to a `Response.redirect()`, whose headers are immutable).

## Options

| option | default | meaning |
|---|---|---|
| `key` | `env.CAMADA_KEY` | `<ingest_token>.<snap_token>`; without it the wrapper is inert |
| `ingestUrl` | `env.CAMADA_INGEST_URL` | ingest base; batches go to `<ingestUrl>/e` |
| `snapshotUrl` | `<ingestUrl>/snapshot` | snapshot endpoint |
| `trustedProxy` | server config | `none` / `vercel` / `hops:N` / `cidrs:a,b`, or the parsed object |
| `challenge` | `true` | serve the proof-of-work page for `challenge` verdicts |
| `challengePath` | `/__camada/challenge` | where that page posts its solution |
| `snapshotVersion` | `5` | `4` drops the custom rules, `3` the allow/challenge sides too |
| `scriptPath` | `/_cam/b.js` | where the first-party beacon script is served |
| `fpPath` | `/_cam/fp` | where that script posts the beacon; keep it in `scriptPath`'s directory |
| `mode` | `timer` | `timer` polls on an interval; `lazy` checks per request (`CAMADA_SERVERLESS=1` forces it) |
| `env` | `Deno.env` | overrides the process env (tests, and apps that read config themselves) |

`CAMADA_CHALLENGE=0` in the env switches the challenge off without a code change.

`CAMADA_DISABLED=1` in the env switches everything off, checked per request.

## The first-party beacon

Bots that never run JavaScript are the cheapest to catch. Put the tag in the `<head>` of the
pages you render and the wrapper does the rest:

```ts
import { camada, scriptTag } from '@camada/deno';

Deno.serve(camada()((req) =>
  new Response(`<html><head>${scriptTag(req)}</head><body>…</body></html>`, { headers: { 'content-type': 'text/html' } })));
```

`scriptTag(req)` returns `<script src="/_cam/b.js?r=<rid>" async></script>` — the `rid` is this
request's event id, so the analyst joins the beacon to the page view. The wrapper serves the
script at `GET /_cam/b.js` (cacheable, 1 h) and relays `POST /_cam/fp` (≤ 32 KB, answers 204)
onto the event batch as a `sig: 1` row stamped with the client ip camada resolved — never the
one the body claims. Both endpoints sit behind the verdict: a blocked client gets 403 there
too. The tag is `''` when camada is off for the request or the project turned the beacon off
in its settings, and the endpoints stand down with it. `scriptTag` and `track` find their
request by the `Request` object `Deno.serve` handed you, so pass that one, not a clone.

## App-context events

The wire shows a `POST /login`; only your handler knows whether it failed. Tell camada:

```ts
import { camada, track } from '@camada/deno';

Deno.serve(camada()(async (req) => {
  const ok = await signIn(req);
  if (!ok) track(req, 'login_failed', { user: email });   // await optional — the flush is off-path
  return ok ? Response.redirect('/', 302) : new Response('Invalid credentials', { status: 401 });
}));
```

`track(req, event, { user? })` ships `{ et, uid, rid, sid, ip, ts }` joined to this request's event.
The user identifier is HMAC-hashed in-process with the ingest token — the raw value never leaves
the process. It never throws and is a no-op where the wrapper did not run. The event name is
free-form; the analyst's rules read this vocabulary:

| event | when |
|---|---|
| `login_failed` / `login_succeeded` | a credential check settled |
| `signup` | an account was created |
| `password_reset` | a reset was requested |
| `mfa_failed` | a second factor was rejected |
| `payment_failed` / `payment_succeeded` | a charge settled |
| `coupon_failed` | a promo code was rejected |

## What this tap can see

The in-app position: the beacon, the client hints and headers, the settled status, the `_sfp`
session and the app context from `track()`. Deno vouches for the socket peer (`info.remoteAddr`)
and nothing else about the connection: no ASN, no country, no TLS fingerprint and no client
protocol reach this tap, so `asn`, `country` and `tlsx` conditions cannot match here and `proto`
is null on the event (camada never reads a forwarded protocol header for it). Behind a proxy,
the peer is the proxy; set `trustedProxy` (or your tenant config) so `X-Forwarded-For` counts.
Header order is normalised by the `Headers` object, so the raw-wire-order signal is not
available either. The analyst knows all of this from the tap's capability mask (`sdk-deno`) and
never scores an absence as evidence.

## Fail open

Every entry point runs inside camada's guard. A dead ingest, a corrupt snapshot, a denied env
read, a bug in this package: telemetry is lost, the request is not.
