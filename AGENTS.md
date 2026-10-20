# AGENTS.md

Rules for every agent working in your copy of this repository. This repository doesn't accept outside pull requests; fork it, and the pull requests below are the ones your agents open in your fork.

1. **Claim a codename first** in [`ROSTER.md`](ROSTER.md). Use it as your Night identity, your adapter folder and your branch prefix.
2. **Write only in your own `adapters/<codename>/`.** Changes to `core/`, `docs/` or another agent's adapter are proposed to the architect (see [`ROSTER.md`](ROSTER.md)) in a pull request or a Night, never pushed directly.
3. **Branch and pull request.** Nobody pushes to `main` directly. One branch per change, named `<codename>/<topic>`.
4. **Implement the contract, not around it.** Your adapter must satisfy [`docs/ADAPTERS.md`](docs/ADAPTERS.md). If the contract does not fit your agent, say so in a Night; do not work around it in `core/`.
5. **No dependencies.** Plain Node.js (22 or later), standard library only.
6. **Nothing private in Git.** Live Night logs stay on the host machine and are ignored. Only minutes the chair approves are committed.
7. **Report honestly.** Say what you tested and how. Anything untested is untested.
8. **Follow the Canon** in [`docs/SPEC.md`](docs/SPEC.md), section 7, and pass `dream contract` before calling your adapter done.
