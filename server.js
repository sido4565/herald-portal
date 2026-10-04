const express = require('express');
const cookieParser = require('cookie-parser');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const path = require('path');
const db = require('./database');
const multer = require('multer');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'herald-dev-secret-change-me';

app.use(express.json());
app.use(cookieParser());
app.use(express.static(path.join(__dirname, 'public')));

// ---------- File uploads ----------
const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(__dirname, 'uploads');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => {
    const safe = file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_');
    cb(null, `${Date.now()}-${req.user.id}-${safe}`);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (file.mimetype !== 'application/pdf') return cb(new Error('Only PDF files are allowed'));
    cb(null, true);
  }
});

app.use('/uploads', express.static(UPLOAD_DIR, {
  setHeaders: (res) => {
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'inline');
  }
}));

// ---------- Auth helpers ----------
const signStudent = s => jwt.sign({ id: s.id, reg: s.reg_no, type: 'student' }, JWT_SECRET, { expiresIn: '7d' });
const signAdmin = a => jwt.sign({ id: a.id, username: a.username, type: 'admin', role: a.role }, JWT_SECRET, { expiresIn: '7d' });

function authStudent(req, res, next) {
  try {
    const p = jwt.verify(req.cookies.token, JWT_SECRET);
    if (p.type !== 'student') return res.status(403).json({ error: 'Student only' });
    req.user = p; next();
  } catch { res.status(401).json({ error: 'Not authenticated' }); }
}
function authAdmin(req, res, next) {
  try {
    const p = jwt.verify(req.cookies.admin_token, JWT_SECRET);
    if (p.type !== 'admin') return res.status(403).json({ error: 'Admin only' });
    req.admin = p; next();
  } catch { res.status(401).json({ error: 'Not authenticated' }); }
}
function authLecturer(req, res, next) {
  try {
    const p = jwt.verify(req.cookies.lecturer_token, JWT_SECRET);
    if (p.type !== 'lecturer') return res.status(403).json({ error: 'Lecturer only' });
    req.lecturer = p;
    next();
  } catch { res.status(401).json({ error: 'Not authenticated' }); }
}

// ---------- Mailer helpers ----------
let mailer = null;
try { mailer = require('./mailer'); } catch (_) {}

function sendMailSafe(fnName, payload) {
  if (!mailer || !mailer.ENABLED) {
    console.log(`[mail:skipped] ${fnName} (mailer disabled)`);
    return;
  }
  if (typeof mailer[fnName] !== 'function') {
    console.log(`[mail:skipped] ${fnName} (function missing)`);
    return;
  }
  mailer[fnName](payload).catch(err => console.error(`✉️  ${fnName} failed:`, err.message));
}

// Helper: generate next registration number for current year
function generateRegNo() {
  const year = new Date().getFullYear();
  const prefix = `HRL-${year}-`;
  const last = db.prepare(
    "SELECT reg_no FROM students WHERE reg_no LIKE ? ORDER BY reg_no DESC LIMIT 1"
  ).get(`${prefix}%`);
  let nextNum = 1;
  if (last) {
    const parts = last.reg_no.split('-');
    const n = parseInt(parts[parts.length - 1], 10);
    if (!isNaN(n)) nextNum = n + 1;
  }
  return `${prefix}${String(nextNum).padStart(4, '0')}`;
}

// ==================== STUDENT ROUTES ====================
app.post('/api/login', (req, res) => {
  const { reg_no, password } = req.body;
  if (!reg_no || !password) return res.status(400).json({ error: 'Missing credentials' });
  const s = db.prepare('SELECT * FROM students WHERE reg_no = ?').get(reg_no);
  if (!s || !bcrypt.compareSync(password, s.password))
    return res.status(401).json({ error: 'Invalid registration number or password' });
  if (!s.active) return res.status(403).json({ error: 'Account deactivated. Contact admin.' });
  res.cookie('token', signStudent(s), { httpOnly: true, sameSite: 'lax' });
  res.json({ ok: true, name: s.name });
});

app.post('/api/register', async (req, res) => {
  const { name, email, password, course } = req.body;

  if (!name || !email || !password || !course) return res.status(400).json({ error: 'All fields are required.' });
  if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters.' });
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: 'Please enter a valid email address.' });

  try {
    const hash = bcrypt.hashSync(password, 10);
    const reg_no = generateRegNo();

    const info = db.prepare(
      'INSERT INTO students (reg_no, name, email, password, course) VALUES (?, ?, ?, ?, ?)'
    ).run(reg_no, name.trim(), email.trim().toLowerCase(), hash, course);

    const s = db.prepare('SELECT * FROM students WHERE id = ?').get(info.lastInsertRowid);
    res.cookie('token', signStudent(s), { httpOnly: true, sameSite: 'lax' });

    sendMailSafe('sendWelcomeEmail', {
      to: s.email,
      studentName: s.name,
      regNo: s.reg_no,
      course: s.course,
    });

    res.json({
      ok: true,
      reg_no: s.reg_no,
      name: s.name,
      message: `Your registration number is ${s.reg_no}`,
    });
  } catch (err) {
    if (String(err.message).includes('UNIQUE')) {
      return res.status(400).json({ error: 'This email is already registered.' });
    }
    console.error('Registration error:', err);
    res.status(500).json({ error: 'Registration failed. Please try again.' });
  }
});

app.post('/api/logout', (req, res) => { res.clearCookie('token'); res.json({ ok: true }); });

app.get('/api/me', authStudent, (req, res) => {
  res.json(db.prepare('SELECT id, reg_no, name, email, course FROM students WHERE id = ?').get(req.user.id));
});

