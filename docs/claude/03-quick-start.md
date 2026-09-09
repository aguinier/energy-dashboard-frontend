> **Archived from `CLAUDE.md` on 2026-08-27 (ABL-536).** Historical narrative,
> incident forensics and dated measurements. `file:line` citations in this file
> are frozen as of the archive date and are **no longer checked** by
> `claudeMdCitations.test.ts`. The durable rules distilled from this material
> live in the repo-root `CLAUDE.md`; where they conflict, the root file wins.
# Quick Start

## Quick Start

```bash
npm install
npm run dev
```

Runs client and server together (`concurrently`). The server needs a local
`server/.env` with `ENERGY_DB_PATH` set — see `server/.env.example` and
**Database Connection** below; without it the server falls back to
`/data/energy_dashboard.db`, which does not exist on a workstation checkout.

- Frontend: http://localhost:5173
- API Server: http://localhost:3001

### Troubleshooting the dev server

**1. `Cannot find package '@babel/core'` is usually a stale process, not a broken tree.**

Symptom: `npm run dev` serves 200 on `localhost:5173`, but every request for `client/src/main.tsx` 500s with
`[plugin:vite:react-babel] Cannot find package '@babel/core' imported from …@vitejs/plugin-react/dist/index.js`,
and the page is blank behind Vite's red error overlay.

The tell: the resolved path in the error ends `@babel\core\index.js`, **not** `lib\index.js`.
`index.js` is the no-`main`-field fallback Node records when it reads the package directory mid-write.
A genuinely missing package reports the bare specifier instead.
Confirm with:

```bash
node -e "import('@babel/core').then(m=>console.log(Object.keys(m).length))"
```

Run from the repo root — if that succeeds while the server still throws, the tree is fine and the
server is stale.

Cause: Node's ESM loader caches resolution results for the life of the process. A dev server started
while an install was mid-flight is pinned to that failure permanently.

**Fix: restart the dev server. Do NOT run `npm install`.** This workstation runs ~20 concurrent node
processes across agent sessions; rewriting `node_modules` underneath them re-creates the race and can
turn one stale process into several.

**2. Check the server half by socket, not by process.** `tsx watch` keeps idling alive after its
child crashes, so a live PID does not mean a live server. Probe the port directly.

**3. Never inherit `PORT` from a Paperclip run.** It is `3100`, Paperclip's own control plane, and
the dashboard server dies `EADDRINUSE`. This is a launch artifact, not a repo bug — do not file it.

**4. If `node_modules/.bin` is genuinely absent**, invoke the package entry points directly rather
than reinstalling:

```bash
node node_modules/tsx/dist/cli.mjs          # server
node node_modules/vite/bin/vite.js           # client
```

This bypasses the missing shims and was the ABL-362 workaround.

**The same applies to `vitest`, and it matters more, because an unrunnable test
command reads as "the tree is broken" and invites the `npm install` note 1
forbids.** Dependencies hoist to the repo root under npm workspaces, so from
`server/` or `client/` the entry point is one level up:

```bash
cd server && node ../node_modules/vitest/vitest.mjs run
cd server && node ../node_modules/typescript/bin/tsc --noEmit
```

Measured that way on ABL-42 (branch tip `e1f849f`, `origin/main` + 2 files):
**102 server test files / 1,944 tests, all passing**, `tsc --noEmit` exit 0 —
identical to the figure `origin/main` was green at. So an empty `.bin` says
nothing about the suite.

**Both suites run normally in the primary checkout as of 2026-08-21, and the
entry-point workarounds above are now a fallback rather than the standing
procedure** (ABL-460, and again under ABL-517 after the identical damage
recurred). Between roughly 2026-08-13 and 2026-08-20 the root `node_modules`
was missing 106 of 605 packages with `node_modules/.bin` empty, and this
section recorded three of the consequences as three separate, unrelated
environment quirks. They were one defect:

