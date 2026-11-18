Setting up LeanBrain for a user (when they paste this repository link or ask to install it):

1. Clone into a stable folder (e.g. `~/leanbrain`), run `npm ci` (Node.js 20+).
2. Ask which folders hold their projects unless the request already says; run `node leanbrain.mjs scan <folder> [more folders]`. With a Cervello catalogue use `node leanbrain.mjs cervello ~/cervello`.
3. Run `node leanbrain.mjs install`. Offer `--mcp` (native tools in Claude Code, Codex, Gemini) and `--hook` (automatic brief in Claude Code); add them only if the user agrees.
4. Check with `node leanbrain.mjs status` and `node leanbrain.mjs brief`. The dashboard is `node leanbrain.mjs serve`.

Working on this repository: run `npm test` before committing. Keep CLI output short and English. Never store secrets in notes, fixtures or the index.