// Public: full course list for the registration picker
app.get('/api/public/courses', (req, res) => {
  // Combine DB courses + the master course catalog
  const dbCourses = db.prepare('SELECT DISTINCT title, code FROM courses ORDER BY title').all();

  // Full catalog (mirrors the welcome.html COURSES array)
  const catalog = [
    // Short Courses
    { code: 'SC001', title: 'Digital Marketing & Social Media Marketing', category: 'Short Courses' },
    { code: 'SC002', title: 'AI for Business & Productivity', category: 'Short Courses' },
    { code: 'SC003', title: 'E-Commerce & Online Business', category: 'Short Courses' },
    { code: 'SC004', title: 'Business Management & Entrepreneurship', category: 'Short Courses' },
    { code: 'SC005', title: 'Advanced Excel for Business', category: 'Short Courses' },
    { code: 'SC006', title: 'Data Analytics for Business', category: 'Short Courses' },
    { code: 'SC007', title: 'Graphic Design for Business', category: 'Short Courses' },
    { code: 'SC008', title: 'Canva Design & Content Creation', category: 'Short Courses' },
    { code: 'SC009', title: 'Website Design for Small Businesses', category: 'Short Courses' },
    { code: 'SC010', title: 'Content Creation & Video Editing', category: 'Short Courses' },
    { code: 'SC011', title: 'Bookkeeping & QuickBooks', category: 'Short Courses' },
    { code: 'SC012', title: 'Accounting for Small Businesses', category: 'Short Courses' },
    { code: 'SC013', title: 'Sales & Customer Relationship Management', category: 'Short Courses' },
    { code: 'SC014', title: 'Professional Selling & Sales Management', category: 'Short Courses' },
    { code: 'SC015', title: 'Procurement & Supply Chain Basics', category: 'Short Courses' },
    { code: 'SC016', title: 'Project Management', category: 'Short Courses' },
    { code: 'SC017', title: 'Business Proposal Writing', category: 'Short Courses' },
    { code: 'SC018', title: 'Business Plan Development', category: 'Short Courses' },
    { code: 'SC019', title: 'Grant & Tender Proposal Writing', category: 'Short Courses' },
    { code: 'SC020', title: 'Personal Branding & LinkedIn Marketing', category: 'Short Courses' },
    { code: 'SC021', title: 'Cybersecurity Awareness for Businesses', category: 'Short Courses' },
    { code: 'SC022', title: 'Freelancing & Online Work Skills', category: 'Short Courses' },
    { code: 'SC023', title: 'Digital Office & Computer Applications', category: 'Short Courses' },
    { code: 'SC024', title: 'Leadership & Team Management', category: 'Short Courses' },
    { code: 'SC025', title: 'Business Communication & Professional Writing', category: 'Short Courses' },
    // Certificate courses
    { code: 'BIZ101', title: 'Business Management Fundamentals', category: 'Certificate Courses' },
    { code: 'MKT201', title: 'Digital Marketing & Sales (Certificate)', category: 'Certificate Courses' },
    { code: 'FIN301', title: 'Finance for Decision Makers', category: 'Certificate Courses' },
    { code: 'ENT401', title: 'Entrepreneurship & Startup Building', category: 'Certificate Courses' },
    { code: 'LDR501', title: 'Leadership & Strategy (Certificate)', category: 'Certificate Courses' },
    // Technical
    { code: 'ELE101', title: 'Electrical Engineering Basics', category: 'Technical Courses' },
    { code: 'WEB101', title: 'Web Development Fundamentals', category: 'Technical Courses' },
    { code: 'DB201', title: 'Database Design & SQL', category: 'Technical Courses' },
    { code: 'JS301', title: 'Advanced JavaScript', category: 'Technical Courses' },
    { code: 'PY101', title: 'Python Programming', category: 'Technical Courses' },
    { code: 'NET210', title: 'Networking Essentials', category: 'Technical Courses' }
  ];

  // Merge DB courses that aren't in the catalog
  const catalogTitles = new Set(catalog.map(c => c.title));
  const extraDb = dbCourses
    .filter(d => !catalogTitles.has(d.title))
    .map(d => ({ code: d.code || '', title: d.title, category: 'Other' }));

  const all = [...catalog, ...extraDb];
  res.json(all);
});

app.get('/api/courses', authStudent, (req, res) => {
  const courses = db.prepare('SELECT * FROM courses').all();
  const enrolled = db.prepare('SELECT course_id FROM enrollments WHERE student_id = ?').all(req.user.id).map(r => r.course_id);
  res.json(courses.map(c => ({ ...c, enrolled: enrolled.includes(c.id) })));
});

app.post('/api/enroll/:courseId', authStudent, (req, res) => {
  const cid = Number(req.params.courseId);
  const exists = db.prepare('SELECT 1 FROM enrollments WHERE student_id = ? AND course_id = ?').get(req.user.id, cid);
  if (exists) return res.status(400).json({ error: 'Already enrolled' });
  db.prepare('INSERT INTO enrollments (student_id, course_id) VALUES (?, ?)').run(req.user.id, cid);
  res.json({ ok: true });
});

app.get('/api/results', authStudent, (req, res) => {
  res.json(db.prepare(`
    SELECT r.marks, r.grade, r.term, c.code, c.title
    FROM results r JOIN courses c ON c.id = r.course_id
    WHERE r.student_id = ? ORDER BY r.term DESC
  `).all(req.user.id));
});

app.get('/api/announcements', authStudent, (req, res) => {
  res.json(db.prepare('SELECT * FROM announcements ORDER BY created_at DESC LIMIT 20').all());
});

app.get('/api/my-fees', authStudent, (req, res) => {
  res.json(db.prepare('SELECT * FROM fees WHERE student_id = ? ORDER BY term DESC').all(req.user.id));
});

app.get('/api/my-timetable', authStudent, (req, res) => {
  res.json(db.prepare(`
    SELECT t.*, c.code, c.title FROM timetable t
    JOIN courses c ON c.id = t.course_id
    JOIN enrollments e ON e.course_id = t.course_id
    WHERE e.student_id = ?
    ORDER BY CASE t.day
      WHEN 'Monday' THEN 1 WHEN 'Tuesday' THEN 2 WHEN 'Wednesday' THEN 3
      WHEN 'Thursday' THEN 4 WHEN 'Friday' THEN 5 WHEN 'Saturday' THEN 6 ELSE 7 END,
      t.start_time
  `).all(req.user.id));
});

app.get('/api/my-assignments', authStudent, (req, res) => {
  res.json(db.prepare(`
    SELECT a.*, c.code, c.title,
      (SELECT id FROM submissions WHERE assignment_id = a.id AND student_id = ?) AS submission_id,
      (SELECT grade FROM submissions WHERE assignment_id = a.id AND student_id = ?) AS grade,
      (SELECT feedback FROM submissions WHERE assignment_id = a.id AND student_id = ?) AS feedback,
      (SELECT file_name FROM submissions WHERE assignment_id = a.id AND student_id = ?) AS file_name
    FROM assignments a JOIN courses c ON c.id = a.course_id
    JOIN enrollments e ON e.course_id = a.course_id
    WHERE e.student_id = ?
    ORDER BY a.due_date ASC
  `).all(req.user.id, req.user.id, req.user.id, req.user.id, req.user.id));
});

