# Contributing

Thanks for helping agents waste fewer tokens.

- Node.js 20+, no build step. `npm ci`, then `npm test` (tests run in temporary homes and never touch your data).
- `npm run demo` serves the dashboard on a fictional workspace; use it for screenshots and UI work.
- Keep CLI output short and in English: every line printed is a token an agent pays for.
- Hooks must fail open and stay fast (the PreToolUse path must not load the tokenizer).
- Every new saving needs an honest baseline in the ledger (`record(kind, full, returned)`), stated in the README.
- Never commit transcripts, real paths, notes or other personal data — fixtures must be synthetic.
