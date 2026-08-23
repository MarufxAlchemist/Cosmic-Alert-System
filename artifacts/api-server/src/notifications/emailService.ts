/**
 * emailService.ts
 * ---------------
 * Provider abstraction layer for email delivery.
 *
 * Architecture
 * ────────────
 *   EmailProvider (interface)
 *       ├── SmtpEmailProvider    — nodemailer, works with any SMTP server
 *       ├── ResendEmailProvider  — Resend.com API (zero-config, recommended)
 *       ├── SendGridEmailProvider — Twilio SendGrid API
 *       └── NoOpEmailProvider    — silent no-op (EMAIL_PROVIDER=none or dev mode)
 *
 * The active provider is chosen at startup via the EMAIL_PROVIDER env var.
 * The factory is called once; the singleton is shared via notificationService.
 *
 * Adding a new provider (e.g. Mailgun):
 *   1. Implement the EmailProvider interface.
 *   2. Add a case to createEmailProvider().
 *   3. No other files need to change.
 *
 * Environment variables
 * ─────────────────────
 *   EMAIL_PROVIDER           smtp | resend | sendgrid | none
 *   NOTIFICATION_FROM_EMAIL  Sender address
 *   NOTIFICATION_FROM_NAME   Sender display name
 *   SMTP_HOST, SMTP_PORT, SMTP_SECURE, SMTP_USER, SMTP_PASS
 *   RESEND_API_KEY
 *   SENDGRID_API_KEY
 */

import { logger } from "../lib/logger.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface EmailOptions {
  to:      string;
  subject: string;
  html:    string;
  text:    string;
}

export interface EmailResult {
  /** true if provider accepted the message for delivery. */
  success: boolean;
  /** Provider-assigned message ID (where available). */
  messageId?: string;
  /** Error message on failure. */
  error?: string;
  /**
   * true if the error is permanent (e.g. 4xx: bad address, invalid API key).
   * Permanent failures should NOT be retried.
   */
  isPermanent?: boolean;
}

export interface EmailProvider {
  readonly name: string;
  send(options: EmailOptions): Promise<EmailResult>;
}

// ---------------------------------------------------------------------------
// NoOp provider (EMAIL_PROVIDER=none or missing config)
// ---------------------------------------------------------------------------

class NoOpEmailProvider implements EmailProvider {
  readonly name = "none";

  async send(options: EmailOptions): Promise<EmailResult> {
    logger.debug(
      { to: options.to, subject: options.subject },
      "[notifications/noop] Email sending is disabled (EMAIL_PROVIDER=none)",
    );
    return { success: true, messageId: "noop" };
  }
}

// ---------------------------------------------------------------------------
// SMTP provider (nodemailer)
// ---------------------------------------------------------------------------

class SmtpEmailProvider implements EmailProvider {
  readonly name = "smtp";

  async send(options: EmailOptions): Promise<EmailResult> {
    // Lazy import to avoid loading nodemailer when not used
    const nodemailer = await import("nodemailer");

    const transport = nodemailer.default.createTransport({
      host:   process.env["SMTP_HOST"]   ?? "smtp.gmail.com",
      port:   Number(process.env["SMTP_PORT"] ?? "587"),
      secure: (process.env["SMTP_SECURE"] ?? "false") === "true",
      auth: {
        user: process.env["SMTP_USER"],
        pass: process.env["SMTP_PASS"],
      },
    });

    const from = `"${process.env["NOTIFICATION_FROM_NAME"] ?? "Transient Event Detection"}" <${process.env["NOTIFICATION_FROM_EMAIL"] ?? process.env["SMTP_USER"]}>`;

    try {
      const info = await transport.sendMail({
        from,
        to:      options.to,
        subject: options.subject,
        html:    options.html,
        text:    options.text,
      });

      return { success: true, messageId: info.messageId };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      // SMTP 5xx = permanent; 4xx from auth = permanent
      const isPermanent = /^(535|550|553|554|EAUTH|ENOTFOUND)/.test(msg);
      return { success: false, error: msg, isPermanent };
    }
  }
}

// ---------------------------------------------------------------------------
// Resend provider
// ---------------------------------------------------------------------------

class ResendEmailProvider implements EmailProvider {
  readonly name = "resend";

  async send(options: EmailOptions): Promise<EmailResult> {
    const { Resend } = await import("resend");
    const resend     = new Resend(process.env["RESEND_API_KEY"]);

    const from = `${process.env["NOTIFICATION_FROM_NAME"] ?? "Transient Event Detection"} <${process.env["NOTIFICATION_FROM_EMAIL"] ?? "alerts@astrosentinel.io"}>`;

    try {
      const { data, error } = await resend.emails.send({
        from,
        to:      [options.to],
        subject: options.subject,
        html:    options.html,
        text:    options.text,
      });

      if (error) {
        return { success: false, error: error.message, isPermanent: true };
      }

      return { success: true, messageId: data?.id };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return { success: false, error: msg, isPermanent: false };
    }
  }
}

// ---------------------------------------------------------------------------
// SendGrid provider
// ---------------------------------------------------------------------------

class SendGridEmailProvider implements EmailProvider {
  readonly name = "sendgrid";

  async send(options: EmailOptions): Promise<EmailResult> {
    const sgMail = await import("@sendgrid/mail");
    sgMail.default.setApiKey(process.env["SENDGRID_API_KEY"] ?? "");

    const from = {
      email: process.env["NOTIFICATION_FROM_EMAIL"] ?? "alerts@astrosentinel.io",
      name:  process.env["NOTIFICATION_FROM_NAME"]  ?? "Transient Event Detection",
    };

    try {
      const [response] = await sgMail.default.send({
        from,
        to:      options.to,
        subject: options.subject,
        html:    options.html,
        text:    options.text,
      });

      return {
        success:   response.statusCode >= 200 && response.statusCode < 300,
        messageId: response.headers["x-message-id"] as string | undefined,
      };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      // SendGrid 4xx = permanent (invalid key, invalid to address, etc.)
      const isPermanent = /^4[0-9]{2}/.test(msg);
      return { success: false, error: msg, isPermanent };
    }
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

let _singleton: EmailProvider | null = null;

/**
 * Returns the configured EmailProvider singleton.
 * Called once at startup; subsequent calls return the same instance.
 */
export function createEmailProvider(): EmailProvider {
  if (_singleton) return _singleton;

  const provider = (process.env["EMAIL_PROVIDER"] ?? "none").toLowerCase();

  switch (provider) {
    case "smtp":
      logger.info("[notifications] Email provider: SMTP");
      _singleton = new SmtpEmailProvider();
      break;
    case "resend":
      logger.info("[notifications] Email provider: Resend");
      _singleton = new ResendEmailProvider();
      break;
    case "sendgrid":
      logger.info("[notifications] Email provider: SendGrid");
      _singleton = new SendGridEmailProvider();
      break;
    default:
      logger.info(
        { provider },
        "[notifications] Email provider: none (notifications disabled — set EMAIL_PROVIDER to enable)",
      );
      _singleton = new NoOpEmailProvider();
  }

  return _singleton;
}
