// @camada/deno against the golden v4 snapshot, driven through the Deno.serve wrapper with a
// hand-built ServeHandlerInfo and a stubbed `globalThis.Deno`. The pipeline itself is covered by
// @camada/core/fetch's own suite; what is tested here is the binding: the peer, the env, the
// per-request slot, the cookie and the timer. Fixtures come through the file: symlink to core.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { CHALLENGE_COOKIE } from '@camada/core';
import iife from '@camada/browser/iife-string';
import { camada, resetCamada, track, scriptTag, type CamadaDenoOptions, type ServeHandlerInfo, type WrappedHandler } from '../src/index.js';

const FIX = fileURLToPath(new URL('../node_modules/@camada/core/test/fixtures/blk3/', import.meta.url));
const V4 = {
  bin: readFileSync(FIX + 'v4-basic.bin'),
  meta: JSON.stringify(JSON.parse(readFileSync(FIX + 'v4-basic.meta.json', 'utf8'))),
};

const BLOCKED_IP = '203.0.113.66';     // block side
const CHALLENGED_IP = '192.0.2.20';    // challenge side only
const HTML = { accept: 'text/html', 'sec-fetch-dest': 'document' };
const CONFIG = { tenant: 'acme', beacon: true, sample: 1, exclude: [], trusted_proxy: { mode: 'none' }, poll_seconds: 30 };
const ENV = { CAMADA_KEY: 'tok-acme.snap-acme', CAMADA_INGEST_URL: 'http://analyst.test', CAMADA_SNAPSHOT_URL: 'http://analyst.test/snapshot' };

// The Deno the wrapper reads: only `env.get(name)`, which is all it touches. Tests swap what it
// answers per key (or whether Deno exists at all) to drive the env path.
let denoEnv: (name: string) => string | undefined;
const g = globalThis as { Deno?: { env: { get(name: string): string | undefined } } };
const installDeno = () => { g.Deno = { env: { get: (name) => denoEnv(name) } }; };
const envOf = (values: Record<string, string>) => (name: string) => values[name];

// 200 body frame: [u32 LE meta-length][meta JSON][BLK bin]
function frame(): ArrayBuffer {
  const m = new TextEncoder().encode(V4.meta);
  const f = new Uint8Array(4 + m.length + V4.bin.length);
  new DataView(f.buffer).setUint32(0, m.length, true);
  f.set(m, 4); f.set(new Uint8Array(V4.bin), 4 + m.length);
  return f.buffer;
}

let events: Array<Record<string, unknown>>;
let sdkHeaders: string[];
let snapshotVersions: string[];

const fetchImpl: typeof fetch = (async (url: string | URL | Request, init?: RequestInit) => {
  const u = String(url);
  if (u.endsWith('/snapshot')) {
    snapshotVersions.push(new Headers(init?.headers).get('x-camada-snapshot') ?? '');
    return new Response(frame(), { status: 200, headers: { etag: `"${JSON.parse(V4.meta).version}"`, 'x-camada-config': JSON.stringify(CONFIG) } });
  }
  sdkHeaders.push(new Headers(init?.headers).get('x-camada-sdk') ?? '');
  events.push(...(JSON.parse(String(init?.body)) as Array<Record<string, unknown>>));
  return new Response(null, { status: 202 });
}) as typeof fetch;

const html = (s: string) => new Response(s, { headers: { 'content-type': 'text/html' } });
async function handler(req: Request): Promise<Response> {
  const { pathname } = new URL(req.url);
  if (pathname === '/') return new Response('home');
  if (pathname === '/cart') return html('<p>cart</p>');
  if (pathname === '/checkout') return html('<p>checkout</p>');
  if (pathname === '/page') return html(`<html><head>${scriptTag(req)}</head><body>page</body></html>`);
  if (pathname === '/redirect') return Response.redirect('http://app.test/', 302);   // immutable headers
  if (pathname === '/boom') throw new Error('handler bug');
  if (pathname === '/login' && req.method === 'POST') { await track(req, 'login_failed', { user: 'alice@example.com' }); return new Response('no', { status: 401 }); }
  if (pathname === '/signup' && req.method === 'POST') { void track(req, 'signup'); return new Response('ok'); }   // fire-and-forget
  return new Response('not found', { status: 404 });
}

/** No opts.env: the key comes from the Deno stub, the way a real process is configured. */
const app = (opts: CamadaDenoOptions = {}): WrappedHandler => camada({ fetchImpl, ...opts })(handler);

const tcp = (hostname: string): ServeHandlerInfo => ({ remoteAddr: { transport: 'tcp', hostname, port: 40000 } });
const UNIX: ServeHandlerInfo = { remoteAddr: { transport: 'unix' } };

