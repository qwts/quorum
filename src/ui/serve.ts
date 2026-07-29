// Serving the library — requirement 6: consumable by the server process that
// serves the UI, with no separate build step for a contributor who only wants
// to run quorum.
//
// There is nothing to compile, so this is a static file handler over
// `src/ui/`, and that is the whole story: `npm start`, open `/ui/`, and the
// files on disk are the files in the browser.
//
// Two things it refuses to do:
//
//   * leave `src/ui`. The path is resolved and checked against the root, so a
//     `..` in the URL is a 404 rather than a read of your home directory.
//     v0 binds to 127.0.0.1 and trusts the machine boundary — that is a reason
//     to keep this narrow, not a reason to skip the check.
//   * guess. An extension it does not know is not served, rather than served
//     as something plausible.

import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export const UI_PATH = '/ui';

const ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)));

const TYPES = new Map([
  ['.html', 'text/html; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.md', 'text/markdown; charset=utf-8'],
]);

/**
 * Serve a file under `src/ui`. Returns false when the request is not ours, so
 * the caller falls through to its own 404 — this handler never decides what a
 * non-UI path means.
 */
export async function serveUi(req: IncomingMessage, res: ServerResponse, pathname: string): Promise<boolean> {
  if (pathname !== UI_PATH && !pathname.startsWith(`${UI_PATH}/`)) return false;

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { 'content-type': 'application/json', allow: 'GET, HEAD' });
    res.end(JSON.stringify({ error: 'the UI is static; only GET and HEAD are served' }));
    return true;
  }

  // Redirect the bare root rather than serving a page from it: a page served
  // at a path it does not live at resolves every relative href one directory
  // too high, and silently — the stylesheet 404s and you get an unstyled page
  // with no error anywhere.
  //
  // The root lands on the room view — the product's front door (#48). It
  // pointed at the component gallery once, when the gallery was the only
  // page; a person told to "open the UI" should meet the product, not its
  // parts catalogue. The gallery keeps its URL at kit/components.html.
  if (pathname === UI_PATH || pathname === `${UI_PATH}/`) {
    res.writeHead(302, { location: `${UI_PATH}/kit/room.html` });
    res.end();
    return true;
  }

  const relative = decodeURIComponent(pathname.slice(UI_PATH.length));

  const target = resolve(join(ROOT, normalize(relative)));
  if (target !== ROOT && !target.startsWith(ROOT + sep)) {
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'not found' }));
    return true;
  }

  const dot = target.lastIndexOf('.');
  const type = dot === -1 ? undefined : TYPES.get(target.slice(dot).toLowerCase());
  if (type === undefined) {
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'not found' }));
    return true;
  }

  let size: number;
  try {
    const info = await stat(target);
    if (!info.isFile()) throw new Error('not a file');
    size = info.size;
  } catch {
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'not found' }));
    return true;
  }

  res.writeHead(200, { 'content-type': type, 'content-length': size, 'cache-control': 'no-cache' });
  if (req.method === 'HEAD') {
    res.end();
    return true;
  }
  createReadStream(target).pipe(res);
  return true;
}
