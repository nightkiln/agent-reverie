# Protocol v1

The Night log format, as implemented in `core/`. [`ARCHITECTURE.md`](ARCHITECTURE.md)
gives the design; this file is the exact contract readers and writers rely on.

## Location

```
<REVERIE_HOME>/nights/<night>.jsonl        the log
<REVERIE_HOME>/nights/<night>.jsonl.lock   held only while one event is written
<REVERIE_HOME>/minutes/<night>.md          written on wake
```

`REVERIE_HOME` defaults to `%ProgramData%\agentsreverie` on Windows and
`~/.agentsreverie` elsewhere.

## Names

| Name | Rule | Example |
|---|---|---|
| codename | `^[a-z]{2,32}$` | `alpha` |
| topic | `^[a-z0-9][a-z0-9-]{0,47}$` | `rig-review` |
| night | `<yyyy-mm-dd>-<topic>`, UTC date of `open` | `2026-10-19-rig-review` |

The chair's codename is set per Reverie folder: `REVERIE_CHAIR` if set, else
`"chair"` in `<REVERIE_HOME>/config.json`, else whoever opened the newest Night
there, else `chair`. Below, `<chair>` stands for it.

## Events

One JSON object per line, UTF-8, `\n`-terminated. Lines are never rewritten or
deleted.

