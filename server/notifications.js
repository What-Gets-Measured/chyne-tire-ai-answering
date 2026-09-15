// notifications.js — Chyne Tire alert delivery
//
// Chyne Tire's Twilio number isn't A2P 10DLC registered yet (that requires
// Business Profile approval using their EIN, still pending as of this
// build), so this version sends the owner alert via email only. SMS
// alerting can be added later once A2P registration clears - the
// notifyMessageTaken() call signature is designed to make that a simple
// addition rather than a rewrite.

const sgMail = require("@sendgrid/mail");
sgMail.setApiKey(process.env.SENDGRID_API_KEY);

const ALERT_EMAIL_ADDRESS = process.env.ALERT_EMAIL_ADDRESS;
const ALERT_FROM_EMAIL = process.env.ALERT_FROM_EMAIL; // must be a SendGrid-verified sender

// Builds a clean, readable summary of the captured message for the email body.
function formatMessageBody({
  name,
  callback_number,
  request,
  requested_timing,
  vehicle_info,
  address,
  channel,
  callerNumber,
}) {
  const lines = [
    `New ${channel} message from Chyne Tire's AI answering line:`,
    "",
    `Caller number: ${callerNumber || "not available"}`,
    `Name: ${name || "not given"}`,
    `Callback number: ${callback_number || "not given"}`,
    `Request: ${request}`,
  ];

  if (requested_timing) lines.push(`Requested timing: ${requested_timing}`);
  if (vehicle_info) lines.push(`Vehicle: ${vehicle_info}`);
  if (address) lines.push(`Address: ${address}`);

  return lines.join("\n");
}

// Called from index.js whenever the take_message tool fires. Returns a
// short status string used only for internal logging - never read aloud
// to the caller (that mistake was made once already on the real estate
// build and fixed by simplifying the tool_result text sent back to the AI).
async function notifyMessageTaken(details) {
  const results = [];

  if (ALERT_EMAIL_ADDRESS && ALERT_FROM_EMAIL) {
    try {
      await sgMail.send({
        to: ALERT_EMAIL_ADDRESS,
        from: ALERT_FROM_EMAIL,
        subject: `New Chyne Tire message: ${details.name || "unknown caller"}`,
        text: formatMessageBody(details),
      });
      results.push("email: sent");
    } catch (err) {
      console.error("Email alert failed:", err.message);
      results.push("email: failed");
    }
  } else {
    console.log("Email alert skipped - ALERT_EMAIL_ADDRESS or ALERT_FROM_EMAIL not set.");
    results.push("email: skipped");
  }

  // SMS intentionally not attempted yet - see file header. Add here once
  // A2P 10DLC registration for this number is approved.

  return results.join(", ");
}

module.exports = { notifyMessageTaken };
