import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'page');
const MIME = { '.html': 'text/html', '.svg': 'image/svg+xml' };

export function startFixtureServer({ port = 0 } = {}) {
  const server = createServer(async (req, res) => {
    const file = req.url === '/' ? 'index.html' : req.url.slice(1);
    try {
      const body = await readFile(join(root, file));
      res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream' });
      res.end(body);
    } catch {
      res.writeHead(404);
      res.end('not found');
    }
  });
  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => {
      resolve({
        url: `http://127.0.0.1:${server.address().port}/`,
        close: () => new Promise((r) => server.close(r)),
      });
    });
  });
}

// CLI mode: node test/helpers/serve.js 8123
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port = Number(process.argv[2] ?? 0);
  startFixtureServer({ port }).then(({ url }) => console.log(`fixture server: ${url}`));
}
