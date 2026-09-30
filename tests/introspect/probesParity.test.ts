import { existsSync } from 'node:fs';
import { expect, test } from 'bun:test';

// probes.ts is duplicated in raidr_cli and raidr_extension on purpose: it is
// serialized with .toString() and evaluated in the page, so it touches DOM
// globals and cannot move into raidr_processor, which forbids DOM in its tsconfig
// lib. This test is the guard on that duplication.
//
// It can only run where both repos are checked out side by side — a developer
// machine, and push_all's local validation, which is what actually gates a
// release. CI checks out one repo, so there the sibling is absent and the
// check is skipped rather than failed.
const EXT_PROBES = `${import.meta.dir}/../../../raidr_extension/src/introspect/probes.ts`;

test.skipIf(!existsSync(EXT_PROBES))(
  'cli probes are identical to the extension probes',
  async () => {
    const cli = await Bun.file(`${import.meta.dir}/../../src/introspect/probes.ts`).text();
    const ext = await Bun.file(EXT_PROBES).text();
    expect(cli).toBe(ext);
  }
);
