/**
 * `raidr install` / `raidr uninstall`: symlink this repo's `skills/reconstruct`
 * directory into a coding agent's personal skills directory as
 * `raidr-reconstruct`. A symlink rather than a copy, so the installed skill
 * always matches the CLI checkout (or global package) it drives.
 */
import { mkdir, symlink, rm, stat, readlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

/** Coding-agent skill locations `raidr install` knows about. */
export type Runtime = 'claude' | 'codex' | 'agents';

/**
 * Where each coding agent looks for personal skills. `agents` is the
 * cross-runtime alias Codex, Gemini CLI, and Copilot CLI all honour, so one
 * install can serve several agents at once.
 */
const SKILL_DIRS: Record<Runtime, string> = {
  claude: '.claude/skills',
  codex: '.codex/skills',
  agents: '.agents/skills',
};

const SKILL_NAME = 'raidr-reconstruct';

/** Outcome of installing for one runtime. `target` is the symlink path. */
export interface InstallResult {
  runtime: Runtime;
  target: string;
  action: 'linked' | 'already-linked' | 'replaced';
}

/** The skill directory inside this repository, resolved from this file. */
export function skillSource(): string {
  return resolve(import.meta.dir, '..', '..', 'skills', 'reconstruct');
}

async function linkOne(
  runtime: Runtime,
  source: string,
  home: string
): Promise<InstallResult> {
  const dir = join(home, SKILL_DIRS[runtime]);
  const target = join(dir, SKILL_NAME);
  await mkdir(dir, { recursive: true });

  try {
    const existing = await readlink(target);
    if (resolve(existing) === source) {
      return { runtime, target, action: 'already-linked' };
    }
    // A stale link to an old checkout is worse than no link: the runtime loads
    // a skill that no longer matches the CLI it drives.
    await rm(target, { force: true });
    await symlink(source, target);
    return { runtime, target, action: 'replaced' };
  } catch {
    // Not a symlink. If something real is there, refuse rather than delete it.
    try {
      await stat(target);
      throw new Error(
        `${target} already exists and is not a link. Move it aside, then re-run.`
      );
    } catch (error) {
      if (error instanceof Error && error.message.includes('already exists')) throw error;
    }
    await symlink(source, target);
    return { runtime, target, action: 'linked' };
  }
}

/**
 * Links the skill for each runtime, replacing a stale link but refusing to
 * delete a real file or directory at the target.
 *
 * `home` is injected rather than read from the environment: node's homedir()
 * ignores runtime changes to HOME, so a test that redirects it would silently
 * write into the developer's real home directory.
 */
export async function install(
  runtimes: Runtime[],
  home: string = homedir()
): Promise<InstallResult[]> {
  const source = skillSource();
  await stat(source); // fail loudly if the repo layout moved
  const results: InstallResult[] = [];
  for (const runtime of runtimes) results.push(await linkOne(runtime, source, home));
  return results;
}

/**
 * Removes the skill link for each runtime. Only symlinks are removed; a
 * runtime with nothing linked is skipped silently.
 *
 * @returns the link paths actually removed.
 */
export async function uninstall(
  runtimes: Runtime[],
  home: string = homedir()
): Promise<string[]> {
  const removed: string[] = [];
  for (const runtime of runtimes) {
    const target = join(home, SKILL_DIRS[runtime], SKILL_NAME);
    try {
      await readlink(target);
      await rm(target, { force: true });
      removed.push(target);
    } catch {
      // Not linked for this runtime; nothing to undo.
    }
  }
  return removed;
}

/**
 * Maps `--claude` / `--codex` / `--agents` / `--all` to runtimes.
 * @returns null when no runtime flag is present, so callers can choose the default.
 */
export function parseRuntimes(argv: string[]): Runtime[] | null {
  const all: Runtime[] = ['claude', 'codex', 'agents'];
  if (argv.includes('--all')) return all;
  const chosen = all.filter((runtime) => argv.includes(`--${runtime}`));
  return chosen.length > 0 ? chosen : null;
}

/** CLI handler for `raidr install`; exits 1 with usage when no runtime flag is given. */
export async function runInstall(argv: string[]): Promise<void> {
  const runtimes = parseRuntimes(argv);
  if (!runtimes) {
    console.error(
      'usage: raidr install [--claude] [--codex] [--agents] [--all]\n' +
        '  --claude  Claude Code      ~/.claude/skills\n' +
        '  --codex   Codex            ~/.codex/skills\n' +
        '  --agents  shared alias     ~/.agents/skills (Codex, Gemini CLI, Copilot CLI)'
    );
    process.exit(1);
  }

  for (const result of await install(runtimes)) {
    const verb =
      result.action === 'already-linked'
        ? 'already installed'
        : result.action === 'replaced'
          ? 'updated'
          : 'installed';
    console.log(`${verb}: ${result.target}`);
  }
  console.log('\nStart a new session — skills are read at session start.');
}

/** CLI handler for `raidr uninstall`; with no flags it uninstalls from every runtime. */
export async function runUninstall(argv: string[]): Promise<void> {
  const runtimes = parseRuntimes(argv) ?? ['claude', 'codex', 'agents'];
  const removed = await uninstall(runtimes);
  if (removed.length === 0) console.log('nothing to remove');
  for (const target of removed) console.log(`removed: ${target}`);
}
