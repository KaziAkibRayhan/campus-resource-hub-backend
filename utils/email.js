const nodemailer = require("nodemailer");

let transporter;

const getTransporter = () => {
  if (transporter) return transporter;

  const { SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS } = process.env;

  if (!SMTP_HOST || !SMTP_USER || !SMTP_PASS) {
    return null;
  }

  transporter = nodemailer.createTransport({
    host: SMTP_HOST,
    port: Number(SMTP_PORT) || 587,
    secure: String(SMTP_PORT) === "465",
    // Force IPv4: hosts without an outbound IPv6 route (e.g. Render) otherwise
    // fail with "connect ENETUNREACH <ipv6>" when DNS returns an IPv6 address.
    family: 4,
    auth: {
      user: SMTP_USER,
      pass: SMTP_PASS,
    },
  });

  return transporter;
};

// Accepts "Name <addr@x.com>" or a bare address.
const parseFrom = (from) => {
  const match = /^(.*)<(.+)>$/.exec(from || "");
  if (match) {
    return { name: match[1].trim().replace(/^"|"$/g, ""), email: match[2].trim() };
  }
  return { email: (from || "").trim() };
};

// SendGrid's HTTP API avoids outbound SMTP entirely, which is more reliable
// on hosts like Render where SMTP connections have hung before.
const sendViaSendGrid = async ({ to, subject, text, html }) => {
  const from = parseFrom(process.env.MAIL_FROM || process.env.SMTP_USER);

  const res = await fetch("https://api.sendgrid.com/v3/mail/send", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.SENDGRID_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      personalizations: [{ to: [{ email: to }] }],
      from,
      subject,
      content: [
        { type: "text/plain", value: text },
        ...(html ? [{ type: "text/html", value: html }] : []),
      ],
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`SendGrid error ${res.status}: ${body}`);
  }

  return { messageId: res.headers.get("x-message-id") };
};

// Gmail REST API over HTTPS — avoids SMTP (which timed out on Render) and
// needs no third-party provider approval. Limit ~500 mails/day.
const getGmailAccessToken = async () => {
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: process.env.GMAIL_CLIENT_ID,
      client_secret: process.env.GMAIL_CLIENT_SECRET,
      refresh_token: process.env.GMAIL_REFRESH_TOKEN,
      grant_type: "refresh_token",
    }),
  });

  if (!res.ok) {
    throw new Error(`Gmail token error ${res.status}: ${await res.text()}`);
  }

  return (await res.json()).access_token;
};

const sendViaGmailApi = async ({ to, subject, text, html }) => {
  const accessToken = await getGmailAccessToken();
  const from = process.env.MAIL_FROM || process.env.SMTP_USER;
  const boundary = `crh-${Date.now()}`;
  const mime = [
    `From: ${from}`,
    `To: ${to}`,
    `Subject: ${subject}`,
    "MIME-Version: 1.0",
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    "",
    `--${boundary}`,
    "Content-Type: text/plain; charset=utf-8",
    "",
    text,
    ...(html ? [`--${boundary}`, "Content-Type: text/html; charset=utf-8", "", html] : []),
    `--${boundary}--`,
  ].join("\r\n");

  const res = await fetch(
    "https://gmail.googleapis.com/gmail/v1/users/me/messages/send",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ raw: Buffer.from(mime).toString("base64url") }),
    }
  );

  if (!res.ok) {
    throw new Error(`Gmail send error ${res.status}: ${await res.text()}`);
  }

  return res.json();
};

const sendEmail = async ({ to, subject, text, html }) => {
  if (process.env.SENDGRID_API_KEY) {
    return sendViaSendGrid({ to, subject, text, html });
  }

  if (
    process.env.GMAIL_REFRESH_TOKEN &&
    process.env.GMAIL_CLIENT_ID &&
    process.env.GMAIL_CLIENT_SECRET
  ) {
    return sendViaGmailApi({ to, subject, text, html });
  }

  const activeTransporter = getTransporter();
  const from = process.env.MAIL_FROM || process.env.SMTP_USER;

  if (!activeTransporter) {
    if (process.env.NODE_ENV !== "production") {
      console.log("[dev-email]", { to, subject, text });
      return { skipped: true };
    }

    throw new Error("Email service is not configured");
  }

  return activeTransporter.sendMail({
    from,
    to,
    subject,
    text,
    html,
  });
};

const sendOtpEmail = async ({ to, otp, purpose }) => {
  const label = purpose === "signup" ? "verify your account" : "reset your password";
  const subject =
    purpose === "signup"
      ? "Verify your Campus Resource Hub account"
      : "Reset your Campus Resource Hub password";
  const text = `Your Campus Resource Hub OTP is ${otp}. It expires in 10 minutes. Use this code to ${label}.`;
  const html = `
    <div style="font-family:Arial,sans-serif;line-height:1.5;color:#0f172a">
      <h2 style="margin:0 0 12px">Campus Resource Hub</h2>
      <p>Use this OTP to ${label}:</p>
      <p style="font-size:28px;font-weight:700;letter-spacing:6px;margin:16px 0">${otp}</p>
      <p>This code expires in 10 minutes. If you did not request it, you can ignore this email.</p>
    </div>
  `;

  return sendEmail({ to, subject, text, html });
};

module.exports = { sendEmail, sendOtpEmail };
