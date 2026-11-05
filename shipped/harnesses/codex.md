---
service: Codex
provider: openai
package: @agentclientprotocol/codex-acp
bin: dist/index.js
command: codex-acp
install: npm install -g @agentclientprotocol/codex-acp@2.5.0
mode: workspace-write
asks: Edits in the folder run without asking; writing outside it asks you first.
---
OpenAI's coding agent, with your ChatGPT or OpenAI sign-in on this computer.
