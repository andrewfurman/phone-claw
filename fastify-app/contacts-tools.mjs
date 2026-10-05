import { executeCli } from "../shared/cli-process.mjs";

// Read-only Apple Contacts lookups (#151) through the mac-contacts SSH wrapper. Used directly
// (`phoneclaw contacts search`) and to turn a spoken name into an iMessage handle. Ambiguity is never guessed:
// several people, or one person with several possible numbers, comes back as a list to ask Andrew about.
const DEFAULT_WRAPPER = "/home/phoneclaw/bin/mac-contacts";
const NAME = /^[\p{L}][\p{L}\p{M}' .-]{0,59}$/u;
const MOBILE = new Set(["mobile", "iphone", "cell", "main"]);

export const looksLikeName = value => NAME.test(String(value ?? "").trim());

export async function contactsSearch(options = {}, deps = {}) {
  const env = deps.env || process.env;
  const run = deps.executeCli || executeCli;
  const query = String(options.query ?? options.name ?? "").trim();
  if (!looksLikeName(query)) return fail("invalid_query", "Say the person's name, like Kate Furman.", "query");
  const limit = [1, 2, 3, 5, 10].includes(Number(options.limit)) ? String(options.limit) : "5";
  const result = await run(env.MAC_CONTACTS_BIN || DEFAULT_WRAPPER, ["search", query, "-l", limit], {
    env: { PATH: env.PATH || "/usr/bin:/bin", HOME: env.HOME || "", MAC_SSH_ALIAS: env.MAC_SSH_ALIAS || "" },
    timeoutMs: 30_000,
    maxBuffer: 1_000_000,
  });
  if (result.status === "cli_timeout") return fail("contacts_timeout", "Contacts did not answer in time.");
  let data;
  try { data = JSON.parse(String(result.stdout || "").trim().split("\n").at(-1)); } catch { data = null; }
  if (!data?.ok) return fail("contacts_failed", data?.message || "Could not search Contacts.");
  const matches = (data.matches || []).map(m => ({ name: m.name, organization: m.organization || undefined, phones: m.phones || [], emails: m.emails || [] }));
  const spoken = matches.slice(0, 3).map(m => `${m.name}${m.phones[0] ? ` (${m.phones[0].label} ${m.phones[0].number})` : ""}`).join("; ");
  return { ok: true, status: "ok", action: "contacts_search", query, total_matches: data.total_matches ?? matches.length, matches, answer_text: matches.length ? `Found ${spoken}.` : `No contact matches ${query}.` };
}

/** Resolve a spoken name to exactly one iMessage handle, or explain why not. */
export async function resolveRecipient(name, deps = {}) {
  const found = await contactsSearch({ query: name, limit: 5 }, deps);
  if (!found.ok) return found;
  const exact = found.matches.filter(m => m.name.toLowerCase() === String(name).trim().toLowerCase());
  const people = exact.length ? exact : found.matches;
  if (!people.length) return fail("contact_not_found", `I couldn't find ${name} in Contacts. Give me a phone number instead.`, "to");
  if (people.length > 1) {
    return { ...fail("ambiguous_contact", `More than one contact matches ${name}: ${people.slice(0, 5).map(p => p.name).join(", ")}. Which one?`, "to"), candidates: people.slice(0, 5).map(p => ({ name: p.name, phones: p.phones.map(x => `${x.label} ${x.number}`) })) };
  }
  const person = people[0];
  const mobiles = person.phones.filter(p => MOBILE.has(p.label));
  const phones = mobiles.length ? mobiles : person.phones;
  if (phones.length === 1) return { ok: true, to: phones[0].number, name: person.name, label: phones[0].label };
  if (phones.length > 1) {
    return { ...fail("ambiguous_number", `${person.name} has several numbers: ${phones.map(p => `${p.label} ${p.number}`).join(", ")}. Which one?`, "to"), candidates: [{ name: person.name, phones: phones.map(x => `${x.label} ${x.number}`) }] };
  }
  if (person.emails.length === 1) return { ok: true, to: person.emails[0].address, name: person.name, label: "email" };
  return fail(person.emails.length ? "ambiguous_number" : "no_handle", `${person.name} has ${person.emails.length ? "several email addresses" : "no phone number or email"} in Contacts. Give me the number to use.`, "to");
}

function fail(status, message, field) {
  return { ok: false, status, ...(field ? { field } : {}), message, answer_text: message };
}
