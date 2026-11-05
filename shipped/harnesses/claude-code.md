---
service: Claude Code
provider: anthropic
package: @agentclientprotocol/claude-agent-acp
bin: dist/index.js
command: claude-agent-acp
install: npm install -g @agentclientprotocol/claude-agent-acp@0.100.0
mode: acceptEdits
asks: Edits in the folder run without asking; commands, and anything outside the folder, ask you first.
---
Anthropic's coding agent, with your Claude sign-in and settings on this computer.
