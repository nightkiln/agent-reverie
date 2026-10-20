import { appendFile, open, readFile, stat, unlink } from 'node:fs/promises';
import { setTimeout as sleep } from 'node:timers/promises';
import { randomBytes } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';

// The log layer: one append-only JSONL file per Night, written under a lock.
// It checks only what every Night needs whatever its mode: well-formed fields,
// ids in order, nothing after the close. Who may do what is policy.mjs.

export const KINDS = ['open', 'lamp', 'ring', 'note', 'wake', 'pin'];
// Reserved for the core's own writes, such as the ebb sweep.
export const SWEEPER = 'reverie';
export const CODENAME_RE = /^[a-z]{2,32}$/;
export const TOPIC_RE = /^[a-z0-9][a-z0-9-]{0,47}$/;
export const NIGHT_RE = /^\d{4}-\d{2}-\d{2}-[a-z0-9][a-z0-9-]{0,47}$/;
export const MAX_TEXT = 16 * 1024;
const LOCK_WAIT_MS = 5000;
const LOCK_STALE_MS = 10000;

export function reverieHome(env = process.env) {
  if (env.REVERIE_HOME) return env.REVERIE_HOME;
  if (process.platform === 'win32') return join(env.ProgramData || 'C:\\ProgramData', 'agentsreverie');
  return join(homedir(), '.agentsreverie');
}

export function check(re, kind, value) {
  if (!re.test(value ?? '')) throw new Error(`invalid ${kind}: ${JSON.stringify(value)}`);
}

// Field formats, before taking the lock.
export function checkShape({ kind, from, to, text, replyTo, for: audience, project, quiet, expired, dismiss }) {
  check(CODENAME_RE, 'codename', from);
  if (!KINDS.includes(kind)) throw new Error(`invalid kind: ${kind}`);
  if (to) for (const name of to) if (name !== '*') check(CODENAME_RE, 'codename', name);
  if (audience) for (const name of audience) if (name !== '*') check(CODENAME_RE, 'codename', name);
  if (kind === 'ring' && !to?.length) throw new Error('ring needs a codename to call');
  if (kind === 'note' && !text) throw new Error('a note needs text');
  if (text && Buffer.byteLength(text) > MAX_TEXT) throw new Error(`text over ${MAX_TEXT} bytes`);
  if (replyTo !== undefined && !Number.isInteger(replyTo)) throw new Error(`invalid replyTo: ${replyTo}`);
  if (project !== undefined) {
    if (kind !== 'open') throw new Error('only open carries a project');
    check(TOPIC_RE, 'project', project);
  }
  if (quiet !== undefined && (quiet !== true || kind !== 'note')) throw new Error('quiet is true on a note, or left out');
  if (kind === 'pin' && text !== 'on' && text !== 'off') throw new Error('a pin says on or off');
  if (expired !== undefined && (expired !== true || kind !== 'wake')) throw new Error('expired is true on a wake, or left out');
  if (dismiss !== undefined && (dismiss !== true || kind !== 'wake')) throw new Error('dismiss is true on a wake, or left out');
  if ((expired === true) !== (from === SWEEPER)) throw new Error(`${SWEEPER} is reserved for the ebb sweep, which alone writes expired`);
}

// Against the log so far, under the lock.
export function checkSequence(night, events, { kind, replyTo }) {
  if (kind === 'open' && events.length) throw new Error(`night ${night} already exists`);
  if (kind !== 'open' && !events.length) throw new Error(`night ${night} does not exist`);
  if (events.at(-1)?.kind === 'wake') throw new Error(`night ${night} is over`);
  if (replyTo !== undefined && !events.some((e) => e.id === replyTo)) throw new Error(`no event ${replyTo} to reply to`);
}

export async function readLog(path, since = 0) {
  let raw;
  try {
    raw = await readFile(path, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
  // A reader can catch an append halfway through. The last element is either
  // '' (the file ends in \n) or a partial line; drop it either way, and the
  // next read picks the line up once it is complete.
  const lines = raw.split('\n');
  lines.pop();
  return lines
    .filter(Boolean)
    .map((line) => JSON.parse(line))
    .filter((event) => event.id > since);
}

export function appendLog(path, event) {
  return appendFile(path, JSON.stringify(event) + '\n', 'utf8');
}

// Exclusive create. Returns true, or the error code when the file could not be
// created and waiting may help.
async function tryCreate(path, token) {
  let handle;
  try {
    handle = await open(path, 'wx');
  } catch (err) {
    // Windows reports EPERM for a file that is being deleted, and also when
    // the folder is not writable for this account.
    if (err.code === 'EEXIST' || err.code === 'EPERM') return err.code;
    throw err;
  }
  try {
    await handle.writeFile(token);
  } finally {
    await handle.close();
  }
  return true;
}

async function ageMs(path) {
  try {
    return Date.now() - (await stat(path)).mtimeMs;
  } catch (err) {
    if (err.code === 'ENOENT') return -1;
    throw err;
  }
}

const backoff = () => sleep(10 + Math.random() * 20);

// Every unlink of a lock file happens under its gate. While the gate is held,
// nobody else can unlink the lock, and nobody can create a new one because the
// file still exists, so the file we inspect is the file we remove.
async function withGate(lock, fn) {
  const gate = `${lock}.gate`;
  const deadline = Date.now() + LOCK_WAIT_MS;
  while ((await tryCreate(gate, `${process.pid}\n`)) !== true) {
    // The gate is held for microseconds; one this old belongs to a dead process.
    if ((await ageMs(gate)) > LOCK_STALE_MS) await unlink(gate).catch(() => {});
    if (Date.now() > deadline) throw new Error(`timed out waiting for gate ${gate}`);
    await backoff();
  }
  try {
    return await fn();
  } finally {
    await unlink(gate).catch(() => {});
  }
}

export async function withLock(path, fn) {
  const lock = `${path}.lock`;
  const token = `${process.pid}:${randomBytes(8).toString('hex')}\n`;
  const deadline = Date.now() + LOCK_WAIT_MS;
  let result;
  while ((result = await tryCreate(lock, token)) !== true) {
    if ((await ageMs(lock)) > LOCK_STALE_MS) {
      await withGate(lock, async () => {
        if ((await ageMs(lock)) > LOCK_STALE_MS) await unlink(lock);
      });
      continue;
    }
    if (Date.now() > deadline) {
      const hint = result === 'EPERM' ? ' (EPERM: check that this account can write the Reverie folder)' : '';
      throw new Error(`timed out waiting for lock ${lock}${hint}`);
    }
    await backoff();
  }
  try {
    return await fn();
  } finally {
    // If this holder ran past the stale limit, the lock may now be someone else's.
    await withGate(lock, async () => {
      const current = await readFile(lock, 'utf8').catch(() => null);
      if (current === token) await unlink(lock);
    });
  }
}