/** Without waitUntil the flush is a detached promise: give it the ticks it needs before asserting. */
const settle = async () => { for (let i = 0; i < 3; i++) await new Promise((r) => setTimeout(r, 0)); };

async function call(a: WrappedHandler, path: string, init: RequestInit = {}, info: ServeHandlerInfo = tcp('8.8.8.8')): Promise<Response> {
  const res = await a(new Request(`http://app.test${path}`, init), info);
  const body = res?.body ? await res.arrayBuffer() : null;   // send the body as the host would: the event ships once it has gone out
  await settle();
  return new Response(body, res);
}

/** The first request is cold (fail open) and loads the snapshot. */
async function primed(opts: CamadaDenoOptions = {}): Promise<WrappedHandler> {
  const a = app(opts);
  await call(a, '/');
  await call(a, '/');
  events.length = 0;
  return a;
}

const nonceOf = (page: string) => /name="nonce" value="([0-9a-f]{32})"/.exec(page)![1];
const solve = (nonce: string): string => {
  for (let n = 0; ; n++) if (createHash('sha256').update(`${nonce}.${n}`).digest('hex').startsWith('0000')) return String(n);
};
const postSolution = (a: WrappedHandler, addr: string, body: string) =>
  call(a, '/__camada/challenge', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body }, tcp(addr));
const postBeacon = (a: WrappedHandler, body: string, addr = '9.9.9.9') =>
  call(a, '/_cam/fp', { method: 'POST', headers: { 'content-type': 'application/json' }, body }, tcp(addr));

beforeEach(() => { events = []; sdkHeaders = []; snapshotVersions = []; denoEnv = envOf(ENV); installDeno(); });
afterEach(() => { resetCamada(); delete g.Deno; vi.useRealTimers(); vi.unstubAllEnvs(); });

describe('capture', () => {
  it('sets x-rid to the event rid on answered responses (an immutable redirect included) and not on a block', async () => {
    const a = await primed();
    for (const path of ['/cart', '/redirect']) {
      const res = await call(a, path);
      expect(res.headers.get('x-rid'), path).toBe(events.find((e) => e.p === path)!.rid);
      if (path === '/redirect') expect(res.headers.get('location')).toBe('http://app.test/');
    }
    const blocked = await call(a, '/', {}, tcp(BLOCKED_IP));
    expect(blocked.status).toBe(403);
    expect(blocked.headers.has('x-rid')).toBe(false);
  });

  it('lets a request through with its real status, tapped sdk-deno and identified on every batch', async () => {
    const a = await primed();
    expect((await call(a, '/')).status).toBe(200);
    expect((await call(a, '/nope')).status).toBe(404);
    expect(events.some((e) => e.tap === 'sdk-deno' && e.p === '/' && e.st === 200)).toBe(true);
    expect(events.some((e) => e.p === '/nope' && e.st === 404)).toBe(true);
    expect(sdkHeaders.length).toBeGreaterThan(0);
    expect(sdkHeaders.every((h) => h === '@camada/deno/0.1.3')).toBe(true);
  });

  it('ships st 500 and rethrows when the handler throws — Deno.serve answers a thrown handler with 500', async () => {
    const a = await primed();
    await expect(a(new Request('http://app.test/boom'), tcp('8.8.8.8'))).rejects.toThrow('handler bug');
    await settle();
    expect(events.at(-1)).toMatchObject({ p: '/boom', st: 500 });
  });
});

describe('enforcement', () => {
  it('blocks a listed peer with 403 and blk', async () => {
    const a = await primed();
    const res = await call(a, '/', {}, tcp(BLOCKED_IP));
    expect(res.status).toBe(403);
    expect(res.headers.get('x-block-reason')).toBe('ip4');
    expect(res.headers.get('x-block-version')).toBeTruthy();
    expect(events.some((e) => e.st === 403 && e.blk === 'ip4')).toBe(true);
  });

  it('serves the challenge page, verifies the solution, and lets the cookie holder through', async () => {
    const a = await primed();
    const page = await call(a, '/cart', { headers: HTML }, tcp(CHALLENGED_IP));
    expect(page.status).toBe(403);
    expect(page.headers.get('content-type')).toContain('text/html');
    const nonce = nonceOf(await page.text());
    expect(events.some((e) => e.st === 403 && e.blk === 'challenge')).toBe(true);

    const ok = await postSolution(a, CHALLENGED_IP, `nonce=${nonce}&solution=${solve(nonce)}&to=%2Fcart`);
    expect(ok.status).toBe(302);
    expect(ok.headers.get('location')).toBe('/cart');
    expect(ok.headers.get('set-cookie')).toContain(`${CHALLENGE_COOKIE}=`);
    expect(events.some((e) => e.st === 200 && e.ch === 1)).toBe(true);

    const cookie = ok.headers.get('set-cookie')!.split(';')[0];
    expect((await call(a, '/cart', { headers: { cookie, ...HTML } }, tcp(CHALLENGED_IP))).status).toBe(200);
  });
});

