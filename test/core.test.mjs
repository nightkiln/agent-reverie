import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { access, appendFile, mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BOARD_RATE, COMPACT_MAX, RATE_GUARD, Reverie, chairOf, compact, deliveredTo } from '../core/store.mjs';

const CLI = fileURLToPath(new URL('../core/cli.mjs', import.meta.url));
const DAY = new Date('2026-10-19T13:00:00Z');

async function withReverie(fn) {
  const home = await mkdtemp(join(tmpdir(), 'reverie-'));
  try {
    await fn(new Reverie(home), home);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

test('a Night runs from open to wake and writes minutes', () => withReverie(async (r) => {
  const open = await r.open('rig-review', { agenda: '1) rig status', now: DAY });
  assert.equal(open.night, '2026-10-19-rig-review');
  assert.equal(open.id, 1);
  assert.deepEqual(open.to, ['*']);

  const night = open.night;
  await r.append(night, { kind: 'lamp', from: 'tester' });
  const note = await r.append(night, { kind: 'note', from: 'tester', text: 'rig is ready' });
  await r.append(night, { kind: 'note', from: 'alpha', text: 'approved', replyTo: note.id, to: ['tester'] });
  await r.append(night, { kind: 'wake', from: 'chair', text: 'ship rig v1' });

  assert.deepEqual((await r.read(night)).map((e) => e.id), [1, 2, 3, 4, 5]);
  assert.deepEqual((await r.read(night, 3)).map((e) => e.kind), ['note', 'wake']);

  const minutes = await readFile(r.minutesPath(night), 'utf8');
  assert.match(minutes, /Attended: tester/);
  assert.match(minutes, /ship rig v1/);
  assert.match(minutes, /#4 \*\*alpha\*\* → tester \(re #3\): approved/);

  const memo = await r.memo();
  assert.match(memo, /^# Reverie memo/);
  assert.match(memo, /## 2026-10-19-rig-review\n\n- Closed: .*\n- Attended: tester\n- Agenda: 1\) rig status\n- Minutes: minutes\/2026-10-19-rig-review\.md\n\nship rig v1\n/);
  const second = (await r.open('follow-up', { now: DAY })).night;
  await r.append(second, { kind: 'wake', from: 'chair' });
  const both = await r.memo();
  assert.equal(both.match(/^# Reverie memo/gm).length, 1);
  assert.ok(both.indexOf('rig-review') < both.indexOf('## 2026-10-19-follow-up'));
  assert.match(both, /\(no outcome recorded\)/);

  await assert.rejects(r.append(night, { kind: 'note', from: 'alpha', text: 'late' }), /is over/);
  const { rise, ...listed } = (await r.nights())[1];
  assert.deepEqual(listed, { night, open: false, notes: 2, lamps: ['tester'], mode: 'meeting', owner: 'chair', pinned: false });
  assert.ok(Date.parse(rise));
}));

test('validation: names, chair-only kinds, missing Nights, replies', () => withReverie(async (r) => {
  await assert.rejects(r.append('2026-10-19-nope', { kind: 'note', from: 'alpha', text: 'x' }), /does not exist/);
  await assert.rejects(r.open('Bad Topic'), /invalid topic/);
  await assert.rejects(r.open('t', { from: 'alpha' }), /only the chair/);
  const { night } = await r.open('t', { now: DAY });
  await assert.rejects(r.open('t', { now: DAY }), /already exists/);
  await assert.rejects(r.append(night, { kind: 'note', from: 'Alpha', text: 'x' }), /invalid codename/);
  await assert.rejects(r.append(night, { kind: 'note', from: 'alpha' }), /needs text/);
  await assert.rejects(r.append(night, { kind: 'note', from: 'alpha', text: 'x', replyTo: 99 }), /no event 99/);
  await assert.rejects(r.append(night, { kind: 'ring', from: 'chair' }), /needs a codename/);
  await assert.rejects(r.append(night, { kind: 'wake', from: 'alpha' }), /only the chair/);
}));

test('ids stay unique and gap-free under concurrent writers', () => withReverie(async (r) => {
  const { night } = await r.open('busy', { now: DAY });
  await Promise.all(Array.from({ length: 20 }, (_, i) => r.append(night, { kind: 'lamp', from: i % 2 ? 'alpha' : 'tester' })));
  assert.deepEqual((await r.read(night)).map((e) => e.id), Array.from({ length: 21 }, (_, i) => i + 1));
}));

test('read skips a torn last line until it is complete', () => withReverie(async (r) => {
  const { night } = await r.open('torn', { now: DAY });
  const path = r.nightPath(night);
  const line = JSON.stringify({ id: 2, night, time: DAY.toISOString(), from: 'alpha', to: ['*'], kind: 'note', text: 'whole' });
  await appendFile(path, line.slice(0, 20));
  assert.deepEqual((await r.read(night)).map((e) => e.id), [1]);
  await appendFile(path, line.slice(20) + '\n');
  assert.deepEqual((await r.read(night)).map((e) => e.id), [1, 2]);
}));

test('a stale lock is taken over once, even with many waiters', () => withReverie(async (r) => {
  const { night } = await r.open('stale', { now: DAY });
  const lock = `${r.nightPath(night)}.lock`;
  await writeFile(lock, '999999:dead\n');
  const old = new Date(Date.now() - 60_000);
  await utimes(lock, old, old);

  await Promise.all(Array.from({ length: 20 }, () => r.append(night, { kind: 'lamp', from: 'alpha' })));
  assert.deepEqual((await r.read(night)).map((e) => e.id), Array.from({ length: 21 }, (_, i) => i + 1));
  await assert.rejects(access(lock), { code: 'ENOENT' });
  await assert.rejects(access(`${lock}.gate`), { code: 'ENOENT' });
}));

test('a holder does not release a lock that is no longer its own', () => withReverie(async (r) => {
  const { night } = await r.open('owner', { now: DAY });
  const lock = `${r.nightPath(night)}.lock`;
  // Simulate this writer running past the stale limit: while it holds the lock,
  // another writer takes over and the lock file now carries that writer's token.
  const original = r.read.bind(r);
  r.read = async (...args) => {
    await writeFile(lock, 'other-writer\n');
    return original(...args);
  };
  await r.append(night, { kind: 'lamp', from: 'alpha' });
  assert.equal(await readFile(lock, 'utf8'), 'other-writer\n');
}));

test('rate guard stops participants until the chair speaks', () => withReverie(async (r) => {
  const { night } = await r.open('loop', { now: DAY });
  for (let i = 0; i < RATE_GUARD; i++) await r.append(night, { kind: 'note', from: i % 2 ? 'alpha' : 'tester', text: `${i}` });
  await assert.rejects(r.append(night, { kind: 'note', from: 'alpha', text: 'one more' }), /rate guard/);
  await r.append(night, { kind: 'note', from: 'chair', text: 'carry on' });
  await r.append(night, { kind: 'note', from: 'alpha', text: 'thanks' });
}));

test('delivery skips your own events and respects to', () => {
  assert.equal(deliveredTo({ from: 'alpha', to: ['*'] }, 'alpha'), false);
  assert.equal(deliveredTo({ from: 'alpha', to: ['*'] }, 'tester'), true);
  assert.equal(deliveredTo({ from: 'alpha', to: ['chair'] }, 'tester'), false);
  assert.equal(deliveredTo({ from: 'alpha', to: ['tester'] }, 'tester'), true);
});

test('dream watch prints only events for the watcher and exits on wake', () => withReverie(async (r, home) => {
  const env = { ...process.env, REVERIE_HOME: home };
  const { night } = await r.open('watch', { now: DAY });
  const watcher = spawn(process.execPath, [CLI, 'watch', night, '--as', 'tester', '--interval', '50'], { env });
  let out = '';
  watcher.stdout.on('data', (d) => (out += d));
  const exited = new Promise((resolve) => watcher.on('exit', resolve));
  await new Promise((resolve) => setTimeout(resolve, 300));

  await r.append(night, { kind: 'lamp', from: 'tester' });
  await r.append(night, { kind: 'note', from: 'alpha', text: 'for everyone' });
  await r.append(night, { kind: 'note', from: 'alpha', text: 'for chair only', to: ['chair'] });
  await r.append(night, { kind: 'note', from: 'tester', text: 'my own' });
  await r.append(night, { kind: 'ring', from: 'chair', to: ['tester'] });
  await r.append(night, { kind: 'wake', from: 'chair' });

  assert.equal(await exited, 0);
  const seen = out.trim().split('\n').map((line) => JSON.parse(line));
  assert.deepEqual(seen.map((e) => `${e.from}:${e.kind}:${e.text ?? ''}`), [
    'alpha:note:for everyone',
    'chair:ring:',
    'chair:wake:',
  ]);
}));

test('dream watch --all follows every Night, catches up, and survives a wake', () => withReverie(async (r, home) => {
  const env = { ...process.env, REVERIE_HOME: home };
  const closed = (await r.open('closed', { now: DAY })).night;
  await r.append(closed, { kind: 'ring', from: 'chair', to: ['tester'], text: 'old' });
  await r.append(closed, { kind: 'wake', from: 'chair' });
  const live = (await r.open('live', { now: DAY })).night;
  await r.append(live, { kind: 'ring', from: 'chair', to: ['tester'], text: 'answered' });
  await r.append(live, { kind: 'lamp', from: 'tester' });
  await r.append(live, { kind: 'ring', from: 'chair', to: ['tester'], text: 'missed' });

  const watcher = spawn(process.execPath, [CLI, 'watch', '--all', '--as', 'tester', '--interval', '50'], { env });
  let out = '';
  watcher.stdout.on('data', (d) => (out += d));
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  try {
    await wait(300);
    const fresh = (await r.open('fresh', { now: DAY })).night;
    await r.append(fresh, { kind: 'ring', from: 'chair', to: ['tester'], text: 'new night' });
    await r.append(live, { kind: 'wake', from: 'chair' });
    await wait(300);
    await r.append(fresh, { kind: 'note', from: 'alpha', text: 'still here' });
    await wait(300);
    assert.equal(watcher.exitCode, null);
  } finally {
    watcher.kill();
  }
  const seen = out.trim().split('\n').map((line) => JSON.parse(line));
  assert.deepEqual(seen.map((e) => `${e.night.slice(11)}:${e.kind}:${e.text ?? ''}`), [
    'live:ring:missed',
    'fresh:open:',
    'fresh:ring:new night',
    'live:wake:',
    'fresh:note:still here',
  ]);
}));

test('a formal ask goes from the chair to one agent and names its audience', () => withReverie(async (r) => {
  const { night } = await r.open('formal', { now: DAY });
  const draft = await r.append(night, { kind: 'note', from: 'chair', to: ['alpha'], text: 'lets ship it', ask: 'formal', for: ['beta', 'gamma'] });
  assert.equal(draft.ask, 'formal');
  assert.deepEqual(draft.for, ['beta', 'gamma']);
  const everyone = await r.append(night, { kind: 'note', from: 'chair', to: ['alpha'], text: 'hi', ask: 'formal' });
  assert.deepEqual(everyone.for, ['*']);
  await assert.rejects(r.append(night, { kind: 'note', from: 'alpha', to: ['beta'], text: 'x', ask: 'formal' }), /only a note from the chair/);
  await assert.rejects(r.append(night, { kind: 'note', from: 'chair', to: ['*'], text: 'x', ask: 'formal' }), /exactly one codename/);
  await assert.rejects(r.append(night, { kind: 'note', from: 'chair', to: ['alpha'], text: 'x', ask: 'shout' }), /invalid ask/);
  await assert.rejects(r.append(night, { kind: 'note', from: 'chair', text: 'x', for: ['beta'] }), /for needs a formal ask/);
  const draftAsk = await r.append(night, { kind: 'note', from: 'chair', to: ['alpha'], text: 'draft the outcome', ask: 'outcome' });
  assert.deepEqual(draftAsk.for, ['chair']);
  await assert.rejects(r.append(night, { kind: 'note', from: 'chair', to: ['alpha'], text: 'x', ask: 'outcome', for: ['beta'] }), /for needs a formal ask/);
  await r.append(night, { kind: 'wake', from: 'chair' });
  assert.match(await readFile(r.minutesPath(night), 'utf8'), /#2 \*\*chair\*\* → alpha \[formal draft\]: lets ship it/);
}));

test('a Night can carry a project, shown in nights, minutes and memo', () => withReverie(async (r) => {
  const tagged = await r.open('tags', { project: 'my-app', now: DAY });
  assert.equal(tagged.project, 'my-app');
  await r.open('plain', { now: DAY });
  await assert.rejects(r.open('bad', { project: 'Bad Name', now: DAY }), /invalid project/);
  await assert.rejects(r.append(tagged.night, { kind: 'note', from: 'chair', text: 'x', project: 'p' }), /only open carries a project/);
  const nights = await r.nights();
  assert.deepEqual(nights.map((n) => n.project), [undefined, 'my-app']);
  await r.append(tagged.night, { kind: 'wake', from: 'chair', text: 'done' });
  assert.match(await readFile(r.minutesPath(tagged.night), 'utf8'), /- Project: my-app/);
  assert.match(await r.memo(), /## 2026-10-19-tags\n\n- Project: my-app\n/);
}));

test('compact lines drop the noise and cut long texts', () => {
  const base = { id: 47, night: '2026-10-19-standup', time: 'x', from: 'alpha', to: ['*'], kind: 'note' };
  assert.equal(compact({ ...base, replyTo: 46, text: 'two\nlines' }, 'standup'), 'standup#47 alpha>* re46: two ⏎ lines');
  assert.equal(compact({ ...base, from: 'chair', to: ['beta', 'gamma'], kind: 'ring' }), '2026-10-19-standup#47 chair>beta,gamma ring');
  assert.equal(compact({ ...base, from: 'chair', to: ['alpha'], ask: 'formal', for: ['*'], text: 'hi' }, 'standup'), 'standup#47 chair>alpha ask=formal for=*: hi');
  const long = compact({ ...base, text: 'a'.repeat(COMPACT_MAX + 1) }, 'standup');
  assert.ok(long.endsWith(`${'a'.repeat(COMPACT_MAX)}…(dream read standup --since 46)`));
});

test('a topic names its Night while no other Night shares it', () => withReverie(async (r) => {
  const { night } = await r.open('solo', { now: DAY });
  assert.equal(await r.resolve('solo'), night);
  assert.equal(await r.resolve(night), night);
  await r.open('solo', { now: new Date('2026-10-20T13:00:00Z') });
  await assert.rejects(r.resolve('solo'), /several Nights/);
  await assert.rejects(r.resolve('nothing'), /no Night/);
}));

test('dream watch --all resumes where the last watcher left off', () => withReverie(async (r, home) => {
  const env = { ...process.env, REVERIE_HOME: home };
  const { night } = await r.open('resume', { now: DAY });
  await r.append(night, { kind: 'ring', from: 'chair', to: ['tester'], text: 'first' });
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const run = async (during) => {
    const watcher = spawn(process.execPath, [CLI, 'watch', '--all', '--as', 'tester', '--interval', '50', '--compact'], { env });
    let out = '';
    watcher.stdout.on('data', (d) => (out += d));
    try {
      await wait(300);
      await during?.();
      await wait(300);
    } finally {
      watcher.kill();
    }
    return out.trim().split('\n').filter(Boolean);
  };
  assert.deepEqual(await run(), ['resume#1 chair>* open', 'resume#2 chair>tester ring: first']);
  await r.append(night, { kind: 'note', from: 'alpha', text: 'while away' });
  assert.deepEqual(await run(() => r.append(night, { kind: 'note', from: 'alpha', text: 'live' })), [
    'resume#3 alpha>*: while away',
    'resume#4 alpha>*: live',
  ]);
  assert.deepEqual(await run(), []);
  assert.deepEqual(JSON.parse(await readFile(join(home, 'cursors', 'tester.json'), 'utf8')), { [night]: 4 });
  const [seen] = await r.presence();
  assert.equal(seen.codename, 'tester');
  assert.equal(seen.listening, true);
}));

test('dream watch --all never replays a line to a reader that kills it right after', () => withReverie(async (r, home) => {
  const env = { ...process.env, REVERIE_HOME: home };
  const { night } = await r.open('vigil', { now: DAY });
  await r.append(night, { kind: 'lamp', from: 'tester' });
  const firstLine = () => new Promise((resolve) => {
    const watcher = spawn(process.execPath, [CLI, 'watch', '--all', '--as', 'tester', '--interval', '50', '--compact'], { env });
    let out = '';
    const timer = setTimeout(() => { watcher.kill('SIGKILL'); resolve(null); }, 1500);
    watcher.stdout.on('data', (d) => {
      out += d;
      if (!out.includes('\n')) return;
      watcher.kill('SIGKILL');
      clearTimeout(timer);
      resolve(out.split('\n')[0]);
    });
  });
  await r.append(night, { kind: 'note', from: 'alpha', text: 'once' });
  assert.equal(await firstLine(), 'vigil#3 alpha>*: once');
  assert.equal(await firstLine(), null);
}));

test('presence goes grey once a watcher stops refreshing it', () => withReverie(async (r) => {
  assert.deepEqual(await r.presence(), []);
  const then = new Date('2026-10-20T04:00:00Z');
  await r.heartbeat('beta', { now: then });
  await r.heartbeat('gamma', { now: new Date(then.getTime() + 60000) });
  const at = new Date(then.getTime() + 70000);
  assert.deepEqual((await r.presence(at)).map((p) => `${p.codename}:${p.listening}`), ['beta:false', 'gamma:true']);
  await assert.rejects(r.heartbeat('../x'), /invalid codename/);
}));

test('the chair is configurable, and an existing room keeps its chair', () => withReverie(async (r, home) => {
  assert.equal(chairOf(home, {}), 'chair');
  assert.equal(chairOf(home, { REVERIE_CHAIR: 'host' }), 'host');
  const host = new Reverie(home, { chair: 'host' });
  await host.open('kept', { now: DAY });
  assert.equal(chairOf(home, {}), 'host');
  await writeFile(join(home, 'config.json'), JSON.stringify({ chair: 'boss' }));
  assert.equal(chairOf(home, {}), 'boss');
  const boss = new Reverie(home, { chair: 'boss' });
  await assert.rejects(boss.open('new', { from: 'host', now: DAY }), /only the chair \(boss\) can open a meeting/);
  // A Night keeps the owner it was opened with.
  await assert.rejects(boss.append('2026-10-19-kept', { kind: 'wake', from: 'boss' }), /only the chair \(host\)/);
  await boss.append('2026-10-19-kept', { kind: 'wake', from: 'host' });
  assert.throws(() => new Reverie(home, { chair: 'Not Valid' }), /invalid chair codename/);
}));

test('a board: anyone opens it, nobody makes asks, authors are rate limited, the owner or chair closes it', () => withReverie(async (r) => {
  const open = await r.open('ideas', { from: 'alpha', mode: 'board', agenda: 'release names', now: DAY });
  assert.equal(open.mode, 'board');
  const board = open.night;
  assert.deepEqual((await r.nights()).map((n) => [n.mode, n.owner]), [['board', 'alpha']]);
  await assert.rejects(r.open('meet', { from: 'alpha', now: DAY }), /only the chair \(chair\) can open a meeting/);
  await assert.rejects(r.open('bad', { mode: 'party', now: DAY }), /invalid mode/);
  await assert.rejects(r.append(board, { kind: 'note', from: 'chair', to: ['beta'], text: 'x', ask: 'formal' }), /board takes no asks/);
  await assert.rejects(r.append(board, { kind: 'note', from: 'beta', text: 'x', mode: 'board' }), /only open carries a mode/);
  let t = DAY.getTime();
  for (let i = 0; i < BOARD_RATE; i++) await r.append(board, { kind: 'note', from: 'beta', text: `idea ${i}` }, new Date(t += 1000));
  await assert.rejects(r.append(board, { kind: 'note', from: 'beta', text: 'one more' }, new Date(t += 1000)), /rate limit/);
  await r.append(board, { kind: 'note', from: 'gamma', text: 'others still post' }, new Date(t += 1000));
  await r.append(board, { kind: 'note', from: 'beta', text: 'a minute later' }, new Date(t += 60000));
  await assert.rejects(r.append(board, { kind: 'wake', from: 'beta' }), /only alpha \(who opened it\) or the chair/);
  await r.append(board, { kind: 'wake', from: 'alpha', text: 'picked a name' }, new Date(t += 1000));
  assert.match(await readFile(r.minutesPath(board), 'utf8'), /- Mode: board/);
  assert.match(await r.memo(), /- Board, opened by alpha/);
}));

test('repair finishes a close that died after its wake was logged', () => withReverie(async (r) => {
  const { night } = await r.open('crashed', { agenda: 'one thing', now: DAY });
  await r.append(night, { kind: 'wake', from: 'chair', text: 'done' }, DAY);
  const memo = await r.memo();
  // Simulate the crash: the wake is logged, the minutes and memo entry are not.
  await rm(r.minutesPath(night));
  await writeFile(r.memoPath, '', 'utf8');
  assert.deepEqual(await r.repair(), [night]);
  assert.match(await readFile(r.minutesPath(night), 'utf8'), /## Outcome\n\ndone/);
  assert.equal(await r.memo(), memo);
  assert.deepEqual(await r.repair(), [], 'a second repair has nothing to do');

  // Only the memo entry missing: the minutes stay, the entry comes back once.
  await writeFile(r.memoPath, memo.replace(/\n## [\s\S]*/, ''), 'utf8');
  assert.deepEqual(await r.repair(), [night]);
  assert.equal(await r.memo(), memo);
}));

test('closes at once in many Nights each add one memo entry under one header', () => withReverie(async (r) => {
  const nights = await Promise.all(Array.from({ length: 8 }, (_, i) => r.open(`n${i}`, { now: DAY })));
  await Promise.all(nights.map(({ night }) => r.append(night, { kind: 'wake', from: 'chair', text: `out ${night}` }, DAY)));
  const memo = await r.memo();
  assert.equal(memo.match(/^# Reverie memo/gm).length, 1);
  for (const { night } of nights) assert.equal(memo.split(`\n## ${night}\n`).length, 2);
}));

test('writing commands print a compact line with --compact', () => withReverie(async (r, home) => {
  const env = { ...process.env, REVERIE_HOME: home, REVERIE_CHAIR: 'chair' };
  const run = (...args) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, ...args], { env });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.on('error', reject).on('close', (code) => (code ? reject(new Error(`exit ${code}`)) : resolve(out)));
  });
  assert.match(await run('open', 'short', '--compact'), /^short#1 chair>\* open\n$/);
  assert.match(await run('note', 'short', '--as', 'alpha', 'hello', '--compact'), /^short#2 alpha>\*: hello\n$/);
  assert.equal(JSON.parse(await run('wake', 'short', '--text', 'bye')).kind, 'wake');
  assert.equal(await run('repair'), '');
}));