| symptom recorded here | actually |
|---|---|
| `.bin` empty, `npx vitest` "is not recognized" | all 129 shims had been deleted |
| client suite "genuinely blocked" on an absent `@rolldown/pluginutils` | the package had been deleted |
| `tsx` failing `Host version "0.27.2" does not match binary version "0.28.1"` | `@esbuild/win32-x64` deleted, so esbuild found no matching binary |

Two further absences never made it into this file at all. `@babel/core` was
**genuinely** missing, so note 1's stale-process story did not apply to it — and
note 1 is the reason that went unnoticed, because it tells you to read that
exact error as a stale process. And every `@radix-ui/*` package was missing,
which is what produced the "7 pre-existing `@radix-ui/*` TS2307 errors in
`components/ui/*`" the Testing section used to tell you to expect. There are
none now: `npx tsc -b --force` exits 0.

**ABL-460 called this an incomplete *install*, and that was wrong — which is why
it recurred within a day** (ABL-517, 2026-08-21, the same shape at 107
packages). Nothing was ever half-installed: something **deleted** those packages
out of the live tree, and the proof is in the shape rather than in any log. All
107 are scoped; they run in unbroken alphabetical order from `@alloc` to
`@rollup`; and they stop dead inside `@rollup/rollup-win32-x64-msvc`, whose
*only* surviving file is `rollup.win32-x64-msvc.node`. That is a recursive
delete walking the directory in name order and aborting on the first file
Windows refuses to unlink — a native addon some live process has memory-mapped.
An install failure has no reason to be alphabetical and no reason to stop there.

**What ran it: `git worktree remove --force` on a scratch worktree whose
`node_modules` was a junction to the shared tree.** Reproduced in an isolated
scratch repo rather than inferred — junction a worktree's `node_modules` at a
directory holding `@aaa @bbb @ccc zzz-survivor`, run `git worktree remove
--force`, and that directory is left present and empty. Git does not treat an
NTFS junction as a link to step over; it walks through and deletes the target's
contents. On 2026-08-21 that call is timestamped `11:45:58Z`, the primary tree's
`@rollup` directory carries an `11:45` mtime, and both suites are recorded green
*through the same junction* fifteen seconds earlier — which is also what clears
the `Remove-Item -Recurse` in the same run of suspicion.

So the rule, and it costs nothing:

**Drop the junction before removing the worktree, and never aim a
`git worktree remove`, `rm -rf` or `Remove-Item -Recurse` at a path that still
contains one.**

```powershell
cmd /c rmdir "<worktree>\node_modules"     # drops the reparse point only
git worktree remove --force "<worktree>"   # now safe
```

`cmd /c rmdir` is the only removal in that pair guaranteed not to follow the
junction.

**And do not confirm the shared tree afterwards by probing an unscoped
package.** The 2026-08-21 run checked `node_modules\vitest`, got `True`, and
reported "shared node_modules intact" — thirty-five minutes before the client
suite failed to boot. `vitest` sorts after every `@` scope, so the aborted walk
had not reached it. Run the completeness check below instead; it cannot be
fooled by ordering.

**The blast radius is what makes this more than an inconvenience.** Measured
2026-08-21, **17 of the 28 worktrees under `C:\Code\able` reach the primary
`node_modules` through a junction**, so one delete-through-junction takes out
seventeen checkouts at once and leaves each reporting a *different*
plausible-looking environment fault. Giving every worktree its own tree would
end that, at ~302 MB and one install each (~5 GB for the seventeen); the
ordering rule above costs nothing and removes the same failure, so it is the
answer unless those installs become desirable for another reason.

