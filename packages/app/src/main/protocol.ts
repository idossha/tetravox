/**
 * The privileged `tetravox://` scheme (§5, directive A2, ROADMAP Phase-0 gate 3).
 *
 * Three hosts, and only three:
 *
 * * `tetravox://app/…`  — the renderer bundle. `*_bg.wasm` is served as `application/wasm`, which is
 *   what makes `WebAssembly.instantiateStreaming` take the streaming path instead of silently falling
 *   back to a full buffer. The window is loaded with `loadURL('tetravox://app/index.html')`, never
 *   `loadFile()`, so the renderer and its module Workers share one real origin.
 * * `tetravox://file/<percent-encoded absolute path>` — user data, as a **streaming** `Response` over
 *   the disk. The dataset worker fetches this itself: raw file bytes never cross IPC and never touch
 *   the UI thread (§5 rule 3, AGENTS rule 7). Reads are confined to the `paths.ts` allow-list.
 *
 * * `tetravox://module/<id>/<version>/<file>` — one file of an **installed extension**, and only
 *   ever one that `module-store.ts#enableModule()` put on {@link served} after re-hashing it
 *   against the install receipt. There is no path joining here and no directory root: the request's
 *   pathname is a **map key**, so a miss is a 404 and a `..` is a miss. That is §5 rule 10's posture
 *   — only main puts anything on the map — applied to script rather than to data.
 *
 * `encodeURIComponent` leaves the whole path in a single URL segment (`/` stays `%2F`), so Chromium's
 * standard-scheme URL parser cannot normalise a `..` into existence before we see it.
 */

import { net, protocol } from 'electron';
import { pathToFileURL } from 'node:url';
import { extname, join, normalize, sep } from 'node:path';
import { resolveAllowed } from './paths';

export const SCHEME = 'tetravox';

/** Must run before `app.whenReady()` — Electron refuses the registration afterwards. */
export function registerScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: SCHEME,
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        stream: true,
        corsEnabled: true,
      },
    },
  ]);
}

const MIME: Record<string, string> = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ttf': 'font/ttf',
  '.wasm': 'application/wasm',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};

function contentTypeFor(file: string): string {
  return MIME[extname(file).toLowerCase()] ?? 'application/octet-stream';
}

// No COOP/COEP: the app is deliberately **not** cross-origin isolated (§1), because WASM is
// single-threaded forever and nothing needs SharedArrayBuffer. `wasm-unsafe-eval` is what lets
// `WebAssembly.instantiate*` run at all under a CSP.
const CSP = [
  "default-src 'none'",
  // `tetravox://module` added 2026-08-30 for downloadable extensions (docs/DECISIONS.md). It is a
  // **host source**, not the scheme source `tetravox:` — the scheme form would also admit
  // `tetravox://file/…`, which is every path the user has ever opened, and would turn an
  // arbitrary-file-read into an arbitrary-script-execute. `script-src 'self'` used to mean "only
  // code the build shipped"; it now means "only code the build shipped, plus code **main** put on
  // an explicit map after verifying its sha256 against a manifest the user consented to", which is
  // strictly narrower than the two doors this repository has already closed for the same purpose
  // (`blob:` in `worker-src`, and `'unsafe-inline'`).
  "script-src 'self' 'wasm-unsafe-eval' tetravox://module",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  // `tetravox://file` is a *different host* from `tetravox://app`, so `'self'` does not cover it.
  "connect-src 'self' tetravox:",
  // `blob:` was removed on 2026-08-30 (docs/DECISIONS.md): both of this app's workers are built from
  // a `new URL(…, import.meta.url)` that Vite emits as a same-origin asset under `tetravox://app`
  // — `engine.ts`'s dataset worker and `Phase0App.tsx`'s — so `'self'` covers every worker that is
  // supposed to exist, and `blob:` covered only ones that are not. `img-src blob:` stays: the
  // screenshot dialog's preview is a real `URL.createObjectURL` of a rendered PNG.
  "worker-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
].join('; ');

function plain(status: number, message: string): Response {
  return new Response(message, {
    status,
    headers: { 'content-type': 'text/plain; charset=utf-8' },
  });
}

/** Stream a file off disk, keeping `net.fetch`'s body as a stream rather than buffering it. */
async function streamFile(
  file: string,
  contentType: string,
  extra?: Record<string, string>
): Promise<Response> {
  let upstream: Response;
  try {
    upstream = await net.fetch(pathToFileURL(file).toString());
  } catch {
    return plain(404, `not found: ${file}`);
  }
  if (!upstream.ok) return plain(upstream.status, `not found: ${file}`);

  const headers = new Headers(extra);
  headers.set('content-type', contentType);
  const length = upstream.headers.get('content-length');
  if (length !== null) headers.set('content-length', length);
  return new Response(upstream.body, { status: 200, headers });
}

/** `tetravox://app/…` → a file under `rendererRoot`, with the bundle's own MIME types. */
async function handleApp(pathname: string, rendererRoot: string): Promise<Response> {
  // `standard: true` means Chromium has already normalised the path; decode once, then prove
  // containment on the joined result anyway.
  const rel = decodeURIComponent(pathname === '/' ? '/index.html' : pathname).replace(/^\/+/, '');
  const file = normalize(join(rendererRoot, rel));
  if (file !== rendererRoot && !file.startsWith(rendererRoot + sep)) {
    return plain(403, 'outside the bundle');
  }
  const type = contentTypeFor(file);
  return streamFile(
    file,
    type,
    type.startsWith('text/html') ? { 'content-security-policy': CSP } : undefined
  );
}

