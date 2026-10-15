# Shelley: a coding agent for exe.dev

[shelley.dev](https://shelley.dev/)

> **This is `sdsmith/shelley`, a private fork.** Everything below the fork
> notes is upstream's README, kept for reference. Nothing here is upstreamed;
> all customizations live on this fork's `custom` branch. See
> [This fork](#this-fork) below for the layout, the update workflow, and the
> rebase resolution log.

Shelley is a mobile-friendly, web-based, multi-conversation, multi-modal,
multi-model, single-user coding agent built for but not exclusive to
[exe.dev](https://exe.dev/). It does not come with authorization or sandboxing:
bring your own.

*Mobile-friendly* because ideas can come any time.

*Web-based*, because terminal-based scroll back is punishment for shoplifting in some countries.

*Multi-modal* because screenshots, charts, and graphs are necessary, not to mention delightful.

*Multi-model* to benefit from all the innovation going on.

*Single-user* because it makes sense to bring the agent to the compute.

# Installation

## Pre-Built Binaries (macOS/Linux)

```bash
curl -Lo shelley "https://github.com/boldsoftware/shelley/releases/latest/download/shelley_$(uname -s | tr '[:upper:]' '[:lower:]')_$(uname -m | sed 's/x86_64/amd64/;s/aarch64/arm64/')" && chmod +x shelley
```

The binaries are on the [releases page](https://github.com/boldsoftware/shelley/releases/latest).

## Homebrew (macOS)

```bash
brew install --cask boldsoftware/tap/shelley
```

## Build from Source

You'll need Go and Node.

```bash
git clone https://github.com/boldsoftware/shelley.git
cd shelley
make
```

# Releases

New releases are automatically created on every commit to `main`. Versions
follow the pattern `v0.N.9OCTAL` where N is the total commit count and 9OCTAL is the commit SHA encoded as octal (prefixed with 9).

# Architecture 

The technical stack is Go for the backend, SQLite for storage, and Typescript
with Vue 3 + PrimeVue for the UI. 

The data model is that Conversations have Messages, which might be from the
user, the model, the tools, or the harness. All of that is stored in the
database, and we use a SSE endpoint to keep the UI updated. 

# History

Shelley is partially based on our previous coding agent effort, [Sketch](https://github.com/boldsoftware/sketch). 

Unsurprisingly, much of Shelley is written by Shelley, Sketch, Claude Code, and Codex. 

# Shelley's Name

Shelley is so named because the main tool it uses is the shell, and I like
putting "-ey" at the end of words. It is also named after Percy Bysshe Shelley,
with an appropriately ironic nod at
"[Ozymandias](https://www.poetryfoundation.org/poems/46565/ozymandias)."
Shelley is a computer program, and, it's an it.

# Open source

Shelley is Apache licensed. We require a CLA for contributions.

# Building Shelley

Run `make`. Run `make serve` to start Shelley locally.

## Dev Tricks

If you want to see how mobile looks, and you're on your home
network where you've got mDNS working fine, you can
run 

```
socat TCP-LISTEN:9001,fork TCP:localhost:9000
```


## This fork

**`sdsmith/shelley`** is a private fork of [boldsoftware/shelley](https://github.com/boldsoftware/shelley).
Nothing is upstreamed from here; all customizations live on this fork's
`custom` branch.

### Layout

- `main` mirrors upstream `main` — keep it synced:
  `gh repo sync sdsmith/shelley -b main`.
- `custom` is the deployed branch: the custom series adopted from
  [RedBeard0531/shelley](https://github.com/RedBeard0531/shelley)'s `custom`
  (replayed commit-by-commit on top of `upstream/main`) plus this fork's own
  commits.
- The canonical checkout is `~/.config/shelley/shelley-customization`
  (the path `make build-custom` and the version dialog's rebase-upgrade flow
  assume). Remotes: `origin` = this fork, `upstream` = boldsoftware/shelley,
  `redbeard` = the donor fork (kept for cherry-picking their future work:
  `git fetch redbeard && git log custom..redbeard/custom`).
- The deployed binary is `/usr/local/bin/shelley` (systemd user unit
  `~/.config/systemd/user/shelley.service`); once installed from a
  `make build-custom` build, `shelley version` reports `customized: true` and
  this checkout is the source of truth for what is deployed.

### Updating

1. `git fetch upstream --tags`
2. On `custom`: `git rebase upstream/main` — resolve conflicts keeping the
   donor customizations working on the new mainline (rules below). Prefer a
   subagent per conflict to explore both sides and propose the merge.
3. **Run the tests at each resolved stage — compiling is not enough.**
   From `ui/`: `node scripts/lint-css.mjs`;
   `npx --yes $(node -p "require('./package.json').packageManager") run
   type-check type-check:vue lint`. For Go changes:
   `go test ./claudetool` / `./server` / whatever the commit touched; run the
   full suite after the rebase (`claudetool/browse`'s TestScreencastStartStop
   fails on this VM even on pristine upstream — environmental).
   `go test ./server` fails fast with "UI build is stale!" whenever replayed
   commits touched `ui/src` after the last build — run `make ui` first. Clean
   commits replay silently between conflict stops, so never assume the
   lint-css baseline is current: if the linter reports different counts, take
   its report.
4. `git push --force-with-lease origin custom`, then `gh repo sync
   sdsmith/shelley -b main`.
5. `make build-custom`, install per the `customizing-shelley` skill
   (side-by-side copy to `/usr/local/bin/shelley`), restart via
   `POST $SHELLEY_URL/exit?resume=true` (systemd restarts and resumes
   in-flight conversations).

### Resolution rules (from the 2026-10 rebase onto the Oct 14 mainline)

- **Port, don't resurrect**: when upstream moved code, port the feature to
  the new structure (e.g. the "All off" button went into `ToolSettings.vue`,
  the shortcut fix kept upstream's import layout, `lastLines` survived while
  the tool-context wrappers upstream had moved to `llm` were dropped) rather
  than restoring dead plumbing.
- **Patch tool**: the donor `patch-simple` flag is an *override* on top of
  upstream's per-model auto-selection — flag on forces the simplified
  single-modification schema, off = auto-selection (`glm*` → simple, else the
  one-operation schema). The donor's flattened one-modification-per-call
  `patch.go` stays; the non-simple profile is labeled `nested` in code (what
  `llm.PatchProfile` returns; `patch.go` only compares `simple`).
- **lint-css baselines** are always set to the linter's own report against
  the merged `styles.css` — never either side's numbers.
- **`font-size: inherit` grandfather**: the donor's lint tightening (removing
  `inherit` from `legacyFontSizes`) was rolled back because upstream's
  `styles.css` still has 3 `font-size: inherit` usages. **Deferred revisit:**
  to enable the tightening, convert those 3 lines to the type scale as its own
  commit and give the diff viewer a visual pass.
- **Removed models**: when a models.dev snapshot drops a model (glm-5p2,
  kimi-k2p6), every surviving reference goes with it — upstream test cases
  included (the GLM 5.2 patch-strategy case was deleted; the GLM 5.3 case
  already covered its intent).
- **Tests pin policies**: tests that pin upstream's policy lists (the
  feature-flags removed/unknown list, the max-1 subagent policy) must learn
  this fork's live flags (`patch-simple`) and policies.
- **Big frames**: this fork's system prompt embeds the skills list and tool
  schemas, so SSE replay frames can exceed one TCP segment — tests must read
  to completion, not assume one `Read` (see the `TestSSEIncrementalUpdates`
  fix).

### Fork-only commits

- `server: count subagent depth along the parent chain` +
  `custom: allow one level of subagent nesting` — subagents may spawn one
  level of subagents (e.g. an `/execute-tasks` task agent fanning out to
  `/mongo-code-review` specialists), no deeper. `MaxSubagentDepth` gates the
  tool by hops walked up the parent chain.
- `test: read client2's SSE replay to completion` — the fork-only test
  robustness fix above.
