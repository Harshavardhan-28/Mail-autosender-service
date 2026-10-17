// Typed mirror of the Express API contracts (src/auth/routes.js, src/server/routes/*.js,
// src/domain/{contacts,schedule,template}.js). Timestamps arrive as ISO strings.

export const CONTACT_STATUSES = ["uploaded", "scheduled", "sent", "replied", "bounced", "opted_out", "failed"] as const;
export type ContactStatus = (typeof CONTACT_STATUSES)[number];

export const MESSAGE_STATES = ["scheduled", "sending", "sent", "failed", "cancelled", "needs_review"] as const;
export type MessageState = (typeof MESSAGE_STATES)[number];

export type MessageKind = "initial" | "followup";

export interface User {
  id: string;
  username: string;
}

export interface Batch {
  id: string;
  name: string;
  originalFilename: string | null;
  createdAt: string;
}

export interface BatchSummary extends Batch {
  contactCount: number;
  statusCounts: Partial<Record<ContactStatus, number>>;
}

export interface Contact {
  id: string;
  batchId: string;
  company: string;
  role: string;
  person: string;
  email: string;
  subject: string;
  mailText: string;
  followupText: string | null;
  status: ContactStatus;
  followupRequested: boolean;
  followupDelayDays: number;
  /** Chosen follow-up instant (09:00 IST of the picked date); null = legacy sent_at + delay rule. */
  followupAt: string | null;
  repliedAt: string | null;
  error: string | null;
  /** Per-contact resume override; null/absent means batch or default. */
  resumeId?: string | null;
  createdAt: string;
}

/** Plain-text preview built by the same composer the sender uses (no HTML ever reaches the browser). */
export interface Preview {
  subject: string;
  text: string;
}

/** Which resume goes out with a contact's first email (display name only; the file is never sent to the browser). */
export interface Attachment {
  id: string | null;
  displayName: string;
  source: "scheduled" | "contact" | "batch" | "default" | "legacy";
}

export interface ResumeUsage {
  pendingMessages: number;
  batches: number;
  contacts: number;
}

export interface Resume {
  id: string;
  displayName: string;
  fileName: string;
  sizeBytes: number;
  sha256: string;
  isDefault: boolean;
  createdAt: string;
  usage: ResumeUsage;
}

export interface ContactWithPreview extends Contact {
  preview: Preview;
  attachment?: Attachment | null;
}

/** A contact as returned by POST /api/batches: `row` is its line number in the uploaded CSV. */
export interface UploadedContact extends ContactWithPreview {
  row: number;
}

/** Live (non-cancelled) message as listed on GET /api/contacts. */
export interface MessageRef {
  id: string;
  kind: MessageKind;
  state: MessageState;
  scheduledFor: string;
  sentAt: string | null;
}

export interface ContactListItem extends Contact {
  attachment?: Attachment | null;
  messages: MessageRef[];
}

export interface Message {
  id: string;
  contactId: string;
  kind: MessageKind;
  state: MessageState;
  scheduledFor: string;
  sentAt: string | null;
  attempts: number;
  error: string | null;
  dryRun: boolean;
  createdAt: string;
}

/** How the server packed staggered sends into the send window. */
export interface ReschedulePlan {
  start: string;
  slots: number;
  perSlot: number;
  staggerMinutes: number;
  window: SendWindow;
}

export interface OverdueMessage {
  id: string;
  contactId: string;
  email: string;
  person: string;
  kind: MessageKind;
  scheduledFor: string;
  batchName: string | null;
}

export interface OverdueList {
  count: number;
  overdueMinutes: number;
  messages: OverdueMessage[];
}

export interface RowIssue {
  row: number;
  message: string;
}

export interface RowWarning extends RowIssue {
  existingStatus: ContactStatus;
}

export interface UploadResult {
  batch: Batch;
  contacts: UploadedContact[];
  errors: RowIssue[];
  warnings: RowWarning[];
}

/** One CSV row as returned by POST /api/batches/preview and sent back (possibly edited) to /commit. */
export interface ImportRow {
  row: number;
  company: string;
  role: string;
  person: string;
  email: string;
  subject: string;
  mailText: string;
  followupText: string | null;
}

/** An existing contact that has the same email as a row being imported. */
export interface ImportConflictMatch {
  contactId: string;
  batchId: string;
  batchName: string;
  status: ContactStatus;
  company: string;
  role: string;
  person: string;
  subject: string;
}

export interface ImportConflict {
  row: number;
  email: string;
  /** False when an existing match was already emailed: it can be skipped or kept, not replaced. */
  replaceable: boolean;
  matches: ImportConflictMatch[];
}

export interface PreviewResult {
  filename: string;
  suggestedName: string;
  rows: ImportRow[];
  errors: RowIssue[];
  conflicts: ImportConflict[];
}

export type Resolution = "skip" | "replace" | "keep";