/** `tetravox://file/<percent-encoded absolute path>` → a streaming read of an allow-listed file. */
async function handleFile(pathname: string): Promise<Response> {
  let requested: string;
  try {
    requested = decodeURIComponent(pathname.replace(/^\/+/, ''));
  } catch {
    return plain(400, 'malformed percent-encoding');
  }
  const file = resolveAllowed(requested);
  if (file === null) return plain(403, 'not on the allow-list');
  return streamFile(file, contentTypeFor(file), { 'cache-control': 'no-store' });
}

// ------------------------------------------------------------------------------------------------
// `tetravox://module` — installed extensions (§13, downloadable extensions, 2026-08-30)
// ------------------------------------------------------------------------------------------------

/**
 * `"<id>/<version>/<file>"` → the absolute path of a file that has been verified **since this
 * process started**.
 *
 * Deliberately a map and not a root directory. `handleApp` and `handleFile` both have to prove
 * containment after joining, because a caller supplies part of a path; here the caller supplies a
 * *key* and nothing else, so there is no traversal surface to defend. The consequences follow from
 * that one choice:
 *
 *  * a module that is installed but **not consented** is not on the map, so the scheme 404s it —
 *    consent gates execution, not just the switcher row;
 *  * a module whose bytes changed on disk since it was enabled is not re-verified per request, but
 *    it was re-hashed at enable (`sample-data.ts`'s "a cached file is re-hashed, not trusted"), and
 *    `disableModule` empties its entries the moment the user withdraws consent;
 *  * only `.js` and `.css` are ever reachable, because `enableModule` only ever adds those.
 *
 * It is module state rather than `module-store.ts` state so that `protocol.ts` — the file that
 * serves it — is also the file that owns it, and so the store can be unit-tested without a running
 * `protocol.handle`.
 */
const served = new Map<string, string>();

/** The key `enableModule` files a module's file under, and the URL the renderer imports. */
export function moduleKey(id: string, version: string, file: string): string {
  return `${id}/${version}/${file}`;
}

/** The `tetravox://module/…` URL for one served file. Kept here so both sides agree on the shape. */
export function moduleUrl(id: string, version: string, file: string): string {
  return `${SCHEME}://module/${moduleKey(id, version, file)}`;
}

/**
 * Put one verified file on the map. **Only `module-store.ts#enableModule()` calls this**, and only
 * after re-hashing the file against the receipt written at install time.
 */
export function serveModuleFile(id: string, version: string, file: string, absolute: string): void {
  served.set(moduleKey(id, version, file), absolute);
}

/** Take a module's files off the map — every version of it. Disable, remove and a failed enable. */
export function unserveModule(id: string): number {
  const prefix = `${id}/`;
  let dropped = 0;
  for (const key of [...served.keys()]) {
    if (key.startsWith(prefix)) {
      served.delete(key);
      dropped += 1;
    }
  }
  return dropped;
}

/** What is currently reachable through the scheme. A test seam, and the dialog's "enabled" truth. */
export function servedModuleKeys(): string[] {
  return [...served.keys()].sort();
}

/**
 * The version of `id` currently on the map, or null when nothing of it is served.
 *
 * `enableModule` unserves every version of an id before it serves the one it is enabling, so at most
 * one version of any id is ever on the map — which is what makes "is this module enabled?" a
 * question the served map alone can answer, without a second consult of the consent record
 * (module-store.ts `moduleStatuses`, and its update-teardown, 2026-08-31).
 */
export function servedModuleVersion(id: string): string | null {
  const prefix = `${id}/`;
  for (const key of served.keys()) {
    if (key.startsWith(prefix)) return key.slice(prefix.length).split('/')[0] ?? null;
  }
  return null;
}

/** Test seam, mirroring `paths.ts#clearAllowList`. */
export function clearServedModules(): void {
  served.clear();
}

/**
 * `tetravox://module/<id>/<version>/<file>` → a verified, enabled extension file, or 404.
 *
 * No join, no root, no containment proof — see {@link served}. A pathname that is not a key is a
 * miss, and every way of writing a traversal is just a different miss.
 */
async function handleModule(pathname: string): Promise<Response> {
  let key: string;
  try {
    key = decodeURIComponent(pathname.replace(/^\/+/, ''));
  } catch {
    return plain(400, 'malformed percent-encoding');
  }
  const file = served.get(key);
  if (file === undefined) return plain(404, `no enabled module resource: ${key}`);
  // `no-store`: the file is replaced in place by an update, and a cached copy of a module the user
  // has since disabled would outlive the consent that admitted it.
  return streamFile(file, contentTypeFor(file), { 'cache-control': 'no-store' });
}

/** Must run after `app.whenReady()`. `rendererRoot` is the directory holding `index.html`. */
export function handleScheme(rendererRoot: string): void {
  const root = normalize(rendererRoot);
  protocol.handle(SCHEME, async (request) => {
    const url = new URL(request.url);
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return plain(405, 'method not allowed');
    }
    switch (url.host) {
      case 'app':
        return handleApp(url.pathname, root);
      case 'file':
        return handleFile(url.pathname);
      case 'module':
        return handleModule(url.pathname);
      default:
        return plain(404, `unknown host: ${url.host}`);
    }
  });
}

/** The URL a worker fetches for `absolutePath`. Kept here so both sides agree on the encoding. */
export function fileUrl(absolutePath: string): string {
  return `${SCHEME}://file/${encodeURIComponent(absolutePath)}`;
}
