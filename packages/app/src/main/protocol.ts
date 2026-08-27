/**
 * The privileged `tetravox://` scheme (§5, directive A2, ROADMAP Phase-0 gate 3).
 *
 * Two hosts, and only two:
 *
 * * `tetravox://app/…`  — the renderer bundle. `*_bg.wasm` is served as `application/wasm`, which is
 *   what makes `WebAssembly.instantiateStreaming` take the streaming path instead of silently falling
 *   back to a full buffer. The window is loaded with `loadURL('tetravox://app/index.html')`, never
 *   `loadFile()`, so the renderer and its module Workers share one real origin.
 * * `tetravox://file/<percent-encoded absolute path>` — user data, as a **streaming** `Response` over
 *   the disk. The dataset worker fetches this itself: raw file bytes never cross IPC and never touch
 *   the UI thread (§5 rule 3, AGENTS rule 7). Reads are confined to the `paths.ts` allow-list.
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
  "script-src 'self' 'wasm-unsafe-eval'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  // `tetravox://file` is a *different host* from `tetravox://app`, so `'self'` does not cover it.
  "connect-src 'self' tetravox:",
  "worker-src 'self' blob:",
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
      default:
        return plain(404, `unknown host: ${url.host}`);
    }
  });
}

/** The URL a worker fetches for `absolutePath`. Kept here so both sides agree on the encoding. */
export function fileUrl(absolutePath: string): string {
  return `${SCHEME}://file/${encodeURIComponent(absolutePath)}`;
}
