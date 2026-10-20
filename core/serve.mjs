import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { REGISTRY } from './modes.mjs';

const PAGE = new URL('./chair.html', import.meta.url);
const MAX_BODY = 64 * 1024;

// The chair page. Bound to 127.0.0.1 only. Every write is a JSON POST, which a
// cross-site form cannot send, and the Host header must name this server, which
// stops DNS-rebinding pages from reaching it.
export function chairServer(reverie, { port = 7777 } = {}) {
  const server = createServer(async (req, res) => {
    try {
      const host = req.headers.host ?? '';
      const bound = server.address()?.port ?? port;
      if (host !== `127.0.0.1:${bound}` && host !== `localhost:${bound}`) return send(res, 403, { error: 'bad host' });

      const url = new URL(req.url, `http://${host}`);
      const route = `${req.method} ${url.pathname}`;

      if (route === 'GET /') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
        return res.end(await readFile(PAGE));
      }
      if (route === 'GET /api/chair') return send(res, 200, { chair: reverie.chair });
      if (route === 'GET /api/modes') return send(res, 200, REGISTRY);
      if (route === 'GET /api/nights') return send(res, 200, await reverie.nights());
      if (route === 'GET /api/presence') return send(res, 200, await reverie.presence());
      if (route === 'GET /api/events') {
        const since = Number(url.searchParams.get('since') ?? 0);
        if (!Number.isInteger(since) || since < 0) return send(res, 400, { error: 'since must be a whole number' });
        return send(res, 200, await reverie.read(url.searchParams.get('night'), since));
      }

      if (req.method !== 'POST') return send(res, 404, { error: 'not found' });
      if (!(req.headers['content-type'] ?? '').startsWith('application/json')) return send(res, 415, { error: 'JSON only' });
      const body = await readJson(req);

      switch (url.pathname) {
        case '/api/open':
          return send(res, 200, await reverie.open(body.topic, { agenda: body.agenda || undefined, project: body.project || undefined, mode: body.mode || undefined }));
        case '/api/note':
          return send(res, 200, await reverie.append(body.night, {
            kind: 'note', from: reverie.chair, text: body.text, to: body.to?.length ? body.to : undefined,
            replyTo: body.replyTo ?? undefined,
            ask: body.ask || undefined, for: body.for?.length ? body.for : undefined,
            quiet: body.quiet === true || undefined,
          }));
        case '/api/pin':
          return send(res, 200, await reverie.append(body.night, { kind: 'pin', from: reverie.chair, text: body.on ? 'on' : 'off' }));
        case '/api/ring':
          return send(res, 200, await reverie.append(body.night, { kind: 'ring', from: reverie.chair, to: body.to, text: body.text || undefined }));
        case '/api/wake':
          return send(res, 200, await reverie.append(body.night, { kind: 'wake', from: reverie.chair, text: body.text || undefined, ...(body.dismiss === true ? { dismiss: true } : {}) }));
        default:
          return send(res, 404, { error: 'not found' });
      }
    } catch (err) {
      send(res, 400, { error: err.message });
    }
  });
  return server;
}

function send(res, status, value) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(value));
}

async function readJson(req) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) throw new Error('request too large');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
}