app.post('/api/submit/:assignmentId', authStudent, upload.single('file'), (req, res) => {
  const aid = Number(req.params.assignmentId);
  const content = (req.body.content || '').trim();
  const filePath = req.file ? `/uploads/${req.file.filename}` : null;
  const fileName = req.file ? req.file.originalname : null;

  if (!content && !filePath) return res.status(400).json({ error: 'Provide text and/or a PDF file' });

  const existing = db.prepare('SELECT * FROM submissions WHERE assignment_id = ? AND student_id = ?').get(aid, req.user.id);

  if (existing) {
    if (existing.file_path && filePath && existing.file_path !== filePath) {
      const oldPath = path.join(__dirname, existing.file_path);
      if (fs.existsSync(oldPath)) fs.unlinkSync(oldPath);
    }
    db.prepare(`
      UPDATE submissions
      SET content = ?, file_path = COALESCE(?, file_path), file_name = COALESCE(?, file_name),
          submitted_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(content, filePath, fileName, existing.id);
  } else {
    db.prepare(`
      INSERT INTO submissions (assignment_id, student_id, content, file_path, file_name)
      VALUES (?, ?, ?, ?, ?)
    `).run(aid, req.user.id, content, filePath, fileName);
  }

  res.json({ ok: true, has_file: !!filePath });
});

app.get('/api/submission/:id/file', authStudent, (req, res) => {
  const sub = db.prepare('SELECT * FROM submissions WHERE id = ?').get(req.params.id);
  if (!sub || !sub.file_path) return res.status(404).json({ error: 'No file' });
  if (sub.student_id !== req.user.id) return res.status(403).json({ error: 'Not yours' });
  const fullPath = path.join(__dirname, sub.file_path);
  if (!fs.existsSync(fullPath)) return res.status(404).json({ error: 'File missing' });
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="${sub.file_name || 'submission.pdf'}"`);
  fs.createReadStream(fullPath).pipe(res);
});

app.get('/api/my-attendance', authStudent, (req, res) => {
  const records = db.prepare(`
    SELECT a.id, a.date, a.status, a.notes, c.code, c.title
    FROM attendance a JOIN courses c ON c.id = a.course_id
    WHERE a.student_id = ? ORDER BY a.date DESC LIMIT 100
  `).all(req.user.id);

  const summary = db.prepare(`
    SELECT c.code, c.title, COUNT(*) AS total,
      SUM(CASE WHEN a.status = 'present' THEN 1 ELSE 0 END) AS present,
      SUM(CASE WHEN a.status = 'absent' THEN 1 ELSE 0 END) AS absent,
      SUM(CASE WHEN a.status = 'late' THEN 1 ELSE 0 END) AS late
    FROM attendance a JOIN courses c ON c.id = a.course_id
    WHERE a.student_id = ? GROUP BY c.id
  `).all(req.user.id);

  res.json({ records, summary });
});

app.get('/api/my-live-classes', authStudent, (req, res) => {
  const rows = db.prepare(`
    SELECT lc.*, c.code, c.title AS course_title
    FROM live_classes lc JOIN courses c ON c.id = lc.course_id
    JOIN enrollments e ON e.course_id = lc.course_id
    WHERE e.student_id = ? ORDER BY lc.scheduled_at ASC
  `).all(req.user.id);

  const now = new Date();
  const enriched = rows.map(r => {
    const start = new Date(r.scheduled_at);
    const end = new Date(start.getTime() + r.duration_minutes * 60000);
    let status = 'upcoming';
    if (now >= start && now <= end) status = 'live';
    else if (now > end) status = 'ended';
    return { ...r, status, ends_at: end.toISOString() };
  });
  res.json(enriched);
});

// ==================== LECTURER ROUTES ====================
// Public: lecturer self-registration
app.post('/api/lecturer/register', async (req, res) => {
  const { name, email, phone, password, qualification, specialization, bio } = req.body;

  if (!name || !email || !password) {
    return res.status(400).json({ error: 'Name, email, and password are required.' });
  }
  if (password.length < 6) {
    return res.status(400).json({ error: 'Password must be at least 6 characters.' });
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ error: 'Please enter a valid email address.' });
  }

  try {
    // Generate staff number: HRD-LECT-YYYY-NNNN
    const year = new Date().getFullYear();
    const prefix = `HRD-LECT-${year}-`;
    const last = db.prepare(
      "SELECT staff_no FROM lecturers WHERE staff_no LIKE ? ORDER BY staff_no DESC LIMIT 1"
    ).get(`${prefix}%`);
    let nextNum = 1;
    if (last) {
      const parts = last.staff_no.split('-');
      const n = parseInt(parts[parts.length - 1], 10);
      if (!isNaN(n)) nextNum = n + 1;
    }
    const staff_no = `${prefix}${String(nextNum).padStart(4, '0')}`;

    const hash = bcrypt.hashSync(password, 10);
    const info = db.prepare(`
      INSERT INTO lecturers (staff_no, name, email, phone, password, qualification, specialization, bio)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      staff_no,
      name.trim(),
      email.trim().toLowerCase(),
      phone || '',
      hash,
      qualification || '',
      specialization || '',
      bio || ''
    );

    const lecturer = db.prepare('SELECT id, staff_no, name, email, status, approved FROM lecturers WHERE id = ?')
      .get(info.lastInsertRowid);

    // Notify superadmin
    try {
      const { sendMail, ENABLED: MAIL_ON } = require('./mailer');
      if (MAIL_ON) {
        sendMail({
          to: process.env.GMAIL_USER || process.env.MAIL_FROM_EMAIL,
          subject: 'New Lecturer Registration — Pending Approval',
          html: `
            <h2>New Lecturer Application</h2>
            <p><strong>${name}</strong> has registered as a lecturer.</p>
            <div style="background:#f5f6f8; padding:14px; border-left:3px solid #b8860b; border-radius:6px; margin:16px 0;">
              <div><strong>Staff No:</strong> ${staff_no}</div>
              <div><strong>Email:</strong> ${email}</div>
              <div><strong>Phone:</strong> ${phone || '—'}</div>
              <div><strong>Qualification:</strong> ${qualification || '—'}</div>
              <div><strong>Specialization:</strong> ${specialization || '—'}</div>
            </div>
            <p><a href="${process.env.APP_URL || 'https://herald-portal.onrender.com'}/admin-dashboard.html" style="background:#0b1a33; color:#fff; padding:12px 22px; border-radius:6px; text-decoration:none; font-weight:600;">Open Admin Panel to Approve</a></p>
          `,
        }).catch(err => console.error('Lecturer notification failed:', err.message));
      }
    } catch (e) { console.error('Notification error:', e.message); }

    res.json({
      ok: true,
      staff_no,
      name: lecturer.name,
      status: 'pending',
      message: `Your staff number is ${staff_no}. Await admin approval to log in.`,
    });
  } catch (err) {
    if (String(err.message).includes('UNIQUE')) {
      return res.status(400).json({ error: 'This email is already registered.' });
    }
    console.error('Lecturer registration error:', err);
    res.status(500).json({ error: 'Registration failed. Please try again.' });
  }
});

// Lecturer login
app.post('/api/lecturer/login', (req, res) => {
  const { staff_no, email, password } = req.body;
  if (!password || (!staff_no && !email)) {
    return res.status(400).json({ error: 'Missing credentials' });
  }

  const lecturer = staff_no
    ? db.prepare('SELECT * FROM lecturers WHERE staff_no = ?').get(staff_no)
    : db.prepare('SELECT * FROM lecturers WHERE email = ?').get(email.toLowerCase());

  if (!lecturer || !bcrypt.compareSync(password, lecturer.password)) {
    return res.status(401).json({ error: 'Invalid staff number/email or password' });
  }
  if (!lecturer.approved) {
    return res.status(403).json({ error: 'Your account is pending approval. Contact the administrator.' });
  }
  if (lecturer.status === 'suspended') {
    return res.status(403).json({ error: 'Your account has been suspended.' });
  }

  const token = jwt.sign(
    { id: lecturer.id, staff_no: lecturer.staff_no, type: 'lecturer' },
    JWT_SECRET,
    { expiresIn: '7d' }
  );
  res.cookie('lecturer_token', token, { httpOnly: true, sameSite: 'lax' });
  res.json({ ok: true, name: lecturer.name, staff_no: lecturer.staff_no });
});

app.post('/api/lecturer/logout', (req, res) => {
  res.clearCookie('lecturer_token');
  res.json({ ok: true });
});

// Get own profile
app.get('/api/lecturer/me', authLecturer, (req, res) => {
  const lecturer = db.prepare(`
    SELECT id, staff_no, name, email, phone, qualification, specialization, bio,
           photo_url, status, approved, created_at
    FROM lecturers WHERE id = ?
  `).get(req.lecturer.id);
  res.json(lecturer);
});

// Update own profile
app.put('/api/lecturer/me', authLecturer, (req, res) => {
  const { name, phone, qualification, specialization, bio } = req.body;
  db.prepare(`
    UPDATE lecturers SET name = ?, phone = ?, qualification = ?, specialization = ?, bio = ?
    WHERE id = ?
  `).run(name, phone || '', qualification || '', specialization || '', bio || '', req.lecturer.id);
  res.json({ ok: true });
});

// Change password
app.post('/api/lecturer/change-password', authLecturer, (req, res) => {
  const { currentPassword, newPassword } = req.body;
  if (!currentPassword || !newPassword) return res.status(400).json({ error: 'Missing fields' });
  if (newPassword.length < 6) return res.status(400).json({ error: 'New password must be at least 6 characters' });

  const lecturer = db.prepare('SELECT password FROM lecturers WHERE id = ?').get(req.lecturer.id);
  if (!bcrypt.compareSync(currentPassword, lecturer.password)) {
    return res.status(400).json({ error: 'Current password is incorrect' });
  }
  db.prepare('UPDATE lecturers SET password = ? WHERE id = ?')
    .run(bcrypt.hashSync(newPassword, 10), req.lecturer.id);
  res.json({ ok: true });
});

// Lecturer: list courses assigned to them (by trainer name match)
app.get('/api/lecturer/my-courses', authLecturer, (req, res) => {
  const lecturer = db.prepare('SELECT name FROM lecturers WHERE id = ?').get(req.lecturer.id);
  const courses = db.prepare(`
    SELECT c.*, (SELECT COUNT(*) FROM enrollments WHERE course_id = c.id) AS enrolled_count
    FROM courses c
    WHERE c.trainer LIKE ?
    ORDER BY c.code
  `).all(`%${lecturer.name}%`);
  res.json(courses);
});

// Lecturer: students in a course
app.get('/api/lecturer/courses/:id/students', authLecturer, (req, res) => {
  const students = db.prepare(`
    SELECT s.id, s.reg_no, s.name, s.email, s.course, s.active
    FROM students s
    JOIN enrollments e ON e.student_id = s.id
    WHERE e.course_id = ?
    ORDER BY s.name
  `).all(req.params.id);
  res.json(students);
});

// Lecturer: view results (read-only, no fees)
app.get('/api/lecturer/results', authLecturer, (req, res) => {
  const rows = db.prepare(`
    SELECT r.id, r.marks, r.grade, r.term,
           s.reg_no, s.name AS student_name,
           c.code, c.title AS course_title
    FROM results r
    JOIN students s ON s.id = r.student_id
    JOIN courses c ON c.id = r.course_id
    ORDER BY r.id DESC LIMIT 200
  `).all();
  res.json(rows);
});

// Lecturer: add a result
app.post('/api/lecturer/results', authLecturer, (req, res) => {
  const { student_id, course_id, marks, term } = req.body;
  if (!student_id || !course_id || marks == null || !term) {
    return res.status(400).json({ error: 'All fields required' });
  }
  function calcGrade(m) {
    if (m >= 80) return 'A'; if (m >= 75) return 'A-'; if (m >= 70) return 'B+';
    if (m >= 65) return 'B'; if (m >= 60) return 'B-'; if (m >= 55) return 'C+';
    if (m >= 50) return 'C'; if (m >= 45) return 'D'; return 'E';
  }
  const grade = calcGrade(Number(marks));
  db.prepare('INSERT INTO results (student_id, course_id, marks, grade, term) VALUES (?, ?, ?, ?, ?)')
    .run(student_id, course_id, marks, grade, term);
  res.json({ ok: true, grade });
});

// Lecturer: announcements (read)
app.get('/api/lecturer/announcements', authLecturer, (req, res) => {
  res.json(db.prepare('SELECT * FROM announcements ORDER BY created_at DESC').all());
});

// Lecturer: post an announcement (goes to superadmin for review? No — direct)
app.post('/api/lecturer/announcements', authLecturer, (req, res) => {
  const { title, body } = req.body;
  if (!title || !body) return res.status(400).json({ error: 'Title and body required' });
  db.prepare('INSERT INTO announcements (title, body) VALUES (?, ?)').run(title, body);
  res.json({ ok: true });
});

// Lecturer: view own timetable
app.get('/api/lecturer/timetable', authLecturer, (req, res) => {
  const rows = db.prepare(`
    SELECT t.*, c.code, c.title
    FROM timetable t
    JOIN courses c ON c.id = t.course_id
    ORDER BY CASE t.day
      WHEN 'Monday' THEN 1 WHEN 'Tuesday' THEN 2 WHEN 'Wednesday' THEN 3
      WHEN 'Thursday' THEN 4 WHEN 'Friday' THEN 5 WHEN 'Saturday' THEN 6 ELSE 7 END,
      t.start_time
  `).all();
  res.json(rows);
});

// Lecturer: take attendance (view existing)
app.get('/api/lecturer/attendance/:courseId', authLecturer, (req, res) => {
  const rows = db.prepare(`
    SELECT a.*, s.reg_no, s.name AS student_name
    FROM attendance a
    JOIN students s ON s.id = a.student_id
    WHERE a.course_id = ?
    ORDER BY a.date DESC, s.name
    LIMIT 500
  `).all(req.params.courseId);
  res.json(rows);
});

// Lecturer: save attendance
app.post('/api/lecturer/attendance', authLecturer, (req, res) => {
  const { course_id, date, records } = req.body;
  if (!course_id || !date || !Array.isArray(records)) {
    return res.status(400).json({ error: 'course_id, date, records[] required' });
  }
  const insert = db.prepare(`
    INSERT INTO attendance (course_id, student_id, date, status, marked_by, notes)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  const del = db.prepare(`DELETE FROM attendance WHERE course_id = ? AND student_id = ? AND date = ?`);
  const tx = db.transaction(() => {
    records.forEach(r => {
      del.run(course_id, r.student_id, date);
      insert.run(course_id, r.student_id, date, r.status || 'present', req.lecturer.id, r.notes || '');
    });
  });
  tx();
  res.json({ ok: true, count: records.length });
});

// ==================== ADMIN ROUTES ====================
app.post('/api/admin/login', (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Missing credentials' });
  const a = db.prepare('SELECT * FROM admins WHERE username = ?').get(username);
  if (!a || !bcrypt.compareSync(password, a.password))
    return res.status(401).json({ error: 'Invalid username or password' });
  res.cookie('admin_token', signAdmin(a), { httpOnly: true, sameSite: 'lax' });
  res.json({ ok: true, name: a.name, role: a.role });
});

app.post('/api/admin/logout', (req, res) => { res.clearCookie('admin_token'); res.json({ ok: true }); });

app.get('/api/admin/me', authAdmin, (req, res) => {
  res.json(db.prepare('SELECT id, username, name, role FROM admins WHERE id = ?').get(req.admin.id));
});

// ---------- Backup management ----------
app.get('/api/admin/backups/list', authAdmin, async (req, res) => {
  try {
    const { listBackupsOnDrive, ENABLED } = require('./backup');
    if (!ENABLED) return res.status(400).json({ error: 'Backup not configured' });
    const backups = await listBackupsOnDrive();
    res.json(backups);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/admin/backups/restore/:name', authAdmin, async (req, res) => {
  try {
    const { downloadBackupByName, validateDbFile, ENABLED } = require('./backup');
    if (!ENABLED) return res.status(400).json({ error: 'Backup not configured' });

    const name = req.params.name;
    const tempPath = path.join('/tmp', `restore-${Date.now()}.db`);

    const result = await downloadBackupByName(name, tempPath);
    if (!result.ok) {
      if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
      return res.status(400).json({ error: result.error || 'Backup not found' });
    }

    // Validation already happened inside downloadBackupByName

    const DB_PATH = path.join(process.env.DATA_DIR || __dirname, 'herald.db');
    db.pragma('wal_checkpoint(TRUNCATE)');

    const oldPath = `${DB_PATH}.old-${Date.now()}`;
    fs.renameSync(DB_PATH, oldPath);
    fs.copyFileSync(tempPath, DB_PATH);
    fs.unlinkSync(tempPath);

    console.log(`✅ Restored backup: ${name} (${result.size} bytes)`);
    res.json({
      ok: true,
      restored_from: name,
      size: result.size,
      old_backup: oldPath,
      note: 'Restart the server to load the restored DB',
    });
  } catch (err) {
    console.error('Restore error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ---------- Manual backup trigger ----------
app.post('/api/admin/backup', authAdmin, async (req, res) => {
  try {
    const { uploadBackup, createSnapshot, validateDbFile, ENABLED } = require('./backup');
    if (!ENABLED) return res.status(400).json({ error: 'Backup not configured' });

    // Force WAL checkpoint before snapshot
    db.pragma('wal_checkpoint(TRUNCATE)');

    const snapshotPath = path.join('/tmp', `herald-snapshot-${Date.now()}.db`);
    await createSnapshot(db, snapshotPath);

    // Validate the snapshot
    const validation = validateDbFile(snapshotPath);
    if (!validation.ok) {
      fs.unlinkSync(snapshotPath);
      return res.status(500).json({ error: `Snapshot invalid: ${validation.reason}` });
    }

    console.log(`📊 Snapshot size: ${validation.size} bytes (validated ✅)`);

    const result = await uploadBackup(snapshotPath, { force: true });
    fs.unlinkSync(snapshotPath);

    res.json({
      ok: true,
      size: result.size,
      filename: result.filename,
      snapshot_size: validation.size,
      at: new Date().toISOString(),
    });
  } catch (err) {
    console.error('Backup error:', err);
    res.status(500).json({ error: err.message });
  }
});
app.get('/api/admin/stats', authAdmin, (req, res) => {
  res.json({
    students: db.prepare('SELECT COUNT(*) AS c FROM students').get().c,
    courses: db.prepare('SELECT COUNT(*) AS c FROM courses').get().c,
    enrollments: db.prepare('SELECT COUNT(*) AS c FROM enrollments').get().c,
    announcements: db.prepare('SELECT COUNT(*) AS c FROM announcements').get().c
  });
});

app.post('/api/admin/backup', authAdmin, async (req, res) => {
  try {
    const { uploadBackup, createSnapshot, ENABLED } = require('./backup');
    if (!ENABLED) return res.status(400).json({ error: 'Backup not configured' });
    const snapshotPath = path.join('/tmp', `herald-snapshot-${Date.now()}.db`);
    await createSnapshot(db, snapshotPath);
    const stats = fs.statSync(snapshotPath);
    console.log(`📊 Snapshot size: ${stats.size} bytes`);
    const result = await uploadBackup(snapshotPath);
    fs.unlinkSync(snapshotPath);
    res.json({ ok: true, size: result.size, snapshot_size: stats.size, at: new Date().toISOString() });
  } catch (err) {
    console.error('Backup error:', err);
    res.status(500).json({ error: err.message });
  }
});

// --- Students
app.get('/api/admin/students', authAdmin, (req, res) => {
  res.json(db.prepare('SELECT id, reg_no, name, email, course, active, created_at FROM students ORDER BY id DESC').all());
});

app.post('/api/admin/students', authAdmin, (req, res) => {
  let { reg_no, name, email, password, course } = req.body;
  if (!name || !email || !password || !course) return res.status(400).json({ error: 'Name, email, password, and course are required.' });
  if (!reg_no) reg_no = generateRegNo();
  try {
    const hash = bcrypt.hashSync(password, 10);
    db.prepare('INSERT INTO students (reg_no, name, email, password, course) VALUES (?, ?, ?, ?, ?)')
      .run(reg_no, name, email.trim().toLowerCase(), hash, course);
    sendMailSafe('sendWelcomeEmail', { to: email, studentName: name, regNo: reg_no, course });
    res.json({ ok: true, reg_no });
  } catch (err) {
    if (String(err.message).includes('UNIQUE')) return res.status(400).json({ error: 'Reg no or email already exists.' });
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/admin/send-fee-reminders', authAdmin, async (req, res) => {
  try {
    if (!mailer || !mailer.ENABLED) return res.status(400).json({ error: 'Mailer not configured' });
    const rows = db.prepare(`
      SELECT f.amount_due - f.amount_paid AS balance, f.term, s.email, s.name
      FROM fees f JOIN students s ON s.id = f.student_id
      WHERE f.amount_due > f.amount_paid
    `).all();

    let sent = 0;
    for (const r of rows) {
      try {
        await mailer.sendFeeReminder({ to: r.email, studentName: r.name, term: r.term, balance: r.balance });
        sent++;
      } catch (e) { console.error('Fee reminder failed:', e.message); }
    }
    res.json({ ok: true, sent, total: rows.length });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.put('/api/admin/students/:id', authAdmin, (req, res) => {
  const { name, email, course, active } = req.body;
  db.prepare('UPDATE students SET name = ?, email = ?, course = ?, active = ? WHERE id = ?')
    .run(name, email, course, active ? 1 : 0, req.params.id);
  res.json({ ok: true });
});

app.delete('/api/admin/students/:id', authAdmin, (req, res) => {
  ['enrollments', 'results', 'fees', 'submissions'].forEach(t =>
    db.prepare(`DELETE FROM ${t} WHERE student_id = ?`).run(req.params.id));
  db.prepare('DELETE FROM students WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

app.post('/api/admin/students/:id/reset-password', authAdmin, async (req, res) => {
  const { newPassword } = req.body;
  if (!newPassword || newPassword.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters.' });
  try {
    db.prepare('UPDATE students SET password = ? WHERE id = ?')
      .run(bcrypt.hashSync(newPassword, 10), req.params.id);
    const student = db.prepare('SELECT name, email, reg_no FROM students WHERE id = ?').get(req.params.id);
    if (student) {
      sendMailSafe('sendMail', {
        to: student.email,
        subject: 'Your Herald Portal password has been reset',
        html: `<h2>Password Reset</h2><p>Hello ${student.name},</p>
               <p>Your password has been reset.</p>
               <p><strong>New password:</strong> <code>${newPassword}</code></p>
               <p>Reg No: ${student.reg_no}</p>`,
      });
    }
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ==================== SUPERADMIN: LECTURER MANAGEMENT ====================
app.get('/api/admin/lecturers', authAdmin, (req, res) => {
  res.json(db.prepare(`
    SELECT id, staff_no, name, email, phone, qualification, specialization,
           status, approved, created_at, approved_at
    FROM lecturers
    ORDER BY approved ASC, created_at DESC
  `).all());
});

app.post('/api/admin/lecturers/:id/approve', authAdmin, (req, res) => {
  db.prepare('UPDATE lecturers SET approved = 1, status = ?, approved_at = CURRENT_TIMESTAMP WHERE id = ?')
    .run('active', req.params.id);

  // Notify lecturer by email
  try {
    const lecturer = db.prepare('SELECT name, email, staff_no FROM lecturers WHERE id = ?').get(req.params.id);
    if (lecturer) {
      const { sendMail, ENABLED: MAIL_ON } = require('./mailer');
      if (MAIL_ON) {
        sendMail({
          to: lecturer.email,
          subject: 'Your Herald Lecturer Account is Approved',
          html: `
            <h2>Account Approved ✅</h2>
            <p>Hello ${lecturer.name},</p>
            <p>Your lecturer account has been approved. You can now log in to the Herald Lecturer Portal.</p>
            <div style="background:#f5f6f8; padding:14px; border-left:3px solid #b8860b; border-radius:6px; margin:16px 0;">
              <div><strong>Staff No:</strong> ${lecturer.staff_no}</div>
              <div><strong>Email:</strong> ${lecturer.email}</div>
            </div>
            <p><a href="${process.env.APP_URL || 'https://herald-portal.onrender.com'}/lecturer-login.html" style="background:#0b1a33; color:#fff; padding:12px 22px; border-radius:6px; text-decoration:none; font-weight:600;">Log in to Lecturer Portal</a></p>
          `,
        }).catch(err => console.error('Approval email failed:', err.message));
      }
    }
  } catch (e) { console.error(e.message); }

  res.json({ ok: true });
});

app.post('/api/admin/lecturers/:id/reject', authAdmin, (req, res) => {
  db.prepare('UPDATE lecturers SET approved = 0, status = ? WHERE id = ?').run('rejected', req.params.id);
  res.json({ ok: true });
});

app.post('/api/admin/lecturers/:id/suspend', authAdmin, (req, res) => {
  db.prepare('UPDATE lecturers SET status = ? WHERE id = ?').run('suspended', req.params.id);
  res.json({ ok: true });
});

app.post('/api/admin/lecturers/:id/reactivate', authAdmin, (req, res) => {
  db.prepare('UPDATE lecturers SET status = ?, approved = 1 WHERE id = ?').run('active', req.params.id);
  res.json({ ok: true });
});

app.delete('/api/admin/lecturers/:id', authAdmin, (req, res) => {
  db.prepare('DELETE FROM lecturers WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// Superadmin: create lecturer directly
app.post('/api/admin/lecturers', authAdmin, (req, res) => {
  const { name, email, phone, password, qualification, specialization, bio } = req.body;
  if (!name || !email || !password) return res.status(400).json({ error: 'Name, email, password required' });

  try {
    const year = new Date().getFullYear();
    const prefix = `HRD-LECT-${year}-`;
    const last = db.prepare("SELECT staff_no FROM lecturers WHERE staff_no LIKE ? ORDER BY staff_no DESC LIMIT 1").get(`${prefix}%`);
    let nextNum = 1;
    if (last) {
      const parts = last.staff_no.split('-');
      const n = parseInt(parts[parts.length - 1], 10);
      if (!isNaN(n)) nextNum = n + 1;
    }
    const staff_no = `${prefix}${String(nextNum).padStart(4, '0')}`;

    const hash = bcrypt.hashSync(password, 10);
    db.prepare(`
      INSERT INTO lecturers (staff_no, name, email, phone, password, qualification, specialization, bio, approved, status, approved_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, 'active', CURRENT_TIMESTAMP)
    `).run(staff_no, name, email.toLowerCase(), phone || '', hash, qualification || '', specialization || '', bio || '');

    res.json({ ok: true, staff_no });
  } catch (err) {
    if (String(err.message).includes('UNIQUE')) {
      return res.status(400).json({ error: 'Email already exists' });
    }
    res.status(500).json({ error: err.message });
  }
});

// --- Courses
app.get('/api/admin/courses', authAdmin, (req, res) => {
  res.json(db.prepare(`
    SELECT c.*, (SELECT COUNT(*) FROM enrollments WHERE course_id = c.id) AS enrolled_count
    FROM courses c ORDER BY c.id
  `).all());
});

app.post('/api/admin/courses', authAdmin, (req, res) => {
  const { code, title, trainer, description } = req.body;
  if (!code || !title || !trainer) return res.status(400).json({ error: 'Code, title, trainer required' });
  try {
    db.prepare('INSERT INTO courses (code, title, trainer, description) VALUES (?, ?, ?, ?)')
      .run(code, title, trainer, description || '');
    res.json({ ok: true });
  } catch { res.status(400).json({ error: 'Course code already exists' }); }
});

app.put('/api/admin/courses/:id', authAdmin, (req, res) => {
  const { code, title, trainer, description } = req.body;
  db.prepare('UPDATE courses SET code = ?, title = ?, trainer = ?, description = ? WHERE id = ?')
    .run(code, title, trainer, description || '', req.params.id);
  res.json({ ok: true });
});

app.delete('/api/admin/courses/:id', authAdmin, (req, res) => {
  ['enrollments', 'results', 'timetable', 'assignments'].forEach(t =>
    db.prepare(`DELETE FROM ${t} WHERE course_id = ?`).run(req.params.id));
  db.prepare('DELETE FROM courses WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

app.get('/api/admin/courses/:id/students', authAdmin, (req, res) => {
  res.json(db.prepare(`
    SELECT s.id, s.reg_no, s.name, s.email FROM students s
    JOIN enrollments e ON e.student_id = s.id WHERE e.course_id = ?
  `).all(req.params.id));
});

// --- Announcements
app.get('/api/admin/announcements', authAdmin, (req, res) => {
  res.json(db.prepare('SELECT * FROM announcements ORDER BY created_at DESC').all());
});

app.post('/api/admin/announcements', authAdmin, (req, res) => {
  const { title, body } = req.body;
  if (!title || !body) return res.status(400).json({ error: 'Title and body required' });
  db.prepare('INSERT INTO announcements (title, body) VALUES (?, ?)').run(title, body);
  res.json({ ok: true });
});

app.put('/api/admin/announcements/:id', authAdmin, (req, res) => {
  const { title, body } = req.body;
  db.prepare('UPDATE announcements SET title = ?, body = ? WHERE id = ?').run(title, body, req.params.id);
  res.json({ ok: true });
});

app.delete('/api/admin/announcements/:id', authAdmin, (req, res) => {
  db.prepare('DELETE FROM announcements WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// --- Results
function calcGrade(m) {
  if (m >= 80) return 'A'; if (m >= 75) return 'A-'; if (m >= 70) return 'B+';
  if (m >= 65) return 'B'; if (m >= 60) return 'B-'; if (m >= 55) return 'C+';
  if (m >= 50) return 'C'; if (m >= 45) return 'D'; return 'E';
}

app.get('/api/admin/results', authAdmin, (req, res) => {
  res.json(db.prepare(`
    SELECT r.id, r.marks, r.grade, r.term, s.reg_no, s.name AS student_name, c.code, c.title AS course_title
    FROM results r JOIN students s ON s.id = r.student_id JOIN courses c ON c.id = r.course_id
    ORDER BY r.id DESC
  `).all());
});

app.post('/api/admin/results', authAdmin, (req, res) => {
  const { student_id, course_id, marks, term } = req.body;
  if (!student_id || !course_id || marks == null || !term) return res.status(400).json({ error: 'All fields required' });
  const grade = calcGrade(Number(marks));
  db.prepare('INSERT INTO results (student_id, course_id, marks, grade, term) VALUES (?, ?, ?, ?, ?)')
    .run(student_id, course_id, marks, grade, term);
  res.json({ ok: true, grade });
});

app.delete('/api/admin/results/:id', authAdmin, (req, res) => {
  db.prepare('DELETE FROM results WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// --- Fees
app.get('/api/admin/fees', authAdmin, (req, res) => {
  res.json(db.prepare(`
    SELECT f.*, s.reg_no, s.name AS student_name
    FROM fees f JOIN students s ON s.id = f.student_id ORDER BY f.id DESC
  `).all());
});

app.get('/api/admin/fees/summary', authAdmin, (req, res) => {
  res.json(db.prepare(`
    SELECT COALESCE(SUM(amount_due), 0) AS total_due, COALESCE(SUM(amount_paid), 0) AS total_paid,
      COUNT(*) AS records,
      SUM(CASE WHEN status = 'paid' THEN 1 ELSE 0 END) AS paid_count,
      SUM(CASE WHEN status = 'partial' THEN 1 ELSE 0 END) AS partial_count,
      SUM(CASE WHEN status = 'unpaid' THEN 1 ELSE 0 END) AS unpaid_count
    FROM fees
  `).get());
});

app.post('/api/admin/fees', authAdmin, (req, res) => {
  const { student_id, term, amount_due, amount_paid } = req.body;
  if (!student_id || !term || amount_due == null) return res.status(400).json({ error: 'Required fields missing' });
  const paid = Number(amount_paid || 0), due = Number(amount_due);
  const status = paid >= due ? 'paid' : (paid > 0 ? 'partial' : 'unpaid');
  db.prepare('INSERT INTO fees (student_id, term, amount_due, amount_paid, status, paid_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(student_id, term, due, paid, status, paid > 0 ? new Date().toISOString() : null);
  res.json({ ok: true });
});

app.put('/api/admin/fees/:id', authAdmin, (req, res) => {
  const { amount_due, amount_paid } = req.body;
  const due = Number(amount_due), paid = Number(amount_paid);
  const status = paid >= due ? 'paid' : (paid > 0 ? 'partial' : 'unpaid');
  db.prepare('UPDATE fees SET amount_due = ?, amount_paid = ?, status = ?, paid_at = ? WHERE id = ?')
    .run(due, paid, status, paid > 0 ? new Date().toISOString() : null, req.params.id);
  res.json({ ok: true });
});

app.post('/api/admin/fees/:id/pay', authAdmin, (req, res) => {
  const { amount } = req.body;
  if (!amount || Number(amount) <= 0) return res.status(400).json({ error: 'Amount must be > 0' });
  const fee = db.prepare('SELECT * FROM fees WHERE id = ?').get(req.params.id);
  if (!fee) return res.status(404).json({ error: 'Fee record not found' });
  const newPaid = Number(fee.amount_paid) + Number(amount);
  const status = newPaid >= fee.amount_due ? 'paid' : (newPaid > 0 ? 'partial' : 'unpaid');
  db.prepare('UPDATE fees SET amount_paid = ?, status = ?, paid_at = ? WHERE id = ?')
    .run(newPaid, status, new Date().toISOString(), req.params.id);
  res.json({ ok: true, new_paid: newPaid, status });
});

app.delete('/api/admin/fees/:id', authAdmin, (req, res) => {
  db.prepare('DELETE FROM fees WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// --- Timetable
app.get('/api/admin/timetable', authAdmin, (req, res) => {
  res.json(db.prepare(`
    SELECT t.*, c.code, c.title FROM timetable t JOIN courses c ON c.id = t.course_id
    ORDER BY CASE t.day
      WHEN 'Monday' THEN 1 WHEN 'Tuesday' THEN 2 WHEN 'Wednesday' THEN 3
      WHEN 'Thursday' THEN 4 WHEN 'Friday' THEN 5 WHEN 'Saturday' THEN 6 ELSE 7 END,
      t.start_time
  `).all());
});

app.post('/api/admin/timetable', authAdmin, (req, res) => {
  const { course_id, day, start_time, end_time, room, trainer } = req.body;
  if (!course_id || !day || !start_time || !end_time) return res.status(400).json({ error: 'Required fields missing' });
  db.prepare('INSERT INTO timetable (course_id, day, start_time, end_time, room, trainer) VALUES (?, ?, ?, ?, ?, ?)')
    .run(course_id, day, start_time, end_time, room || '', trainer || '');
  res.json({ ok: true });
});

app.delete('/api/admin/timetable/:id', authAdmin, (req, res) => {
  db.prepare('DELETE FROM timetable WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// --- Assignments
app.get('/api/admin/assignments', authAdmin, (req, res) => {
  res.json(db.prepare(`
    SELECT a.*, c.code, c.title,
      (SELECT COUNT(*) FROM submissions WHERE assignment_id = a.id) AS submission_count,
      (SELECT COUNT(*) FROM submissions WHERE assignment_id = a.id AND grade IS NOT NULL AND grade != '') AS graded_count,
      (SELECT COUNT(*) FROM submissions WHERE assignment_id = a.id AND file_path IS NOT NULL) AS file_count
    FROM assignments a JOIN courses c ON c.id = a.course_id ORDER BY a.id DESC
  `).all());
});

app.post('/api/admin/assignments', authAdmin, (req, res) => {
  const { course_id, title, description, due_date } = req.body;
  if (!course_id || !title) return res.status(400).json({ error: 'Course and title required' });
  db.prepare('INSERT INTO assignments (course_id, title, description, due_date) VALUES (?, ?, ?, ?)')
    .run(course_id, title, description || '', due_date || '');
  res.json({ ok: true });
});

app.delete('/api/admin/assignments/:id', authAdmin, (req, res) => {
  db.prepare('DELETE FROM submissions WHERE assignment_id = ?').run(req.params.id);
  db.prepare('DELETE FROM assignments WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

app.get('/api/admin/assignments/:id/submissions', authAdmin, (req, res) => {
  res.json(db.prepare(`
    SELECT sub.*, s.reg_no, s.name AS student_name
    FROM submissions sub JOIN students s ON s.id = sub.student_id
    WHERE sub.assignment_id = ? ORDER BY sub.submitted_at DESC
  `).all(req.params.id));
});

app.get('/api/admin/submission/:id/file', authAdmin, (req, res) => {
  const sub = db.prepare('SELECT * FROM submissions WHERE id = ?').get(req.params.id);
  if (!sub || !sub.file_path) return res.status(404).json({ error: 'No file' });
  const fullPath = path.join(__dirname, sub.file_path);
  if (!fs.existsSync(fullPath)) return res.status(404).json({ error: 'File missing' });
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="${sub.file_name || 'submission.pdf'}"`);
  fs.createReadStream(fullPath).pipe(res);
});

app.put('/api/admin/submissions/:id', authAdmin, async (req, res) => {
  const { grade, feedback } = req.body;
  db.prepare('UPDATE submissions SET grade = ?, feedback = ? WHERE id = ?')
    .run(grade || '', feedback || '', req.params.id);

  if (grade) {
    const sub = db.prepare(`
      SELECT sub.*, s.email, s.name AS student_name, a.title AS assignment_title, c.code AS course_code
      FROM submissions sub
      JOIN students s ON s.id = sub.student_id
      JOIN assignments a ON a.id = sub.assignment_id
      JOIN courses c ON c.id = a.course_id
      WHERE sub.id = ?
    `).get(req.params.id);

    if (sub) {
      sendMailSafe('sendAssignmentGraded', {
        to: sub.email,
        studentName: sub.student_name,
        assignmentTitle: sub.assignment_title,
        courseCode: sub.course_code,
        grade,
        feedback,
      });
    }
  }

  res.json({ ok: true });
});

// --- Attendance (admin)
app.get('/api/admin/attendance/:courseId', authAdmin, (req, res) => {
  res.json(db.prepare(`
    SELECT a.*, s.reg_no, s.name AS student_name
    FROM attendance a JOIN students s ON s.id = a.student_id
    WHERE a.course_id = ?
    ORDER BY a.date DESC, s.name ASC
    LIMIT 500
  `).all(req.params.courseId));
});

app.post('/api/admin/attendance', authAdmin, (req, res) => {
  const { course_id, date, records } = req.body;
  if (!course_id || !date || !Array.isArray(records)) {
    return res.status(400).json({ error: 'course_id, date, records[] required' });
  }
  const insert = db.prepare(`INSERT INTO attendance (course_id, student_id, date, status, marked_by, notes) VALUES (?, ?, ?, ?, ?, ?)`);
  const del = db.prepare(`DELETE FROM attendance WHERE course_id = ? AND student_id = ? AND date = ?`);
  const tx = db.transaction(() => {
    records.forEach(r => {
      del.run(course_id, r.student_id, date);
      insert.run(course_id, r.student_id, date, r.status || 'present', req.admin.id, r.notes || '');
    });
  });
  tx();
  res.json({ ok: true, count: records.length });
});

app.get('/api/admin/attendance-summary/:courseId', authAdmin, (req, res) => {
  res.json(db.prepare(`
    SELECT s.id, s.reg_no, s.name,
      COUNT(a.id) AS total,
      SUM(CASE WHEN a.status = 'present' THEN 1 ELSE 0 END) AS present,
      SUM(CASE WHEN a.status = 'absent' THEN 1 ELSE 0 END) AS absent,
      SUM(CASE WHEN a.status = 'late' THEN 1 ELSE 0 END) AS late
    FROM students s
    JOIN enrollments e ON e.student_id = s.id AND e.course_id = ?
    LEFT JOIN attendance a ON a.student_id = s.id AND a.course_id = ?
    GROUP BY s.id ORDER BY s.name
  `).all(req.params.courseId, req.params.courseId));
});

app.delete('/api/admin/attendance/:id', authAdmin, (req, res) => {
  db.prepare('DELETE FROM attendance WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// --- Live Classes (admin)
app.get('/api/admin/live-classes', authAdmin, (req, res) => {
  res.json(db.prepare(`
    SELECT lc.*, c.code, c.title AS course_title
    FROM live_classes lc JOIN courses c ON c.id = lc.course_id
    ORDER BY lc.scheduled_at DESC
  `).all());
});

app.post('/api/admin/live-classes', authAdmin, async (req, res) => {
  const { course_id, title, description, meeting_url, scheduled_at, duration_minutes, notify } = req.body;
  if (!course_id || !title || !meeting_url || !scheduled_at) {
    return res.status(400).json({ error: 'course_id, title, meeting_url, scheduled_at required' });
  }
  const info = db.prepare(`
    INSERT INTO live_classes (course_id, title, description, meeting_url, scheduled_at, duration_minutes, created_by)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(course_id, title, description || '', meeting_url, scheduled_at, Number(duration_minutes) || 60, req.admin.id);

  if (notify && mailer && mailer.ENABLED) {
    try {
      const students = db.prepare(`
        SELECT s.email, s.name FROM students s
        JOIN enrollments e ON e.student_id = s.id
        WHERE e.course_id = ?
      `).all(course_id);
      const course = db.prepare('SELECT code, title FROM courses WHERE id = ?').get(course_id);
      for (const s of students) {
        mailer.sendLiveClassNotification({
          to: s.email,
          studentName: s.name,
          courseCode: course.code,
          courseTitle: course.title,
          classTitle: title,
          scheduledAt: new Date(scheduled_at),
          meetingUrl: meeting_url,
        }).catch(err => console.error('Class email failed:', err.message));
      }
    } catch (e) {
      console.error('Class notification error:', e.message);
    }
  }

  res.json({ ok: true, id: info.lastInsertRowid });
});

app.delete('/api/admin/live-classes/:id', authAdmin, (req, res) => {
  db.prepare('DELETE FROM live_classes WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

app.listen(PORT, () => console.log(`Herald Portal running on http://localhost:${PORT}`));