// The policy layer: who may do what in a Room, read from its mode's settings
// in modes.mjs. The mode and the Room's Seer (owner) come from its open event,
// so a Room keeps its rules even if the room's settings change later.

import { ASKS, REGISTRY } from './modes.mjs';

export { ASKS, REGISTRY };
export const MODES = Object.keys(REGISTRY);
// Meeting: participant notes allowed in a row with no owner event in between.
export const RATE_GUARD = REGISTRY.meeting.pace.count;
// Board: notes one author may post in BOARD_WINDOW_MS.
export const BOARD_RATE = REGISTRY.board.pace.count;
export const BOARD_WINDOW_MS = REGISTRY.board.pace.ms;

export const modeOf = (events) => events[0]?.mode ?? 'meeting';
const DAY_MS = 24 * 60 * 60 * 1000;
// Rise: the time of a Room's newest open, or note that is not quiet.
export const riseOf = (events) => events.findLast((e) => e.kind === 'open' || (e.kind === 'note' && !e.quiet))?.time;
// Pinned: the latest pin says on.
export const pinnedOf = (events) => events.findLast((e) => e.kind === 'pin')?.text === 'on';
export const ownerOf = (events) => events[0]?.from;

// How a mode names its Seer in errors: a chair-opened mode's Seer is the chair.
const seerName = (settings, owner) => (settings.opens === 'chair' ? `the chair (${owner})` : `${owner} (who opened it)`);

// Why the sweep may close this Room now, as the wake's text, or null: no rise
// for ebbDays, open for limits.days, or at limits.notes.
export function expiryOf(events, { now = new Date(), registry = REGISTRY } = {}) {
  const settings = registry[modeOf(events)];
  if (!settings || !events.length) return null;
  const { ebbDays, limits } = settings;
  if (ebbDays !== null && now - Date.parse(riseOf(events)) >= ebbDays * DAY_MS) return `Closed after ${ebbDays} quiet days.`;
  if (limits?.days && now - Date.parse(events[0].time) >= limits.days * DAY_MS) return `Closed after ${limits.days} days open.`;
  if (limits?.notes && events.filter((e) => e.kind === 'note').length >= limits.notes) return `Closed at its ${limits.notes}-note limit.`;
  return null;
}

// owned: how many open Rooms of this mode the author already owns (open only).
export function enforce(events, { kind, from, to, ask, for: audience, mode, quiet, expired, dismiss }, { chair, now = new Date(), registry = REGISTRY, owned = 0 }) {
  if (kind === 'open') {
    const settings = registry[mode];
    if (!settings) throw new Error(`invalid mode: ${mode}`);
    if (settings.opens === 'chair' && from !== chair) {
      const open = Object.keys(registry).filter((m) => registry[m].opens === 'anyone');
      throw new Error(`only the chair (${chair}) can open a ${mode}${open.length ? `; anyone can open a ${open.join(' or ')}` : ''}`);
    }
    const cap = settings.limits?.open;
    if (cap && from !== chair && owned >= cap) {
      throw new Error(`${from} already has ${owned} open ${settings.label}s (the limit is ${cap}); wake one first`);
    }
    if (ask !== undefined) throw new Error('only a note can carry an ask');
    return;
  }
  if (mode !== undefined) throw new Error('only open carries a mode');
  const name = modeOf(events);
  const settings = registry[name];
  const owner = ownerOf(events);

  if (expired) {
    // The sweep: only on a mode that ebbs or has limits, once one is reached.
    if (settings.ebbDays === null && !settings.limits) throw new Error(`a ${name} does not ebb`);
    if (!expiryOf(events, { now, registry })) throw new Error(`this ${name} rose less than ${settings.ebbDays} days ago and is within its limits`);
    return;
  }
  if (dismiss && from !== chair) throw new Error(`only the chair (${chair}) can dismiss the watchers`);
  if (quiet && !settings.capabilities.includes('quiet')) throw new Error(`a ${name} takes no quiet notes`);
  if (kind === 'pin') {
    if (!settings.capabilities.includes('pin')) throw new Error(`a ${name} takes no pins`);
    if (from !== owner && from !== chair) throw new Error(`only ${seerName(settings, owner)} or the chair (${chair}) can pin this ${name}`);
  }

  if (kind === 'wake' && !(from === owner || (settings.closes.includes('chair') && from === chair))) {
    throw new Error(settings.closes.includes('chair')
      ? `only ${seerName(settings, owner)} or the chair (${chair}) can close this ${name}`
      : `only ${seerName(settings, owner)} can wake this ${settings.label}`);
  }

  if (ask !== undefined) {
    if (!settings.asks.length) throw new Error(`a ${name} takes no asks`);
    if (!settings.asks.includes(ask)) throw new Error(`invalid ask: ${ask}`);
    if (kind !== 'note' || from !== owner) throw new Error(`only a note from ${seerName(settings, owner)} can carry an ask`);
    if (to?.length !== 1 || to[0] === '*') throw new Error('an ask goes to exactly one codename');
  }
  if (audience?.length && ask !== 'formal') throw new Error('for needs a formal ask');

  if (kind === 'note') {
    const cap = settings.limits?.notes;
    if (cap && events.filter((e) => e.kind === 'note').length >= cap) {
      throw new Error(`this ${settings.label} is full (${cap} notes); ${seerName(settings, owner)} or the chair can wake it with an outcome, or anyone can open a follow-up`);
    }
    const { per, count, ms } = settings.pace;
    if (per === 'run' && from !== owner) {
      let run = 0;
      for (let i = events.length - 1; i >= 0 && events[i].from !== owner; i--) if (events[i].kind === 'note') run++;
      if (run >= count) throw new Error(`rate guard: ${run} notes since ${seerName(settings, owner)} last spoke; waiting for ${owner}`);
    }
    if (per === 'author') {
      const since = now.getTime() - ms;
      const recent = events.filter((e) => e.kind === 'note' && e.from === from && Date.parse(e.time) > since).length;
      if (recent >= count) throw new Error(`rate limit: ${recent} notes from ${from} in the last ${ms / 1000} s on this ${name}`);
    }
  }
}

// Who an ask's answer is for.
export function askAudience(events, { ask, for: audience }) {
  if (ask === 'formal') return audience?.length ? audience : ['*'];
  if (ask === 'outcome') return [ownerOf(events)];
  return undefined;
}
