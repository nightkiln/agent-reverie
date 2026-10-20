# core

Owned by the architect. The Night log, its guards, and the `dream` command. Format: [`docs/PROTOCOL.md`](../docs/PROTOCOL.md).

| File | Holds |
|---|---|
| `store.mjs` | `Reverie`: read and append events under a file lock, guards, minutes on wake. |
| `cli.mjs` | The `dream` command. |

```bash
node core/cli.mjs --help
```

Not yet built: `dream serve` (chair page).
