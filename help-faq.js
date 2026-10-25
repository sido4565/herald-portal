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
    answer: 'Open the Register page, enter your name, email, password, choose your course, and provide your ID or passport number. KCSE certificates and completion letters are optional uploads. After submitting, your account starts as pending; the portal says it will email your registration number once your account is approved.',
    category: 'registration',
  },
  {
    id: 'register-docs',
    keywords: ['documents', 'kcse', 'certificate', 'completion letter', 'upload', 'attach', 'file'],
    question: 'Which documents do I upload when registering?',
    answer: 'Your ID or passport number is required. KCSE Certificate and Completion Letter uploads are optional. The registration form accepts PDF, JPG, JPEG, and PNG files; you can still submit without those documents.',
    category: 'registration',
  },
  {
    id: 'register-pending',
    keywords: ['pending', 'approval', 'not approved', 'waiting', 'status', 'when approved'],
    question: 'Why is my account still pending?',
    answer: 'New student accounts start in PENDING status and cannot sign in until an administrator reviews them. The portal does not publish a fixed approval timeframe. If you need an update, contact support@heraldtrainer.co.ke and include your registration number.',
    category: 'registration',
  },
  {
    id: 'register-rejected',
    keywords: ['rejected', 'rejection', 'declined', 'not accepted', 'denied'],
    question: 'My application was rejected. What now?',
    answer: 'The portal marks rejected applications and blocks student login, but it does not show a rejection reason on the login page. Contact support@heraldtrainer.co.ke with your registration number to ask why it was rejected and what to do next.',
    category: 'registration',
  },

  // ─── Login / Password ───
  {
    id: 'login-forgot',
    keywords: ['forgot password', 'reset password', 'lost password', 'cannot login', "can't login", 'login failed', 'password reset'],
    question: 'I forgot my password. How do I reset it?',
    answer: 'The student login page does not currently offer a self-service password reset. Email support@heraldtrainer.co.ke with your registration number and ask for help resetting your password.',
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
    answer: 'Sign in, open your Student Dashboard, and use the Fee Statement card’s M-Pesa form. Enter your phone number and amount, then confirm the STK push on your phone. The portal does not publish a manual Paybill number, so contact support before sending a manual payment.',
    category: 'fees',
  },
  {
    id: 'fees-balance',
    keywords: ['balance', 'fee balance', 'how much', 'owe', 'outstanding', 'statement', 'fee statement', 'my fees', 'my fee'],
    question: 'How do I check my fee balance?',
    answer: 'Log in to your Student Dashboard. The "Fee Statement" card shows: total fees, amount paid, and outstanding balance. If a payment is missing, wait 5 minutes and refresh — M-Pesa confirmations can take a moment. If it is still missing after 30 minutes, email support@heraldtrainer.co.ke with the M-Pesa transaction code.',
    category: 'fees',
  },
  {
    id: 'fees-receipt',
    keywords: ['receipt', 'transaction code', 'mpesa code', 'proof of payment', 'confirmation'],
    question: 'How do I get a receipt for my M-Pesa payment?',
    answer: 'After a payment is recorded, open Fee Statement on your Student Dashboard and select Receipt on the fee row. Use your browser’s print dialog if you need a paper copy or PDF.',
    category: 'fees',
  },
  {
    id: 'fees-mpesa-failed',
    keywords: ['mpesa failed', 'payment failed', 'stk push failed', 'money deducted', 'not reflected'],
    question: 'My M-Pesa payment failed but money was deducted.',
    answer: 'If M-Pesa deducted money but your dashboard has not updated, contact support@heraldtrainer.co.ke with your registration number, transaction code, amount, and payment date. Do not retry the payment until the first transaction has been checked.',
    category: 'fees',
  },

  // ─── Courses ───
  {
    id: 'knec-preparation',
    keywords: ['knec', 'business technical', 'btep', 'artisan', 'craft examination', 'technical tvet'],
    question: 'Which KNEC exams can I prepare for?',
    answer: 'Herald offers preparation for selected KNEC Business Single & Group examinations, the Business Technical Education Programme (BTEP), and Technical TVET examinations at Artisan, Craft, Diploma, and Higher Diploma levels. Preparation tuition is KES 5,000 per month; KNEC registration and examination charges are separate. Contact us to confirm subject availability and intake dates.',
    category: 'courses',
  },
  {
    id: 'partner-monthly-fees',
    keywords: ['kasneb fees', 'abe fees', 'abma fees', 'icm fees', 'ics fees', 'nita fees', 'iata fees', 'partner tuition'],
    question: 'What is the monthly tuition for partner programs?',
    answer: 'Monthly tuition is KES 5,000 for each listed KASNEB, ABE, ABMA, ICM, ICS, NITA, and IATA program. Awarding-body registration and examination charges are separate; contact us to confirm the fees for your specific qualification.',
    category: 'courses',
  },
  {
    id: 'courses-list',
    keywords: ['courses', 'what courses', 'catalog', 'programs', 'available courses', 'course list'],
    question: 'What courses does Herald Trainer offer?',
    answer: 'The Courses page lists 37 short, business, and technical courses, with titles, course codes, fees, and durations. Partner qualifications and KNEC exam-preparation options are listed below the course catalog.',
    category: 'courses',
  },
  {
    id: 'courses-enroll',
    keywords: ['enroll', 'enrollment', 'join course', 'add course', 'register course'],
    question: 'How do I enroll in a course?',
    answer: 'Choose your course on the Register page; the portal automatically enrolls you when that course matches a course in its student catalog. To add or change a course after registration, contact support@heraldtrainer.co.ke with your registration number and course name.',
    category: 'courses',
  },
  {
    id: 'courses-drop',
    keywords: ['drop course', 'withdraw', 'unsubscribe', 'leave course', 'cancel enrollment'],
    question: 'Can I drop a course?',
    answer: 'There is no self-service course withdrawal option in the student dashboard. Contact support@heraldtrainer.co.ke with your registration number and course code to ask about withdrawal and any fee adjustment.',
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
    answer: 'The portal does not publish a general retake rule. Contact your lecturer or support@heraldtrainer.co.ke with your registration number, course code, and the reason you missed the exam to ask about the next step.',
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
    answer: 'The student dashboard does not currently show a certificate download button. Contact support@heraldtrainer.co.ke with your registration number and course to ask about completion and certificate issuance.',
    category: 'certificates',
  },

  // ─── Lecturer ───
  {
    id: 'lecturer-register',
    keywords: ['lecturer register', 'teach', 'become lecturer', 'apply to teach', 'teaching position', 'tutor'],
    question: 'How do I apply to become a lecturer?',
    answer: 'Open Lecturer Registration and submit your contact details, qualifications, specialization, and required application documents. Your application remains pending until reviewed; the portal does not publish a review timeframe. Contact support if you need an update.',
    category: 'lecturer',
  },
  {
    id: 'lecturer-upload-docs',
    keywords: ['lecturer documents', 'cv upload', 'lecturer files', 'cover letter', 'testimonials'],
    question: 'Which documents do lecturers upload?',
    answer: 'The lecturer form accepts CV and cover-letter files in PDF, DOC, or DOCX format. Testimonials/supporting documents can be PDF or image files. These upload fields are optional in the current form. Contact support if a file will not submit.',
    category: 'lecturer',
  },

  // ─── General / Support ───
  {
    id: 'support-contact',
    keywords: ['contact', 'support', 'email', 'phone', 'speak to human', 'help', 'customer service', 'reach you'],
    question: 'How do I contact support?',
    answer: 'Email support@heraldtrainer.co.ke or use the Contact page. Include your registration number for student account or fee questions; for a payment issue, include the M-Pesa transaction code. The portal does not publish a guaranteed response time.',
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
    answer: 'The portal hashes passwords rather than storing them as plain text. M-Pesa payments are confirmed through Safaricom’s STK prompt; never share your M-Pesa PIN with anyone. Contact support if you have a specific privacy or account-security concern.',
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
