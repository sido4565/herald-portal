/**
 * Herald Portal — Help Bot FAQ knowledge base
 * Each entry: { id, keywords, question, answer, category }
 * Matching strategy: keyword overlap score; best match wins.
 * Add/edit entries freely — order doesn't matter.
 */

const FAQ = [
  // ─── Registration / Application ───
  {
    id: 'register-how',
    keywords: ['register', 'registration', 'apply', 'application', 'sign up', 'signup', 'enroll', 'admission'],
    question: 'How do I register for a course?',
    answer: 'Go to the Register page (heraldtrainer.co.ke/register.html), fill in your name, email, password, program of study, ID/passport number, and upload your KCSE certificate and completion letter (PDF/JPG/PNG, max 5MB each). Submit — you will receive a registration number (e.g. HRL-2026-0001). Your account will be PENDING until an admin approves it (usually within 24 hours). You will get an email when approved.',
    category: 'registration',
  },
  {
    id: 'register-docs',
    keywords: ['documents', 'kcse', 'certificate', 'completion letter', 'upload', 'attach', 'file'],
    question: 'Which documents do I upload when registering?',
    answer: 'You need: (1) your ID or Passport number (typed in), (2) KCSE Certificate (PDF or image, optional but recommended), (3) Completion Letter (PDF or image, optional). You can upload PDF, JPG, JPEG, or PNG files up to 5MB each. If you do not have a KCSE certificate yet, you can still register and upload it later.',
    category: 'registration',
  },
  {
    id: 'register-pending',
    keywords: ['pending', 'approval', 'not approved', 'waiting', 'status', 'when approved'],
    question: 'Why is my account still pending?',
    answer: 'New student accounts start in PENDING status. An admin reviews your application and uploaded documents, then approves or rejects within 24 hours (usually faster). You will receive an email at the address you registered with when a decision is made. If it has been more than 48 hours, email support@heraldtrainer.co.ke with your registration number.',
    category: 'registration',
  },
  {
    id: 'register-rejected',
    keywords: ['rejected', 'rejection', 'declined', 'not accepted', 'denied'],
    question: 'My application was rejected. What now?',
    answer: 'If your application was rejected, you will receive an email explaining the reason. Common reasons: unclear/blurry documents, missing KCSE certificate, or incorrect personal details. You can re-apply with corrected documents by contacting support@heraldtrainer.co.ke and quoting your registration number.',
    category: 'registration',
  },

  // ─── Login / Password ───
  {
    id: 'login-forgot',
    keywords: ['forgot password', 'reset password', 'lost password', 'cannot login', "can't login", 'login failed', 'password reset'],
    question: 'I forgot my password. How do I reset it?',
    answer: 'On the login page, click "Forgot Password". Enter your registered email — you will get a reset link within 5 minutes. Check your spam folder if you do not see it. If you still cannot log in, email support@heraldtrainer.co.ke with your registration number.',
    category: 'login',
  },
  {
    id: 'login-email',
    keywords: ['change email', 'wrong email', 'update email', 'email address'],
    question: 'How do I change my email address?',
    answer: 'Email addresses cannot be changed from the dashboard for security reasons. Email support@heraldtrainer.co.ke from your current email address, state your registration number, and request the change. You will receive a confirmation once done.',
    category: 'login',
  },

  // ─── Fees / M-Pesa ───
  {
    id: 'fees-how-pay',
    keywords: ['pay fees', 'payment', 'mpesa', 'm-pesa', 'paybill', 'till', 'stk push', 'how to pay'],
    question: 'How do I pay my fees?',
    answer: 'You can pay via M-Pesa in two ways: (1) From your Student Dashboard → Fee Statement → "Pay via M-Pesa", enter your phone number and amount, then confirm the STK push prompt on your phone. (2) Manually: Go to M-Pesa → Lipa na M-PESA → Pay Bill → Business Number (ask support for the current Paybill), Account = your Registration Number, enter amount, confirm with your PIN. Fees appear on your statement within 5 minutes.',
    category: 'fees',
  },
  {
    id: 'fees-balance',
    keywords: ['balance', 'fee balance', 'how much', 'owe', 'outstanding', 'statement', 'fee statement'],
    question: 'How do I check my fee balance?',
    answer: 'Log in to your Student Dashboard. The "Fee Statement" card shows: total fees, amount paid, and outstanding balance. If a payment is missing, wait 5 minutes and refresh — M-Pesa confirmations can take a moment. If it is still missing after 30 minutes, email support@heraldtrainer.co.ke with the M-Pesa transaction code.',
    category: 'fees',
  },
  {
    id: 'fees-receipt',
    keywords: ['receipt', 'transaction code', 'mpesa code', 'proof of payment', 'confirmation'],
    question: 'How do I get a receipt for my M-Pesa payment?',
    answer: 'Every M-Pesa payment generates an automatic receipt on your Fee Statement page — scroll to the "Payments" section. For a formal PDF receipt (for employer reimbursement etc.), email support@heraldtrainer.co.ke with your registration number and the M-Pesa transaction code, and one will be emailed within 24 hours.',
    category: 'fees',
  },
  {
    id: 'fees-mpesa-failed',
    keywords: ['mpesa failed', 'payment failed', 'stk push failed', 'money deducted', 'not reflected'],
    question: 'My M-Pesa payment failed but money was deducted.',
    answer: 'If money was deducted but your balance did not update: wait 30 minutes and refresh (Safaricom sometimes delays confirmation). If still not reflected, email support@heraldtrainer.co.ke with: your registration number, M-Pesa transaction code (e.g. QGH7XXXXXX), amount, and date. Refunds for failed transactions are processed within 3-5 business days.',
    category: 'fees',
  },

  // ─── Courses ───
  {
    id: 'courses-list',
    keywords: ['courses', 'what courses', 'catalog', 'programs', 'available courses', 'course list'],
    question: 'What courses does Herald Trainer offer?',
    answer: 'Visit the Courses page (heraldtrainer.co.ke/courses.html) to see the full catalog, including Digital Marketing & Social Media Marketing, Business Management, and more. Each course page shows duration, fees, and modules. You can enroll after registering and being approved.',
    category: 'courses',
  },
  {
    id: 'courses-enroll',
    keywords: ['enroll', 'enrollment', 'join course', 'add course', 'register course'],
    question: 'How do I enroll in a course?',
    answer: 'After your registration is approved, log in and go to Courses. Click "Enroll" on any course — you will be added immediately. If you see the red "You haven\'t enrolled in any courses yet" banner on your dashboard, it means you have not enrolled in anything. Go to the Courses page to pick one.',
    category: 'courses',
  },
  {
    id: 'courses-drop',
    keywords: ['drop course', 'withdraw', 'unsubscribe', 'leave course', 'cancel enrollment'],
    question: 'Can I drop a course?',
    answer: 'Yes — email support@heraldtrainer.co.ke with your registration number and the course code you want to drop. Withdrawals are processed within 2 business days. Note: fee refunds after dropping are subject to the refund policy (contact support for details).',
    category: 'courses',
  },

  // ─── Exams ───
  {
    id: 'exams-schedule',
    keywords: ['exam', 'exams', 'when is exam', 'exam schedule', 'exam timetable', 'test'],
    question: 'When are my exams?',
    answer: 'Log in to your Student Dashboard → "My Exams" card. All exams for your enrolled courses appear there with status (Not Started / In Progress / Completed), duration, and total marks. Click "Start" to begin an exam. Exams become available on the scheduled date; if you do not see one you expect, contact your lecturer.',
    category: 'exams',
  },
  {
    id: 'exams-how',
    keywords: ['take exam', 'start exam', 'how to do exam', 'exam instructions', 'submit exam'],
    question: 'How do I take an exam?',
    answer: 'Dashboard → My Exams → click "Start →" on any Not Started exam. Read the instructions carefully. Answer each question, save your progress as you go, and click "Submit" when done. You can resume an In Progress exam later — your answers are saved. Once submitted, you cannot re-take the exam.',
    category: 'exams',
  },
  {
    id: 'exams-results',
    keywords: ['results', 'marks', 'grades', 'score', 'exam results', 'grade'],
    question: 'Where do I see my exam results?',
    answer: 'Log in to your Student Dashboard → "Academic Results" table shows all completed exams with course code, term, marks, and grade. For a printable summary, click "Download PDF Transcript" at the top of the Academic Results section.',
    category: 'exams',
  },
  {
    id: 'exams-missed',
    keywords: ['missed exam', 'absent', 'cannot attend', 'reschedule exam', 'retake'],
    question: 'I missed an exam. Can I retake it?',
    answer: 'Exam retakes are handled by your lecturer. Email your lecturer (their address is on the course page) with your registration number, the course code, and the reason. Approval is at their discretion. If you cannot reach them, email support@heraldtrainer.co.ke.',
    category: 'exams',
  },

  // ─── Transcripts / Certificates ───
  {
    id: 'transcript-download',
    keywords: ['transcript', 'download transcript', 'pdf transcript', 'academic transcript'],
    question: 'How do I download my transcript?',
    answer: 'Log in to your Student Dashboard → "Academic Results" card → click "📥 Download PDF Transcript" (top-right of that section). The PDF includes all completed courses, marks, and grades. If the button does not work, try a different browser (Chrome/Firefox recommended) or disable any ad blocker.',
    category: 'certificates',
  },
  {
    id: 'certificate-download',
    keywords: ['certificate', 'completion certificate', 'graduation', 'download certificate', 'cert'],
    question: 'How do I get my completion certificate?',
    answer: 'Completion certificates are issued after you have finished all modules of your course and passed the final exam. Once eligible, a "Download Certificate" button appears on your Student Dashboard under "My Enrolled Courses". If you have finished but do not see it, email support@heraldtrainer.co.ke with your registration number.',
    category: 'certificates',
  },

  // ─── Lecturer ───
  {
    id: 'lecturer-register',
    keywords: ['lecturer register', 'teach', 'become lecturer', 'apply to teach', 'teaching position', 'tutor'],
    question: 'How do I apply to become a lecturer?',
    answer: 'Go to heraldtrainer.co.ke/lecturer-register.html. Fill in your name, email, phone, qualification, specialization, and upload your CV, cover letter, and testimonials (PDF/JPG, max 5MB). Submit — you will get a staff number (e.g. HRD-LECT-2026-0001). The admin reviews applications within 2-3 business days. You will get an email when approved.',
    category: 'lecturer',
  },
  {
    id: 'lecturer-upload-docs',
    keywords: ['lecturer documents', 'cv upload', 'lecturer files', 'cover letter', 'testimonials'],
    question: 'Which documents do lecturers upload?',
    answer: 'When applying as a lecturer you upload: CV (required), Cover Letter (required), Testimonials or supporting documents (optional). All must be PDF, JPG, or PNG, max 5MB each. Documents are stored securely on Cloudflare R2 and only viewable by admins and you.',
    category: 'lecturer',
  },

  // ─── General / Support ───
  {
    id: 'support-contact',
    keywords: ['contact', 'support', 'email', 'phone', 'speak to human', 'help', 'customer service', 'reach you'],
    question: 'How do I contact support?',
    answer: 'Email: support@heraldtrainer.co.ke (response within 24 hours on business days). For urgent fee issues, include your registration number and M-Pesa transaction code. For technical issues, describe the problem and include a screenshot if possible.',
    category: 'support',
  },
  {
    id: 'portal-not-working',
    keywords: ['not working', 'broken', 'error', 'bug', 'website down', 'cannot open', 'loading forever'],
    question: 'The portal is not working for me. What should I do?',
    answer: 'Try in this order: (1) Hard-refresh: Ctrl+Shift+R (Linux/Windows) or Cmd+Shift+R (Mac). (2) Try an incognito/private window. (3) Disable ad blockers or extensions. (4) Try Chrome or Firefox. (5) Clear browser cache. If the problem persists, email support@heraldtrainer.co.ke with a screenshot and the time it happened.',
    category: 'support',
  },
  {
    id: 'mobile-access',
    keywords: ['mobile', 'phone', 'tablet', 'android', 'iphone', 'app', 'download app'],
    question: 'Is there a mobile app?',
    answer: 'Herald Portal works on all phones and tablets through the browser — no app download needed. Open heraldtrainer.co.ke on any modern mobile browser (Chrome, Safari, Firefox) and the site adapts to your screen. For the best experience, add it to your home screen (Chrome → ⋮ → "Add to Home screen").',
    category: 'support',
  },
  {
    id: 'privacy',
    keywords: ['privacy', 'data', 'gdpr', 'personal information', 'secure', 'safe'],
    question: 'Is my data safe?',
    answer: 'Yes. Passwords are hashed with bcrypt (never stored in plain text). Uploaded documents are stored on Cloudflare R2 with private access (only you and admins can view). Payment data is handled directly by Safaricom M-Pesa — Herald never sees your M-PESA PIN. All traffic is encrypted with HTTPS.',
    category: 'support',
  },
];

/**
 * Score a message against an FAQ entry.
 * Returns a number 0..N — higher = better match.
 */
function scoreMatch(message, faq) {
  const msg = ' ' + message.toLowerCase().replace(/[^a-z0-9\s'-]/g, ' ') + ' ';
  let score = 0;
  for (const kw of faq.keywords) {
    const k = kw.toLowerCase();
    // Whole-word match = 3 points; substring = 1 point
    if (msg.includes(' ' + k + ' ')) score += 3;
    else if (msg.includes(k)) score += 1;
  }
  // Bonus if the question text shares words with the user's message
  const qWords = faq.question.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(w => w.length > 3);
  for (const w of qWords) if (msg.includes(' ' + w + ' ')) score += 1;
  return score;
}

/**
 * Find the best FAQ match for a message.
 * Returns { faq, score } or null if no match above threshold.
 */
function findBestFaq(message) {
  let best = null;
  for (const faq of FAQ) {
    const score = scoreMatch(message, faq);
    if (score > 0 && (!best || score > best.score)) best = { faq, score };
  }
  // Require at least 2 points to count as a match (avoids one stray keyword)
  return best && best.score >= 2 ? best : null;
}

module.exports = { FAQ, findBestFaq };
