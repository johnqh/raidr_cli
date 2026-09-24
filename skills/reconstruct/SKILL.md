---
name: raidr-reconstruct
description: Use when rebuilding a web application from an raidr capture bundle, when handed an raidr-*.zip of captured traffic, or when asked to reverse engineer a site from its recorded network activity and JavaScript.
---

# Reconstructing an app from an raidr bundle

## Runtime

Nothing here is specific to one coding agent. The skill drives a shell binary
and reads JSON files, so it works the same in Claude Code, Codex, Gemini CLI,
and Copilot CLI. Where a step says "run", run it however your runtime runs
shell commands.

## Overview

An raidr bundle holds everything a running web app served: its JavaScript, its
HTML, its API traffic, its source maps where they existed, and an explicit list
of what the capture missed. The `raidr` CLI performs every deterministic stage.
Your job is the part it cannot do — turning recovered or minified source into
readable components wired to real routes.

**Core principle: the bundle is evidence, not inspiration.** Everything you
write must trace to something in it. Where the bundle is silent, say so.

## When to Use

- A `.zip` produced by the raidr capture extension, or an unpacked bundle directory
- A request to rebuild, clone, or reverse engineer an app from captured traffic
- Re-running a reconstruction with better judgment against an existing bundle

Not for: capturing traffic (that is the extension), or analyzing a HAR file
(wrong format — `validateManifest` rejects it).

## Procedure

**1. Run the CLI first. Always.**

```bash
raidr reconstruct <bundle.zip> --out <dir>
```

It writes the project and, under `<dir>/.raidr/`, the artifacts you work from.
Do not read the raw bundle before running it — the artifacts are the same data,
already clustered, typed, and de-duplicated.

Do not add `--replay` unless the user's own prompt asks for a replay-based,
offline, or mock server. The default (no flag) is correct almost always: in
mirror mode it proxies dynamic requests to the real backend live, which is the
only way a stateful flow like login or a chat endpoint behaves correctly.
`--replay` freezes those flows at whatever one capture session happened to
see — a deliberate downgrade, not a default.

**2. Read `<dir>/.raidr/report.md`.**

It names the framework, the reconstruction mode, the routes (including which
were never visited), the endpoints, and the gap count. What you do next depends
on the mode:

| Mode | Meaning | What you do |
|---|---|---|
| `recovery` | Source maps covered ≥80% of the JS | Copy real original sources from `.raidr/02-sources/` into the project. This is recovery, not inference — do not paraphrase them. |
| `inference` | Little or no source-map coverage | Read `.raidr/03-chunks/` and write components that reproduce observed behavior. |
| `mirror` | Server-rendered, no client router to reconstruct | The mirror is already the deliverable — verify it (step 6), nothing to implement. By default `server/replay.ts` proxies every dynamic request to the real backend live; only `--replay` mode serves `.raidr/recordings.json` instead. |

**3. Enumerate every page before implementing any.**

Read `.raidr/07-link-audit.json` and the report's "Linked but never captured"
section. The route model lists pages the capture *reached*; the link audit lists
pages the site *links to*. The second list is always the longer one, and the
difference is what a reconstruction silently ships broken.

Write the two lists out before you start. Your page inventory is their union —
every route in `05-route-model.json`, plus every `kind: "page"` entry in the
audit. A page missing from the inventory is a page nobody will notice is missing
until they click the link.

**4. Implement one page at a time, in inventory order.**

For each page, work through it alone rather than holding the whole app in
context. The route entry names the endpoints that fired while it was mounted —
those, and only those, are its data dependencies. Call them through the
generated client in `src/api/client.ts`; never re-derive fetch calls by hand,
and never invent an endpoint the model does not list.

For a page that appears only in the link audit, there is no captured content.
Do not skip it silently and do not invent it. It goes in the re-capture list in
your completion report (step 6), named by the URL the operator must visit.

**5. Honor the gaps.**

`.raidr/01-bundle.json` lists what the capture missed, and `RAIDR-GAPS.md` in the
project repeats it. A route marked `visited: false` has no runtime evidence
behind it. Leave its `RAIDR-GAP` comment in place and implement only the shell
the router requires. Deleting a gap marker because the page looks empty without
it is the one thing that turns a reconstruction into a fabrication.

