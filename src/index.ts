// @camada/deno — the one-line install for a Deno.serve app:
//   Deno.serve(camada()(handler));   // env: CAMADA_KEY (+ CAMADA_INGEST_URL / CAMADA_SNAPSHOT_URL in dev)
//   new Response(`<head>${scriptTag(req)}</head>…`)   // the first-party beacon
//   track(req, 'login_failed', { user })              // an outcome the wire cannot show
export {
  camada, track, scriptTag, resetCamada,
  type CamadaDenoOptions, type CamadaDenoVars, type ServeHandlerInfo, type ServeHandler, type WrappedHandler,
} from './camada.js';
