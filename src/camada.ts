// @camada/deno — the Deno.serve wrapper over @camada/core/fetch (SDK-G04).
//   Deno.serve(camada()(handler));
// The runtime vouches for exactly one thing here: `info.remoteAddr`, the TCP socket peer. It goes
// in as `ctx.peer` and core combines it with X-Forwarded-For under the trusted-proxy rules; a
// client header on its own never becomes the ip. Deno is a long-lived process, so the snapshot
// polls on a timer by default (CAMADA_SERVERLESS=1 or `mode: 'lazy'` for Deno Deploy), and there
// is no `waitUntil`: the event flush is a fire-and-forget promise the process keeps alive.
import iife from '@camada/browser/iife-string';
import { TAP_DENO, guarded } from '@camada/core';
import { createFetchCamada, withSetCookie, type FetchCamada, type FetchCamadaOptions, type FetchVars } from '@camada/core/fetch';
import { SDK_ID } from './version.js';

export type CamadaDenoOptions = FetchCamadaOptions;
export type CamadaDenoVars = FetchVars;

/** The second argument Deno.serve hands a handler, typed structurally so this package needs no Deno types. */
export interface ServeHandlerInfo {
  remoteAddr: { transport: 'tcp' | 'udp' | 'unix' | 'unixpacket'; hostname?: string; port?: number };
}
export type ServeHandler = (req: Request, info: ServeHandlerInfo) => Response | Promise<Response>;
export type WrappedHandler = (req: Request, info: ServeHandlerInfo) => Promise<Response>;

type DenoGlobal = { env: { toObject(): Record<string, string> } };
type ProcessGlobal = { env?: Record<string, string | undefined> };
type Env = Record<string, string | undefined>;

// Every camada() call owns one pipeline; resetCamada() must reach all of them.
const instances = new Set<FetchCamada>();
// The per-request slot: Deno hands the same Request object to the handler, so track() and
// scriptTag() find their vars by it without the app threading anything through.
const slots = new WeakMap<Request, { cam: FetchCamada; vars: FetchVars }>();

/** Deno.env over process.env (Deno 2 exposes both; a Node test process only the latter). A denied
 *  --allow-env throws on either read, and a throw here must cost enforcement, never the response. */
function hostEnv(): Env {
  const deno = (globalThis as { Deno?: DenoGlobal }).Deno;
  const proc = (globalThis as { process?: ProcessGlobal }).process;
  const base = guarded(() => ({ ...proc?.env }), {} as Env);
  return deno ? { ...base, ...guarded(() => deno.env.toObject(), {} as Env) } : base;
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
    slots.set(req, { cam, vars: r.vars });
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
export function track(req: Request, event: string, data?: { user?: string }): Promise<void> {
  const s = slots.get(req);
  return s ? s.cam.track(s.vars, event, data) : Promise.resolve();
}

/** The `<script>` tag for an HTML response; `''` where the wrapper did not run or the beacon is off. */
export function scriptTag(req: Request): string {
  const s = slots.get(req);
  return s ? s.cam.scriptTag(s.vars) : '';
}

/** Test/reset hook: stops every poller and queue this module created and drops their engines. */
export function resetCamada(): void {
  for (const cam of instances) cam.reset();
  instances.clear();
}
