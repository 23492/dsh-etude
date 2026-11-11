# dsh-etude: design and plan

Status: decided 2026-11-11. Values that differ per instance (AUD tags, emails, hostnames) live in the cordis config of each profile, never in this repo.

## Findings (verified)

- **Which human drives a turn.** DSH has no per-turn user identity. A Peer's principal is only `{ kind: 'owner' }` (`dsh-typert-protocol` `PrincipalMap`), and agent turns, schedules and subagents carry no request. The only place the human shows up is the Cloudflare Access JWT on browser requests: every `/api` request passes the `connection/request` waterfall (`dsh-client-connection`, `webCtx.waterfall('connection/request', req, res, next)`) with the raw `IncomingMessage`, so its `cf-access-jwt-assertion` header is readable there. Consequence: a DSH instance belongs to one person, and the plugin learns who that is from verified JWTs, not from the turn.
- **Linked App Token works for this Worker.** Verified live on 2026-11-11: a DSH Access JWT sent as `Cf-Access-Token` to the Etude hostname gets through Access, and `/v1/auth/access` answers with the user's email. So the Etude-scoped JWT that Access mints carries `email`, and the Worker's identity binding needs no change. The policy on the Etude app is a reusable policy with decision `non_identity` and include `linked_app_token` (the DSH app's uid).
- **JWT lifetime.** The DSH Access session in the first deployment is 24 h. The JWT's `exp` follows the Access login, not the last request. The browser GUI refreshes it on every `/api` request, but a long or scheduled agent run can outlive it. The plugin then keeps working on the local collection and reports that sync waits for the user to open DSH.
- **Other AUDs on the same hostname.** Paths of the DSH hostname can sit behind a separate Access app with its own AUD. Their JWTs fail the AUD check and are ignored.
- **Instances behind a gatekeeper.** A gatekeeper proxy in front of some instances deletes every `cf-access-*` header before DSH, so those instances never see a JWT today. That is a prerequisite outside this repo (see README). Once the gatekeeper passes the verified header through, such an instance needs only config. Instances that share one Access app need one Linked App rule (that app's uid) on the Etude app between them.
- **Etude runtime.** `@zibhelina/etude` is not on npm. GitHub serves a source tarball per tag (`v3.1.2`, sha256 pinned). The CLI needs Node 24 (`node:sqlite`, TypeScript stripping) and, for everything the CLI uses, only four npm packages plus their deps: `marked`, `ts-fsrs`, `hash-wasm`, `quickjs-emscripten` (10 tarballs, 13 MB). DSH itself runs on Node 22. A full `npm install --omit=dev` of Etude was killed by the RAM guard at 212 MiB while the container had 236 MiB free; the minimal set avoids npm entirely.
- **Etude CLI facts used.** `etude commands` is a machine-readable catalog (250 commands) with `writes`, `confirm` and `dryRun` per command. `src/cli/run.ts` exports `run(argv, io)` and `parseInvocation(argv)`. Sync setup needs HTTPS except on localhost. The CLI sends no telemetry. Destructive commands refuse to run without `--yes`.

## Decisions

### Auth: Linked App Token, no fallback

The Worker refuses every `/v1` call whose Access email differs from the device's account (`identity_mismatch`), so each sync request must carry the user's own Access identity. Linked App Token gives exactly that with no change to the Worker's trust model. A service token per instance would need the Worker to trust a token-to-email map, and is not tied to the human. An admin magic link only replaces the first sign-in; the per-request identity check would still fail, so it is no fallback.

Flow:

1. `connection/request` listener: read `cf-access-jwt-assertion`, verify RS256 against the team certs, `iss`, `exp`, and `aud` = the DSH app's AUD (code from `dsh-mcp/lib/access.js`). Keep the newest valid JWT per email in memory only. The JWT is a bearer credential for DSH itself, so it is never written to disk or logged.
2. A tool call resolves the owner (below), takes that owner's JWT and starts the Etude runner with the JWT on a private pipe (fd 3), not in argv or env.
3. The runner wraps `fetch`: requests to the configured Etude origin get `Cf-Access-Token: <jwt>`; requests to any other origin never do. Access swaps the token for an Etude-scoped `Cf-Access-Jwt-Assertion` with the same email.
4. First use for an email: `sync setup --server <etudeUrl>`, `GET /v1/auth/access` for a one-time `lnk_` token, `sync verify <lnk>`, `sync unlock` (server keeps the key), `sync now`. Afterwards the device token stays in that collection's home (`sync/<device>.json`, 0600, written by Etude).

### Identity and isolation

- Config `allowedEmails` (required). A JWT whose email is not in it is ignored.
- The owner of a tool call is the single allowed email with a live JWT. When live JWTs for two different emails exist, the tool refuses: DSH cannot tell which of them is driving the turn. With no live JWT, the owner is the one email that already has a linked collection; with none, the tool asks the user to open DSH in the browser.
- Each email gets its own Etude home: `<dataDir>/users/<sha256(lowercase email)>/`. The runner always gets `ETUDE_HOME` set by the plugin; the agent cannot pass `--db`, and any path argument that resolves inside `<dataDir>` is refused, so one person's agent cannot point the CLI at another person's collection or device token.
- The Worker is the second wall: a device token only works with a matching Access email, and Access only mints a JWT for the person who logged in.

### Tool surface: one generic `etude` tool

One tool, `etude`, taking `args` (argv after `etude`) and optional `stdin`. The Etude catalog is self-describing (`etude commands`, `etude <group> --help`) and has 250 commands; a curated set would lag behind each Etude release. The tool description carries the mental model and the common recipes from Etude's own `skill/SKILL.md`.

Policy, checked in the plugin against the cached catalog and again in the runner with `parseInvocation`:

- **Denied:** `--db`; `sync` verbs other than `status` and `now` (the plugin owns the connection); `account` verbs other than `status` and `devices`; `serve`, `update`, `db restore`, `settings key`, `settings chatgpt`, `market publish`, `market index`, `agent ask` (needs an AI key the plugin does not manage).
- **Irreversible commands:** refused, with no approval path (owner's decision, 2026-11-11). That is every command the catalog marks `confirm` plus `card reset`; the refusal names the archive equivalent.
- **AI grading:** config flag `aiGrading`, default off. Off: `settings test-ai` refused and the runner answers `/v1/ai/` itself with 403; the agent grades in chat with `study rate`. On (owner's decision, 2026-11-11, revising the earlier "off"): the runner sets `ai.decision={kind:llm}` and `ai.feedback` to the Etude server's proxy with a placeholder key, once per collection; `study answer` grades with AI. In both modes `ai.*`, `settings key` and `settings chatgpt` stay refused, so grading can only go through the owner's server.
- **Skill:** Etude's own `skill/` from the pinned tarball is served through `ctx.skills.registerProvider` as skill `etude`, upstream text untouched, with the DSH preface `skill/dsh.md` prepended at load time.
- **Sync:** before a command, `sync now` when the last sync is older than `syncMaxAgeSeconds` (default 60); after a command the catalog marks `writes`, `sync now` again. All inside one runner process, so a call costs one Node start.
- **Working directory:** the runner runs in the agent's session cwd, so `--fields-file notes.json` and `pack import deck.md` resolve like in bash.

### Runtime: pinned downloads, installed by the plugin

- Pinned in `lib/manifest.js`: Etude tag `v3.1.2` (same as `etude.ref` in etude-cloudflare) with the tarball sha256, Node `v24.22.2` per arch with sha256 from nodejs.org `SHASUMS256.txt`, and the 10 npm tarballs with their sha512 integrity from Etude's `package-lock.json`.
- On start, the plugin checks `<dataDir>/runtime/<etude-version>/.ready`. When missing it downloads in the background, streaming to disk with hash checks, extracts only `bin src runtime types schedulers examples skill package.json LICENSE`, and caches `etude commands`. Peak memory is a few tens of MiB; no npm, no build.
- Config `nodePath` and `etudeRoot` override the downloads (development, or a host that already has Node 24).
- Bumping Etude means changing the manifest in the same change as `etude.ref`; `scripts/manifest-from-tag.mjs` regenerates the hashes.

### Config per instance

```yaml
- id: etude
  name: dsh-etude
  config:
    etudeUrl: https://etude.example.com
    accessTeamDomain: <team>.cloudflareaccess.com
    accessAudiences: [<AUD of this DSH's Access app>]
    allowedEmails: [<owner email>]
    # optional: dataDir (default /data/.dsh/dsh-etude), nodePath, etudeRoot,
    # timeoutMs (120000), syncMaxAgeSeconds (60)
```

## Work plan

1. `lib/access.js` (verifier), `lib/identity.js` (JWT store, owner resolution), `lib/policy.js` (argv rules), `lib/runtime.js` + `lib/manifest.js` (install), `runner/runner.mjs` (Node 24 side: fetch hook, link flow, sync, run), `index.js` (cordis plugin: listener, tool, pre-execute).
2. Tests (`node --test`):
   - access: forged signature, wrong aud, wrong iss, expired, no email are all rejected.
   - identity: disallowed email ignored, two live emails refuse, owner fallback to the linked collection.
   - policy: `--db`, `sync setup`, paths into `dataDir` denied; irreversible commands and `ai.*` settings refused.
   - end to end (needs the Node 24 runtime): the real `etude-cloudflare/sync-worker/src/worker.js` on a D1 shim over `node:sqlite`, behind a fake Access edge that implements Linked App Token (accepts `Cf-Access-Token` signed for the DSH AUD, mints an Etude-AUD JWT with the same email). Alice's agent adds a card, a second Etude device of Alice sees it after sync; Bob's agent sees none of Alice's cards; a JWT for Bob cannot drive Alice's collection.
3. README: install (package.json link, cordis row), Cloudflare setup, gatekeeper prerequisite, uninstall and rollback.
4. Install on the first profile; verify with a real round trip (agent adds a card, it shows in the browser).

## Owner decisions (2026-11-11)

- Deleting: archive only. Irreversible commands are refused outright.
- AI grading on the agent's device: first off, then on through the Etude server (`aiGrading: true`).

## First live install, 2026-11-11

Installed on the first DSH profile (symlinked local plugin, `package.json` link, one cordis row; backups `*.bak-pre-dsh-etude-*`). dsh-hmr composed the new row live; no DSH restart was needed. Checks from a real agent turn:

- The first call linked the collection to the owner's Etude account with no code or token: `connection/request` delivers the Access JWT and Linked App Token works end to end.
- `deck list` returned the owner's real collection (827 cards).
- `item add` created a card in a new deck; after a sync in the browser it showed in the Etude web app (828 cards).
- `deck delete` was refused with the archive hint; `deck archive` worked.
- The skill `etude` appears in the session's skill catalog.

Not yet done: the end-to-end suite against the runtime the plugin downloaded (it ran green against a development copy of the same Etude tag), and instances behind a gatekeeper (blocked until it passes `Cf-Access-Jwt-Assertion`).
