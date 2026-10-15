import { ImapFlow } from "imapflow";

const HEADER_NAMES = ["auto-submitted", "x-autoreply", "x-autorespond", "precedence"];

// Gmail may rewrite the Message-ID on delivery, so matching on the stored id alone can miss a
// reply. Ordered searches: In-Reply-To, References, then (when contact details are given)
// "from the recipient, subject contains the original subject, since the send date".
// Each entry is tagged with `via` so the audit trail says which search matched.
export function buildReplySearches(messageId, { fromEmail, subject, since } = {}) {
  const searches = [
    { via: "in-reply-to", query: { header: { "in-reply-to": messageId } } },
    { via: "references", query: { header: { references: messageId } } },
  ];
  const clean = (v) => typeof v === "string" && v.trim() !== "" && !/[\r\n]/.test(v);
  if (clean(fromEmail) && clean(subject) && since instanceof Date) {
    searches.push({ via: "from-subject", query: { from: fromEmail.trim().toLowerCase(), subject, since } });
  }
  return searches;
}

// Raw header block -> Map(lowercase name -> unfolded value).
export function parseHeaders(raw) {
  const out = new Map();
  if (!raw) return out;
  const text = Buffer.isBuffer(raw) ? raw.toString("utf8") : String(raw);
  const unfolded = text.replace(/\r?\n[ \t]+/g, " ");
  for (const line of unfolded.split(/\r?\n/)) {
    const i = line.indexOf(":");
    if (i > 0) out.set(line.slice(0, i).trim().toLowerCase(), line.slice(i + 1).trim());
  }
  return out;
}

const AUTO_SUBJECT = /^\s*(?:(?:re|fwd?)\s*:\s*)*(?:automatic reply|out of office)\b/i;

// Decides whether a search hit is a genuine human reply. Rejects auto-replies, bounces, mail
// from the sending account itself, and (for the loose fallback search) any sender that is not
// exactly the contact. headers is a Map from parseHeaders.
export function classifyReply({ from, subject, headers }, { contactEmail, ownEmail, exactFrom = false } = {}) {
  const sender = typeof from === "string" ? from.trim().toLowerCase() : "";
  if (!sender) return { ok: false, reason: "no sender" };
  const local = sender.split("@")[0];
  if (local === "mailer-daemon" || local === "postmaster") return { ok: false, reason: "bounce sender" };
  if (ownEmail && sender === String(ownEmail).trim().toLowerCase()) return { ok: false, reason: "own address" };
  const h = headers instanceof Map ? headers : new Map();
  const autoSubmitted = h.get("auto-submitted");
  if (autoSubmitted !== undefined && autoSubmitted.trim().toLowerCase() !== "no") return { ok: false, reason: "auto-submitted" };
  if (h.has("x-autoreply") || h.has("x-autorespond")) return { ok: false, reason: "autoreply header" };
  if (["auto_reply", "bulk", "junk"].includes((h.get("precedence") ?? "").trim().toLowerCase())) return { ok: false, reason: "precedence" };
  if (typeof subject === "string" && AUTO_SUBJECT.test(subject)) return { ok: false, reason: "auto subject" };
  if (exactFrom && sender !== String(contactEmail ?? "").trim().toLowerCase()) return { ok: false, reason: "sender mismatch" };
  return { ok: true };
}

const imapError = (message, code, fatal) => Object.assign(new Error(message), { code, fatal });

// imapflow's search()/fetchOne() do NOT throw on failure: they return false/undefined (and drop
// the selected mailbox when the connection closes). Every such result is turned into a thrown
// error here so it can never be mistaken for "no reply". fatal = the connection itself is gone.
function assertUsable(client) {
  if (!client.usable || !client.mailbox) throw imapError("IMAP connection lost", "NoConnection", true);
}

export const IMAP_COMMAND_TIMEOUT_MS = 60_000;
export const IMAP_SNAPSHOT_TIMEOUT_MS = 180_000;
export const SNAPSHOT_DAYS = 31; // sweep window is 30 days + the one day of slack on each candidate's `since`
const FETCH_CHUNK = 500;
const SNAPSHOT_HEADERS = ["in-reply-to", "references", ...HEADER_NAMES];

// Races one IMAP call against a timer. A stalled socket never settles on its own, so on timeout the
// connection is destroyed and a fatal ETIMEDOUT is thrown (the sweep treats it as "connection gone").
// The timer is always cleared and a late settlement of the abandoned call is swallowed.
export function withTimeout(client, run, ms, label = "IMAP command") {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      try {
        client?.close?.();
      } catch {
        // already closed
      }
      reject(imapError(`${label} timed out`, "ETIMEDOUT", true));
    }, ms);
    let call;
    try {
      call = Promise.resolve(run());
    } catch (err) {
      clearTimeout(timer);
      return reject(err);
    }
    call.then(
      (v) => (clearTimeout(timer), resolve(v)),
      (e) => (clearTimeout(timer), reject(e)),
    );
  });
}

// Message-IDs compare without angle brackets / whitespace, case-insensitively (as IMAP HEADER search did).
const normId = (v) => String(v ?? "").replace(/[<>\s]/g, "").toLowerCase();
const headerHasId = (value, id) => id !== "" && typeof value === "string" && value.replace(/[<>]/g, " ").toLowerCase().split(/\s+/).some((t) => t === id || t.includes(id));

