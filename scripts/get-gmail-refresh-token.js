// One-time helper: obtains a Gmail API refresh token for OTP sending.
//
// Usage:
//   1. Put GMAIL_CLIENT_ID and GMAIL_CLIENT_SECRET in .env (Desktop-app OAuth
//      client from Google Cloud Console).
//   2. node scripts/get-gmail-refresh-token.js
//   3. Open the printed URL in a browser, sign in with the Gmail account that
//      will send OTP mail, and approve. ("unverified app" warning: click
//      Advanced -> Go to <app>)
//   4. Copy the printed GMAIL_REFRESH_TOKEN line into .env (and Render).
require("dotenv").config();
const http = require("http");

const PORT = 53682;
const REDIRECT_URI = `http://127.0.0.1:${PORT}`;
const SCOPE = "https://www.googleapis.com/auth/gmail.send";

const { GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET } = process.env;

if (!GMAIL_CLIENT_ID || !GMAIL_CLIENT_SECRET) {
  console.error("Set GMAIL_CLIENT_ID and GMAIL_CLIENT_SECRET in .env first.");
  process.exit(1);
}

const authUrl =
  "https://accounts.google.com/o/oauth2/v2/auth?" +
  new URLSearchParams({
    client_id: GMAIL_CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    response_type: "code",
    scope: SCOPE,
    access_type: "offline",
    prompt: "consent",
  });

const server = http.createServer(async (req, res) => {
  const code = new URL(req.url, REDIRECT_URI).searchParams.get("code");

  if (!code) {
    res.end("No code in request. Try the auth URL again.");
    return;
  }

  const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: GMAIL_CLIENT_ID,
      client_secret: GMAIL_CLIENT_SECRET,
      code,
      redirect_uri: REDIRECT_URI,
      grant_type: "authorization_code",
    }),
  });

  const tokens = await tokenRes.json();

  if (!tokens.refresh_token) {
    res.end("Failed — check the terminal.");
    console.error("No refresh_token in response:", tokens);
    process.exit(1);
  }

  res.end("Done! Refresh token printed in the terminal. You can close this tab.");
  console.log("\nAdd this line to .env (and to Render env vars):\n");
  console.log(`GMAIL_REFRESH_TOKEN=${tokens.refresh_token}\n`);
  server.close();
});

server.listen(PORT, () => {
  console.log("\nOpen this URL in your browser and approve access:\n");
  console.log(authUrl + "\n");
});
