import {
  archiveElevenLabsConversation,
  archiveLatestElevenLabsConversations,
} from "../fastify-app/conversation-history.mjs";

const conversationId = process.argv.find((arg) => arg.startsWith("--conversation-id="))?.split("=")[1];
const latestArg = process.argv.find((arg) => arg.startsWith("--latest="))?.split("=")[1];
const latest = Number(latestArg || process.env.CONVERSATION_ARCHIVE_LATEST || 10);

const result = conversationId
  ? await archiveElevenLabsConversation({ conversationId })
  : await archiveLatestElevenLabsConversations({ limit: latest });

console.log(JSON.stringify(result, null, 2));
process.exit(result.ok ? 0 : 1);
