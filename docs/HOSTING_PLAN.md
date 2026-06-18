# Hosting Plan

## Short Term

Use Cloudflare Workers for the public Twilio and ElevenLabs webhook layer.

That layer is a good fit because it is stateless, fast, HTTPS-native, and only needs to receive Twilio webhooks, call ElevenLabs over HTTPS, and return TwiML.

## Claude Code Bridge

Do not run the Claude Code session inside Cloudflare Workers. Workers are not a good fit for durable shells, long-lived processes, local git state, or supervised command execution.

Use a separate worker machine for Claude Code. The better long-term options are:

- AWS EC2 when the Claude side needs durable sessions, IAM integration, SSH access, and full machine control.
- Railway or DigitalOcean when you want simpler deployment and can accept less AWS-native permission control.

For this app, EC2 is the stronger long-term fit once the system can push to GitHub or operate on real repositories.

## Recommended Production Shape

1. Cloudflare Worker receives public Twilio and ElevenLabs webhooks.
2. ElevenLabs agent tool calls hit `POST /agent-command` on the Worker.
3. The Worker authenticates the request and writes a signed job to the Claude bridge.
4. A private EC2 box runs a supervised Claude Code worker process.
5. The EC2 worker only executes allow-listed operations.
6. Destructive actions, deploys, and git pushes require explicit approval.
7. All commands and responses are logged for auditability.

## Guardrails Before Real Command Execution

- Use narrow GitHub credentials scoped to the target repos.
- Use a command allow-list, not arbitrary shell passthrough.
- Require a spoken confirmation from the caller before creating a job.
- Add server-side rate limits.
- Log caller number, command, repo, session, result, and approval state.
- Keep protected branches protected.
