import { composeBody } from "../compose.js";
import { followupSubject, renderFollowup } from "./template.js";

// Initial-email preview via the same composer the sender uses. The API exposes the
// plain-text body only; the HTML version is never sent to the browser.
export function renderInitialPreview(contact, signatureHtml = "") {
  const { text } = composeBody(contact.mailText, signatureHtml);
  return { subject: contact.subject, text };
}

// Preview of a stored message (initial or follow-up) exactly as the worker composes it.
// contact is a DB row; template is the saved follow-up template.
export function renderMessagePreview(kind, contact, template, signatureHtml = "") {
  if (kind === "initial") return renderInitialPreview({ subject: contact.subject, mailText: contact.mail_text }, signatureHtml);
  const rendered = renderFollowup(
    { person: contact.person, role: contact.role, company: contact.company, subject: contact.subject, followupText: contact.followup_text },
    template,
  );
  return { subject: followupSubject(rendered.subject), text: composeBody(rendered.text, signatureHtml).text };
}