describe('the peer', () => {
  it('is the TCP remoteAddr Deno vouches for', async () => {
    const a = await primed();
    await call(a, '/', {}, tcp('8.8.4.4'));
    expect(events.at(-1)).toMatchObject({ ip: '8.8.4.4' });
  });

  it('is null over a unix socket — captured, no ip rules, no challenge', async () => {
    const a = await primed();
    const res = await call(a, '/checkout', { headers: HTML }, UNIX);
    expect(res.status).toBe(200);
    expect(events.at(-1)).toMatchObject({ p: '/checkout', ip: null });
  });

  it('is never a client header on its own', async () => {
    const a = await primed();
    for (const h of ['x-forwarded-for', 'cf-connecting-ip', 'x-real-ip']) {
      const res = await call(a, '/', { headers: { [h]: BLOCKED_IP } }, UNIX);
      expect(res.status).toBe(200);
      expect(events.at(-1)).toMatchObject({ ip: null });
    }
    expect((await call(a, '/', { headers: { 'x-forwarded-for': BLOCKED_IP } }, tcp('8.8.8.8'))).status).toBe(200);
  });

  it('honours a trusted-proxy X-Forwarded-For behind the peer', async () => {
    const a = await primed({ trustedProxy: 'hops:1' });
    expect((await call(a, '/', { headers: { 'x-forwarded-for': BLOCKED_IP } }, tcp('10.1.1.1'))).status).toBe(403);
  });
});

describe('session', () => {
  it('sets _sfp on a first visit, Secure on https, and never overwrites one', async () => {
    const a = await primed();
    const first = await call(a, '/');
    expect(first.headers.get('set-cookie')).toContain('_sfp=');
    expect(first.headers.get('set-cookie')).toContain('HttpOnly');
    expect(first.headers.get('set-cookie')).not.toContain('Secure');
    expect(events.at(-1)).toMatchObject({ ns: 1 });
    const secure = await a(new Request('https://app.test/'), tcp('8.8.8.8'));
    expect(secure.headers.get('set-cookie')).toContain('; Secure');
    const known = await call(a, '/', { headers: { cookie: '_sfp=known-sid' } });
    expect(known.headers.get('set-cookie')).toBeNull();
    expect(events.at(-1)).toMatchObject({ sid: 'known-sid', ns: 0 });
  });

  it('survives a Response.redirect, whose headers are immutable', async () => {
    const a = await primed();
    const res = await call(a, '/redirect');
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('http://app.test/');
    expect(res.headers.get('set-cookie')).toContain('_sfp=');
  });
});

describe('WebSocket upgrade', () => {
  /** What Deno.upgradeWebSocket returns: a 101 with immutable headers, which Deno < 2.6 refuses to see copied. */
  const upgradeResponse = (): Response => {
    const res = Response.error();   // immutable headers; undici will not build a 101 itself
    Object.defineProperty(res, 'status', { value: 101 });
    return res;
  };

  it('returns the runtime\'s 101 untouched, with no cookie on a first visit, and ships st 101', async () => {
    let upgrade = upgradeResponse();
    // Deno 2.9: once Deno.upgradeWebSocket has run, reading the request throws "Request closed".
    const ws = camada({ fetchImpl })((req) => {
      for (const k of ['headers', 'url', 'method']) Object.defineProperty(req, k, { get: () => { throw new TypeError('Request closed'); } });
      return upgrade;
    });
    const handshake = (cookie?: string) =>
      ws(new Request('http://app.test/ws', { headers: { upgrade: 'websocket', ...(cookie ? { cookie } : {}) } }), tcp('8.8.8.8'));
    await handshake();   // cold: loads the snapshot
    await settle();
    for (const cookie of [undefined, '_sfp=known-sid']) {
      upgrade = upgradeResponse();
      events.length = 0;
      const res = await handshake(cookie);
      expect(res).toBe(upgrade);
      expect(res.headers.get('set-cookie')).toBeNull();
      await settle();
      expect(events).toEqual([expect.objectContaining({ p: '/ws', st: 101 })]);
    }
  });
});

