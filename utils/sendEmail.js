// utils/emailUtil.js
import Mailgun from "mailgun.js";
import FormData from "form-data";
import ejs from "ejs";
import path from "path";
import { fileURLToPath } from "url";
import { Email } from "../models/email.js"; // adjust as needed
import 'dotenv/config';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Mailgun setup
const mailgun = new Mailgun(FormData);
const mg = mailgun.client({
  username: "api",
  key: process.env.MAILGUN_API_KEY, // must be defined
});

/**
 * Send an email through Mailgun
 */
export async function sendEmail({
  to,
  subject,
  template,
  templateData = {},
  userId = null,
  from = process.env.MAILGUN_FROM,
}) {
  try {
    const templatePath = path.join(__dirname, "../views/emails", `${template}.ejs`);
    const html = await ejs.renderFile(templatePath, templateData);

    const result = await mg.messages.create(process.env.MAILGUN_DOMAIN, {
      from,
      to,
      subject,
      html,
    });

    const emailLog = new Email({
      to,
      subject,
      html,
      userId,
      messageId: result.id,
      sentAt: new Date(),
    });
    await emailLog.save();

    // console.log(`Email sent to ${to} (${subject})`);
    return result;
  } catch (err) {
    console.error("Mailgun send error:", err.message || err);
    throw err;
  }
}