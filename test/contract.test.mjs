// The adapter contract test, run against a well-behaved stand-in agent and a
// silent one.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runContract } from '../core/contract.mjs';
import { Reverie } from '../core/store.mjs';

async function withHome(fn) {
  const home = await mkdtemp(join(tmpdir(), 'reverie-'));
  try { await fn(home); } finally { await rm(home, { recursive: true, force: true }); }
}

// A stand-in agent that follows the contract by reading the log directly.
function standIn(home, as) {
  const r = new Reverie(home, { chair: 'chair' });
  const done = new Set();
  let running = true;
  const loop = (async () => {
    while (running) {
      for (const { night, open } of await r.nights()) {
        if (!open) continue;
        for (const e of await r.read(night)) {
          const key = `${night}#${e.id}`;
          if (done.has(key) || e.from === as || !e.to.includes(as)) continue;
          done.add(key);
          try {
            if (e.kind === 'ring' && e.replyTo === undefined) await r.append(night, { kind: 'lamp', from: as });
            else if (e.ask === 'formal') await r.append(night, { kind: 'note', from: as, to: e.for, replyTo: e.id, text: `On behalf of ${e.from}: ${e.text}` });
            else if (e.ask === 'outcome') await r.append(night, { kind: 'note', from: as, to: [e.from], replyTo: e.id, text: 'Draft memo: Decisions: keep the test.' });
            else if (e.kind === 'note') {
              await r.append(night, { kind: 'note', from: as, replyTo: e.id, text: 'Answered.' });
              await r.advance('shown', as, { [night]: e.id });
              await r.advance('handled', as, { [night]: e.id });
            }
          } catch {}
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  })();
  return async () => { running = false; await loop; };
}

test('contract: a stand-in that follows the protocol passes every check', () => withHome(async (home) => {
  const stop = standIn(home, 'tester');
  try {
    const { passed, results } = await runContract({ home, as: 'tester', timeoutMs: 3000, pollMs: 20 });
    assert.deepEqual(results.filter((x) => !x.ok), []);
    assert.equal(passed, true);
    assert.equal(results.length, 6);
  } finally {
    await stop();
  }
}));

test('contract: a silent agent fails, and each check says what was missing', () => withHome(async (home) => {
  const { passed, results } = await runContract({ home, as: 'tester', timeoutMs: 100, pollMs: 20 });
  assert.equal(passed, false);
  assert.match(results[0].detail, /no lamp within/);
  assert.equal(results.find((x) => x.name.includes('own notes')).ok, true);
  assert.match(results.at(-1).detail, /mark the note handled/);
}));
