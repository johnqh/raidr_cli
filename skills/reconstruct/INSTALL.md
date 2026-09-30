# Installing the raidr reconstruct skill

The skill drives the `raidr` CLI, so install both.

## 1. Install the CLI

From a clone of this repository:

```bash
cd ~/projects/raidr_processor && bun install && bun run build
cd ~/projects/raidr_cli && bun install
bun link
```

`bun link` registers the `raidr` binary globally. Verify:

```bash
raidr reconstruct
# usage: raidr reconstruct <bundle.zip|dir> --out <dir>
```

If the linked binary is not on your PATH, invoke the entry point directly. The
skill works either way — substitute this wherever it says `raidr`:

```bash
bun ~/projects/raidr_cli/src/cli.ts reconstruct <bundle.zip> --out <dir>
```

## 2. Install the skill

The CLI installs it for you. Pick your runtime:

```bash
raidr install --claude    # Claude Code   → ~/.claude/skills
raidr install --codex     # Codex         → ~/.codex/skills
raidr install --agents    # shared alias  → ~/.agents/skills
raidr install --all       # all three
```

`--agents` is the cross-runtime alias Codex, Gemini CLI, and Copilot CLI all
honour, so one install serves several agents. Where both exist at the same
scope, `.agents/skills/` wins.

The command symlinks rather than copies, so the skill tracks this repository. It
is safe to re-run: an existing correct link is left alone, a stale link to an
old checkout is repaired, and a real directory in the way is reported rather
than deleted.

### By hand, if you prefer

```bash
mkdir -p ~/.codex/skills
ln -s ~/projects/raidr_cli/skills/reconstruct ~/.codex/skills/raidr-reconstruct
```

Then start a new session — every runtime reads skills at session start.

## 3. Confirm end to end

```bash
raidr reconstruct ~/projects/raidr_cli/fixtures/bundles/react-sample.zip --out /tmp/rebuilt
cat /tmp/rebuilt/.raidr/report.md
```

Expected: framework `react`, bundler `vite`, mode `recovery` at 100%, four
routes, and five endpoints — `/api/login`, `/api/me`, `/api/stats`,
`/api/users`, `/api/users/{id}`.

Then confirm the output actually runs:

```bash
cd /tmp/rebuilt && bun install && bun run build && bun run server/replay.ts
```

## Uninstalling

```bash
raidr uninstall --all
cd ~/projects/raidr_cli && bun unlink
```
