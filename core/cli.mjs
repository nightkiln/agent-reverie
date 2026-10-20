#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { setTimeout as sleep } from 'node:timers/promises';
import { PRESENCE_EVERY_MS, Reverie, compact, deliveredTo, urgentFor } from './store.mjs';
import { chairServer } from './serve.mjs';
import { runContract } from './contract.mjs';

const USAGE = `usage: dream <command> ...

  open  <topic> [--agenda <text>] [--project <name>] [--mode meeting|board] [--as <codename>]
                                                           start a Night: a meeting (the chair) or a board (anyone)
  lamp  <night> --as <codename>                            join a Night
  ring  <night> <codename> [--as <codename>] [--text ..]   call on a participant
  note  <night> --as <codename> <text> [--to a,b] [--reply-to N] [--ask formal --for a,b] [--quiet]
                                                           --quiet (a Hush, boards only): does not lift the board
  pin   <night> on|off --as <codename>                     keep a board on top of its project (its opener or the chair)
  read  <night> [--since N] [--compact]                    print events after id N
  watch <night> --as <codename> [--since N] [--interval ms] [--compact]
                                                           print new events for <codename>; exits on wake
  watch --all --as <codename> [--interval ms] [--compact] [--ping all|urgent|none]
                                                           the same across every Night, new ones included; never exits,
                                                           a restart resumes where the last watcher left off, and the
                                                           chair page shows it as listening. --ping urgent prints only
                                                           when a ring, an ask or a meeting event arrives (with the
                                                           unread events before it); none only shows as listening
  omens --as <codename> [--peek] [--project <name>] [--compact]
                                                           your Omens: events for you not yet handled, all Nights,
                                                           oldest first; marks them shown unless --peek
  omens --as <codename> --mark-handled <night>#<id>|all    you have finished with that event and everything before it
  wake  <night> [--text <outcome>] [--as <codename>]       end the Night, write minutes (its owner, or the chair for a board)
        [--dismiss]                                          Dawn: also stop every agent's watch --all (the chair only)
  nights [--project <name> [--open|--crypt]]              list Nights; one project's are pinned first, then boards
                                                           by latest rise and meetings by date
  memo                                                     print the running memo of past outcomes
  repair                                                   write missing minutes and memo entries, then sweep
  sweep                                                    close boards with no rise for their ebb days (7)
  contract --as <codename> --home <scratch> [--timeout s]  check an agent against the adapter contract, through the log of a
                                                           scratch folder its adapter already watches (REVERIE_HOME=<scratch>)
  serve [--port N]                                         chair page on http://127.0.0.1:7777

<night> may be just its topic when one Night has it. --compact prints one short line
per event (night#id from>to [reN] [kind]: text) instead of JSON, long texts cut;
it works on the writing commands too.

The chair is REVERIE_CHAIR, else "chair" in <folder>/config.json, else whoever
opened the newest meeting, else "chair". A board takes no asks, rate-limits each
author per minute, and does not guarantee replies.

Reverie folder: REVERIE_HOME, else %ProgramData%\\agentsreverie on Windows, else ~/.agentsreverie.`;

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    as: { type: 'string' },
    agenda: { type: 'string' },
    project: { type: 'string' },
    mode: { type: 'string' },
    text: { type: 'string' },
    to: { type: 'string' },
    'reply-to': { type: 'string' },
    ask: { type: 'string' },
    for: { type: 'string' },
    ping: { type: 'string', default: 'all' },
    peek: { type: 'boolean' },
    'mark-handled': { type: 'string' },
    quiet: { type: 'boolean' },
    dismiss: { type: 'boolean' },
    home: { type: 'string' },
    timeout: { type: 'string', default: '120' },
    open: { type: 'boolean' },
    crypt: { type: 'boolean' },
    since: { type: 'string' },
    interval: { type: 'string', default: '1000' },
    port: { type: 'string', default: '7777' },
    all: { type: 'boolean' },
    compact: { type: 'boolean' },
    help: { type: 'boolean', short: 'h' },
  },
});

const [command, topicOrNight, ...rest] = positionals;
const reverie = new Reverie();
const print = (value) => process.stdout.write(JSON.stringify(value) + '\n');
let target = topicOrNight;

// A Night's topic is enough to name it in compact output while no other
// Night shares it; `resolve` takes it back.
function shortNames(nights) {
  const count = new Map();
  for (const { night } of nights) count.set(night.slice(11), (count.get(night.slice(11)) ?? 0) + 1);
  return new Map(nights.map(({ night }) => [night, count.get(night.slice(11)) === 1 ? night.slice(11) : night]));
}
const show = (event, names, opts = {}) => values.compact
  ? process.stdout.write(compact(event, names?.get(event.night) ?? event.night, opts) + '\n')
  : print(opts.shown ? { ...event, shown: true } : event);
