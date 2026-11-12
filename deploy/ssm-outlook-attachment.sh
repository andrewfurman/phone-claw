#!/usr/bin/env bash
# Pull one Outlook attachment (e.g. a screenshot pasted into an email) from the bridge over SSM,
# without writing anything on the bridge. Each SSM call runs `phoneclaw outlook attachments`
# against the running bridge (http://127.0.0.1:8000) and prints one base64 byte range, which
# stays under SSM's ~24 KB inline output limit. The bridge caches the attachment in memory for
# a few minutes, so Outlook is asked for it once; the pieces are joined on this machine.
#
#   INSTANCE_ID=i-... AWS_PROFILE=... deploy/ssm-outlook-attachment.sh <account> <message-id>
#       lists the message's attachments (index, name, type, size, inline, content id)
#   INSTANCE_ID=i-... AWS_PROFILE=... deploy/ssm-outlook-attachment.sh <account> <message-id> <index> <out-file>
#       saves attachment <index> to <out-file> on this machine
#
# Needs: aws CLI with SSM SendCommand on the instance, and node locally. AWS_REGION defaults to
# us-east-1; BRIDGE_ENV_FILE (the bridge's EnvironmentFile) defaults to /etc/phoneclaw/bridge.env.
set -euo pipefail
: "${INSTANCE_ID:?Set INSTANCE_ID to the bridge EC2 instance id}"
REGION="${AWS_REGION:-us-east-1}"
ENV_FILE="${BRIDGE_ENV_FILE:-/etc/phoneclaw/bridge.env}"
ACCOUNT="${1:?account (covernode or adga)}"
MESSAGE_ID="${2:?message id}"
INDEX="${3:-}"
OUT="${4:-}"
CHUNK=13500 # bytes per call: 18,000 base64 characters plus the JSON around them

json() { node -e "$1" "${@:2}"; }

# Runs `phoneclaw outlook attachments --json <args>` on the bridge as the phoneclaw user, with the
# bridge's environment (for CLI_BRIDGE_TOKEN), and prints the result's `data` object compactly.
attachments() {
  local args_b64 cmd params id status
  args_b64=$(printf '%s' "$1" | base64 | tr -d '\n')
  cmd="A=\$(echo $args_b64 | base64 -d); systemd-run --quiet --uid=phoneclaw --gid=phoneclaw -p EnvironmentFile=$ENV_FILE -p WorkingDirectory=/opt/phoneclaw --pipe --wait /usr/bin/node bin/phoneclaw.mjs outlook attachments --json \"\$A\" | node -e 'let s=\"\";process.stdin.on(\"data\",d=>s+=d).on(\"end\",()=>{const r=JSON.parse(s);if(!r.ok){console.error(r.answer_text||r.status);process.exit(1)}console.log(JSON.stringify(r.data))})'"
  params=$(json 'console.log(JSON.stringify({ commands: [process.argv[1]] }))' "$cmd")
  id=$(aws ssm send-command --region "$REGION" --instance-ids "$INSTANCE_ID" \
    --document-name AWS-RunShellScript --comment "phoneclaw outlook attachment (read-only)" \
    --parameters "$params" --query Command.CommandId --output text)
  aws ssm wait command-executed --region "$REGION" --command-id "$id" --instance-id "$INSTANCE_ID" 2>/dev/null || true
  status=$(aws ssm get-command-invocation --region "$REGION" --command-id "$id" --instance-id "$INSTANCE_ID" --query Status --output text)
  if [ "$status" != "Success" ]; then
    echo "SSM command $id: $status" >&2
    aws ssm get-command-invocation --region "$REGION" --command-id "$id" --instance-id "$INSTANCE_ID" --query StandardErrorContent --output text >&2
    return 1
  fi
  aws ssm get-command-invocation --region "$REGION" --command-id "$id" --instance-id "$INSTANCE_ID" --query StandardOutputContent --output text
}

with_retry() { # retries transient SSM / Outlook errors
  local try
  for try in 1 2 3; do attachments "$1" && return 0; sleep $((try * 5)); done
  return 1
}

call_args() { # $1: extra fields as JSON
  json 'const [a, id, extra] = process.argv.slice(1); console.log(JSON.stringify({ account: a, id, ...JSON.parse(extra) }))' "$ACCOUNT" "$MESSAGE_ID" "$1"
}

if [ -z "$INDEX" ]; then
  with_retry "$(call_args '{}')" | json 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{for(const a of JSON.parse(s).attachments)console.log([a.index,a.name,a.content_type,a.size,a.is_inline?"inline":"attached",a.content_id].join("\t"))})'
  exit 0
fi
: "${OUT:?out-file}"

: > "$OUT"
offset=0
while [ -n "$offset" ]; do
  piece=$(with_retry "$(call_args "{\"index\":$INDEX,\"offset\":$offset,\"length\":$CHUNK}")")
  printf '%s' "$piece" | json 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(Buffer.from(JSON.parse(s).data_base64,"base64")))' >> "$OUT"
  offset=$(printf '%s' "$piece" | json 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const r=JSON.parse(s);console.log(r.next_offset ?? "")})')
  meta="$piece"
done
total=$(printf '%s' "$meta" | json 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const r=JSON.parse(s);console.log(r.total_bytes)})')
size=$(wc -c < "$OUT" | tr -d ' ')
[ "$size" = "$total" ] || { echo "Got $size of $total bytes" >&2; exit 1; }
echo "$OUT ($size bytes)"
