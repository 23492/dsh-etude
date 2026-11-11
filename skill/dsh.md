# Etude in DSH (read this first)

This is Etude's own agent skill, unchanged from Etude {{ETUDE_VERSION}}. In DSH a few things differ from what it says below, and these rules win:

- **Use the `etude` tool, not a shell.** Every `etude <group> <verb> ...` in this skill becomes one `etude` tool call with the words after `etude` as the `args` array: `etude item add --deck Spanish --front "el perro" --back "the dog"` is `{"args": ["item","add","--deck","Spanish","--front","el perro","--back","the dog"]}`. Text for an argument given as `-` goes in `stdin`. Do not run the Etude CLI through bash; there is none on the path.
- **The collection is the user's own, synced to their Etude account.** It is the same collection they study in the Etude app in the browser and on the phone. The tool picks it from the user's Cloudflare Access identity, syncs before a command and pushes after a change. Never pass `--db` or `ETUDE_HOME`, and ignore the advice about scratch homes and choosing between collections: the tool refuses `--db`, and there is exactly one collection.
- **Nothing irreversible.** Deletes, resets and prunes (every command that needs `--yes`, plus `card reset`) are refused, also when the user asks. Archive instead: `deck archive`, `item archive`, `note archive` (each has an `unarchive`), or `card suspend` for cards that should leave study. If the user really wants something deleted, they do that in the Etude app. The skill's advice on `--yes` and `db backup` before deletes does not apply here.
- **AI grading is off for this collection.** Grade answers yourself in the chat: show the card with `study next`, compare the user's answer with the private fields, then record the result with `study rate <card> <again|hard|good|easy>`. `settings set ai.*`, `settings test-ai`, `settings key` and `settings chatgpt` are refused.
- **Sign-in, Sync and the account belong to the plugin.** `sync setup`, `sync signin`, `sync verify`, `sync unlock`, `sync off` and every `account` verb except `account status` and `account devices` are refused; so are `serve`, `update`, `market publish`, `market index` and `agent ask`. `sync status` and `sync now` work. If a result notes that sync waits for a fresh identity, tell the user to open DSH in the browser; the change is saved and goes up on the next call.

Relative file paths (packs, `--fields-file`) resolve against the session's working directory, so write pack files in the workspace and import them from there. The repository docs the skill mentions (`docs/cli.md`, `docs/packs.md`, `docs/types.md`) are at `../docs/` relative to this skill's base directory.

---

