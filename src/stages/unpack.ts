/**
 * Stage 3 of `raidr reconstruct`: beautify every captured JavaScript response
 * and, for webpack output, split it into per-module files. Runs only when
 * source-map recovery falls below the recovery threshold.
 */
import prettier from 'prettier';
import type { LoadedBundle } from '../bundle/load';

/** One captured script, beautified. */
export interface UnpackedChunk {
  url: string;
  /** Content hash of the captured response body. */
  hash: string;
  /** Beautified source, or the original bytes if prettier could not parse it. */
  source: string;
  /** True when {@link splitWebpackModules} found module boundaries. */
  splittable: boolean;
  /** Per-module sources; empty unless `splittable`. */
  modules: Array<{ id: string; source: string }>;
}

/** Prettier-formats script source; returns the input unchanged if it will not parse. */
export async function beautify(source: string): Promise<string> {
  try {
    return await prettier.format(source, {
      parser: 'babel',
      semi: true,
      singleQuote: true,
    });
  } catch {
    // Minified output is sometimes not parseable as standalone script text.
    // Returning it unchanged keeps the bytes available to the reader.
    return source;
  }
}

/**
 * webpack emits `{ <id>: (module, exports, require) => { ... } }`. Scanning for
 * `<id>:` at brace depth 1 recovers module boundaries without an AST.
 */
export function splitWebpackModules(
  source: string
): Array<{ id: string; source: string }> {
  const start = source.search(/\{\s*\d+\s*:\s*(\(|function)/);
  if (start < 0) return [];

  const modules: Array<{ id: string; source: string }> = [];
  let depth = 0;
  let currentId: string | null = null;
  let bodyStart = 0;
  let inString: string | null = null;
  let escaped = false;

  for (let i = start; i < source.length; i += 1) {
    const char = source[i]!;

    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === '\\') {
      escaped = true;
      continue;
    }
    if (inString) {
      if (char === inString) inString = null;
      continue;
    }
    if (char === '"' || char === "'" || char === '`') {
      inString = char;
      continue;
    }

    if (char === '{') {
      depth += 1;
      continue;
    }
    if (char === '}') {
      depth -= 1;
      if (depth === 1 && currentId !== null) {
        modules.push({ id: currentId, source: source.slice(bodyStart, i + 1) });
        currentId = null;
      }
      if (depth === 0) break;
      continue;
    }

    if (depth === 1 && currentId === null) {
      const match = /^(\d+)\s*:/.exec(source.slice(i));
      if (match) {
        currentId = match[1]!;
        bodyStart = i + match[0].length;
        i += match[0].length - 1;
      }
    }
  }

  return modules;
}

/**
 * Beautifies every response whose `mimeType` contains `javascript` and whose
 * body was captured. Chunks without a body in the bundle are skipped.
 */
export async function unpackChunks(bundle: LoadedBundle): Promise<UnpackedChunk[]> {
  const chunks: UnpackedChunk[] = [];

  for (const request of bundle.requests) {
    if (!request.mimeType?.includes('javascript')) continue;
    if (!request.responseBodyHash) continue;
    const source = bundle.text(request.responseBodyHash);
    if (source === null) continue;

    const modules = splitWebpackModules(source);
    chunks.push({
      url: request.url,
      hash: request.responseBodyHash,
      source: await beautify(source),
      splittable: modules.length > 0,
      modules: await Promise.all(
        modules.map(async (m) => ({ id: m.id, source: await beautify(m.source) }))
      ),
    });
  }

  return chunks;
}
