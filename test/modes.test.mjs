// The mode suite: the same checks run against every mode in the registry, so a
// new mode is held to what its settings say before it merges.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { REGISTRY, validate } from '../core/modes.mjs';
import { enforce } from '../core/policy.mjs';

const T0 = Date.parse('2026-10-19T13:00:00Z');
const at = (s) => new Date(T0 + s * 1000).toISOString();
const ctx = (s = 0) => ({ chair: 'chair', now: new Date(T0 + s * 1000) });

function room(name, seer) {
  return [{ id: 1, kind: 'open', from: seer, to: ['*'], mode: name, time: at(0) }];
}
const note = (events, from, s, extra = {}) => [...events, { id: events.length + 1, kind: 'note', from, to: ['*'], text: 'x', time: at(s), ...extra }];

for (const [name, mode] of Object.entries(REGISTRY)) {
  const seer = mode.opens === 'chair' ? 'chair' : 'alpha';

  test(`${name}: opens says who may open it`, () => {
    enforce([], { kind: 'open', from: 'chair', mode: name }, ctx());
    const other = () => enforce([], { kind: 'open', from: 'alpha', mode: name }, ctx());
    if (mode.opens === 'anyone') other();
    else assert.throws(other, /only the chair/);
  });

  test(`${name}: closes says who may wake it`, () => {
    const events = room(name, seer);
    enforce(events, { kind: 'wake', from: seer }, ctx());
    const byChair = () => enforce(events, { kind: 'wake', from: 'chair' }, ctx());
    if (mode.closes.includes('chair') || seer === 'chair') byChair();
    else assert.throws(byChair);
    assert.throws(() => enforce(events, { kind: 'wake', from: 'zeta' }, ctx()), /only/);
  });

  test(`${name}: asks says which asks the Seer may make`, () => {
    const events = room(name, seer);
    for (const ask of ['formal', 'outcome']) {
      const make = () => enforce(events, { kind: 'note', from: seer, to: ['beta'], text: 'x', ask }, ctx());
      if (mode.asks.includes(ask)) make();
      else assert.throws(make, /takes no asks|invalid ask/);
    }
  });

  test(`${name}: pace holds back notes as set`, () => {
    let events = room(name, seer);
    const { per, count, ms } = mode.pace;
    for (let i = 0; i < count; i++) events = note(events, 'beta', i * 0.1);
    const next = (s) => enforce(events, { kind: 'note', from: 'beta', text: 'x' }, ctx(s));
    assert.throws(() => next(count * 0.1), per === 'run' ? /rate guard/ : /rate limit/);
    if (per === 'author') {
      next(ms / 1000 + count); // the window has passed
      enforce(events, { kind: 'note', from: 'gamma', text: 'x' }, ctx(count * 0.1)); // others still post
    } else {
      enforce(note(events, seer, count * 0.1), { kind: 'note', from: 'beta', text: 'x' }, ctx(count * 0.1)); // the Seer spoke
    }
  });
}

test('the registry refuses settings the policy cannot read', () => {
  const base = REGISTRY.board;
  assert.throws(() => validate({ odd: { ...base, opens: 'nobody' } }), /invalid opens/);
  assert.throws(() => validate({ odd: { ...base, asks: ['shout'] } }), /invalid asks/);
  assert.throws(() => validate({ odd: { ...base, pace: { per: 'run', count: 3, ms: 10 } } }), /invalid pace/);
  assert.throws(() => validate({ odd: { ...base, pace: { per: 'author', count: 3 } } }), /invalid pace/);
  assert.throws(() => validate({ odd: { ...base, capabilities: ['laser'] } }), /invalid capabilities/);
  assert.throws(() => validate({ odd: { ...base, limits: { notes: 0 } } }), /invalid limits/);
  assert.throws(() => validate({ odd: { ...base, limits: { forever: 1 } } }), /invalid limits/);
  assert.doesNotThrow(() => validate(REGISTRY));
});

test('a third mode is one registry entry, with no other code', () => {
  const registry = { ...REGISTRY, vigil: { ...REGISTRY.board, label: 'Vigil', closes: ['seer'], pace: { per: 'author', count: 1, ms: 1000 } } };
  validate(registry);
  const opts = { ...ctx(), registry };
  enforce([], { kind: 'open', from: 'alpha', mode: 'vigil' }, opts);
  const events = room('vigil', 'alpha');
  assert.throws(() => enforce(events, { kind: 'wake', from: 'chair' }, opts), /only alpha \(who opened it\) can wake this Vigil/);
  const one = note(events, 'beta', 0);
  assert.throws(() => enforce(one, { kind: 'note', from: 'beta', text: 'x' }, opts), /rate limit/);
});