The repair was **purely additive and changed no source file** — a clean `npm ci`
into a scratch directory, then a copy of only the absent packages into the live
tree, each placed by same-volume rename so it is observed either wholly present
or wholly absent. All 498 packages already on disk were verified version-
identical to `package-lock.json` first, and the one partially-written package
(`@rollup/rollup-win32-x64-msvc`, holding its `.node` binary with no
`package.json`) was completed by adding the two missing files after confirming
the binary was byte-identical. **Not one existing file was overwritten.** That
is what makes it safe against note 1's hazard, which is specifically about
`npm install` *rewriting* modules under ~40 live agent processes: a running
process cannot have an already-resolved module change underneath it if no
existing file changes.

**The `npm ci` into scratch is the fallback, not the first move — a
verified-complete sibling worktree is a cheaper donor and needs no network.**
ABL-517 repaired all 107 that way in under a minute: survey every
`C:\Code\able\*/node_modules` against the damaged tree's own
`package-lock.json`, take one reporting `missing=0` **and**
`versionMismatch=0` (2026-08-21: `ABL-300-v1-api-key-auth`, `ABL-351-…`,
`ed-wt-abl412`, `ed-wt-ceo`), and copy from it under exactly the rules above.
Check both counts, not just the first: a tree can hold every package at a
version the lockfile does not ask for. Two details that repair needs and a
naive copy gets wrong — walk the missing list **shallowest path first**, or a
package nested inside another arrives before its parent (12 of the 107 turned
out to be carried in by a parent and had to be re-checked and skipped); and
merge, never rename over, any directory that already partially exists, which
is how `@rollup/rollup-win32-x64-msvc` keeps the mapped `.node` no process
will release (verified byte-identical to the donor's before the two missing
files were added beside it). The 129 `.bin` shims copy across safely too —
they are generated with relative paths only (`%dp0%\..\vitest\vitest.mjs`),
with zero absolute paths across all 129.