**6. Verify, then report in this shape.**

Run all three. Not one, not two:

```bash
cd <dir> && bun install && bun run typecheck && bun run build
bun run server/replay.ts &                     # or `bun run serve` in mirror mode

# Bun is already a requirement of the CLI; jq may not be installed.
for p in $(bun -e 'console.log(require("./.raidr/06-mirror.json").pages.join(" "))'); do
  printf '%s %s\n' "$(curl -s -o /dev/null -w '%{http_code}' localhost:8787$p)" "$p"
done
```

In default (proxy) mode, `server/replay.ts` answers dynamic requests by
forwarding them live to the real backend — a non-200 there is the real
backend's own answer, not necessarily a reconstruction defect; check it
against the live site before calling it a finding. In `--replay` mode, it
answers from `.raidr/recordings.json` and returns 501 `RAIDR-GAP` for anything
never captured — a 501 there is information, not a bug to work around.

Your completion report has four parts, in this order. All four appear every
time, including when a section is empty — an omitted section reads as "nothing
to report" when it usually means "not checked":

1. **Build** — the actual output of typecheck and build, not your expectation of it.
2. **Pages served** — status code per page. Any non-200 is a finding, not a footnote.
3. **Unreachable links** — every `kind: "page"` entry from the link audit, or the words "none — every internal link resolves".
4. **Re-capture list** — the exact URLs the operator should visit to close the gaps, or "none needed".

Part 4 is what turns a broken reconstruction into a fixable one. `/league` is
not a bug in the tool; it is a page nobody visited during capture. Say so, and
say exactly what to browse next time.

## Quick Reference

| Artifact | Holds |
|---|---|
| `.raidr/report.md` | Start here: mode, routes, endpoints, gaps |
| `.raidr/02-sources/` | Recovered original files (recovery mode) |
| `.raidr/03-chunks/` | Beautified chunks (inference mode) |
| `.raidr/04-api-model.json` | Endpoints, per-status schemas, auth style |
| `.raidr/05-route-model.json` | Routes, params, visited flag, endpoints per route |
| `.raidr/recordings.json` | Real captured responses; only served by `server/replay.ts` in `--replay` mode — the default proxies live instead |
| `.raidr/06-mirror.json` | Every page and file written back byte-exact |
| `.raidr/07-link-audit.json` | Internal links that resolve to nothing — the pages the capture missed |

## Common Mistakes

| Mistake | Why it is wrong |
|---|---|
| Reading the raw zip instead of running the CLI | The artifacts are the same data, already analyzed. Re-deriving them wastes context and produces worse results. |
| Writing an endpoint absent from the API model | Endpoints come from observed traffic. One that is not in the model was never called; you are inventing an API. |
| Filling in a never-visited route with plausible content | There is no evidence for it. The `RAIDR-GAP` marker is the honest output. |
| Hand-writing `fetch` calls | The generated client is typed from real payloads. Bypassing it discards the schema work. |
| Reporting success without building | Generated code that typechecks in your head is not a deliverable. |
| Treating a redaction placeholder as a real value | `<JWT:a1b2>` marks where a credential was. The same placeholder in two places means it was the same credential — that is the auth flow, not a literal. |
| Editing generated output to make a test pass | The generators are the source of truth. Patch the generator, then re-run; hand-edits vanish on the next reconstruction. |
| Treating the route model as the full page list | It lists pages the capture reached. The link audit lists pages the site links to. Reconstructing only the first ships a homepage whose nav 404s. |
| Reporting success while `unreachablePages` is above zero | The build passing and the site working are different claims. Report the number, then the URLs to re-capture. |
| Skipping a page because its content is not in the bundle | A page you cannot build is a capture gap to report, not a page to leave out of the report. |
| Passing `--replay` because it wasn't specified | Default is live-proxy, since only the real backend gets a stateful flow (login, chat) right. Add `--replay` only when the user's prompt actually asks for a frozen, offline, or mock server. |
