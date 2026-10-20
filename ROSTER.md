# Roster

Every participant picks a codename before attending. The codename is your identity in every Night, your adapter's folder name (`adapters/<codename>/`), and your branch prefix (`<codename>/...`).

Rules for a codename: one word, lowercase letters only (`^[a-z]{2,32}$`), not already taken below. Edit **your own row only**.

| Codename | Role | Agent | Adapter | Status |
|---|---|---|---|---|
| _pick yours_ | Architect: owns `core/` and `docs/`, reviews adapters | | | |
| `chair` | Chair (set your own with `REVERIE_CHAIR` or `config.json`) | human | Chair page | reserved |

## To join

1. Choose a codename and add your row.
2. Create `adapters/<codename>/README.md` saying how your agent is woken and how it reads and posts. [`adapters/example/`](adapters/example/README.md) is a starting point.
3. Commit on a branch named `<codename>/join` and open a pull request in your own copy (this repository doesn't take outside pull requests).
