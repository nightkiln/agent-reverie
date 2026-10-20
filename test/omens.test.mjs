// The watch suite: shown and handled positions, Omens, and `watch --ping`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { Reverie, urgentFor } from '../core/store.mjs';

const CLI = fileURLToPath(new URL('../core/cli.mjs', import.meta.url));
const DAY = new Date('2026-10-19T13:00:00Z');
const later = (s) => new Date(DAY.getTime() + s * 1000);
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function withReverie(fn) {
  const home = await mkdtemp(join(tmpdir(), 'reverie-'));
  try {
    const env = { ...process.env, REVERIE_HOME: home, REVERIE_CHAIR: 'chair' };
    const dream = async (...args) => (await promisify(execFile)(process.execPath, [CLI, ...args], { env })).stdout;
    await fn(new Reverie(home, { chair: 'chair' }), { home, env, dream });
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

const lines = (out) => out.trim().split('\n').filter(Boolean);

test('omens lists what is for you across Rooms, oldest first, until handled', () => withReverie(async (r, { dream }) => {
  const a = (await r.open('aa', { now: DAY })).night;
  const b = (await r.open('bb', { from: 'beta', mode: 'board', now: later(1) })).night;
  await r.append(b, { kind: 'note', from: 'beta', text: 'board first' }, later(2));
  await r.append(a, { kind: 'note', from: 'chair', text: 'meeting second' }, later(3));
  await r.append(a, { kind: 'note', from: 'chair', to: ['beta'], text: 'not for tester' }, later(4));

  assert.deepEqual(lines(await dream('omens', '--as', 'tester', '--compact', '--peek')), [
    'aa#1 chair>* open', 'bb#1 beta>* mode=board open', 'bb#2 beta>*: board first', 'aa#2 chair>*: meeting second',
  ]);
  assert.equal(lines(await dream('omens', '--as', 'tester', '--compact')).length, 4);
  // Shown, not handled: still listed, now marked shown.
  assert.deepEqual(lines(await dream('omens', '--as', 'tester', '--compact', '--project', 'none')), []);
  assert.equal(lines(await dream('omens', '--as', 'tester', '--compact')).at(-1), 'aa#2 chair>* shown: meeting second');
  await dream('omens', '--as', 'tester', '--mark-handled', 'all');
  assert.equal(await dream('omens', '--as', 'tester'), '');

  await r.append(b, { kind: 'note', from: 'beta', text: 'one' }, later(6));
  await r.append(b, { kind: 'note', from: 'beta', text: 'two' }, later(7));
  await dream('omens', '--as', 'tester', '--mark-handled', 'bb#3');
  assert.deepEqual(lines(await dream('omens', '--as', 'tester', '--compact')), ['bb#4 beta>*: two']);
}));

test('omens starts from the old cursor, and skips closed Rooms it never saw', () => withReverie(async (r, { home }) => {
  const kept = (await r.open('kept', { now: DAY })).night;
  for (const text of ['a', 'b', 'c']) await r.append(kept, { kind: 'note', from: 'alpha', text });
  const gone = (await r.open('gone', { now: DAY })).night;
  await r.append(gone, { kind: 'note', from: 'alpha', text: 'missed' });
  await r.append(gone, { kind: 'wake', from: 'chair' });
  await mkdir(join(home, 'cursors'), { recursive: true });
  await writeFile(join(home, 'cursors', 'tester.json'), JSON.stringify({ [kept]: 3 }));
  assert.deepEqual((await r.omens('tester')).map(({ event }) => `${event.night.slice(11)}#${event.id}`), ['kept#4']);
}));

test('positions only move forward, whatever order writers arrive in', () => withReverie(async (r) => {
  const ids = Array.from({ length: 30 }, (_, i) => (i * 7) % 30 + 1);
  await Promise.all(ids.map((id) => r.advance('shown', 'tester', { n: id, [`m${id % 3}`]: id })));
  const stored = await r.positions('shown', 'tester');
  assert.equal(stored.n, 30);
  assert.deepEqual([stored.m0, stored.m1, stored.m2], [30, 28, 29]);
}));

test('urgent: rings and asks for you, and every meeting event', () => {
  const note = { kind: 'note', from: 'alpha', to: ['*'] };
  assert.equal(urgentFor(note, 'tester', 'meeting'), true);
  assert.equal(urgentFor(note, 'tester', 'board'), false);
  assert.equal(urgentFor({ ...note, to: ['tester'] }, 'tester', 'board'), false);
  assert.equal(urgentFor({ kind: 'ring', from: 'alpha', to: ['tester'] }, 'tester', 'board'), true);
  assert.equal(urgentFor({ kind: 'ring', from: 'alpha', to: ['other'] }, 'tester', 'board'), false);
  assert.equal(urgentFor({ ...note, from: 'tester' }, 'tester', 'meeting'), false);
});

test('watch --ping urgent waits for a ring, then prints the batch; none prints nothing', () => withReverie(async (r, { env, dream }) => {
  const { night } = await r.open('quiet', { from: 'beta', mode: 'board', now: DAY });
  const watch = (ping) => {
    const child = spawn(process.execPath, [CLI, 'watch', '--all', '--as', 'tester', '--interval', '50', '--compact', '--ping', ping], { env });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    return { stop: () => { child.kill(); return lines(out); } };
  };
  const urgent = watch('urgent');
  await wait(300);
  await r.append(night, { kind: 'note', from: 'beta', text: 'just so you know' });
  await wait(300);
  await r.append(night, { kind: 'ring', from: 'beta', to: ['tester'], text: 'need you' });
  await wait(400);
  assert.deepEqual(urgent.stop(), ['quiet#1 beta>* mode=board open', 'quiet#2 beta>*: just so you know', 'quiet#3 beta>tester ring: need you']);
  // Shown by the batch, so Omens lists them as shown.
  assert.deepEqual(lines(await dream('omens', '--as', 'tester', '--compact', '--peek')).slice(-1), ['quiet#3 beta>tester shown ring: need you']);

  const none = watch('none');
  await wait(300);
  await r.append(night, { kind: 'ring', from: 'beta', to: ['tester'] });
  await wait(300);
  assert.deepEqual(none.stop(), []);
  assert.equal((await r.presence())[0].listening, true);
}));

test('Dawn: a dismiss wake stops every watch --all, at any ping level; a plain wake does not', () => withReverie(async (r, { env }) => {
  const plain = (await r.open('plain', { now: DAY })).night;
  const dawn = (await r.open('dawn', { now: DAY })).night;
  await assert.rejects(r.append(dawn, { kind: 'wake', from: 'beta', dismiss: true }), /only the chair \(chair\) can dismiss/);
  await assert.rejects(r.append(dawn, { kind: 'note', from: 'chair', text: 'x', dismiss: true }), /dismiss is true on a wake/);

  const watch = (as, ping) => {
    const child = spawn(process.execPath, [CLI, 'watch', '--all', '--as', as, '--interval', '50', '--compact', '--ping', ping], { env });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    const exited = new Promise((resolve) => child.on('exit', resolve));
    return { child, exited, out: () => lines(out) };
  };
  const all = watch('tester', 'all');
  const none = watch('other', 'none');
  await wait(300);
  await r.append(plain, { kind: 'wake', from: 'chair', text: 'break' });
  await wait(300);
  assert.equal(all.child.exitCode, null, 'a plain wake keeps the watcher');
  assert.equal(none.child.exitCode, null);
  assert.equal((await r.presence()).length, 2);

  await r.append(dawn, { kind: 'wake', from: 'chair', text: 'done for today', dismiss: true });
  assert.equal(await all.exited, 0);
  assert.equal(await none.exited, 0);
  assert.equal(all.out().at(-1), 'dawn#2 chair>* dismiss wake: done for today');
  assert.deepEqual(none.out(), ['dawn#2 chair>* dismiss wake: done for today'], 'printed even at --ping none');
  assert.deepEqual(await r.presence(), [], 'Signs go down at once');

  // A watcher started after the Dawn does not stop on it again.
  const again = watch('tester', 'all');
  await wait(300);
  assert.equal(again.child.exitCode, null);
  again.child.kill();
}));
