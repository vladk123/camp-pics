import Mailgun from "mailgun.js";
import FormData from "form-data";
import ejs from "ejs";
import path from "path";
import { fileURLToPath } from "url";
import { Email } from "../models/email.js";
import { logger } from "./logging.js";
import 'dotenv/config';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Mailgun setup
const mailgun = new Mailgun(FormData);
const mg = mailgun.client({
  username: "api",
  key: process.env.MAILGUN_API_KEY, // must be defined
});

export const MAX_EMAIL_MESSAGE_ID_LENGTH = 512;

const TEMPLATE_RENDER_FAILURE_MESSAGE = 'Email template rendering failed.';
const PROVIDER_DELIVERY_FAILURE_MESSAGE = 'Email provider delivery failed.';
const METADATA_PERSISTENCE_FAILURE_MESSAGE =
  'Email delivery metadata persistence failed.';

async function reportOperationalFailure(log, message, error) {
  try {
    await log(null, null, 'error', { message, error });
  } catch {
    // Operational logging must never change the delivery result.
  }
}

function providerMessageId(result) {
  const id = result?.id;
  return typeof id === 'string' &&
    id.length > 0 &&
    id.length <= MAX_EMAIL_MESSAGE_ID_LENGTH
    ? id
    : undefined;
}

export function createEmailSender({
  renderTemplate = ejs.renderFile,
  mailClient = mg,
  EmailModel = Email,
  log = logger,
  now = () => new Date(),
  domain = process.env.MAILGUN_DOMAIN,
  defaultFrom = process.env.MAILGUN_FROM,
} = {}) {
  return async function injectedSendEmail({
    to,
    subject,
    template,
    templateData = {},
    userId,
    from = defaultFrom,
  }) {
    let html;
    try {
      const templatePath = path.join(
        __dirname,
        "../views/emails",
        `${template}.ejs`,
      );
      html = await renderTemplate(templatePath, templateData);
    } catch (error) {
      await reportOperationalFailure(
        log,
        TEMPLATE_RENDER_FAILURE_MESSAGE,
        error,
      );
      throw error;
    }

    let result;
    try {
      result = await mailClient.messages.create(domain, {
        from,
        to,
        subject,
        html,
      });
    } catch (error) {
      await reportOperationalFailure(
        log,
        PROVIDER_DELIVERY_FAILURE_MESSAGE,
        error,
      );
      throw error;
    }

    try {
      const metadata = {
        to,
        template,
      };
      if (
        userId !== undefined &&
        userId !== null &&
        !(typeof userId === 'string' && userId.trim().length === 0)
      ) {
        metadata.userId = userId;
      }
      const messageId = providerMessageId(result);
      if (messageId !== undefined) {
        metadata.messageId = messageId;
      }
      metadata.sentAt = now();

      const emailRecord = new EmailModel(metadata);
      await emailRecord.save();
    } catch (error) {
      await reportOperationalFailure(
        log,
        METADATA_PERSISTENCE_FAILURE_MESSAGE,
        error,
      );
    }

    return result;
  };
}

export function sendEmail(options) {
  return createEmailSender()(options);
}
