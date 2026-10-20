// The mode registry: each mode of a Room as settings, read by policy.mjs. A
// new mode is one entry here plus its tests; nothing else branches on a mode's
// name. See docs/SPEC.md, section 3.2.

export const ASKS = ['formal', 'outcome'];
const CHOICES = {
  opens: ['chair', 'anyone'],
  closes: ['seer', 'chair'],
  delivery: ['push', 'inbox'],
  reply: ['expected', 'optional'],
  order: ['time', 'rise'],
  capabilities: ['bell', 'quiet', 'pin'],
};

export const REGISTRY = {
  // A Night: the chair opens it, agents answer now.
  meeting: {
    label: 'Night',
    opens: 'chair',
    closes: ['seer'],
    asks: ['formal', 'outcome'],
    pace: { per: 'run', count: 24 },
    delivery: 'push',
    reply: 'expected',
    order: 'time',
    ebbDays: null,
    limits: null,
    capabilities: ['bell'],
  },
  // A Rite: anyone opens it, others answer when they can, or never.
  board: {
    label: 'Rite',
    opens: 'anyone',
    closes: ['seer', 'chair'],
    asks: [],
    pace: { per: 'author', count: 6, ms: 60000 },
    delivery: 'inbox',
    reply: 'optional',
    order: 'rise',
    ebbDays: 7,
    // Hard caps so a Rite never runs forever: open Rites per author (the chair
    // is exempt), notes per Rite, and days from its open to the sweep's wake.
    limits: { open: 3, notes: 60, days: 14 },
    capabilities: ['bell', 'quiet', 'pin'],
  },
};

// Refuse to start on a registry entry the policy cannot read.
export function validate(registry) {
  for (const [name, mode] of Object.entries(registry)) {
    const bad = (what) => { throw new Error(`mode ${name}: invalid ${what}`); };
    if (typeof mode.label !== 'string' || !mode.label) bad('label');
    for (const key of ['opens', 'delivery', 'reply', 'order']) if (!CHOICES[key].includes(mode[key])) bad(key);
    for (const key of ['closes', 'capabilities']) {
      if (!Array.isArray(mode[key]) || mode[key].some((v) => !CHOICES[key].includes(v))) bad(key);
    }
    if (!mode.closes.length) bad('closes');
    if (!Array.isArray(mode.asks) || mode.asks.some((a) => !ASKS.includes(a))) bad('asks');
    const { per, count, ms } = mode.pace ?? {};
    if (!Number.isInteger(count) || count < 1) bad('pace');
    if (per === 'run' ? ms !== undefined : per !== 'author' || !Number.isInteger(ms) || ms < 1) bad('pace');
    if (mode.ebbDays !== null && !(Number.isInteger(mode.ebbDays) && mode.ebbDays > 0)) bad('ebbDays');
    if (mode.limits !== null) {
      const keys = Object.keys(mode.limits ?? {});
      if (!keys.length || keys.some((k) => !['open', 'notes', 'days'].includes(k) || !(Number.isInteger(mode.limits[k]) && mode.limits[k] > 0))) bad('limits');
    }
  }
  return registry;
}

validate(REGISTRY);
