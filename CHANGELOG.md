# Changelog

## 1.0.0 — LeanBrain

First release under the new name (previously *Atlante*).

- Session memory for Claude Code, Codex and Gemini CLI: incremental transcript sync, per-session outcome, edited files, tools, failures and token usage.
- Token guard for Claude Code: outlines for large reads, stubs for unchanged re-reads, diffs after edits — on Read and on `cat`/`sed -n`/`head`/`tail`; brief and project card at session start; reset after `/compact`.
- Insights: pause tax (cache rebuild cost after idle pauses, 1-hour cache verdict), immunity (commands that fail on this machine, blocked before they run), déjà vu (similar past work in any project), collision radar (other sessions on the same files).
- Lean context tools: `pack`, `find`, `map`, `sym`, `grep`, `read`, `run`, `recall`, notes and todos.
- Usage and cost by day, project, model, agent and tool, with prices for Claude Opus 5.5, Fable 5.2, Sonnet 5.5, Haiku 5.5 and GPT-6.2 Astra/Sol; `audit` of fixed context.
- MCP server (8 tools), agent rules for CLAUDE.md, AGENTS.md and GEMINI.md, redesigned dashboard with an Insights view, demo workspace and screenshot script.