/** POST /api/batches/commit: the usual upload result plus how the duplicates were handled. */
export interface CommitResult extends UploadResult {
  skipped: number;
  replaced: number;
}

export type RefusalReason =
  | "replied"
  | "bounced"
  | "opted_out"
  | "failed"
  | "suppressed"
  | "already_sent"
  | "already_scheduled"
  | "not_in_batch"
  | `other_batch_${string}`;

export interface Refusal {
  contactId: string;
  email: string | null;
  reason: RefusalReason;
}

export interface ContactsPage {
  contacts: ContactListItem[];
  total: number;
  page: number;
  pageSize: number;
}

export interface ContactsQuery {
  status?: ContactStatus;
  q?: string;
  batchId?: string;
  /** Exact, case-insensitive company match. */
  company?: string;
  page?: number;
  pageSize?: number;
}

export interface FollowupTemplate {
  subject: string;
  body: string;
}

/** Daily window (local time in `tz`) in which real emails may be sent; start inclusive, end exclusive. */
export interface SendWindow {
  start: string;
  end: string;
  tz: string;
}

/** `enforced` is false on servers that do not gate sending (local development). */
/** The file name every resume attachment is sent under (Resumes page). */
export interface AttachmentNameInfo {
  name: string;
  fileName: string;
  isDefault: boolean;
}

export interface SendWindowInfo {
  enforced: boolean;
  window: SendWindow;
}

export interface CompanyCount {
  company: string;
  count: number;
}

export interface FollowupBulkResult {
  updated: number;
  skipped: number;
  total: number;
}

export interface FollowupResult {
  contact: Contact;
  followup: Message | null;
}

export type ResolveAction = "mark_sent" | "requeue" | "cancel";

export interface CancelResult {
  message: Message;
  contact: Contact;
}

export interface SweepState {
  ok: boolean;
  at: string;
  lastSuccessAt: string | null;
  errorCode: string | null;
  rowErrors: number;
}

export interface SweepResult {
  skipped?: boolean;
  reason?: string;
  checked?: number;
  replied?: number;
  rowErrors?: number;
  error?: boolean;
}

export interface UpcomingSend {
  messageId: string;
  contactId: string;
  kind: MessageKind;
  scheduledFor: string;
  email: string;
  company: string;
  person: string;
}

export interface RecentEvent {
  id: number;
  contactId: string | null;
  type: string;
  meta: Record<string, unknown> | null;
  at: string;
  email: string | null;
}

export interface CompanyStat {
  company: string;
  total: number;
  sent: number;
  replied: number;
}

export interface Dashboard {
  totals: Record<ContactStatus, number>;
  sentToday: number;
  dailyCap: number;
  repliedRate: number;
  upcoming: UpcomingSend[];
  recentEvents: RecentEvent[];
  byCompany: CompanyStat[];
  sweep: SweepState | null;
  followupsHeld: boolean;
  /** Set while sending is paused by a credentials/config error, or (scope "resume") a message is held for its resume. */
  sendHold: { at: string; code: string; message: string; scope?: "resume"; messageId?: string } | null;
  dryRun: boolean;
}

/** GET /api/mails: one row per live (non-cancelled) message. */
export type MailTab = "sent" | "scheduled" | "attention";
export type MailKindFilter = MessageKind;

export interface MailRow {
  id: string;
  kind: MessageKind;
  state: MessageState;
  subject: string;
  scheduledFor: string;
  sentAt: string | null;
  attempts: number;
  error: string | null;
  dryRun: boolean;
  /** Scheduled and more than an hour past its time (the send window closed or pacing did not fit it). */
  overdue: boolean;
  contact: { id: string; person: string; company: string; role: string; email: string; status: ContactStatus; repliedAt: string | null };
  batch: { id: string; name: string };
}

export interface MailCounts {
  sent: number;
  scheduled: number;
  attention: number;
}

export interface MailsPage {
  mails: MailRow[];
  total: number;
  page: number;
  pageSize: number;
  counts: MailCounts;
}

export interface MailsQuery {
  state?: MailTab | "all";
  kind?: MessageKind;
  q?: string;
  batchId?: string;
  /** Exact, case-insensitive company match. */
  company?: string;
  page?: number;
  pageSize?: number;
}

export interface MailEvent {
  type: string;
  at: string;
  meta: Record<string, unknown> | null;
}

/** GET /api/mails/:id. `body` is the plain-text mail exactly as it is (or will be) sent. */
export interface MailDetail extends MailRow {
  body: string;
  attachment: Attachment | null;
  messageId: string | null;
  /** The initial message a follow-up is threaded under. */
  threadedWith: string | null;
  /** The contact's other live message (the follow-up of an initial mail, or the initial of a follow-up). */
  related: { id: string; kind: MessageKind; state: MessageState } | null;
  timeline: MailEvent[];
}
