# Changelog

## 0.1.2 (unreleased; follows 0.1.1)

Needs `@camada/core` 0.5.0.

### Changed

- `ts` is the request start, so `[ts, ts + dur]` is when the request ran.
- `dur` for a `text/event-stream` response runs to its last byte, or until the client leaves.
  Any other response goes out untouched and ships at once, with `dur` = time to first byte.

### Fixed

- Path rules match the canonical path (through `@camada/core` 0.5.0). A percent-encoded,
  upper-cased or trailing-slash spelling of a blocked path used to slip past the block.
- A WebSocket upgrade goes back exactly as Deno made it, with no session cookie, and ships one
  event with `st: 101`. A first visit used to rebuild the 101, which stopped Deno.serve accepting
  connections on Deno < 2.6. On Deno 2.9 an upgrade used to ship no event, because the request is
  closed once `Deno.upgradeWebSocket` returns.
- A `fetch()` of a gzip upstream that a first visit's cookie copies goes out decoded without the
  stale `Content-Encoding` and `Content-Length`.
- The exit flush no longer throws `NotCapable` without `--allow-run`.
