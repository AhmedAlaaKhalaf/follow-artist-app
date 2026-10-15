/**
 * Resend email delivery for "new product from an artist you follow".
 *
 * Env:
 *   RESEND_API_KEY                   — Resend API key
 *   RESEND_FROM_EMAIL                — e.g. "Collector <notify@collectorsme.com>" (verified domain)
 *   EMAIL_NOTIFICATIONS_ENABLED      — must be "true" to send anything
 *   EMAIL_REQUIRE_MARKETING_CONSENT  — "false" to also email followers who never
 *                                      subscribed (unsubscribed are always skipped)
 *   EMAIL_REPLY_TO                   — optional reply-to address
 */

import { Resend } from "resend";

const BATCH_SIZE = 100;
// Resend's default rate limit is 2 requests/second.
const BATCH_DELAY_MS = 600;

let client = null;

export function emailConfig() {
  const apiKey = process.env.RESEND_API_KEY || "";
  const from = process.env.RESEND_FROM_EMAIL || "";
  return {
    enabled: process.env.EMAIL_NOTIFICATIONS_ENABLED === "true",
    hasApiKey: Boolean(apiKey),
    from,
    replyTo: process.env.EMAIL_REPLY_TO || "",
    requireMarketingConsent: process.env.EMAIL_REQUIRE_MARKETING_CONSENT !== "false",
    ready: Boolean(apiKey && from),
  };
}

function resendClient() {
  if (!client) client = new Resend(process.env.RESEND_API_KEY);
  return client;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * @param {{ shopName: string, artistName: string, artistUrl: string,
 *   productTitle: string, productUrl: string, imageUrl?: string|null,
 *   unsubscribeUrl?: string|null }} data
 */
export function renderArtistProductEmail(data) {
  const subject = `New from ${data.artistName}: ${data.productTitle}`;
  const e = Object.fromEntries(
    Object.entries(data).map(([k, v]) => [k, escapeHtml(v)]),
  );

  const html = `<!doctype html>
<html>
  <body style="margin:0;padding:0;background:#f6f6f6;font-family:Arial,Helvetica,sans-serif;color:#111;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f6f6f6;padding:24px 0;">
      <tr><td align="center">
        <table role="presentation" width="560" cellpadding="0" cellspacing="0" style="max-width:560px;width:100%;background:#fff;border-radius:8px;overflow:hidden;">
          <tr><td style="padding:24px 24px 8px;font-size:14px;color:#666;">${e.shopName}</td></tr>
          <tr><td style="padding:0 24px 16px;">
            <h1 style="margin:0;font-size:22px;line-height:1.3;">${e.artistName} just released new work</h1>
          </td></tr>
          ${data.imageUrl ? `<tr><td style="padding:0 24px;"><a href="${e.productUrl}"><img src="${e.imageUrl}" alt="${e.productTitle}" width="512" style="display:block;width:100%;height:auto;border-radius:6px;" /></a></td></tr>` : ""}
          <tr><td style="padding:16px 24px 8px;font-size:18px;font-weight:bold;">${e.productTitle}</td></tr>
          <tr><td style="padding:8px 24px 24px;">
            <a href="${e.productUrl}" style="display:inline-block;background:#111;color:#fff;text-decoration:none;padding:12px 20px;border-radius:6px;font-size:15px;">View the product</a>
            <a href="${e.artistUrl}" style="display:inline-block;margin-left:12px;color:#111;font-size:14px;">More from ${e.artistName}</a>
          </td></tr>
          <tr><td style="padding:16px 24px 24px;border-top:1px solid #eee;font-size:12px;color:#888;line-height:1.5;">
            You're receiving this because you follow ${e.artistName} on ${e.shopName}.
            To stop these emails, unfollow the artist on their page${data.unsubscribeUrl ? ` or <a href="${e.unsubscribeUrl}" style="color:#888;">unsubscribe from marketing emails</a>` : ""}.
          </td></tr>
        </table>
      </td></tr>
    </table>
  </body>
</html>`;

  const text = [
    `${data.artistName} just released new artwork on ${data.shopName}.`,
    "",
    data.productTitle,
    data.productUrl,
    "",
    `More from ${data.artistName}: ${data.artistUrl}`,
    "",
    `You're receiving this because you follow ${data.artistName}. Unfollow the artist on their page to stop these emails.`,
    data.unsubscribeUrl ? `Unsubscribe from marketing emails: ${data.unsubscribeUrl}` : "",
  ].join("\n");

  return { subject, html, text };
}

/**
 * Send one email per recipient using Resend batch sends.
 *
 * @param {Array<{ to: string, subject: string, html: string, text: string, unsubscribeUrl?: string|null }>} messages
 * @param {{ idempotencyPrefix?: string }} [options]
 * @returns {Promise<{ sent: number, failed: number }>}
 */
export async function sendEmails(messages, { idempotencyPrefix } = {}) {
  const config = emailConfig();
  if (!config.enabled || !config.ready) {
    return { sent: 0, failed: 0, skipped: messages.length };
  }

  let sent = 0;
  let failed = 0;
  for (let i = 0; i < messages.length; i += BATCH_SIZE) {
    const chunk = messages.slice(i, i + BATCH_SIZE).map((m) => ({
      from: config.from,
      to: [m.to],
      subject: m.subject,
      html: m.html,
      text: m.text,
      ...(config.replyTo ? { replyTo: config.replyTo } : {}),
      ...(m.unsubscribeUrl ? { headers: { "List-Unsubscribe": `<${m.unsubscribeUrl}>` } } : {}),
    }));

    try {
      const { error } = await resendClient().batch.send(
        chunk,
        idempotencyPrefix ? { idempotencyKey: `${idempotencyPrefix}:${i / BATCH_SIZE}` } : undefined,
      );
      if (error) {
        failed += chunk.length;
        console.error("[artist-email] Resend batch failed", { message: error.message, name: error.name });
      } else {
        sent += chunk.length;
      }
    } catch (error) {
      failed += chunk.length;
      console.error("[artist-email] Resend batch threw", { message: error?.message });
    }

    if (i + BATCH_SIZE < messages.length) await sleep(BATCH_DELAY_MS);
  }

  return { sent, failed };
}

/** Single send for the admin "Send test email" button. */
export async function sendTestEmail(to) {
  const config = emailConfig();
  if (!config.ready) {
    return { ok: false, message: "Set RESEND_API_KEY and RESEND_FROM_EMAIL on the server first." };
  }
  const content = renderArtistProductEmail({
    shopName: "Your store",
    artistName: "Sample Artist",
    artistUrl: "https://example.com/artists/sample-artist",
    productTitle: "Sample artwork",
    productUrl: "https://example.com/products/sample-artwork",
    imageUrl: null,
    unsubscribeUrl: null,
  });
  try {
    const { error } = await resendClient().emails.send({
      from: config.from,
      to: [to],
      subject: `[Test] ${content.subject}`,
      html: content.html,
      text: content.text,
      ...(config.replyTo ? { replyTo: config.replyTo } : {}),
    });
    if (error) return { ok: false, message: error.message };
    return { ok: true, message: `Test email sent to ${to}.` };
  } catch (error) {
    return { ok: false, message: error?.message || "Resend request failed." };
  }
}
