const nodemailer = require('nodemailer');

const ENABLED = !!(process.env.GMAIL_USER && process.env.GMAIL_PASS);

const transporter = ENABLED ? nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.GMAIL_USER,
    pass: process.env.GMAIL_PASS,
  },
}) : null;

const FROM = process.env.GMAIL_FROM || process.env.GMAIL_USER || 'noreply@herald-portal.test';

async function sendMail({ to, subject, html, text }) {
  if (!ENABLED) {
    console.log(`[mail:disabled] Would send to ${to}: ${subject}`);
    return { skipped: true };
  }
  try {
    const info = await transporter.sendMail({
      from: `"Herald Trainer Consultant" <${FROM}>`,
      to, subject, html, text,
    });
    console.log(`✉️  Email sent to ${to}: ${info.messageId}`);
    return { ok: true, messageId: info.messageId };
  } catch (err) {
    console.error(`✉️  Email failed to ${to}: ${err.message}`);
    throw err;
  }
}

// ---- Templates ----
function baseLayout(title, bodyHtml) {
  return `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="utf-8">
      <style>
        body { font-family: -apple-system, 'Segoe UI', Roboto, sans-serif; background: #f5f6f8; padding: 24px; color: #1a1f2e; }
        .card { max-width: 560px; margin: auto; background: #fff; border-radius: 8px; overflow: hidden; box-shadow: 0 4px 12px rgba(15,23,42,0.08); }
        .head { background: #0b1a33; color: #fff; padding: 24px 28px; border-bottom: 4px solid #b8860b; }
        .head h1 { margin: 0; font-size: 18px; font-weight: 600; letter-spacing: 0.02em; }
        .body { padding: 28px; font-size: 14px; line-height: 1.6; }
        .body h2 { margin: 0 0 14px; font-size: 17px; color: #0b1a33; }
        .body p { margin: 0 0 12px; color: #4a5260; }
        .detail { background: #f5f6f8; padding: 14px 16px; border-radius: 6px; margin: 16px 0; border-left: 3px solid #b8860b; }
        .detail-row { display: flex; justify-content: space-between; padding: 6px 0; font-size: 13px; }
        .detail-row .lbl { color: #6b7280; text-transform: uppercase; font-size: 10px; letter-spacing: 0.06em; font-weight: 600; }
        .detail-row .val { font-weight: 600; color: #1a1f2e; }
        .btn { display: inline-block; background: #0b1a33; color: #fff; padding: 12px 22px; border-radius: 6px; text-decoration: none; font-weight: 600; font-size: 13px; margin-top: 8px; }
        .footer { text-align: center; padding: 20px; color: #6b7280; font-size: 11px; border-top: 1px solid #e5e8ed; }
      </style>
    </head>
    <body>
      <div class="card">
        <div class="head"><h1>Herald Trainer and Consultant</h1></div>
        <div class="body">${bodyHtml}</div>
        <div class="footer">
          Herald Trainer Consultant &middot; Training &middot; Consulting &middot; Excellence
        </div>
      </div>
    </body>
    </html>`;
}

async function sendLiveClassNotification({ to, studentName, courseCode, courseTitle, classTitle, scheduledAt, meetingUrl }) {
  const subject = `Live Class Scheduled: ${classTitle}`;
  const when = scheduledAt.toLocaleString();
  const html = baseLayout('Live Class', `
    <h2>New Live Class Scheduled</h2>
    <p>Hello ${studentName},</p>
    <p>A new live class has been scheduled for <strong>${courseCode} — ${courseTitle}</strong>.</p>
    <div class="detail">
      <div class="detail-row"><span class="lbl">Class</span><span class="val">${classTitle}</span></div>
      <div class="detail-row"><span class="lbl">Course</span><span class="val">${courseCode}</span></div>
      <div class="detail-row"><span class="lbl">When</span><span class="val">${when}</span></div>
    </div>
    <p>Join using the button below when the class starts.</p>
    <a href="${meetingUrl}" class="btn">Join Live Class</a>
  `);
  return sendMail({ to, subject, html });
}

async function sendFeeReminder({ to, studentName, term, balance }) {
  const subject = `Fee Reminder — ${term}`;
  const html = baseLayout('Fee Reminder', `
    <h2>Fee Balance Reminder</h2>
    <p>Hello ${studentName},</p>
    <p>This is a friendly reminder that you have an outstanding fee balance for <strong>${term}</strong>.</p>
    <div class="detail">
      <div class="detail-row"><span class="lbl">Term</span><span class="val">${term}</span></div>
      <div class="detail-row"><span class="lbl">Balance</span><span class="val">KES ${Number(balance).toLocaleString()}</span></div>
    </div>
    <p><strong>Payment via KCB:</strong></p>
    <div class="detail">
      <div class="detail-row"><span class="lbl">Paybill</span><span class="val">522522</span></div>
      <div class="detail-row"><span class="lbl">Account</span><span class="val">1279021640</span></div>
      <div class="detail-row"><span class="lbl">Name</span><span class="val">HERALD TRAINER AND CONSULTANT</span></div>
    </div>
    <p>Kindly clear the balance at your earliest convenience.</p>
  `);
  return sendMail({ to, subject, html });
}

async function sendAssignmentGraded({ to, studentName, assignmentTitle, grade, feedback, courseCode }) {
  const subject = `Assignment Graded: ${assignmentTitle}`;
  const html = baseLayout('Assignment Graded', `
    <h2>Your Assignment Has Been Graded</h2>
    <p>Hello ${studentName},</p>
    <p>Your submission for <strong>${courseCode}</strong> assignment <strong>"${assignmentTitle}"</strong> has been graded.</p>
    <div class="detail">
      <div class="detail-row"><span class="lbl">Grade</span><span class="val">${grade || '—'}</span></div>
      <div class="detail-row"><span class="lbl">Feedback</span><span class="val">${feedback || '—'}</span></div>
    </div>
    <p>Log in to the portal to view details.</p>
  `);
  return sendMail({ to, subject, html });
}

async function sendWelcomeEmail({ to, studentName, regNo, course }) {
  const subject = `Welcome to Herald Portal`;
  const html = baseLayout('Welcome', `
    <h2>Welcome to Herald Portal</h2>
    <p>Hello ${studentName},</p>
    <p>Your account has been created. You can now log in to access your courses, fees, results, and more.</p>
    <div class="detail">
      <div class="detail-row"><span class="lbl">Reg No</span><span class="val">${regNo}</span></div>
      <div class="detail-row"><span class="lbl">Course</span><span class="val">${course}</span></div>
    </div>
    <a href="${process.env.APP_URL || 'https://herald-portal.onrender.com'}/login.html" class="btn">Log In</a>
  `);
  return sendMail({ to, subject, html });
}

module.exports = {
  sendMail,
  sendLiveClassNotification,
  sendFeeReminder,
  sendAssignmentGraded,
  sendWelcomeEmail,
  ENABLED,
};