So an empty `.bin` still says nothing about the suite, and a missing package
still names its **bare specifier** where the stale-process trap resolves to a
path ending `@babel\core\index.js` (note 1's tell). But do not read a bare
specifier as "unfixable in this checkout" any more. Check whether the tree is
actually complete before reporting a suite as blocked:

```bash
node -e "const l=require('./package-lock.json'),f=require('fs');let m=0;
for(const[p,v]of Object.entries(l.packages)){if(!p.includes('node_modules/')||v.link||!v.version)continue;
if(v.os&&!v.os.includes('win32'))continue;if(v.cpu&&!v.cpu.includes('x64'))continue;
if(!f.existsSync(p+'/package.json'))m++}console.log('missing packages:',m)"
```

That prints `0` on a healthy tree, needs no install to run, and is the check
that would have caught this on day one. A non-zero count calls for the additive
repair above — it is still not a licence to run `npm install` in place.

**What is safe to run while other processes hold this checkout**, since "do not
install" was read as "do not touch it" and left Ops with no move at all:
`npm install --dry-run` (reports the plan, writes nothing to `node_modules`),
`npm ls`, and the completeness check above. What is not: `npm install`, `npm ci`
and `npm rebuild`, all of which rewrite modules in place, plus
`npm approve-scripts`, which also dirties `package.json`. Run `npm ci` only
into a scratch directory **outside** the checkout, as the repair above does, and
with `--ignore-scripts` — `better-sqlite3`'s install script is a `node-gyp
rebuild` that re-points the native ABI for every worktree at once, which is the
trap under "NODE_MODULE_VERSION mismatch" below reached by a different route.

**`node_modules/.package-lock.json` is absent after this repair, and that is
cosmetic rather than a hazard.** npm writes that hidden lockfile from its own
reify step, so copying directories in does not produce one. The worry it invites
— that a tree npm does not consider installed gets partially rewritten by the
next command to touch it — does not occur, because npm falls back to reading the
real tree from disk: verified 2026-08-20, `npm install --dry-run` reports
`up to date` with the file absent. The next legitimate install writes it. Do not
hand-author one.

## The junction delete, measured — and the control (ABL-640, 2026-09-03)

The rule above ("drop the junction first") was written in two places and lost
**four** times: ABL-460, ABL-517, ABL-636 and one prior, each 107 packages,
each a fleet-wide outage across the 17 junctioned worktrees. Documentation was
never going to be the control. What follows is what was measured instead.

**Only `git worktree remove --force` walks a junction.** Same harness for each
row: a throwaway git repo, a real linked worktree, `node_modules` junctioned to
a throwaway target holding 4 files, delete aimed at the worktree.

| deleter | target after | link removed |
|---|---|---|
| `git worktree remove --force` | **4 -> 0 (destroyed)** | yes |
| `Remove-Item -Recurse -Force` (PS 5.1) | 4 -> 4 intact | yes |
| `fs.rmSync(recursive:true)` (Node 24) | 4 -> 4 intact | yes |
| `rm -rf` (Git Bash) | 4 -> 4 intact | yes |
| `rmdir /s /q` (cmd) | 4 -> 4 intact | yes |

So CLAUDE.md's former "(or any recursive delete)" was wrong, and wrong in the
expensive direction: it spread suspicion over four innocent commands and left
the guilty one looking like one of a crowd. The destructive call is a single
command, and **it reports nothing** — git prints no output and exits 0 while
emptying the target. Plain `git worktree remove` without `--force` refuses
first ("contains modified or untracked files"), because the junction is itself
an untracked entry; `--force` is what converts that refusal into the delete.

**Three junctions per worktree, not one** — `node_modules`,
`client/node_modules`, `server/node_modules`. The old one-line `rmdir` recipe
dropped one of three.

**Option (1) from the issue — a directory symlink instead of a junction — is
not available on this workstation.** Both `mklink /D` and
`New-Item -ItemType SymbolicLink` fail with *"Administrator privilege required"*:
agent processes are unelevated and Developer Mode
(`AllowDevelopmentWithoutDevLicense`) is not set. Creating a *junction* needs no
privilege, which is exactly why every worktree uses one. Whether git would step
over a symlink was never reached — the link cannot be created at all. Enabling
Developer Mode machine-wide would be the prerequisite, and that is a Board call,
not a repo change.

**The control that was shipped: a deny-DELETE ACE on the shared tree.**
`icacls <tree> /deny "<user>:(OI)(CI)(DE,DC)"`. Under it, `git worktree remove
--force` fails its first unlink and **aborts the whole removal**, so the tree is
left byte-for-byte intact rather than partially eaten — which also means the
guard does not need to be placed cleverly, only present. Both rights are
needed: Windows permits a delete when the object grants `DELETE` *or* its parent
grants `FILE_DELETE_CHILD`. `(OI)(CI)` makes the ACE inheritable, so packages
added later by an additive repair are covered without re-running it.

Measured side effects, all of which must hold for the guard to be affordable:

| operation | under the guard |
|---|---|
| read a package (Node resolution) | works |
| add a new file (additive donor repair) | works |
| overwrite an existing file | works |
| delete a file inside the tree | **refused** |
| `client`/`server` suites, `tsc -b --force` | unchanged and green |

Placement matters for one reason only: vitest keeps its dep-optimizer cache in
`server/node_modules/.vite` and must stay free to evict it, so the guard sits on
`server/node_modules/better-sqlite3` (the unhoisted native module) rather than on
that directory. `client/node_modules` is unguarded because it holds no package
the lockfile requires — it is empty. The root `node_modules` is guarded whole.

**What the guard costs:** a raw `git worktree remove --force` against a
junctioned worktree now fails and leaves the worktree directory behind. That is
the intended trade — a leftover directory is cheap, visible and recoverable
(`npm run worktree:remove -- <path>` still removes it cleanly with the guard on);
a destroyed shared tree is expensive, silent, and has cost four outages.

Re-verify after a git upgrade with `npm run repro:junction-delete`: the control
rests on a measured behaviour of git's recursive removal, not on a documented
guarantee, so it can regress under us without warning.
