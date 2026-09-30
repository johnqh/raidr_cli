/**
 * Stage 5b of `raidr reconstruct`: write the captured site back to disk under
 * `<out>/public/`, byte-for-byte, and fill client-rendered routes from DOM
 * snapshots. Always runs, whatever the reconstruction mode.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { LoadedBundle } from '../bundle/load';

/** Resource types that make up the site as it was actually served. */
const MIRRORED = new Set([
  'Document',
  'Script',
  'Stylesheet',
  'Font',
  'Image',
  'Media',
  'Other',
]);

/** Fetch/XHR responses that are static data rather than a live API call. */
const DATA_SUFFIX = /\.(json|rsc|txt|xml|svg|wasm|i8|u16|f32|bin|csv)$/i;

/** Summary of {@link emitMirror}. All paths are mirror-relative and start with `/`. */
export interface MirrorResult {
  filesWritten: number;
  /** Every HTML page written (served or snapshot), sorted, e.g. `/users/index.html`. */
  pages: string[];
  /** Total bytes written. */
  bytes: number;
  /** Pages written from a rendered-DOM snapshot rather than served bytes. */
  fromSnapshot: string[];
  /** Every mirror-relative path written, for the link audit to resolve against. */
  paths: string[];
  /** Mirrored HTML, so links can be checked without re-reading disk. */
  documents: Array<{ path: string; html: string }>;
}

function toDiskPath(url: string, isDocument: boolean): string | null {
  let pathname: string;
  try {
    pathname = new URL(url).pathname;
  } catch {
    return null;
  }
  // Refuse to escape the output directory, whatever the capture contained.
  if (pathname.includes('..')) return null;

  if (pathname.endsWith('/')) {
    pathname += 'index.html';
  } else if (isDocument && !/\.[a-z0-9]+$/i.test(pathname)) {
    // An extensionless page like /users becomes /users/index.html — which is
    // how a static host resolves it anyway, and avoids a file named `users`
    // colliding with the directory that /users/1 needs.
    pathname += '/index.html';
  }

  return pathname.replace(/^\/+/, '');
}

/**
 * Writes the site back to disk exactly as it was served. This is the one part
 * of a reconstruction that involves no inference at all: the bytes are the
 * bytes. For a server-rendered app with no source maps it is also the only
 * faithful artifact available — the components were never sent to the browser.
 *
 * Only GETs with a captured body and no 3xx+ status are written, limited to
 * {@link MIRRORED} resource types plus Fetch/XHR responses that look like static
 * data files. The first capture of a path wins; paths containing `..` are
 * dropped; extensionless documents become `<path>/index.html`.
 */
export async function emitMirror(
  bundle: LoadedBundle,
  outDir: string
): Promise<MirrorResult> {
  const seen = new Set<string>();
  const pages: string[] = [];
  const documents: Array<{ path: string; html: string }> = [];
  const fromSnapshot: string[] = [];
  let filesWritten = 0;
  let bytes = 0;
  const decoder = new TextDecoder();

  for (const request of bundle.requests) {
    if (request.method !== 'GET') continue;
    if (!request.responseBodyHash) continue;
    if (request.status !== null && request.status >= 300) continue;

    const isMirrored =
      MIRRORED.has(request.resourceType) ||
      ((request.resourceType === 'Fetch' || request.resourceType === 'XHR') &&
        DATA_SUFFIX.test(new URL(request.url).pathname));
    if (!isMirrored) continue;

    const relative = toDiskPath(request.url, request.resourceType === 'Document');
    if (relative === null || seen.has(relative)) continue;
    seen.add(relative);

    const body = bundle.content.get(request.responseBodyHash);
    if (!body) continue;

    const path = join(outDir, relative);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, body);
    filesWritten += 1;
    bytes += body.byteLength;

    if (request.resourceType === 'Document') {
      pages.push(`/${relative}`);
      documents.push({ path: `/${relative}`, html: decoder.decode(body) });
    }
  }

  // A client-rendered route was never served as a document. Its rendered DOM is
  // the only evidence the page existed, so write it where a host would serve
  // that URL — but only where nothing real was captured, so served bytes always
  // win over a snapshot.
  for (const [routePath, hash] of Object.entries(bundle.snapshots)) {
    const relative = toDiskPath(`https://x${routePath}`, true);
    if (relative === null || seen.has(relative)) continue;
    const body = bundle.content.get(hash);
    if (!body) continue;

    seen.add(relative);
    const path = join(outDir, relative);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, body);
    filesWritten += 1;
    bytes += body.byteLength;
    pages.push(`/${relative}`);
    fromSnapshot.push(`/${relative}`);
    documents.push({ path: `/${relative}`, html: decoder.decode(body) });
  }

  return {
    filesWritten,
    fromSnapshot: fromSnapshot.sort(),
    pages: pages.sort(),
    bytes,
    paths: Array.from(seen).map((p) => `/${p}`).sort(),
    documents,
  };
}
