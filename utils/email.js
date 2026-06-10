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

const sendEmail = async ({ to, subject, text, html }) => {
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
