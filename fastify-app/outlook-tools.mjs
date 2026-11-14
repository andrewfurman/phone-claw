import { analyzeImagesWithGateway } from "./ai-gateway-vision.mjs";
import { configureAccounts, refreshAccounts, sessionStatus, setInlineImageHosts, setVisionAnalyzer } from "outlook-web-cli";

// Work Outlook (CoverNode, AD-GA) comes from andrewfurman/outlook-web-cli, which signs in
// with each mailbox's saved Outlook web session (~phoneclaw/.config/outlook-web-cli/sessions).
// The signed-in Chrome sessions on the bridge (DevTools ports below, issue #161) are only
// used to import that session again if it ever stops working.
configureAccounts([
  {
    name: "covernode",
    aliases: ["covernode.io", "covernodeoutlook", "covernodework"],
    email_domain: "covernode.io",
    cdp_port: Number(process.env.OUTLOOK_COVERNODE_CDP_PORT || 9230),
    mailbox_url: "https://outlook.cloud.microsoft/mail/",
  },
  {
    name: "adga",
    aliases: ["ad-ga.com", "adgaoutlook", "adgawork"],
    email_domain: "ad-ga.com",
    cdp_port: Number(process.env.OUTLOOK_ADGA_CDP_PORT || 9231),
    mailbox_url: "https://outlook.cloud.microsoft/mail/andrew@ad-ga.com/",
  },
]);
setVisionAnalyzer(analyzeImagesWithGateway);
// Newspaper/visualizer images on R2's CDN can be inlined in drafts.
if (!process.env.OUTLOOK_INLINE_IMAGE_HOSTS) setInlineImageHosts(["dmvr3d99h35se.cloudfront.net"]);

export {
  __test_selectBestTokenFromMsalEntries,
  listWorkAccounts,
  outlookAgenda,
  outlookAttachmentInspect,
  outlookAttachments,
  outlookDeleteDraft,
  outlookDraftNew,
  outlookDraftReply,
  outlookMessages,
  outlookRead,
  outlookSearch,
  outlookStatus,
  resolveWorkAccountAlias,
} from "outlook-web-cli";

// Session health for `phoneclaw outlook session` and the keepalive timer. No secrets.
export async function outlookSession({ refresh = false, rotate = false } = {}) {
  if (refresh || rotate) return refreshAccounts({ rotate });
  const accounts = ["covernode", "adga"].map((name) => sessionStatus(name));
  return { ok: accounts.every((a) => a.saved), status: "ok", accounts };
}
