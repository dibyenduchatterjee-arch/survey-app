// Minimal static file server for the browser test harness and local PWA preview.
// Serves ONLY webapp/ and shared/. The repo root holds .env, .git/ and the
// SQLite database, none of which may ever be reachable over localhost.
import { createServer } from 'node:http';
import { readFile, realpath, stat } from 'node:fs/promises';
import { dirname, extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ALLOWED = ['webapp', 'shared'];
const port = Number(process.argv[2]) || 8008;
const types = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

// Returns an absolute file path inside an allowed directory, or null.
export function resolveServable(urlPath) {
  let path;
  try { path = decodeURIComponent(urlPath); } catch { return null; }
  if (path.includes('\0') || path.includes('\\')) return null;
  const segments = path.split('/').filter(Boolean);
  // Refuse traversal outright rather than relying on resolve() alone, and
  // refuse any dotfile or dot-directory (.env, .git, ...).
  if (segments.some(s => s === '..' || s === '.' || s.startsWith('.'))) return null;
  if (!ALLOWED.includes(segments[0])) return null;
  const file = resolve(root, ...segments);
  for (const dir of ALLOWED) {
    const base = resolve(root, dir);
    if (file === base || file.startsWith(base + sep)) return file;
  }
  return null;
}

const server = createServer(async (req, res) => {
  const deny = code => res.writeHead(code, { 'Content-Type': 'text/plain' }).end(code === 403 ? 'Forbidden' : 'Not found');
  try {
    if (req.method !== 'GET' && req.method !== 'HEAD') return deny(403);
    const file = resolveServable(new URL(req.url, 'http://x').pathname);
    if (!file) return deny(403);
    // A symlink inside webapp/ must not lead out of it.
    const real = await realpath(file);
    if (!ALLOWED.some(d => real === resolve(root, d) || real.startsWith(resolve(root, d) + sep))) return deny(403);
    const info = await stat(real);
    if (!info.isFile()) return deny(404);
    res.writeHead(200, {
      'Content-Type': types[extname(real)] || 'application/octet-stream',
      'Cache-Control': 'no-store',
    });
    res.end(req.method === 'HEAD' ? undefined : await readFile(real));
  } catch {
    deny(404);
  }
});

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  // Loopback only: the dev server is not for other machines on the network.
  server.listen(port, '127.0.0.1', () =>
    console.log(`Serving ${ALLOWED.join(', ')} from ${root} on http://localhost:${port}`));
}