// A writing command prints the event it wrote, compact on request.
const wrote = async (event) => show(event, values.compact && shortNames(await reverie.nights()));
const list = (s) => s?.split(',').map((x) => x.trim()).filter(Boolean);
const int = (name, s) => {
  if (s === undefined) return undefined;
  if (!/^\d+$/.test(s)) throw new Error(`${name} must be a whole number`);
  return Number(s);
};

async function main() {
  if (!command || values.help) return console.log(USAGE);
  if (!['open', 'nights', 'memo', 'repair', 'serve', 'omens', 'sweep', 'contract'].includes(command)) target = await reverie.resolve(target);
  switch (command) {
    case 'open':
      return wrote(await reverie.open(target, { from: values.as ?? reverie.chair, agenda: values.agenda, project: values.project, mode: values.mode }));
    case 'lamp':
      return wrote(await reverie.append(target, { kind: 'lamp', from: values.as }));
    case 'ring':
      return wrote(await reverie.append(target, { kind: 'ring', from: values.as ?? reverie.chair, to: rest.length ? rest : list(values.to), text: values.text }));
    case 'note':
      return wrote(await reverie.append(target, {
        kind: 'note',
        from: values.as,
        to: list(values.to),
        text: values.text ?? rest.join(' '),
        replyTo: int('--reply-to', values['reply-to']),
        ask: values.ask,
        for: list(values.for),
        quiet: values.quiet || undefined,
      }));
    case 'read': {
      const names = values.compact && shortNames(await reverie.nights());
      for (const event of await reverie.read(target, int('--since', values.since) ?? 0)) show(event, names);
      return;
    }
    case 'watch':
      return values.all ? watchAll() : watch(target);
    case 'wake':
      return wrote(await reverie.append(target, { kind: 'wake', from: values.as ?? reverie.chair, text: values.text ?? (rest.join(' ') || undefined), ...(values.dismiss ? { dismiss: true } : {}) }));
    case 'omens':
      return omens();
    case 'memo':
      return process.stdout.write(await reverie.memo());
    case 'pin':
      return wrote(await reverie.append(target, { kind: 'pin', from: values.as ?? reverie.chair, text: rest[0] }));
    case 'repair':
      for (const night of await reverie.repair()) console.log(`repaired ${night}`);
      return sweep();
    case 'sweep':
      return sweep();
    case 'contract': {
      if (!values.as || !values.home) throw new Error('contract needs --as <codename> and --home <scratch folder>');
      if (values.home === reverie.home) throw new Error('contract writes test Rooms: point --home at a scratch folder, not your Reverie');
      const { passed } = await runContract({
        home: values.home, as: values.as, timeoutMs: int('--timeout', values.timeout) * 1000,
        report: ({ name, ok, detail }) => console.log(`${ok ? 'pass' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`),
      });
      console.log(passed ? 'contract: pass' : 'contract: FAIL');
      if (!passed) process.exitCode = 1;
      return;
    }
    case 'nights': {
      if ((values.open || values.crypt) && !values.project) throw new Error('--open and --crypt need --project');
      const state = values.open ? 'open' : values.crypt ? 'crypt' : undefined;
      for (const night of values.project ? await reverie.fane(values.project, { state }) : await reverie.nights()) print(night);
      return;
    }
    case 'serve': {
      // Finish any close that died between its wake and its minutes.
      for (const night of await reverie.repair()) console.log(`repaired ${night}`);
      const server = chairServer(reverie, { port: int('--port', values.port) });
      await new Promise((resolve, reject) => server.once('error', reject).listen(int('--port', values.port), '127.0.0.1', resolve));
      console.log(`chair page: http://127.0.0.1:${server.address().port}/  (Reverie: ${reverie.home})`);
      await sweep();
      setInterval(() => sweep().catch((err) => console.error(`dream: sweep: ${err.message}`)), SWEEP_EVERY_MS);
      return;
    }
    default:
      throw new Error(`unknown command: ${command}\n\n${USAGE}`);
  }
}

async function watch(night) {
  if (!values.as) throw new Error('watch needs --as <codename>');
  const interval = int('--interval', values.interval);
  const existing = await reverie.read(night);
  if (!existing.length) throw new Error(`night ${night} does not exist`);
  let cursor = int('--since', values.since) ?? existing.at(-1).id;
  if (existing.at(-1).kind === 'wake' && cursor >= existing.at(-1).id) return;
  const names = values.compact && shortNames(await reverie.nights());
  for (;;) {
    for (const event of await reverie.read(night, cursor)) {
      cursor = event.id;
      if (deliveredTo(event, values.as)) show(event, names);
      if (event.kind === 'wake') return;
    }
    await sleep(interval);
  }
}

const SWEEP_EVERY_MS = 60 * 60 * 1000;
async function sweep() {
  for (const night of await reverie.sweep()) console.log(`ebbed ${night}`);
}