describe('first-party beacon', () => {
  it('serves the IIFE at GET /_cam/b.js and tags the page with the rid', async () => {
    const a = await primed();
    const res = await call(a, '/_cam/b.js?r=abc');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('javascript');
    expect(await res.text()).toBe(iife);
    const page = await (await call(a, '/page')).text();
    const rid = /\?r=([0-9a-f-]{36})"/.exec(page)![1];
    expect(events.find((e) => e.p === '/page')).toMatchObject({ rid, tap: 'sdk-deno' });
  });

  it('relays POST /_cam/fp as a sig:1 row with the server-resolved ip and tap', async () => {
    const a = await primed();
    const res = await postBeacon(a, JSON.stringify({ rid: 'abc', tz: 'UTC', ip: '1.1.1.1', tap: 'proxy' }));
    expect(res.status).toBe(204);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ sig: 1, rid: 'abc', tz: 'UTC', ip: '9.9.9.9', tap: 'sdk-deno' });
  });

  it('emits no tag for a request the wrapper never saw', () => {
    expect(scriptTag(new Request('http://app.test/'))).toBe('');
  });
});

describe('track', () => {
  it('ships an app-context event joined by rid and sid, with the user hashed', async () => {
    const a = await primed();
    const res = await call(a, '/login', { method: 'POST', headers: { cookie: '_sfp=known-sid' } });
    expect(res.status).toBe(401);
    const row = events.find((e) => e.et === 'login_failed')!;
    expect(row).toMatchObject({ tap: 'sdk-deno', sid: 'known-sid', ip: '8.8.8.8' });
    expect(row.uid).toMatch(/^[0-9a-f]{32}$/);
    expect(row.rid).toBe(events.find((e) => e.p === '/login')!.rid);
    expect(JSON.stringify(events)).not.toContain('alice');
    await call(a, '/signup', { method: 'POST' });
    expect(events.find((e) => e.et === 'signup')).toMatchObject({ uid: null });
  });

  it('is a silent no-op for a request the wrapper never saw', async () => {
    await primed();
    await expect(track(new Request('http://app.test/'), 'login_failed', { user: 'x' })).resolves.toBeUndefined();
    expect(events).toEqual([]);
  });
});

describe('the env', () => {
  it('is inert without a key and with CAMADA_DISABLED=1', async () => {
    denoEnv = envOf({});
    const a = app();
    expect((await call(a, '/', {}, tcp(BLOCKED_IP))).status).toBe(200);
    denoEnv = envOf({ ...ENV, CAMADA_DISABLED: '1' });
    const b = app();
    await call(b, '/');
    expect((await call(b, '/', {}, tcp(BLOCKED_IP))).status).toBe(200);
    expect(events).toEqual([]);
    expect(snapshotVersions).toEqual([]);
  });

  it('enforces under a granular --allow-env that covers only the camada keys', async () => {
    const granted = ['CAMADA_KEY', 'CAMADA_INGEST_URL', 'CAMADA_SNAPSHOT_URL'];   // the README's own flag
    denoEnv = (name) => { if (!granted.includes(name)) throw new Error(`Requires env access to "${name}"`); return ENV[name as keyof typeof ENV]; };
    const a = await primed();
    expect((await call(a, '/', {}, tcp(BLOCKED_IP))).status).toBe(403);
  });

  it('goes inert, not down, when Deno.env is denied', async () => {
    denoEnv = () => { throw new Error('Requires env access'); };
    const a = app();
    expect((await call(a, '/', {}, tcp(BLOCKED_IP))).status).toBe(200);
    expect(events).toEqual([]);
    expect(snapshotVersions).toEqual([]);
  });

  it('falls back to process.env without a Deno global', async () => {
    delete g.Deno;
    for (const [k, v] of Object.entries(ENV)) vi.stubEnv(k, v);
    const a = await primed();
    expect((await call(a, '/', {}, tcp(BLOCKED_IP))).status).toBe(403);
  });
});

describe('timer mode', () => {
  it('polls the snapshot on its own by default, and resetCamada() stops every instance', async () => {
    vi.useFakeTimers();
    const a = app();
    const b = app({ ingestUrl: 'http://other.test' });   // a second pipeline with its own engine
    await a(new Request('http://app.test/'), tcp('8.8.8.8'));
    await b(new Request('http://app.test/'), tcp('8.8.8.8'));
    expect(snapshotVersions).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(31_000);
    expect(snapshotVersions).toHaveLength(4);
    resetCamada();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(snapshotVersions).toHaveLength(4);
  });

  it('is lazy under CAMADA_SERVERLESS=1 or mode: lazy', async () => {
    vi.useFakeTimers();
    denoEnv = envOf({ ...ENV, CAMADA_SERVERLESS: '1' });
    const a = app();
    await a(new Request('http://app.test/'), tcp('8.8.8.8'));
    denoEnv = envOf(ENV);
    const b = app({ mode: 'lazy' });
    await b(new Request('http://app.test/'), tcp('8.8.8.8'));
    await vi.advanceTimersByTimeAsync(31_000);
    expect(snapshotVersions).toHaveLength(2);
  });
});
