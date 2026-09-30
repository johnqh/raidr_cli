/**
 * Reads an raidr capture bundle — a `.zip` or an already-unpacked directory —
 * into memory and validates its manifest with raidr_processor. This is the only
 * place the CLI touches the bundle's on-disk layout; every stage works from the
 * returned {@link LoadedBundle}.
 */
import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { unzipSync } from 'fflate';
import {
  parseJsonl,
  validateManifest,
  type CapturedFrame,
  type CapturedRequest,
  type Gap,
  type RedactionEntry,
  type RuntimeArtifacts,
  type RaidrManifest,
} from '@sudobility/raidr_processor';

/**
 * A bundle held entirely in memory. Missing optional files (gaps, redaction,
 * source maps, snapshots, runtime/*) load as empty defaults rather than
 * throwing; only `raidr.json` is required.
 */
export interface LoadedBundle {
  manifest: RaidrManifest;
  /** Rows of `network/requests.jsonl`, in file order. */
  requests: CapturedRequest[];
  /** Rows of `network/websockets.jsonl`. */
  frames: CapturedFrame[];
  /** What the capture knows it missed (`gaps.json`). */
  gaps: Gap[];
  /** Pseudonym table from `redaction.json` — placeholders, never real values. */
  redaction: RedactionEntry[];
  /** Script URL → content hash of its source map (`sourcemaps/index.json`). */
  sourceMaps: Record<string, string>;
  /** route path → hash of the rendered DOM, for client-rendered routes */
  snapshots: Record<string, string>;
  runtime: RuntimeArtifacts;
  /**
   * Content hash → bytes. `content/<hash>.*`, `sourcemaps/<hash>.map` and
   * `snapshots/<hash>.html` all land in this one map, keyed by bare hash, so
   * every `*Hash` field in the bundle resolves here.
   */
  content: Map<string, Uint8Array>;
  /** UTF-8 decode of a content entry, or null when the hash is absent. */
  text(hash: string): string | null;
  /** Parsed JSON of a content entry; undefined when absent or not valid JSON. */
  json(hash: string): unknown;
}

const decoder = new TextDecoder();

async function readTree(dir: string, prefix = ''): Promise<Map<string, Uint8Array>> {
  const files = new Map<string, Uint8Array>();
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    const abs = join(dir, entry.name);
    if (entry.isDirectory()) {
      for (const [k, v] of await readTree(abs, rel)) files.set(k, v);
    } else {
      files.set(rel, new Uint8Array(await readFile(abs)));
    }
  }
  return files;
}

/**
 * Loads and validates a bundle.
 *
 * @param path a bundle `.zip`, or a directory with the same layout.
 * @throws when `raidr.json` is missing or fails `validateManifest` (for
 *   example an unsupported format version, or a HAR file passed by mistake).
 */
export async function loadBundle(path: string): Promise<LoadedBundle> {
  const info = await stat(path);
  const files: Map<string, Uint8Array> = info.isDirectory()
    ? await readTree(path)
    : new Map(Object.entries(unzipSync(new Uint8Array(await readFile(path)))));

  const readText = (name: string): string | null => {
    const bytes = files.get(name);
    return bytes ? decoder.decode(bytes) : null;
  };
  const readJson = <T>(name: string, fallback: T): T => {
    const text = readText(name);
    return text === null ? fallback : (JSON.parse(text) as T);
  };

  const manifestText = readText('raidr.json');
  if (manifestText === null) throw new Error(`${path}: raidr.json not found`);

  const validation = validateManifest(JSON.parse(manifestText));
  if (!validation.ok) {
    throw new Error(`${path}: invalid bundle — ${validation.errors.join('; ')}`);
  }

  // Gaps first: everything downstream must know what is missing before it
  // starts reasoning about what is present.
  const gaps = readJson<Gap[]>('gaps.json', []);

  const content = new Map<string, Uint8Array>();
  for (const [name, bytes] of files) {
    if (name.startsWith('content/')) {
      const hash = name.slice('content/'.length).split('.')[0];
      if (hash) content.set(hash, bytes);
    } else if (name.startsWith('sourcemaps/') && name.endsWith('.map')) {
      content.set(name.slice('sourcemaps/'.length, -'.map'.length), bytes);
    } else if (name.startsWith('snapshots/') && name.endsWith('.html')) {
      content.set(name.slice('snapshots/'.length, -'.html'.length), bytes);
    }
  }

  const text = (hash: string): string | null => {
    const bytes = content.get(hash);
    return bytes ? decoder.decode(bytes) : null;
  };

  return {
    manifest: validation.manifest,
    requests: parseJsonl<CapturedRequest>(readText('network/requests.jsonl') ?? ''),
    frames: parseJsonl<CapturedFrame>(readText('network/websockets.jsonl') ?? ''),
    gaps,
    redaction: readJson<RedactionEntry[]>('redaction.json', []),
    sourceMaps: readJson<Record<string, string>>('sourcemaps/index.json', {}),
    snapshots: readJson<Record<string, string>>('snapshots/index.json', {}),
    runtime: {
      framework: readJson('runtime/framework.json', null),
      routes: readJson('runtime/routes.json', []),
      stores: readJson('runtime/stores.json', []),
      chunks: readJson('runtime/chunks.json', { known: [], loaded: [] }),
      coverage: readJson('runtime/coverage.json', {}),
      navigations: readJson('runtime/navigations.json', []),
    },
    content,
    text,
    json(hash: string): unknown {
      const raw = text(hash);
      if (raw === null) return undefined;
      try {
        return JSON.parse(raw);
      } catch {
        return undefined;
      }
    },
  };
}
