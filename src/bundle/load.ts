/**
 * Reads an raidr capture bundle — a `.zip` or an already-unpacked directory —
 * into memory and validates its manifest with raidr_processor. This is the only
 * place the CLI touches the bundle's on-disk layout; every stage works from the
 * returned {@link LoadedBundle}. Parsing is raidr_processor's `readBundle`
 * (shared with raidr_crawler); this module only reads the files.
 */
import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { readBundle, unzipBundle, type LoadedBundle } from '@sudobility/raidr_processor';

export type { LoadedBundle };

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
  return info.isDirectory()
    ? readBundle(await readTree(path), path)
    : unzipBundle(new Uint8Array(await readFile(path)), path);
}
