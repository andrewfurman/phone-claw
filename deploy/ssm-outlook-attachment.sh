#!/usr/bin/env bash
# Pull one Outlook attachment (e.g. a screenshot pasted into an email) from the bridge over SSM,
# without writing anything on the bridge. Each SSM call pipes a small script into node's stdin;
# the script calls `outlookAttachments` and prints one base64 byte range, which stays under
# SSM's ~24 KB inline output limit. The pieces are joined on this machine.
#
#   INSTANCE_ID=i-... AWS_PROFILE=... deploy/ssm-outlook-attachment.sh <account> <message-id>
#       lists the message's attachments (index, name, type, size, inline, content id)
#   INSTANCE_ID=i-... AWS_PROFILE=... deploy/ssm-outlook-attachment.sh <account> <message-id> <index> <out-file>
#       saves attachment <index> to <out-file> on this machine
#
# Needs: aws CLI with SSM SendCommand on the instance; AWS_REGION (default us-east-1).
set -euo pipefail
: "${INSTANCE_ID:?Set INSTANCE_ID to the bridge EC2 instance id}"
REGION="${AWS_REGION:-us-east-1}"
ACCOUNT="${1:?account (covernode or adga)}"
MESSAGE_ID="${2:?message id}"
INDEX="${3:-}"
OUT="${4:-}"
CHUNK=15000 # bytes per call: 20,000 base64 characters

run_on_bridge() { # $1: JavaScript module source; prints its stdout. Retries transient failures.
  local try
  for try in 1 2 3; do run_once "$1" && return 0; sleep $((try * 5)); done
  return 1
}

run_once() {
  local b64 id status
  b64=$(printf '%s' "$1" | base64 | tr -d '\n')
  id=$(aws ssm send-command --region "$REGION" --instance-ids "$INSTANCE_ID" \
    --document-name AWS-RunShellScript --comment "phoneclaw outlook attachment (read-only)" \
    --parameters "commands=[\"echo $b64 | base64 -d | sudo -u phoneclaw node --input-type=module\"]" \
    --query Command.CommandId --output text)
  aws ssm wait command-executed --region "$REGION" --command-id "$id" --instance-id "$INSTANCE_ID" 2>/dev/null || true
  status=$(aws ssm get-command-invocation --region "$REGION" --command-id "$id" --instance-id "$INSTANCE_ID" --query Status --output text)
  [ "$status" = "Success" ] || { echo "SSM command $id: $status" >&2; aws ssm get-command-invocation --region "$REGION" --command-id "$id" --instance-id "$INSTANCE_ID" --query StandardErrorContent --output text >&2; return 1; }
  aws ssm get-command-invocation --region "$REGION" --command-id "$id" --instance-id "$INSTANCE_ID" --query StandardOutputContent --output text
}

js() { # $1: outlookAttachments arguments as JSON; $2: what to print
  printf 'const { outlookAttachments } = await import("/opt/phoneclaw/fastify-app/outlook-tools.mjs");\nconst r = await outlookAttachments(%s);\nif (!r.ok) { console.error(JSON.stringify(r)); process.exit(1); }\n%s\n' "$1" "$2"
}

args() { # JSON-encode the call arguments (message ids contain = and _)
  node -e 'const [a, id, extra] = process.argv.slice(1); console.log(JSON.stringify({ account: a, id, ...JSON.parse(extra) }))' "$ACCOUNT" "$MESSAGE_ID" "$1"
}

if [ -z "$INDEX" ]; then
  run_on_bridge "$(js "$(args '{}')" 'for (const a of r.attachments) console.log([a.index, a.name, a.content_type, a.size, a.is_inline ? "inline" : "attached", a.content_id].join("\t"));')"
  exit 0
fi
: "${OUT:?out-file}"

# First piece also returns the attachment id, so later pieces fetch only that attachment.
first=$(run_on_bridge "$(js "$(args "{\"index\":$INDEX,\"offset\":0,\"length\":$CHUNK}")" 'console.log(JSON.stringify({ aid: r.attachment.attachment_id, name: r.attachment.name, total: r.total_bytes, next: r.next_offset })); console.log(r.data_base64);')")
meta=$(printf '%s\n' "$first" | head -1)
printf '%s\n' "$first" | sed -n 2p | base64 -d > "$OUT"
aid=$(node -e 'console.log(JSON.parse(process.argv[1]).aid)' "$meta")
next=$(node -e 'const m = JSON.parse(process.argv[1]); console.log(m.next ?? "")' "$meta")
while [ -n "$next" ]; do
  piece=$(run_on_bridge "$(js "$(args "{\"attachmentId\":$(node -e 'console.log(JSON.stringify(process.argv[1]))' "$aid"),\"offset\":$next,\"length\":$CHUNK}")" 'console.log(r.next_offset ?? ""); console.log(r.data_base64);')")
  printf '%s\n' "$piece" | sed -n 2p | base64 -d >> "$OUT"
  next=$(printf '%s\n' "$piece" | head -1)
done
total=$(node -e 'console.log(JSON.parse(process.argv[1]).total)' "$meta")
size=$(wc -c < "$OUT" | tr -d ' ')
[ "$size" = "$total" ] || { echo "Got $size of $total bytes" >&2; exit 1; }
echo "$OUT ($size bytes, $(node -e 'console.log(JSON.parse(process.argv[1]).name)' "$meta"))"
