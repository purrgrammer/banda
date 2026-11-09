# Security

banda runs agents that act on your behalf, so its boundaries matter: the box (the agent's computer), the egress proxy
(the only way out, which adds credentials and holds writes for you), drafts and permissions (what may run without
asking), and the browser. [DESIGN.md](DESIGN.md) states the rules; [docs/README.md](docs/README.md) tracks the open
isolation, egress and browser findings. It is pre-release: do not rely on it to contain untrusted code or content yet.

## Reporting

Please report a vulnerability privately through GitHub's
[private vulnerability reporting](https://github.com/purrgrammer/banda/security/advisories/new) rather than a public
issue. Include what you did, what you expected and what happened; a reproduction against a throwaway home
(`BANDA_HOME=$(mktemp -d)`) helps most. You will get an answer as soon as we can, and credit if you want it.

Findings already listed under a section's **Open work** in `docs/` are known; a new way to exploit one is still welcome.
