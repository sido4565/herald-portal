// mailer.js — TurboSMTP version
const { TurboSmtp } = require('@turbosmtp/mail');

const ENABLED = !!(process.env.TURBOSMTP_KEY && process.env.TURBOSMTP_SECRET);

const mailer = ENABLED ? new TurboSmtp({
  key: process.env.TURBOSMTP_KEY,
  secret: process.env.TURBOSMTP_SECRET,
}) : null;

const FROM = process.env.MAIL_FROM || 'Herald Trainer Consultant <sidzac33@gmail.com>';

async function sendMail({ to, subject, html, text }) {
  if (!ENABLED) {
    console.log(`[mail:disabled] Would send to ${to}: ${subject}`);
    return { skipped: true };
  }
  try {
    const result = await mailer.send({
      from: FROM,
      to: [to],
      subject,
      html,
      text: text || undefined,
    });
    console.log(`✉️  Email sent to ${to}: ${result.mid}`);
    return { ok: true, messageId: result.mid };
  } catch (err) {
    console.error(`✉️  Email failed to ${to}: ${err.message}`);
    throw err;
  }
}

// Template layout (same as before)
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
        .head h1 { margin: 0; font-size: 18px; font-weight: 600; }
        .body { padding: 28px; font-size: 14px; line-height: 1.6; }
        .body h2 { margin: 0 0 14px; font-size: 17px; color: #0b1a33; }
        .body p { margin: 0 0 12px; color: #4a5260; }
        .detail { background: #f5f6f8; padding: 14px 16px; border-radius: 6px; margin: 16px 0; border-left: 3px solid #b8860b; }
        .detail-row { display: flex; justify-content: space-between; padding: 6px 0; font-size: 13px; }
        .detail-row .lbl { color: #6b7280; text-transform: uppercase; font-size: 10px; letter-spacing: 0.06em; font-weight: 600; }
        .detail-row .val { font-weight: 600; color: #1a1f2e; }
        .btn { display: inline-block; background: #0b1a33; color: #fff !important; padding: 12px 22px; border-radius: 6px; text-decoration: none; font-weight: 600; font-size: 13px; margin-top: 8px; }
        .footer { text-align: center; padding: 20px; color: #6b7280; font-size: 11px; border-top: 1px solid #e5e8ed; }
      </style>
    </head>
    <body>
      <div class="card">
        <div class="head"><h1>Herald Trainer and Consultant</h1></div>
        <div class="body">${bodyHtml}</div>
        <div class="footer">Herald Trainer Consultant &middot; Training &middot; Consulting &middot; Excellence</div>
      </div>
    </body>
    </html>`;
}

async function sendLiveClassNotification({ to, studentName, courseCode, courseTitle, classTitle, scheduledAt, meetingUrl }) {
  return sendMail({
    to,
    subject: `Live Class Scheduled: ${classTitle}`,
    html: baseLayout('Live Class', `
      <h2>New Live Class Scheduled</h2>
      <p>Hello ${studentName},</p>
      <p>A new live class has been scheduled for <strong>${courseCode} — ${courseTitle}</strong>.</p>
      <div class="detail">
        <div class="detail-row"><span class="lbl">Class</span><span class="val">${classTitle}</span></div>
        <div class="detail-row"><span class="lbl">When</span><span class="val">${scheduledAt.toLocaleString()}</span></div>
      </div>
      <a href="${meetingUrl}" class="btn">Join Live Class</a>
    `),
  });
}

async function sendFeeReminder({ to, studentName, term, balance }) {
  return sendMail({
    to,
    subject: `Fee Reminder — ${term}`,
    html: baseLayout('Fee Reminder', `
      <h2>Fee Balance Reminder</h2>
      <p>Hello ${studentName},</p>
      <p>You have an outstanding balance for <strong>${term}</strong>.</p>
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
    `),
  });
}

async function sendAssignmentGraded({ to, studentName, assignmentTitle, grade, feedback, courseCode }) {
  return sendMail({
    to,
    subject: `Assignment Graded: ${assignmentTitle}`,
    html: baseLayout('Assignment Graded', `
      <h2>Assignment Graded</h2>
      <p>Hello ${studentName},</p>
      <p>Your submission for <strong>${courseCode}</strong> — <strong>${assignmentTitle}</strong> has been graded.</p>
      <div class="detail">
        <div class="detail-row"><span class="lbl">Grade</span><span class="val">${grade || '—'}</span></div>
        <div class="detail-row"><span class="lbl">Feedback</span><span class="val">${feedback || '—'}</span></div>
      </div>
    `),
  });
}

async function sendWelcomeEmail({ to, studentName, regNo, course }) {
  return sendMail({
    to,
    subject: `Welcome to Herald Portal — Your Registration Number`,
    html: baseLayout('Welcome', `
      <h2>Welcome to Herald Portal</h2>
      <p>Hello ${studentName},</p>
      <p>Your account has been created successfully.</p>
      <div class="detail">
        <div class="detail-row"><span class="lbl">Registration No</span><span class="val">${regNo}</span></div>
        <div class="detail-row"><span class="lbl">Course</span><span class="val">${course}</span></div>
      </div>
      <p><strong>Save your registration number — you'll need it every time you log in.</strong></p>
      <a href="${process.env.APP_URL || 'https://herald-portal.onrender.com'}/login.html" class="btn">Log In to Herald Portal</a>
    `),
  });
}

module.exports = {
  sendMail,
  sendLiveClassNotification,
  sendFeeReminder,
  sendAssignmentGraded,
  sendWelcomeEmail,
  ENABLED,
};