async function omens() {
  if (!values.as) throw new Error('omens needs --as <codename>');
  const mark = values['mark-handled'];
  if (mark !== undefined) {
    // Handled implies shown, so both move; handled never runs ahead of shown.
    if (mark === 'all') {
      const updates = {};
      for (const { event, shown } of await reverie.omens(values.as)) if (shown) updates[event.night] = event.id;
      return void (await reverie.advance('handled', values.as, updates));
    }
    const at = mark.lastIndexOf('#');
    const night = await reverie.resolve(mark.slice(0, at));
    const id = int('--mark-handled id', at < 0 ? undefined : mark.slice(at + 1));
    if (id === undefined || !(await reverie.read(night)).some((e) => e.id === id)) throw new Error(`no event ${mark}`);
    await reverie.advance('shown', values.as, { [night]: id });
    return void (await reverie.advance('handled', values.as, { [night]: id }));
  }
  const starts = {};
  const list = await reverie.omens(values.as, { project: values.project, starts });
  const names = values.compact && shortNames(await reverie.nights());
  const updates = {};
  for (const { event } of list) updates[event.night] = Math.max(updates[event.night] ?? 0, event.id);
  // Recorded before printing, like the watcher's cursor.
  if (!values.peek) {
    // Pin where each Room's Omens began, so later cursor moves can't hide them.
    if (Object.keys(starts).length) await reverie.advance('handled', values.as, starts);
    if (list.length) await reverie.advance('shown', values.as, updates);
  }
  for (const { event, shown } of list) show(event, names, { shown });
}

// Follows every Night at once, so an adapter can run one watcher for good.
// On start, an open Night delivers what came after the later of: the last
// event an earlier watcher for this codename printed (kept in
// <home>/cursors/<codename>.json), and this participant's own last word in
// it. So a ring sent while nobody was watching still arrives, and a restart
// replays nothing. Closed Nights start at their end. Nights opened later
// start at 0, so their open event and first rings come through.
async function watchAll() {
  if (!values.as) throw new Error('watch needs --as <codename>');
  if (target) throw new Error('watch --all takes no Night');
  if (!['all', 'urgent', 'none'].includes(values.ping)) throw new Error('--ping must be all, urgent or none');
  const interval = int('--interval', values.interval);
  const saved = await reverie.cursors(values.as);
  const since = new Date().toISOString();
  let beat = 0;
  const cursors = new Map();
  for (const { night, open } of await reverie.nights()) {
    const events = await reverie.read(night);
    const spoke = events.findLast((e) => e.from === values.as)?.id ?? 0;
    cursors.set(night, open ? Math.max(spoke, saved[night] ?? 0) : events.at(-1)?.id ?? 0);
  }
  // Where this watcher began in each Night: an urgent batch never reaches
  // further back than this unless a `shown` position says so.
  const began = new Map(cursors);
  // Pin each Room's Omens start before the cursor moves on: under --ping
  // urgent or none, the cursor passes events the agent has not been shown.
  const handled = await reverie.positions('handled', values.as);
  const pin = Object.fromEntries([...cursors].filter(([night]) => !(night in handled)));
  if (Object.keys(pin).length) await reverie.advance('handled', values.as, pin);
  for (;;) {
    if (Date.now() - beat >= PRESENCE_EVERY_MS) {
      await reverie.heartbeat(values.as, { since });
      beat = Date.now();
    }
    const nights = await reverie.nights();
    const names = values.compact && shortNames(nights);
    let moved = false;
    for (const { night, mode } of nights) {
      if (!cursors.has(night) && !(night in saved)) await reverie.advance('handled', values.as, { [night]: 0 });
      let cursor = cursors.get(night) ?? saved[night] ?? 0;
      for (const event of await reverie.read(night, cursor)) {
        cursor = event.id;
        if (!deliveredTo(event, values.as)) continue;
        // Saved before printing: whoever reads this line may kill us at once.
        saved[night] = event.id;
        reverie.saveCursorsSync(values.as, saved);
        if (event.dismiss) {
          // The chair closed with Dawn: print it at every ping level, take
          // the Sign down and stop. The adapter must not restart us.
          await reverie.advance('shown', values.as, { [night]: event.id });
          show(event, names);
          await reverie.saveCursors(values.as, saved);
          await reverie.leave(values.as);
          return;
        }
        if (values.ping === 'all') {
          await reverie.advance('shown', values.as, { [night]: event.id });
          show(event, names);
        } else if (values.ping === 'urgent' && urgentFor(event, values.as, mode)) {
          // One batch: the unread events before the urgent one, then it.
          const shown = (await reverie.positions('shown', values.as))[night] ?? began.get(night) ?? 0;
          const batch = (await reverie.read(night, shown)).filter((e) => e.id <= event.id && deliveredTo(e, values.as));
          await reverie.advance('shown', values.as, { [night]: event.id });
          for (const e of batch) show(e, names);
        }
      }
      if (cursor !== saved[night]) moved = true;
      cursors.set(night, cursor);
    }
    if (moved) {
      Object.assign(saved, Object.fromEntries(nights.map(({ night }) => [night, cursors.get(night)])));
      await reverie.saveCursors(values.as, saved);
    }
    await sleep(interval);
  }
}

main().catch((err) => {
  console.error(`dream: ${err.message}`);
  process.exitCode = 1;
});
