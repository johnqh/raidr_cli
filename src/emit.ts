/**
 * Writes generated files to disk, prettier-formatting the ones prettier knows.
 * Shared by the source-recovery, chunk-unpack and project-codegen stages.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import prettier from 'prettier';
import { safeRelativePath } from './paths';

const FORMATTABLE = /\.(ts|tsx|js|jsx|json|css|html)$/;

/**
 * Writes each `relative path → source` entry under `outDir`, creating parent
 * directories. Formatting failures are swallowed and the raw source is written
 * instead, so one unparseable file never aborts a reconstruction. Over-long
 * path segments are shortened (`safeRelativePath`); a path still too long for
 * the file system is skipped.
 *
 * @returns the number of files written (formatted or not).
 */
export async function emitFiles(
  outDir: string,
  files: Record<string, string>
): Promise<number> {
  let written = 0;
  for (const [relative, source] of Object.entries(files)) {
    const path = join(outDir, safeRelativePath(relative));
    try {
      await mkdir(dirname(path), { recursive: true });
    } catch (error) {
      if ((error as { code?: string }).code === 'ENAMETOOLONG') continue;
      throw error;
    }

    let content = source;
    if (FORMATTABLE.test(relative)) {
      try {
        content = await prettier.format(source, { filepath: path });
      } catch {
        // Emitting unformatted output beats failing the whole reconstruction.
      }
    }
    try {
      await writeFile(path, content, 'utf8');
    } catch (error) {
      if ((error as { code?: string }).code === 'ENAMETOOLONG') continue;
      throw error;
    }
    written += 1;
  }
  return written;
}
