# dsh-etude

A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) plugin that gives the agent one tool, `etude`, for the user's own [Etude](https://github.com/Zibhelina/etude) collection: decks, items, cards, study, stats, tags, presets, card types and packs. The agent can turn notes into cards, quiz the user in chat and find weak spots. Changes sync to the user's Etude account, so they show up in the Etude app in the browser and on the phone.

The plugin connects to the right Etude account by itself, from the user's Cloudflare Access identity. Nobody types a code or a token.

Design and the reasons behind it: [PLAN.md](PLAN.md).

## How it works

- Every browser request to DSH carries the user's Cloudflare Access JWT. The plugin checks it (signature, issuer, audience, expiry, `allowedEmails`) and keeps the newest one in memory. It is never written to disk.
- A tool call runs the Etude CLI (pinned version, under its own Node 24) in a child process for the one allowed person whose JWT is live. Each person has a separate Etude home under `<dataDir>/users/<sha256(email)>/`.
- Requests to the Etude server carry that JWT as `Cf-Access-Token`. A Linked App Token policy on the Etude Access app makes Access accept it and pass an Etude-scoped JWT with the same email to the Etude Worker. The Worker signs the collection in on first use and binds its device token to that email.
- Sync runs before a command (when the last sync is older than `syncMaxAgeSeconds`) and after every command that writes.
- When no fresh JWT is around (for example a scheduled run 24 hours after the last login), the command runs on the local collection and the result says that sync waits until the user opens DSH in the browser.

## Safety

- Isolation: the email comes only from a verified JWT, never from the agent. If live JWTs for two different allowed emails exist, the tool refuses. `--db` and every path into `<dataDir>` are refused, also through symlinks. On the server, a device token works only together with an Access identity for the same email.
- Nothing irreversible: every command Etude marks destructive (it needs `--yes`: deletes, prunes, type and scheduler resets) and `card reset` are refused, with no approval path. The refusal names the archive equivalent (`deck archive`, `item archive`, `note archive`, `card suspend`). Deleting is done by the user in the Etude app.
- AI grading is off by default. With `aiGrading: true` in the plugin config, the plugin points the collection's grader at the Etude server's AI proxy (`/v1/ai/chat/completions`): the provider key stays a Worker secret, the forwarded Access identity authorizes each call, and the Worker fixes model and effort. `study answer` then grades open answers with AI and `settings test-ai` works. Either way `settings set|unset ai.*`, `settings key` and `settings chatgpt` are refused, so the agent cannot point grading at another provider. When off, the runner answers any request to `/v1/ai/` itself with 403, so grading settings that sync in from the browser cannot use it; the agent grades in the chat and records the result with `study rate`.
- Not available to the agent: sign-in and Sync setup (the plugin owns them), `account` changes, `serve`, `update`, `market publish` and `market index`, and `agent ask`.
- The runner gets a minimal environment (no DSH secrets), a 256 MB heap cap and a timeout.

## The Etude skill

The plugin serves Etude's own agent skill as the DSH skill `etude`, so the agent loads it when the user talks about flashcards, studying or being quizzed. It comes from the same pinned, hash-checked Etude tarball as the CLI (`skill/SKILL.md` and `skill/references/`, plus `docs/` without screenshots for the pages the skill links to), and its text stays exactly as released. A short DSH preface ([skill/dsh.md](skill/dsh.md)) goes in front when the skill loads: use the `etude` tool with an argv array, no `--db`, sign-in and Sync belong to the plugin, nothing irreversible, and the AI grading rule that matches the config. An Etude bump therefore replaces the skill without any merge. On a profile without a skill registry the tool still works.

## Requirements