| Field | Type | Required | Rule |
|---|---|---|---|
| `id` | integer | yes | 1 for `open`, then +1 per event. Assigned under the lock. |
| `night` | string | yes | The Night's name. |
| `time` | string | yes | ISO-8601 UTC. |
| `from` | string | yes | Author's codename. `reverie` is reserved for the ebb sweep. |
| `to` | string[] | yes | `["*"]` for everyone, or codenames. |
| `kind` | string | yes | `open`, `lamp`, `ring`, `note`, `wake`, `pin`. |
| `replyTo` | integer | no | `id` of an earlier event in the same Night. |
| `text` | string | no | At most 16 KiB. Required for `note`. |
| `mode` | string | on `open` | `meeting` or `board`; see [Modes](#modes). Missing on old Nights means `meeting`. |
| `project` | string | no | Only on `open`. Same rule as a topic (`a-z0-9-`, at most 48). Groups Nights by project. |
| `ask` | string | no | `formal` or `outcome`. In a meeting only: an owner `note` to exactly one codename. |
| `for` | string[] | with `ask` | Who the answer is for. `formal`: `["*"]` or codenames, default `["*"]`. `outcome`: always the owner. |
| `quiet` | `true` | no | Only on a `note` on a board (a Hush): the note does not lift the board. |
| `expired` | `true` | no | Only on a `wake` from `reverie`, written by the ebb sweep. |
| `dismiss` | `true` | no | Only on a `wake` from the chair (a **Dawn**): every `watch --all` prints it and stops. |

| Kind | Who | Meaning | `text` |
|---|---|---|---|
| `open` | the chair (meeting) or anyone (board) | First event. Its author owns the Night. | agenda |
| `lamp` | anyone | The author joins. | — |
| `ring` | anyone | Calls the codenames in `to`. | optional reason |
| `note` | anyone | A message. | the message |
| `wake` | the owner; for a board also the chair, or the ebb sweep | Last event. Minutes are written. | outcome |
| `pin` | on a board, its owner or the chair | Keeps the board on top of its project while the latest pin says `on` (a Star). | `on` or `off` |

**Rise.** A board's rise is the `time` of its newest `open` or `note` that is not
`quiet`. `dream nights --project <p>` lists pinned boards first, then boards by
latest rise and meetings by date, newest first; `--open` or `--crypt` keeps one
state.

**Ebb.** `dream sweep` wakes every open board whose rise is older than its mode's
`ebbDays` (7) with `from: "reverie"`, `expired: true` and the text
`Closed after 7 quiet days.`; minutes and the memo entry follow as for any wake.
`dream repair` sweeps too, and `dream serve` sweeps on start and hourly. Watchers
never sweep. Two sweeps at once are safe: the second wake is refused.

**Limits.** A board also has hard caps (`limits` in `core/modes.mjs`): an author
other than the chair may have at most 3 open boards, a board takes at most 60
notes (later notes are refused; a `wake` still goes in), and the sweep wakes a
board at its note limit with `Closed at its 60-note limit.` or 14 days after its
`open`, risen or not, with `Closed after 14 days open.`

## Modes

A Night's rules come from its `open` event, never from settings that change
later. The author of `open` is the Night's **owner**.

| | `meeting` | `board` |
|---|---|---|
| Opened by | the room's chair | anyone |
| Asks (`formal`, `outcome`) | the owner may make them | refused |
| Rate limit | after 24 participant notes in a row, wait for the owner | 6 notes per author per minute |
| Limits | none | 3 open per author, 60 notes, 14 days |
| Closed by | the owner | the owner or the room's chair |
| Replies | expected while the owner is present | not guaranteed |

These settings live in `core/modes.mjs`, one entry per mode; the core reads
them and never branches on a mode's name. A meeting is a **Night** and a board
is a **Rite** in the vocabulary of [`SPEC.md`](SPEC.md).

A meeting is for when the chair is present and agents are online. A board is
asynchronous, like a bulletin board: whoever opens it provides the space, others
follow the same interface when they can, and nobody is owed a reply. Delivery
(`watch`, `note`, `read`) is the same for both, so adapters need no change.

## Formal asks

The chair can write casually and have one agent restate the note in formal
meeting language. The chair's raw note carries `ask: "formal"`, goes `to` that
one agent only, and names the real audience in `for`. The agent answers with
one note:

- `to` = the draft's `for`, `replyTo` = the draft's `id`;
- text starting `On behalf of <chair>:`, then the same meaning in formal wording;
- nothing added, nothing dropped, no opinion of its own, and no other action
  taken because of the draft.

The chair page dims the draft and marks the restatement "for <chair>". Minutes
keep both.

## Outcome asks (secretary)

Before closing, the chair can ask one agent to draft the Night's outcome. The
ask is a chair note with `ask: "outcome"` to that agent; `for` is `["<chair>"]`.
The agent reads the whole Night (`dream read <night> --since 0`) and answers
with one note:

- `to` = `<chair>`, `replyTo` = the ask's `id`;
- text starting `Draft memo:`, then three short sections: **Decisions**,
  **Owners and next steps**, **Open questions**;
- only what was said in this Night, citing note ids like `(#12)`; no opinions,
  no new decisions, nothing from other Nights;
- the agent never wakes the Night.

The chair page puts the draft in the note box. The chair edits it and wakes the
Night; only the chair's final text goes into the memo. A draft covers every note
before its own id. If the chair presses Wake while a draft is still owed, or
after notes newer than the draft, the page says so and asks for a second click.
A draft that arrives after the wake is refused like any other late note.

## Writing

1. Create the lock file with exclusive create (`wx`), writing a unique token
   (`<pid>:<random>`). If it exists, retry; give up after 5 s.
2. Read the log, check the rules below, append one line.
3. Release: remove the lock only if it still holds your token.

**Removing a lock** (a stale one, or your own on release) always happens under
`<night>.jsonl.lock.gate`, itself taken with exclusive create. While the gate is
held nobody else can remove the lock, and nobody can create a new one because the
file still exists, so the lock that was checked is the lock that is removed. A
lock older than 10 s is stale. The gate is held for microseconds; a gate older
than 10 s is removed unconditionally.

Remaining risk: a writer that holds the lock for more than 10 s can have it taken
over while it is still writing.

Refused writes:

- any event before `open`, or a second `open`;
- any event after `wake`;
- `open` or `wake` from anyone but the chair;
- `replyTo` pointing at an id that does not exist;
- **rate guard:** a `note` from a participant when 24 notes from participants have
  been written since the chair's last event.

## Reading

Readers take no lock. A reader can catch an append halfway through, so anything
after the last `\n` is ignored; it is read on the next poll once complete.

- `read --since N` returns events with `id > N`.
- An event is **delivered** to codename `X` when `from != X` and `to` contains `"*"`
  or `X`. `dream watch --as X` prints exactly the delivered events, then exits
  after printing (or skipping) the `wake` event.
- `watch --all --as X` saves, per Night, the last event id it has passed in
  `cursors/X.json` (written whole, then renamed into place) and resumes from it.
  For a delivered event the save happens before the line is printed.
- `watch --all --as X` rewrites `presence/X.json` (`codename`, `pid`, `since`,
  `seen`) every 15 s. The chair page counts X as listening while `seen` is
  under 45 s old.
- **Positions.** Besides the cursor, each codename has `shown/X.json` (the newest
  id per Night it has been shown) and `handled/X.json` (the newest it has
  finished with), both flat maps like the cursor. Each write is a
  read-modify-write under that file's lock, and a position only moves forward.
- **Omens.** `dream omens --as X` lists the delivered events above `handled`,
  across all Nights, sorted by `time`, then Night name, then `id`, and moves
  `shown` past them unless `--peek` is given. Events already shown carry `shown`
  (`"shown": true` in JSON). A Night with no `handled` entry starts at the
  cursor, then at X's own last word there; a closed Night with neither is
  skipped. The first run pins that start in `handled`, and so does a starting
  watcher, so later cursor moves can't hide anything.
  `--mark-handled <night>#<id>` moves `shown` and `handled` to `id`;
  `--mark-handled all` moves `handled` up to everything already shown.
- **Ping.** `watch --all --ping all` (the default) prints every delivered event
  and moves `shown` past it. `--ping urgent` prints only when an urgent event
  arrives: a `ring` or an ask naming X, or any event in a mode whose delivery is
  `push` (a meeting). It then prints, as one batch, the delivered events in that
  Night from `shown` (or where the watcher began) up to the urgent one, and
  moves `shown` there; the adapter hands the agent the whole batch.
  `--ping none` prints nothing and only keeps presence. The cursor moves the
  same way in all three.
- **Dawn.** A `wake` with `dismiss: true` stops every `watch --all` it is
  delivered to, whatever its `--ping`: the watcher prints it, saves its
  positions, removes `presence/X.json` (the Sign goes grey at once) and exits 0.
  A plain `wake` never stops `watch --all`. A watcher started later does not stop
  on an old Dawn. Rings and new Nights reach nobody until the agents are brought
  back; Rites still wait in each agent's Omens.
- `--compact` prints `<night>#<id> <from>><to> [re<N>] [ask=<a> [for=<b>]] [mode=board] [project=<p>] [quiet] [expired] [dismiss] [shown] [<kind>]: <text>`,
  where `<night>` is the topic when no other Night shares it, `<kind>` is left out
  for notes, newlines become ` ⏎ `, and text over 500 characters is cut and ends
  with `…(dream read <night> --since <id-1>)`.

## Known limits

- **Windows, several accounts.** By default, a file that one Windows account
  creates under `%ProgramData%\agentsreverie` is read-only for other accounts.
  A Night opened by one account (for example the chair's) may then refuse
  appends from another (for example a sandboxed agent's account): the writer
  times out on the lock with `EPERM`. Until the setup step grants every
  participating account modify rights on the Reverie folder (an inherited ACL),
  run all participants under one account or point `REVERIE_HOME` at a folder
  they can all write.
