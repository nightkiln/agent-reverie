import { test } from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Reverie } from '../core/store.mjs';
import { chairServer } from '../core/serve.mjs';

async function withChair(fn) {
  const home = await mkdtemp(join(tmpdir(), 'reverie-'));
  const reverie = new Reverie(home);
  const server = chairServer(reverie, { port: 0 });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  try {
    await fn({ reverie, port });
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(home, { recursive: true, force: true });
  }
}

function call(port, method, path, { body, host = `127.0.0.1:${port}`, type = 'application/json' } = {}) {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, method, path, headers: { host, ...(body !== undefined ? { 'content-type': type } : {}) } }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => {
        let json;
        try { json = JSON.parse(data); } catch {}
        resolve({ status: res.statusCode, type: res.headers['content-type'], json, text: data });
      });
    });
    req.on('error', reject);
    if (body !== undefined) req.write(typeof body === 'string' ? body : JSON.stringify(body));
    req.end();
  });
}

test('chair page: serves the page and runs a Night as chair', () => withChair(async ({ reverie, port }) => {
  const page = await call(port, 'GET', '/');
  assert.equal(page.status, 200);
  assert.deepEqual((await call(port, 'GET', '/api/presence')).json, []);
  assert.deepEqual((await call(port, 'GET', '/api/chair')).json, { chair: 'chair' });
  const board = await call(port, 'POST', '/api/open', { body: { topic: 'ideas', mode: 'board' } });
  assert.deepEqual([board.json.mode, board.json.from], ['board', 'chair']);
  const asked = await call(port, 'POST', '/api/note', { body: { night: board.json.night, text: 'x', to: ['tester'], ask: 'formal' } });
  assert.match(asked.json.error, /board takes no asks/);
  await reverie.heartbeat('tester');
  assert.deepEqual((await call(port, 'GET', '/api/presence')).json.map((p) => [p.codename, p.listening]), [['tester', true]]);
  assert.match(page.type, /text\/html/);
  assert.match(page.text, /Reverie Dais/);
  const modes = (await call(port, 'GET', '/api/modes')).json;
  assert.deepEqual([modes.meeting.label, modes.board.label], ['Night', 'Rite']);
  assert.deepEqual(modes.board.capabilities, ['bell', 'quiet', 'pin']);
  const hushed = await call(port, 'POST', '/api/note', { body: { night: board.json.night, text: 'fine', quiet: true } });
  assert.equal(hushed.json.quiet, true);
  const starred = await call(port, 'POST', '/api/pin', { body: { night: board.json.night, on: true } });
  assert.deepEqual([starred.json.kind, starred.json.text], ['pin', 'on']);
  assert.equal((await call(port, 'GET', '/api/nights')).json.find((n) => n.night === board.json.night).pinned, true);

  const opened = await call(port, 'POST', '/api/open', { body: { topic: 'chair-test', agenda: 'try the page', project: 'reverie' } });
  assert.equal(opened.json.project, 'reverie');
  assert.equal(opened.status, 200);
  const night = opened.json.night;
  assert.equal(opened.json.from, 'chair');

  await reverie.append(night, { kind: 'lamp', from: 'tester' });
  const note = await call(port, 'POST', '/api/note', { body: { night, text: 'hello', to: ['tester'] } });
  assert.equal(note.status, 200);
  assert.deepEqual(note.json.to, ['tester']);
  const ring = await call(port, 'POST', '/api/ring', { body: { night, to: ['tester'] } });
  assert.equal(ring.json.kind, 'ring');

  const formal = await call(port, 'POST', '/api/note', { body: { night, text: 'ship it', to: ['tester'], ask: 'formal', for: ['alpha'] } });
  assert.deepEqual([formal.json.ask, formal.json.for], ['formal', ['alpha']]);
  const events = await call(port, 'GET', `/api/events?night=${night}&since=2`);
  assert.deepEqual(events.json.map((e) => e.kind), ['note', 'ring', 'note']);

  const nights = await call(port, 'GET', '/api/nights');
  assert.equal(nights.json[0].open, true);

  const wake = await call(port, 'POST', '/api/wake', { body: { night, text: 'done' } });
  assert.equal(wake.json.kind, 'wake');
  const after = await call(port, 'POST', '/api/note', { body: { night, text: 'too late' } });
  assert.equal(after.status, 400);
  assert.match(after.json.error, /is over/);
}));

test('chair page: refuses foreign hosts, non-JSON posts and bad input', () => withChair(async ({ port }) => {
  assert.equal((await call(port, 'GET', '/api/nights', { host: 'evil.example' })).status, 403);
  assert.equal((await call(port, 'POST', '/api/open', { body: 'topic=x', type: 'application/x-www-form-urlencoded' })).status, 415);
  assert.equal((await call(port, 'POST', '/api/open', { body: { topic: 'Bad Topic!' } })).status, 400);
  assert.equal((await call(port, 'GET', '/api/events?night=../../etc&since=0')).status, 400);
  assert.equal((await call(port, 'GET', '/api/events?night=2026-10-19-x&since=-1')).status, 400);
  assert.equal((await call(port, 'GET', '/nope')).status, 404);
}));