- DSH with the `connection/request` waterfall (`@deepseek-ai/dsh-client-connection` 0.2.x). Node 22.5 or newer for the plugin itself.
- DSH reachable only through Cloudflare Access, with the `Cf-Access-Jwt-Assertion` header reaching DSH unchanged.
- An Etude Sync server that verifies Access JWTs, such as [etude-cloudflare](https://github.com/23492/etude-cloudflare), behind its own Access app.
- About 230 MB of disk for the runtime and outbound HTTPS to `nodejs.org`, `codeload.github.com` and `registry.npmjs.org` on first start.

**Prerequisite for instances behind a gatekeeper.** A reverse proxy in front of DSH that strips `cf-access-*` headers (some gatekeepers do) leaves the plugin without an identity: the tool then answers "No Cloudflare Access identity is known yet". The proxy has to pass the `Cf-Access-Jwt-Assertion` it verified through to DSH. Other `cf-access-*` headers can stay stripped.

## Install on a DSH profile

1. Put the repo where the profile can link it, for example `<profile>/local-plugins/dsh-etude`, and link it in `<profile>/package.json`:

   ```json
   "dsh-etude": "link:local-plugins/dsh-etude"
   ```

   The plugin has no npm dependencies.

2. Add a row to `<profile>/cordis.patch.yml`:

   ```yaml
   - insert:
       - id: etude
         name: dsh-etude
         config:
           etudeUrl: https://etude.example.com
           accessTeamDomain: <team>.cloudflareaccess.com
           # AUD tag of the Access app in front of THIS DSH. Requests under other Access apps
           # on the same hostname carry another AUD and are ignored.
           accessAudiences:
             - <aud>
           # The owner of this DSH instance. One person per instance.
           allowedEmails:
             - <owner email>
           # Optional:
           # dataDir: /data/.dsh/dsh-etude      # collections and the runtime
           # timeoutMs: 120000                  # per call, sync included
           # syncMaxAgeSeconds: 60              # pull first when the last sync is older
           # nodePath: /path/to/node24          # skip the Node download
           # etudeRoot: /path/to/etude          # skip the Etude download (needs its CLI deps)
   ```

3. Restart DSH. On first start the plugin downloads Node 24.22.2, Etude 3.1.2 and its four CLI packages, checks every hash and writes `<dataDir>/runtime/etude-3.1.2/.ready-2`. The log says `dsh-etude: Etude 3.1.2 ready (250 commands)`.

4. Open DSH in the browser once (that delivers the JWT), then ask the agent something like "which Etude decks do I have?". The first call links the collection; the result notes "Linked this collection to the Etude account …".

## Cloudflare setup

On the Etude Access app, add a policy that accepts tokens from the DSH Access app:

- Dashboard: Zero Trust, Access controls, Applications, the Etude app, Policies. Create a policy with Action **Service Auth**, Include, Selector **Linked App Token**, Value: the DSH app. Attach it next to the existing Allow policy.
- API: create a reusable policy and attach its id to the Etude app.

  ```sh
  curl "https://api.cloudflare.com/client/v4/accounts/$ACCOUNT_ID/access/policies" \
    -H "Authorization: Bearer $CF_TOKEN" --json '{
      "name": "Etude: linked from <DSH app>",
      "decision": "non_identity",
      "include": [{ "linked_app_token": { "app_uid": "<uid of the DSH Access app>" } }]
    }'
  ```

Each DSH Access app that should reach Etude needs one such rule. Instances that share one Access app (one entrance routing to several instances) need one rule between them.

A Service Auth rule does not look at the Etude app's Allow policy: a valid token from the linked DSH app gets through for whoever it names, and the Worker creates an Etude account for that email on first use. So everyone the DSH Access app lets in can reach Etude through the plugin; keep `allowedEmails` to the instance owner. Blocking a person in the Worker (`/admin/block`) stops the plugin too.

Background: [Linked App Token](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/linked-app-token/).

## Uninstall and rollback

1. Remove the `etude` row from `cordis.patch.yml` and the `dsh-etude` line from `package.json`, then restart DSH. The tool disappears; nothing else in DSH depends on it.
2. Optional: remove the Linked App Token policy from the Etude Access app.
3. Optional: sign the plugin's device out of the Etude account (Etude app, Settings, Account, Devices: the device is called "Etude desktop"), and delete `<dataDir>` (`/data/.dsh/dsh-etude` by default). The cards stay in the Etude account; the local copy is only a synced device.

To go back to an older plugin version, check out that commit; the runtime of each Etude version lives in its own directory, so versions do not overwrite each other.

## Upgrading Etude

Bump the pin together with `etude.ref` of the Sync server, so the client is the version the server was tested against:

```sh
node scripts/manifest-from-tag.mjs v3.1.3 v24.22.2   # rewrites lib/manifest.js with fresh hashes
```

Check that the CLI still imports only the packages listed in `scripts/manifest-from-tag.mjs` (`ROOTS`).

## Tests

```sh
npm test                                   # unit and skill tests (access, identity, policy, skill)
ETUDE_TEST_NODE=/path/to/node24 ETUDE_TEST_ROOT=/path/to/etude npm test   # plus end to end
```

The end-to-end tests run etude-cloudflare's real `worker.js` (expected at `../etude-cloudflare`) on a D1 stand-in over `node:sqlite`, behind a fake Access edge that implements Linked App Token. They cover the first link and a card reaching a second device of the same person, a second person's separate account, a device token refused under another identity or without one, the refusal with two people on one DSH, a refused delete that changes nothing next to a working archive, AI grading staying off, pack import from the workspace, and the local-only path without a fresh identity. `test/skill.test.mjs` checks that the skill provider is registered and that the pinned version equals `../etude-cloudflare/etude.ref`. A runtime installed by the plugin works as `ETUDE_TEST_NODE=<dataDir>/runtime/node-v24.22.2/bin/node ETUDE_TEST_ROOT=<dataDir>/runtime/etude-3.1.2`.

## License

MIT for this plugin. Etude itself is AGPL-3.0; the plugin downloads it unmodified from its GitHub release tag.
