import { access, appendFile, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { CODENAME_RE, NIGHT_RE, SWEEPER, TOPIC_RE, appendLog, check, checkSequence, checkShape, readLog, reverieHome, withLock } from './log.mjs';
import { REGISTRY, askAudience, enforce, expiryOf, modeOf, ownerOf, pinnedOf, riseOf } from './policy.mjs';

export { CODENAME_RE, KINDS, MAX_TEXT, NIGHT_RE, TOPIC_RE, reverieHome } from './log.mjs';
export { ASKS, BOARD_RATE, BOARD_WINDOW_MS, MODES, RATE_GUARD, REGISTRY } from './policy.mjs';

export const DEFAULT_CHAIR = 'chair';
// A `watch --all` refreshes its presence this often; the chair page counts a
// watcher as listening while its last refresh is younger than PRESENCE_STALE_MS.
export const PRESENCE_EVERY_MS = 15000;
export const PRESENCE_STALE_MS = 45000;
// Longest text a compact line carries before it points at `dream read`.
export const COMPACT_MAX = 500;
export const POSITIONS = ['shown', 'handled'];

// The chair's codename, in order: REVERIE_CHAIR; "chair" in <home>/config.json;
// whoever opened the newest meeting here, so an existing room keeps its chair;
// else DEFAULT_CHAIR.
export function chairOf(home, env = process.env) {
  if (env.REVERIE_CHAIR) return env.REVERIE_CHAIR;
  try {
    const { chair } = JSON.parse(readFileSync(join(home, 'config.json'), 'utf8'));
    if (chair) return chair;
  } catch (err) {
    if (err.code !== 'ENOENT') throw new Error(`cannot read ${join(home, 'config.json')}: ${err.message}`);
  }
  try {
    for (const file of readdirSync(join(home, 'nights')).filter((f) => f.endsWith('.jsonl')).sort().reverse()) {
      const open = JSON.parse(readFileSync(join(home, 'nights', file), 'utf8').split('\n')[0]);
      if (open.mode !== 'board') return open.from;
    }
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  return DEFAULT_CHAIR;
}

export function deliveredTo(event, codename) {
  if (event.from === codename) return false;
  return event.to.includes('*') || event.to.includes(codename);
}

// One line per event, for adapters that pay per token:
//   standup#47 alpha>* re46: <text>
// Notes carry no kind word; time and the repeated night are left out. A long
// text is cut and says how to read the rest.
// Urgent for a codename: an event for it that pings it now even under
// `watch --ping urgent`. Everything else waits in its Omens.
export function urgentFor(event, codename, mode) {
  if (!deliveredTo(event, codename)) return false;
  if (REGISTRY[mode]?.delivery === 'push') return true;
  if (event.dismiss) return true;
  return (event.kind === 'ring' || event.ask !== undefined) && event.to.includes(codename);
}

export function compact(event, name = event.night, { shown = false } = {}) {
  let line = `${name}#${event.id} ${event.from}>${event.to.join(',')}`;
  if (event.replyTo !== undefined) line += ` re${event.replyTo}`;
  if (event.ask) line += ` ask=${event.ask}`;
  if (event.ask === 'formal') line += ` for=${event.for.join(',')}`;
  if (event.mode === 'board') line += ' mode=board';
  if (event.project) line += ` project=${event.project}`;
  if (event.quiet) line += ' quiet';
  if (event.expired) line += ' expired';
  if (event.dismiss) line += ' dismiss';
  if (shown) line += ' shown';
  if (event.kind !== 'note') line += ` ${event.kind}`;
  if (event.text) {
    let text = event.text.replace(/\r?\n/g, ' ⏎ ');
    if (text.length > COMPACT_MAX) text = `${text.slice(0, COMPACT_MAX)}…(dream read ${name} --since ${event.id - 1})`;
    line += `: ${text}`;
  }
  return line;
}

export class Reverie {
  constructor(home = reverieHome(), { chair = chairOf(home) } = {}) {
    check(CODENAME_RE, 'chair codename', chair);
    this.home = home;
    this.chair = chair;
  }

  nightPath(night) {
    check(NIGHT_RE, 'night', night);
    return join(this.home, 'nights', `${night}.jsonl`);
  }

  // One running memo across Nights: each wake appends the Night's outcome, so
  // the next meeting starts from what was decided before.
  get memoPath() {
    return join(this.home, 'memo.md');
  }

  async memo() {
    try {
      return await readFile(this.memoPath, 'utf8');
    } catch (err) {
      if (err.code === 'ENOENT') return '';
      throw err;
    }
  }

  minutesPath(night) {
    check(NIGHT_RE, 'night', night);
    return join(this.home, 'minutes', `${night}.md`);
  }

  read(night, since = 0) {
    return readLog(this.nightPath(night), since);
  }

  async nights() {
    let files;
    try {
      files = await readdir(join(this.home, 'nights'));
    } catch (err) {
      if (err.code === 'ENOENT') return [];
      throw err;
    }
    const out = [];
    for (const file of files.filter((f) => f.endsWith('.jsonl')).sort()) {
      const night = file.slice(0, -'.jsonl'.length);
      const events = await this.read(night);
      out.push({
        night,
        open: events.at(-1)?.kind !== 'wake',
        notes: events.filter((e) => e.kind === 'note').length,
        lamps: [...new Set(events.filter((e) => e.kind === 'lamp').map((e) => e.from))],
        mode: modeOf(events),
        rise: riseOf(events),
        pinned: pinnedOf(events),
        owner: ownerOf(events),
        ...(events[0]?.project ? { project: events[0].project } : {}),
      });
    }
    return out;
  }

  // A full Night name, or a topic that exactly one Night has.
  async resolve(name) {
    if (NIGHT_RE.test(name ?? '') || !TOPIC_RE.test(name ?? '')) return name;
    const matches = (await this.nights()).filter((n) => n.night.slice(11) === name).map((n) => n.night);
    if (matches.length === 1) return matches[0];
    if (!matches.length) throw new Error(`no Night with topic ${name}`);
    throw new Error(`topic ${name} names several Nights: ${matches.join(', ')}`);
  }

  // Where `watch --all` left off for one codename, per Night, so a restarted
  // watcher does not replay what it already printed.
  cursorPath(codename) {
    check(CODENAME_RE, 'codename', codename);
    return join(this.home, 'cursors', `${codename}.json`);
  }

  async cursors(codename) {
    try {
      return JSON.parse(await readFile(this.cursorPath(codename), 'utf8'));
    } catch (err) {
      if (err.code === 'ENOENT' || err instanceof SyntaxError) return {};
      throw err;
    }
  }

  // Read positions beside the cursor (docs/SPEC.md, section 3.3): `shown`, the
  // newest id an agent has been shown, and `handled`, the newest it has
  // finished with. Watch and Omens both write them, so each write happens
  // under the file's lock and a position only moves forward.
  positionPath(kind, codename) {
    if (!POSITIONS.includes(kind)) throw new Error(`invalid position: ${kind}`);
    check(CODENAME_RE, 'codename', codename);
    return join(this.home, kind, `${codename}.json`);
  }

  async positions(kind, codename) {
    try {
      return JSON.parse(await readFile(this.positionPath(kind, codename), 'utf8'));
    } catch (err) {
      if (err.code === 'ENOENT' || err instanceof SyntaxError) return {};
      throw err;
    }
  }

  async advance(kind, codename, updates) {
    const path = this.positionPath(kind, codename);
    await mkdir(join(this.home, kind), { recursive: true });
    return withLock(path, async () => {
      const stored = await this.positions(kind, codename);
      for (const [night, id] of Object.entries(updates)) if (!(night in stored) || id > stored[night]) stored[night] = id;
      const tmp = `${path}.${process.pid}.tmp`;
      await writeFile(tmp, JSON.stringify(stored), 'utf8');
      // Windows can refuse a rename while another process reads the file.
      for (let tries = 0; ; tries++) {
        try {
          await rename(tmp, path);
          break;
        } catch (err) {
          if (err.code !== 'EPERM' || tries >= 20) throw err;
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
      }
      return stored;
    });
  }

  // An agent's Omens: events for it above its `handled` position, across all
  // Rooms, oldest first. A Room with no `handled` yet starts at the old cursor,
  // then at the agent's own last word in it; a closed Room it never had a
  // position in is skipped, since nothing there can be acted on. `starts`
  // returns those starting points, so a caller can pin them as `handled`.
  async omens(codename, { project, starts = {} } = {}) {
    const [cursor, shown, handled] = await Promise.all([
      this.cursors(codename), this.positions('shown', codename), this.positions('handled', codename),
    ]);
    const out = [];
    for (const room of await this.nights()) {
      if (project && room.project !== project) continue;
      const { night } = room;
      let base = handled[night];
      const events = await this.read(night);
      if (base === undefined) {
        base = cursor[night];
        if (base === undefined && !room.open) continue;
        base ??= events.findLast((e) => e.from === codename)?.id ?? 0;
        starts[night] = base;
      }
      const seen = Math.max(base, shown[night] ?? 0);
      for (const event of events) {
        if (event.id > base && deliveredTo(event, codename)) out.push({ event, shown: event.id <= seen });
      }
    }
    return out.sort((a, b) => a.event.time.localeCompare(b.event.time) || a.event.night.localeCompare(b.event.night) || a.event.id - b.event.id);
  }

  // Presence: one small file per watcher, rewritten while it runs, so the chair
  // can see who would hear a ring before ringing.
  async heartbeat(codename, { since, now = new Date() } = {}) {
    check(CODENAME_RE, 'codename', codename);
    const dir = join(this.home, 'presence');
    await mkdir(dir, { recursive: true });
    const path = join(dir, `${codename}.json`);
    const tmp = `${path}.${process.pid}.tmp`;
    await writeFile(tmp, JSON.stringify({ codename, pid: process.pid, since: since ?? now.toISOString(), seen: now.toISOString() }), 'utf8');
    await rename(tmp, path);
  }

  // A watcher that stops on purpose takes its Sign down at once, rather than
  // letting it go stale.
  async leave(codename) {
    check(CODENAME_RE, 'codename', codename);
    await rm(join(this.home, 'presence', `${codename}.json`), { force: true });
  }

  async presence(now = new Date()) {
    let files;
    try {
      files = await readdir(join(this.home, 'presence'));
    } catch (err) {
      if (err.code === 'ENOENT') return [];
      throw err;
    }
    const out = [];
    for (const file of files.filter((f) => f.endsWith('.json')).sort()) {
      try {
        const { codename, since, seen } = JSON.parse(await readFile(join(this.home, 'presence', file), 'utf8'));
        if (!CODENAME_RE.test(codename ?? '') || Number.isNaN(Date.parse(seen))) continue;
        out.push({ codename, since, seen, listening: now - new Date(seen) < PRESENCE_STALE_MS });
      } catch {
        // A file caught mid-rename or hand-edited: skip it this round.
      }
    }
    return out;
  }

  // Synchronous, so a watcher can record a line as seen before printing it: a
  // reader that kills the watcher right after reading the line never gets it again.
  saveCursorsSync(codename, cursors) {
    const path = this.cursorPath(codename);
    mkdirSync(join(this.home, 'cursors'), { recursive: true });
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(cursors), 'utf8');
    renameSync(tmp, path);
  }

  async saveCursors(codename, cursors) {
    const path = this.cursorPath(codename);
    await mkdir(join(this.home, 'cursors'), { recursive: true });
    const tmp = `${path}.${process.pid}.tmp`;
    await writeFile(tmp, JSON.stringify(cursors), 'utf8');
    await rename(tmp, path);
  }

  async open(topic, { from = this.chair, agenda, project, mode = 'meeting', now = new Date() } = {}) {
    check(TOPIC_RE, 'topic', topic);
    const night = `${now.toISOString().slice(0, 10)}-${topic}`;
    // Counted outside the Room's lock, so two opens at the same instant can
    // both pass; the cap is a guard against runaway agents, not a quota.
    const owned = REGISTRY[mode]?.limits?.open && from !== this.chair
      ? (await this.nights()).filter((n) => n.open && n.mode === mode && n.owner === from).length
      : 0;
    return this.append(night, { kind: 'open', from, text: agenda, project, mode }, now, { owned });
  }

  async append(night, entry, now = new Date(), { owned = 0 } = {}) {
    const { kind, from, to, text, replyTo, ask, project, mode, quiet, expired, dismiss } = entry;
    checkShape(entry);
    const path = this.nightPath(night);
    await mkdir(join(this.home, 'nights'), { recursive: true });
    return withLock(path, async () => {
      const events = await this.read(night);
      checkSequence(night, events, entry);
      enforce(events, entry, { chair: this.chair, now, owned });

      const event = {
        id: (events.at(-1)?.id ?? 0) + 1,
        night,
        time: now.toISOString(),
        from,
        to: to?.length ? to : ['*'],
        kind,
        ...(replyTo !== undefined ? { replyTo } : {}),
        ...(mode !== undefined ? { mode } : {}),
        ...(project !== undefined ? { project } : {}),
        ...(ask !== undefined ? { ask, for: askAudience(events, entry) } : {}),
        ...(quiet ? { quiet } : {}),
        ...(expired ? { expired } : {}),
        ...(dismiss ? { dismiss } : {}),
        ...(text ? { text } : {}),
      };
      await appendLog(path, event);

      if (kind === 'wake') await this.#record(night, [...events, event]);
      return event;
    });
  }

  // Minutes and the memo entry for a closed Night. Idempotent, so `repair` can
  // finish a close that died after its wake was logged. The memo is shared by
  // every Night, so it has its own lock: two closes at once take turns.
  async #record(night, events) {
    await mkdir(join(this.home, 'minutes'), { recursive: true });
    await writeFile(this.minutesPath(night), renderMinutes(events), 'utf8');
    await withLock(this.memoPath, async () => {
      const memo = await this.memo();
      if (memo.includes(memoHeading(night))) return;
      await appendFile(this.memoPath, (memo ? '' : MEMO_HEAD) + renderMemoEntry(events), 'utf8');
    });
  }

  // Closed Nights missing their minutes or memo entry get them; returns their names.
  // The sweep: wakes every open Room that has ebbed (no rise for ebbDays) or
  // reached one of its mode's limits (days open, notes). Only writers run it
  // (sweep, repair, serve), never a watcher. Two sweepers at once are safe:
  // the second wake is refused.
  async sweep(now = new Date()) {
    const swept = [];
    for (const room of await this.nights()) {
      if (!room.open) continue;
      const text = expiryOf(await this.read(room.night), { now });
      if (!text) continue;
      try {
        await this.append(room.night, { kind: 'wake', from: SWEEPER, expired: true, text }, now);
        swept.push(room.night);
      } catch (err) {
        if (!/is over|rose less/.test(err.message)) throw err;
      }
    }
    return swept;
  }

  // A Fane's Rooms the way people scan them: pinned first, then each by its
  // mode's order (newest rise first for a Rite, newest open first otherwise).
  async fane(project, { state } = {}) {
    const key = (room) => (REGISTRY[room.mode]?.order === 'rise' ? room.rise : room.night.slice(0, 10)) ?? '';
    return (await this.nights())
      .filter((room) => room.project === project && (!state || (state === 'open') === room.open))
      .sort((a, b) => Number(b.pinned) - Number(a.pinned) || key(b).localeCompare(key(a)) || b.night.localeCompare(a.night));
  }

  async repair() {
    const repaired = [];
    for (const { night, open } of await this.nights()) {
      if (open) continue;
      const memo = await this.memo();
      const hasMinutes = await access(this.minutesPath(night)).then(() => true, () => false);
      if (hasMinutes && memo.includes(memoHeading(night))) continue;
      await withLock(this.nightPath(night), async () => this.#record(night, await this.read(night)));
      repaired.push(night);
    }
    return repaired;
  }
}

const memoHeading = (night) => `\n## ${night}\n`;

const MEMO_HEAD = '# Reverie memo\n\nWhat each Night decided, newest last. Read it before joining a Night.\n';

export function renderMemoEntry(events) {
  const open = events[0];
  const wake = events.at(-1);
  const lamps = [...new Set(events.filter((e) => e.kind === 'lamp').map((e) => e.from))];
  return [
    '',
    `## ${open.night}`,
    '',
    ...(open.project ? [`- Project: ${open.project}`] : []),
    ...(open.mode === 'board' ? [`- Board, opened by ${open.from}`] : []),
    `- Closed: ${wake.time}`,
    `- Attended: ${lamps.join(', ') || 'nobody'}`,
    `- Agenda: ${(open.text || '(none)').replace(/\n+/g, ' ')}`,
    `- Minutes: minutes/${open.night}.md`,
    '',
    wake.text || '(no outcome recorded)',
    '',
  ].join('\n');
}

export function renderMinutes(events) {
  const open = events[0];
  const wake = events.at(-1);
  const lamps = [...new Set(events.filter((e) => e.kind === 'lamp').map((e) => e.from))];
  return [
    `# Minutes: ${open.night}`,
    '',
    ...(open.project ? [`- Project: ${open.project}`] : []),
    ...(open.mode === 'board' ? ['- Mode: board'] : []),
    `- Opened: ${open.time} by ${open.from}`,
    `- Closed: ${wake.time} by ${wake.from}`,
    `- Attended: ${lamps.join(', ') || 'nobody'}`,
    '',
    '## Agenda',
    '',
    open.text || '(none)',
    '',
    '## Outcome',
    '',
    wake.text || '(none)',
    '',
    '## Notes',
    '',
    ...events
      .filter((e) => e.kind === 'note')
      .map((e) => `- #${e.id} **${e.from}**${e.to.includes('*') ? '' : ` → ${e.to.join(', ')}`}${e.replyTo ? ` (re #${e.replyTo})` : ''}${e.ask ? ` [${e.ask} draft]` : ''}: ${e.text}`),
    '',
  ].join('\n');
}
