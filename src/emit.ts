/**
 * Writes generated files to disk, prettier-formatting the ones prettier knows.
 * Shared by the source-recovery, chunk-unpack and project-codegen stages.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import prettier from 'prettier';

const FORMATTABLE = /\.(ts|tsx|js|jsx|json|css|html)$/;

/**
 * Writes each `relative path → source` entry under `outDir`, creating parent
 * directories. Formatting failures are swallowed and the raw source is written
 * instead, so one unparseable file never aborts a reconstruction.
 *
 * @returns the number of files written (every entry, formatted or not).
 */
export async function emitFiles(
  outDir: string,
  files: Record<string, string>
): Promise<number> {
  let written = 0;
  for (const [relative, source] of Object.entries(files)) {
    const path = join(outDir, relative);
    await mkdir(dirname(path), { recursive: true });

    let content = source;
    if (FORMATTABLE.test(relative)) {
      try {
        content = await prettier.format(source, { filepath: path });
      } catch {
        // Emitting unformatted output beats failing the whole reconstruction.
      }
    }
    await writeFile(path, content, 'utf8');
    written += 1;
  }
  return written;
}
