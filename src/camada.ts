// @camada/deno — the Deno.serve wrapper over @camada/core/fetch (SDK-G04).
//   Deno.serve(camada()(handler));
// The runtime vouches for exactly one thing here: `info.remoteAddr`, the TCP socket peer. It goes
// in as `ctx.peer` and core combines it with X-Forwarded-For under the trusted-proxy rules; a
// client header on its own never becomes the ip. Deno is a long-lived process, so the snapshot
// polls on a timer by default (CAMADA_SERVERLESS=1 or `mode: 'lazy'` for Deno Deploy), and there
// is no `waitUntil`: the event flush is a fire-and-forget promise the process keeps alive.
import iife from '@camada/browser/iife-string';
import { TAP_DENO, logRateLimited } from '@camada/core';
import { createFetchCamada, withSetCookie, track as coreTrack, scriptTag as coreScriptTag, type FetchCamada, type FetchCamadaOptions, type FetchVars } from '@camada/core/fetch';
import { SDK_ID } from './version.js';

export type CamadaDenoOptions = FetchCamadaOptions;
export type CamadaDenoVars = FetchVars;

/** The second argument Deno.serve hands a handler, typed structurally so this package needs no Deno types. */
export interface ServeHandlerInfo {
  remoteAddr: { transport: 'tcp' | 'udp' | 'unix' | 'unixpacket'; hostname?: string; port?: number };
}
export type ServeHandler = (req: Request, info: ServeHandlerInfo) => Response | Promise<Response>;
export type WrappedHandler = (req: Request, info: ServeHandlerInfo) => Promise<Response>;

type DenoGlobal = { env: { get(name: string): string | undefined } };
type Env = Record<string, string | undefined>;

// Every camada() call owns one pipeline; resetCamada() must reach all of them.
const instances = new Set<FetchCamada>();
// The per-request slot: Deno hands the same Request object to the handler, so track() and
// scriptTag() find their vars by it without the app threading anything through.
const slots = new WeakMap<Request, FetchVars>();

/** Every key core reads, fetched one by one: `Deno.env.get` works under a granular
 *  `--allow-env=CAMADA_KEY,…` grant, where `toObject()` (and enumerating `process.env`) throws. */
const ENV_KEYS = ['CAMADA_KEY', 'CAMADA_TOKEN', 'CAMADA_SNAPSHOT_TOKEN', 'CAMADA_INGEST_URL', 'CAMADA_SNAPSHOT_URL', 'CAMADA_TRUSTED_PROXY', 'CAMADA_CHALLENGE', 'CAMADA_DISABLED', 'CAMADA_SERVERLESS'];

/** Deno.env where there is a Deno (a Node test process has only process.env). A key the grant does
 *  not cover throws NotCapable; that costs enforcement, never the response, and is logged as what it is. */
function hostEnv(): Env | undefined {
  const deno = (globalThis as { Deno?: DenoGlobal }).Deno;
  if (!deno) return globalThis.process?.env;
  const env: Env = {};
  let denied = 0;
  for (const k of ENV_KEYS) {
    try { env[k] = deno.env.get(k); } catch { denied++; }
  }
  if (denied === ENV_KEYS.length) logRateLimited(new Error('Deno.env access denied — run with --allow-env (or --allow-env=CAMADA_KEY,CAMADA_INGEST_URL,CAMADA_SNAPSHOT_URL); camada is inactive'));
  return env;
}

/** Only a TCP peer is an address; a unix socket has none, and camada then sees no client ip. */
const peerOf = (info: ServeHandlerInfo | undefined): string | null =>
  info?.remoteAddr?.transport === 'tcp' ? info.remoteAddr.hostname ?? null : null;

/**
 * Builds the wrapper: `Deno.serve(camada()(handler))`. Mode defaults to `timer` (a long-lived
 * process polls the snapshot on an unref'd interval); `opts.mode` overrides and CAMADA_SERVERLESS=1
 * forces lazy. Deno's setInterval returns a number, so that unref is a no-op there and the poll
 * keeps the process alive until resetCamada() or exit — under Node (vitest) resetCamada() is what
 * lets a test process end.
 */
export function camada(opts: CamadaDenoOptions = {}): (handler: ServeHandler) => WrappedHandler {
  const cam = createFetchCamada({ tap: TAP_DENO, sdk: SDK_ID, iife }, { ...opts, mode: opts.mode ?? 'timer' });
  instances.add(cam);
  return (handler) => async (req, info) => {
    const r = await cam.before(req, { peer: peerOf(info), env: hostEnv() });
    if (!r) return handler(req, info);
    if (r.response) return r.response;
    slots.set(req, r.vars);
    let res: Response;
    try {
      res = await handler(req, info);
    } catch (err) {
      cam.after(req, r.vars, null);   // Deno.serve's onError decides the status; camada cannot see it
      throw err;
    }
    cam.after(req, r.vars, res.status);
    return r.vars.sessionCookie ? withSetCookie(res, r.vars.sessionCookie) : res;
  };
}

/** Records an outcome the handler knows (`login_failed`, `signup`, ...), joined to this request's
 *  event. Never throws; a silent no-op where the wrapper did not run. See @camada/core/fetch. */
export const track = (req: Request, event: string, data?: { user?: string }): Promise<void> => coreTrack(slots.get(req), event, data);

/** The `<script>` tag for an HTML response; `''` where the wrapper did not run or the beacon is off. */
export const scriptTag = (req: Request): string => coreScriptTag(slots.get(req));

/** Test/reset hook: stops every poller and queue this module created and drops their engines; the wrappers stay wired and rebuild lazily. */
export function resetCamada(): void {
  for (const cam of instances) cam.reset();
}