/**
 * Wraps an already-connected imapflow client (INBOX selected). Exported for tests.
 * The inbox is read ONCE per checker (lazily, on the first check): one SEARCH since the last
 * SNAPSHOT_DAYS days and one FETCH pass over those uids; every candidate is then matched in memory,
 * so a sweep costs O(1) round-trips however many contacts are checked.
 */
export function createCheckerFromClient(client, config, { onClose, timeoutMs = IMAP_COMMAND_TIMEOUT_MS, snapshotTimeoutMs = IMAP_SNAPSHOT_TIMEOUT_MS, now = () => new Date(), chunkSize = FETCH_CHUNK } = {}) {
  let snapshot; // Promise of the index; a failure is cached so every row sees the same error without re-reading the inbox

  async function readInbox() {
    assertUsable(client);
    const since = new Date(now().getTime() - SNAPSHOT_DAYS * 86_400_000);
    const uids = await withTimeout(client, () => client.search({ since }, { uid: true }), timeoutMs, "IMAP search");
    if (!Array.isArray(uids)) {
      assertUsable(client);
      throw imapError("IMAP search failed", "ESEARCH", false);
    }
    const index = [];
    for (let i = 0; i < uids.length; i += chunkSize) {
      const range = uids.slice(i, i + chunkSize).join(",");
      await withTimeout(
        client,
        async () => {
          for await (const msg of client.fetch(range, { uid: true, envelope: true, headers: SNAPSHOT_HEADERS }, { uid: true })) {
            if (!msg?.envelope) continue; // nothing to match or classify on
            const headers = parseHeaders(msg.headers);
            index.push({
              uid: msg.uid,
              from: msg.envelope.from?.[0]?.address,
              subject: msg.envelope.subject,
              date: msg.envelope.date ? new Date(msg.envelope.date) : null,
              headers,
            });
          }
        },
        snapshotTimeoutMs,
        "IMAP fetch",
      );
    }
    assertUsable(client); // a connection that died mid-iteration ends the loop quietly
    return index;
  }

  return {
    async check(messageId, opts = {}) {
      if (!messageId) return false;
      snapshot ??= readInbox();
      const index = await snapshot;
      const id = normId(messageId);
      const wantFrom = typeof opts.fromEmail === "string" ? opts.fromEmail.trim().toLowerCase() : "";
      const wantSubject = typeof opts.subject === "string" ? opts.subject.trim().toLowerCase() : "";
      const loose = wantFrom !== "" && wantSubject !== "" && !/[\r\n]/.test(opts.subject) && opts.since instanceof Date;
      const passes = [
        { via: "in-reply-to", match: (m) => headerHasId(m.headers.get("in-reply-to"), id) },
        { via: "references", match: (m) => headerHasId(m.headers.get("references"), id) },
      ];
      if (loose) {
        passes.push({
          via: "from-subject",
          match: (m) =>
            String(m.from ?? "").trim().toLowerCase() === wantFrom &&
            String(m.subject ?? "").toLowerCase().includes(wantSubject) &&
            m.date instanceof Date && m.date.getTime() >= opts.since.getTime(),
        });
      }
      for (const { via, match } of passes) {
        for (const m of index) {
          if (!match(m)) continue;
          const verdict = classifyReply(
            { from: m.from, subject: m.subject, headers: m.headers },
            { contactEmail: opts.fromEmail, ownEmail: config.gmailUser, exactFrom: via === "from-subject" },
          );
          if (verdict.ok) return { matched: true, via, uid: m.uid };
        }
      }
      return false;
    },
    async close() {
      if (onClose) await onClose();
    },
  };
}

/**
 * Opens ONE IMAP connection for a whole sweep. check(messageId, opts) resolves to false (genuinely
 * no reply) or { matched: true, via, uid }; any failure is thrown (fatal = connection gone) and
 * must be treated as "unknown", never as "no reply". close() must always be called.
 */
export async function createReplyChecker(config) {
  const client = new ImapFlow({
    host: "imap.gmail.com",
    port: 993,
    secure: true,
    auth: { user: config.gmailUser, pass: config.gmailAppPassword },
    logger: false,
  });
  client.on?.("error", () => {}); // surfaced through usable/mailbox checks; avoid unhandled 'error'
  let lock;
  try {
    await withTimeout(client, () => client.connect(), IMAP_COMMAND_TIMEOUT_MS, "IMAP connect");
    lock = await withTimeout(client, () => client.getMailboxLock("INBOX"), IMAP_COMMAND_TIMEOUT_MS, "IMAP mailbox lock");
  } catch (err) {
    await withTimeout(client, () => client.logout(), IMAP_COMMAND_TIMEOUT_MS, "IMAP logout").catch(() => {});
    err.fatal = true;
    throw err;
  }
  return createCheckerFromClient(client, config, {
    onClose: async () => {
      try {
        lock.release();
      } finally {
        await withTimeout(client, () => client.logout(), IMAP_COMMAND_TIMEOUT_MS, "IMAP logout").catch(() => {});
      }
    },
  });
}
