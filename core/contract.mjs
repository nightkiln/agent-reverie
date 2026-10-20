// The adapter contract test (docs/SPEC.md, section 8). It checks an agent
// through the log only: it plays the chair and another agent by writing
// events into a scratch Reverie folder, and waits for the agent's answers. It
// never starts or watches the adapter's process; the agent runs its own
// adapter against the same folder first.

import { setTimeout as sleep } from 'node:timers/promises';
import { Reverie } from './store.mjs';

const CHAIR = 'chair';
const PEER = 'contractpeer';

export async function runContract({ home, as, timeoutMs = 120000, pollMs = 500, report = () => {} }) {
  const r = new Reverie(home, { chair: CHAIR });
  const stamp = Date.now().toString(36);
  const results = [];
  const check = async (name, fn) => {
    let ok = false, detail = '';
    try {
      detail = (await fn()) ?? '';
      ok = true;
    } catch (err) {
      detail = err.message;
    }
    results.push({ name, ok, detail });
    report({ name, ok, detail });
    return ok;
  };
  // Wait for an event from the agent that matches.
  const answer = async (night, after, match, what) => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const found = (await r.read(night, after)).find((e) => e.from === as && match(e));
      if (found) return found;
      if (Date.now() > deadline) throw new Error(`no ${what} within ${Math.round(timeoutMs / 1000)} s`);
      await sleep(pollMs);
    }
  };

  // A Night: rung, the agent Lamps in; then a formal and an outcome ask.
  const night = (await r.open(`contract-${stamp}`, { from: CHAIR, agenda: 'Adapter contract test. Answer as the protocol says.' })).night;
  const ring = await r.append(night, { kind: 'ring', from: CHAIR, to: [as], text: 'contract test: please lamp in' });
  await check('Night: lamps in after a ring', async () => `#${(await answer(night, ring.id, (e) => e.kind === 'lamp', 'lamp')).id}`);

  const formal = await r.append(night, { kind: 'note', from: CHAIR, to: [as], ask: 'formal', for: ['*'], text: 'we try the contract test now' });
  await check('Night: restates a formal ask to its audience', async () => {
    const e = await answer(night, formal.id, (e) => e.kind === 'note' && e.replyTo === formal.id, 'restatement');
    if (!e.to.includes('*')) throw new Error(`#${e.id} went to ${e.to.join(',')}, not everyone`);
    if (!/^On behalf of /.test(e.text)) throw new Error(`#${e.id} does not start "On behalf of"`);
    return `#${e.id}`;
  });

  await r.append(night, { kind: 'note', from: CHAIR, text: 'Decision: the contract test is worth keeping.' });
  const outcome = await r.append(night, { kind: 'note', from: CHAIR, to: [as], ask: 'outcome', text: 'Please draft the outcome of this Night for the memo.' });
  await check('Night: drafts the outcome for the chair', async () => {
    const e = await answer(night, outcome.id, (e) => e.kind === 'note' && e.replyTo === outcome.id, 'draft');
    if (e.to.length !== 1 || e.to[0] !== CHAIR) throw new Error(`#${e.id} went to ${e.to.join(',')}, not ${CHAIR}`);
    if (!/^Draft memo:/.test(e.text)) throw new Error(`#${e.id} does not start "Draft memo:"`);
    return `#${e.id}`;
  });

  await check('Night: never answers its own notes', async () => {
    const events = await r.read(night);
    const own = new Set(events.filter((e) => e.from === as).map((e) => e.id));
    const bad = events.filter((e) => e.from === as && own.has(e.replyTo));
    if (bad.length) throw new Error(`answered itself in #${bad.map((e) => e.id).join(', #')}`);
    if (events.some((e) => e.kind === 'wake')) throw new Error('the agent woke the Night');
  });
  await r.append(night, { kind: 'wake', from: CHAIR, text: 'Contract test done.' });

  // A Rite: another agent rings it for an answer.
  const rite = (await r.open(`contract-rite-${stamp}`, { from: PEER, mode: 'board', agenda: 'Adapter contract test, the async half.' })).night;
  const asked = await r.append(rite, { kind: 'note', from: PEER, to: [as], text: 'contract test: please answer this note with a reply to it' });
  const bell = await r.append(rite, { kind: 'ring', from: PEER, to: [as], replyTo: asked.id });
  await check('Rite: answers a note that rings it', async () => `#${(await answer(rite, asked.id, (e) => e.kind === 'note' && e.replyTo === asked.id, 'reply')).id}`);

  await check('Omens: marks what it handled', async () => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const handled = (await r.positions('handled', as))[rite] ?? 0;
      if (handled >= asked.id) return `handled up to #${handled}`;
      if (Date.now() > deadline) throw new Error(`handled is at #${handled} in the Rite; mark the note handled after answering (dream omens --mark-handled)`);
      await sleep(pollMs);
    }
  });
  await r.append(rite, { kind: 'wake', from: PEER, text: 'Contract test done.' });

  return { passed: results.every((x) => x.ok), results };
}
