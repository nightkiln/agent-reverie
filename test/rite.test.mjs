// Board (Rite) extras: quiet notes, pins, rise order and the ebb sweep.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { Reverie, compact } from '../core/store.mjs';

const CLI = fileURLToPath(new URL('../core/cli.mjs', import.meta.url));
const DAY = new Date('2026-10-19T13:00:00Z');
const days = (n) => new Date(DAY.getTime() + n * 24 * 60 * 60 * 1000);

async function withReverie(fn) {
  const home = await mkdtemp(join(tmpdir(), 'reverie-'));
  try {
    const env = { ...process.env, REVERIE_HOME: home, REVERIE_CHAIR: 'chair' };
    const dream = async (...args) => (await promisify(execFile)(process.execPath, [CLI, ...args], { env })).stdout;
    await fn(new Reverie(home, { chair: 'chair' }), dream);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

const board = (r, topic, now = DAY, project = 'app') => r.open(topic, { from: 'alpha', mode: 'board', project, now }).then((e) => e.night);

test('a quiet note answers without lifting the board; meetings take none', () => withReverie(async (r) => {
  const night = await board(r, 'hush');
  await r.append(night, { kind: 'note', from: 'beta', text: 'loud' }, days(1));
  await r.append(night, { kind: 'note', from: 'gamma', text: 'agreed', quiet: true }, days(2));
  const [room] = await r.nights();
  assert.equal(room.rise, days(1).toISOString());
  assert.equal(compact((await r.read(night)).at(-1), 'hush'), 'hush#3 gamma>* quiet: agreed');

  const meeting = (await r.open('meet', { now: DAY })).night;
  await assert.rejects(r.append(meeting, { kind: 'note', from: 'beta', text: 'x', quiet: true }), /takes no quiet notes/);
  await assert.rejects(r.append(night, { kind: 'ring', from: 'beta', to: ['alpha'], quiet: true }), /quiet is true on a note/);
}));

test('pins: the opener or the chair keeps a board on top; meetings take none', () => withReverie(async (r) => {
  const night = await board(r, 'pinned');
  await assert.rejects(r.append(night, { kind: 'pin', from: 'beta', text: 'on' }), /only alpha \(who opened it\) or the chair/);
  await assert.rejects(r.append(night, { kind: 'pin', from: 'alpha', text: 'yes' }), /on or off/);
  await r.append(night, { kind: 'pin', from: 'alpha', text: 'on' });
  assert.equal((await r.nights())[0].pinned, true);
  await r.append(night, { kind: 'pin', from: 'chair', text: 'off' });
  assert.equal((await r.nights())[0].pinned, false);
  const meeting = (await r.open('meet', { now: DAY })).night;
  await assert.rejects(r.append(meeting, { kind: 'pin', from: 'chair', text: 'on' }), /takes no pins/);
}));

test('a project lists pinned first, then boards by latest rise', () => withReverie(async (r, dream) => {
  const old = await board(r, 'old', days(0));
  const fresh = await board(r, 'fresh', days(1));
  const top = await board(r, 'top', days(0));
  await r.open('elsewhere', { from: 'beta', mode: 'board', project: 'other', now: days(3) });
  await r.append(old, { kind: 'note', from: 'beta', text: 'bump' }, days(2));
  await r.append(fresh, { kind: 'note', from: 'beta', text: 'hush', quiet: true }, days(4));
  await r.append(top, { kind: 'pin', from: 'alpha', text: 'on' }, days(0));
  assert.deepEqual((await r.fane('app')).map((n) => n.night.slice(11)), ['top', 'old', 'fresh']);
  await r.append(old, { kind: 'wake', from: 'alpha' }, days(2));
  const listed = (out) => out.trim().split('\n').map((line) => JSON.parse(line).night.slice(11));
  assert.deepEqual(listed(await dream('nights', '--project', 'app', '--open')), ['top', 'fresh']);
  assert.deepEqual(listed(await dream('nights', '--project', 'app', '--crypt')), ['old']);
}));

test('the sweep closes a board that has not risen for its ebb days, and only that', () => withReverie(async (r) => {
  const stale = await board(r, 'stale', days(0));
  await r.append(stale, { kind: 'note', from: 'beta', text: 'last word' }, days(1));
  await r.append(stale, { kind: 'note', from: 'gamma', text: 'quiet ack', quiet: true }, days(5));
  const live = await board(r, 'live', days(0));
  await r.append(live, { kind: 'note', from: 'beta', text: 'recent' }, days(6));
  await r.open('meet', { now: days(0) });

  assert.deepEqual(await r.sweep(days(7.5)), []);
  assert.deepEqual(await r.sweep(days(8.5)), [stale]);
  assert.deepEqual(await r.sweep(days(8.5)), [], 'a second sweep finds nothing');
  const wake = (await r.read(stale)).at(-1);
  assert.equal(wake.from, 'reverie');
  assert.equal(wake.expired, true);
  assert.equal(compact(wake, 'stale'), 'stale#4 reverie>* expired wake: Closed after 7 quiet days.');
  assert.match(await readFile(r.minutesPath(stale), 'utf8'), /Closed after 7 quiet days/);
  assert.match(await r.memo(), /## .*-stale\n/);
}));

test('limits: open Rites per author, notes per Rite, days from open', () => withReverie(async (r) => {
  for (const t of ['one', 'two', 'three']) await board(r, t);
  await assert.rejects(board(r, 'four'), /alpha already has 3 open Rites \(the limit is 3\); wake one first/);
  await r.open('chairs', { from: 'chair', mode: 'board', now: DAY });
  await r.append(`${DAY.toISOString().slice(0, 10)}-one`, { kind: 'wake', from: 'alpha' }, DAY);
  await board(r, 'four');

  const full = (await r.open('full', { from: 'beta', mode: 'board', now: DAY })).night;
  for (let i = 0; i < 60; i++) await r.append(full, { kind: 'note', from: `w${'abcdefghij'[i % 10]}x`, text: `n${i}` }, new Date(DAY.getTime() + i * 60000));
  await assert.rejects(r.append(full, { kind: 'note', from: 'beta', text: 'one more' }, days(1)), /this Rite is full \(60 notes\)/);
  await r.append(full, { kind: 'ring', from: 'beta', to: ['alpha'] }, days(1));

  const busy = (await r.open('busy', { from: 'gamma', mode: 'board', now: DAY })).night;
  for (let d = 1; d <= 14; d++) await r.append(busy, { kind: 'note', from: 'beta', text: `day ${d}` }, days(d - 0.5));
  assert.deepEqual(await r.sweep(days(1.5)), [full]);
  assert.match((await r.read(full)).at(-1).text, /Closed at its 60-note limit\./);
  assert.ok(!(await r.sweep(days(13.9))).includes(busy), 'still rising, still open');
  assert.ok((await r.sweep(days(14.1))).includes(busy), 'a Rite that keeps rising still closes after 14 days');
  assert.equal((await r.read(busy)).at(-1).text, 'Closed after 14 days open.');
}));

test('reverie is reserved for the sweep', () => withReverie(async (r) => {
  await assert.rejects(r.open('mine', { from: 'reverie', mode: 'board', now: DAY }), /reserved/);
  const night = await board(r, 'early');
  await assert.rejects(r.append(night, { kind: 'note', from: 'reverie', text: 'hi' }), /reserved/);
  await assert.rejects(r.append(night, { kind: 'wake', from: 'alpha', expired: true }), /reserved/);
  await assert.rejects(r.append(night, { kind: 'wake', from: 'reverie', expired: true }, days(1)), /rose less than 7 days ago and is within its limits/);
  const meeting = (await r.open('meet', { now: DAY })).night;
  await assert.rejects(r.append(meeting, { kind: 'wake', from: 'reverie', expired: true }, days(30)), /does not ebb/);
}));

test('dream pin and dream note --quiet', () => withReverie(async (r, dream) => {
  const night = await board(r, 'cli');
  assert.equal((await dream('pin', 'cli', 'on', '--as', 'alpha', '--compact')).trim(), 'cli#2 alpha>* pin: on');
  assert.equal((await dream('note', 'cli', '--as', 'beta', '--quiet', 'fine', '--compact')).trim(), 'cli#3 beta>* quiet: fine');
  assert.equal((await r.nights())[0].pinned, true);
  assert.equal((await r.read(night)).at(-1).quiet, true);
}));
