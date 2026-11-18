# Security

LeanBrain runs locally: it reads your projects and agent transcripts, writes only to `~/.leanbrain` and to the agent settings you ask it to change (with backups), and serves a dashboard bound to 127.0.0.1 with Host/Origin checks. It makes no network calls.

If you find a vulnerability (for example a way for a web page to reach the dashboard API, or a hook that could be abused), please open a private security advisory on GitHub instead of a public issue.
