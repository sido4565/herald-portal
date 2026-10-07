const express = require('express');
const cookieParser = require('cookie-parser');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const db = require('./database');

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
    cb(null, `${Date.now()}-${req.user?.id || req.lecturer?.id || 'anon'}-${safe}`);
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

const materialUpload = multer({
  storage,
  limits: { fileSize: 25 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = [
      'application/pdf',
      'application/msword',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'application/vnd.ms-powerpoint',
      'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      'image/jpeg', 'image/png', 'image/webp',
      'video/mp4', 'video/webm',
    ];
    if (!allowed.includes(file.mimetype)) return cb(new Error('Unsupported file type'));
    cb(null, true);
  },
});

app.use('/uploads', express.static(UPLOAD_DIR, {
  setHeaders: (res) => {
    res.setHeader('Content-Disposition', 'inline');
  }
}));

// ---------- Auth helpers ----------
const signStudent = s => jwt.sign({ id: s.id, reg: s.reg_no, type: 'student' }, JWT_SECRET, { expiresIn: '7d' });
const signAdmin = a => jwt.sign({ id: a.id, username: a.username, type: 'admin', role: a.role }, JWT_SECRET, { expiresIn: '7d' });
const signLecturer = l => jwt.sign({ id: l.id, staff_no: l.staff_no, type: 'lecturer' }, JWT_SECRET, { expiresIn: '7d' });

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
    req.lecturer = p; next();
  } catch { res.status(401).json({ error: 'Not authenticated' }); }
}

// ---------- Mailer helper ----------
let mailer = null;
try { mailer = require('./mailer'); } catch (_) {}

function sendMailSafe(fnName, payload) {
  if (!mailer || !mailer.ENABLED) return;
  if (typeof mailer[fnName] !== 'function') return;
  mailer[fnName](payload).catch(err => console.error(`✉️  ${fnName} failed:`, err.message));
}

// ---------- Registration number generator ----------
async function generateRegNo() {
  const year = new Date().getFullYear();
  const prefix = `HRL-${year}-`;
  const last = await db.execute({
    sql: "SELECT reg_no FROM students WHERE reg_no LIKE ? ORDER BY reg_no DESC LIMIT 1",
    args: [`${prefix}%`],
  });
  let nextNum = 1;
  if (last.rows.length) {
    const parts = last.rows[0].reg_no.split('-');
    const n = parseInt(parts[parts.length - 1], 10);
    if (!isNaN(n)) nextNum = n + 1;
  }
  return `${prefix}${String(nextNum).padStart(4, '0')}`;
}

async function generateStaffNo() {
  const year = new Date().getFullYear();
  const prefix = `HRD-LECT-${year}-`;
  const last = await db.execute({
    sql: "SELECT staff_no FROM lecturers WHERE staff_no LIKE ? ORDER BY staff_no DESC LIMIT 1",
    args: [`${prefix}%`],
  });
  let nextNum = 1;
  if (last.rows.length) {
    const parts = last.rows[0].staff_no.split('-');
    const n = parseInt(parts[parts.length - 1], 10);
    if (!isNaN(n)) nextNum = n + 1;
  }
  return `${prefix}${String(nextNum).padStart(4, '0')}`;
}

function calcGrade(m) {
  if (m >= 80) return 'A'; if (m >= 75) return 'A-'; if (m >= 70) return 'B+';
  if (m >= 65) return 'B'; if (m >= 60) return 'B-'; if (m >= 55) return 'C+';
  if (m >= 50) return 'C'; if (m >= 45) return 'D'; return 'E';
}

// ==================== STUDENT ROUTES ====================
app.post('/api/login', async (req, res) => {
  const { reg_no, password } = req.body;
  if (!reg_no || !password) return res.status(400).json({ error: 'Missing credentials' });
  const result = await db.execute({ sql: 'SELECT * FROM students WHERE reg_no = ?', args: [reg_no] });
  const s = result.rows[0];
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
    const reg_no = await generateRegNo();

    const info = await db.execute({
      sql: 'INSERT INTO students (reg_no, name, email, password, course) VALUES (?, ?, ?, ?, ?)',
      args: [reg_no, name.trim(), email.trim().toLowerCase(), hash, course],
    });

    const sRes = await db.execute({
      sql: 'SELECT * FROM students WHERE id = ?',
      args: [info.lastInsertRowid],
    });
    const s = sRes.rows[0];
    res.cookie('token', signStudent(s), { httpOnly: true, sameSite: 'lax' });

    sendMailSafe('sendWelcomeEmail', {
      to: s.email,
      studentName: s.name,
      regNo: s.reg_no,
      course: s.course,
    });

    res.json({ ok: true, reg_no: s.reg_no, name: s.name, message: `Your registration number is ${s.reg_no}` });
  } catch (err) {
    if (String(err.message).includes('UNIQUE')) {
      return res.status(400).json({ error: 'This email is already registered.' });
    }
    console.error('Registration error:', err);
    res.status(500).json({ error: 'Registration failed. Please try again.' });
  }
});

app.post('/api/logout', (req, res) => { res.clearCookie('token'); res.json({ ok: true }); });

app.get('/api/me', authStudent, async (req, res) => {
  const r = await db.execute({
    sql: 'SELECT id, reg_no, name, email, course FROM students WHERE id = ?',
    args: [req.user.id],
  });
  res.json(r.rows[0]);
});

// Public course list for registration picker
app.get('/api/public/courses', async (req, res) => {
  const dbCourses = await db.execute('SELECT DISTINCT title, code FROM courses ORDER BY title');
  const catalog = [
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
    { code: 'BIZ101', title: 'Business Management Fundamentals', category: 'Certificate Courses' },
    { code: 'MKT201', title: 'Digital Marketing & Sales (Certificate)', category: 'Certificate Courses' },
    { code: 'FIN301', title: 'Finance for Decision Makers', category: 'Certificate Courses' },
    { code: 'ENT401', title: 'Entrepreneurship & Startup Building', category: 'Certificate Courses' },
    { code: 'LDR501', title: 'Leadership & Strategy (Certificate)', category: 'Certificate Courses' },
    { code: 'ELE101', title: 'Electrical Engineering Basics', category: 'Technical Courses' },
    { code: 'WEB101', title: 'Web Development Fundamentals', category: 'Technical Courses' },
    { code: 'DB201', title: 'Database Design & SQL', category: 'Technical Courses' },
    { code: 'JS301', title: 'Advanced JavaScript', category: 'Technical Courses' },
    { code: 'PY101', title: 'Python Programming', category: 'Technical Courses' },
    { code: 'NET210', title: 'Networking Essentials', category: 'Technical Courses' },
  ];
  const catalogTitles = new Set(catalog.map(c => c.title));
  const extraDb = dbCourses.rows
    .filter(d => !catalogTitles.has(d.title))
    .map(d => ({ code: d.code || '', title: d.title, category: 'Other' }));
  res.json([...catalog, ...extraDb]);
});

app.get('/api/courses', authStudent, async (req, res) => {
  const courses = await db.execute('SELECT * FROM courses');
  const enrolled = await db.execute({
    sql: 'SELECT course_id FROM enrollments WHERE student_id = ?',
    args: [req.user.id],
  });
  const enrolledIds = enrolled.rows.map(r => r.course_id);
  res.json(courses.rows.map(c => ({ ...c, enrolled: enrolledIds.includes(c.id) })));
});

app.post('/api/enroll/:courseId', authStudent, async (req, res) => {
  const cid = Number(req.params.courseId);
  const exists = await db.execute({
    sql: 'SELECT 1 FROM enrollments WHERE student_id = ? AND course_id = ?',
    args: [req.user.id, cid],
  });
  if (exists.rows.length) return res.status(400).json({ error: 'Already enrolled' });
  await db.execute({
    sql: 'INSERT INTO enrollments (student_id, course_id) VALUES (?, ?)',
    args: [req.user.id, cid],
  });
  res.json({ ok: true });
});

app.get('/api/results', authStudent, async (req, res) => {
  const r = await db.execute({
    sql: `SELECT r.marks, r.grade, r.term, c.code, c.title
          FROM results r JOIN courses c ON c.id = r.course_id
          WHERE r.student_id = ? ORDER BY r.term DESC`,
    args: [req.user.id],
  });
  res.json(r.rows);
});

app.get('/api/announcements', authStudent, async (req, res) => {
  const r = await db.execute('SELECT * FROM announcements ORDER BY created_at DESC LIMIT 20');
  res.json(r.rows);
});

app.get('/api/my-fees', authStudent, async (req, res) => {
  const r = await db.execute({
    sql: 'SELECT * FROM fees WHERE student_id = ? ORDER BY term DESC',
    args: [req.user.id],
  });
  res.json(r.rows);
});

app.get('/api/my-timetable', authStudent, async (req, res) => {
  const r = await db.execute({
    sql: `SELECT t.*, c.code, c.title FROM timetable t
          JOIN courses c ON c.id = t.course_id
          JOIN enrollments e ON e.course_id = t.course_id
          WHERE e.student_id = ?
          ORDER BY CASE t.day
            WHEN 'Monday' THEN 1 WHEN 'Tuesday' THEN 2 WHEN 'Wednesday' THEN 3
            WHEN 'Thursday' THEN 4 WHEN 'Friday' THEN 5 WHEN 'Saturday' THEN 6 ELSE 7 END,
            t.start_time`,
    args: [req.user.id],
  });
  res.json(r.rows);
});

app.get('/api/my-assignments', authStudent, async (req, res) => {
  const r = await db.execute({
    sql: `SELECT a.*, c.code, c.title,
            (SELECT id FROM submissions WHERE assignment_id = a.id AND student_id = ?) AS submission_id,
            (SELECT grade FROM submissions WHERE assignment_id = a.id AND student_id = ?) AS grade,
            (SELECT feedback FROM submissions WHERE assignment_id = a.id AND student_id = ?) AS feedback,
            (SELECT file_name FROM submissions WHERE assignment_id = a.id AND student_id = ?) AS file_name
          FROM assignments a JOIN courses c ON c.id = a.course_id
          JOIN enrollments e ON e.course_id = a.course_id
          WHERE e.student_id = ?
          ORDER BY a.due_date ASC`,
    args: [req.user.id, req.user.id, req.user.id, req.user.id, req.user.id],
  });
  res.json(r.rows);
});

app.post('/api/submit/:assignmentId', authStudent, upload.single('file'), async (req, res) => {
  const aid = Number(req.params.assignmentId);
  const content = (req.body.content || '').trim();
  const filePath = req.file ? `/uploads/${req.file.filename}` : null;
  const fileName = req.file ? req.file.originalname : null;

  if (!content && !filePath) return res.status(400).json({ error: 'Provide text and/or a PDF file' });

  const existing = await db.execute({
    sql: 'SELECT * FROM submissions WHERE assignment_id = ? AND student_id = ?',
    args: [aid, req.user.id],
  });

  if (existing.rows.length) {
    const old = existing.rows[0];
    if (old.file_path && filePath && old.file_path !== filePath) {
      const oldPath = path.join(__dirname, old.file_path);
      if (fs.existsSync(oldPath)) fs.unlinkSync(oldPath);
    }
    await db.execute({
      sql: `UPDATE submissions SET content = ?, file_path = COALESCE(?, file_path),
            file_name = COALESCE(?, file_name), submitted_at = CURRENT_TIMESTAMP WHERE id = ?`,
      args: [content, filePath, fileName, old.id],
    });
  } else {
    await db.execute({
      sql: 'INSERT INTO submissions (assignment_id, student_id, content, file_path, file_name) VALUES (?, ?, ?, ?, ?)',
      args: [aid, req.user.id, content, filePath, fileName],
    });
  }

  res.json({ ok: true, has_file: !!filePath });
});

app.get('/api/submission/:id/file', authStudent, async (req, res) => {
  const r = await db.execute({ sql: 'SELECT * FROM submissions WHERE id = ?', args: [req.params.id] });
  const sub = r.rows[0];
  if (!sub || !sub.file_path) return res.status(404).json({ error: 'No file' });
  if (sub.student_id !== req.user.id) return res.status(403).json({ error: 'Not yours' });
  const fullPath = path.join(__dirname, sub.file_path);
  if (!fs.existsSync(fullPath)) return res.status(404).json({ error: 'File missing' });
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="${sub.file_name || 'submission.pdf'}"`);
  fs.createReadStream(fullPath).pipe(res);
});

app.get('/api/my-attendance', authStudent, async (req, res) => {
  const records = await db.execute({
    sql: `SELECT a.id, a.date, a.status, a.notes, c.code, c.title
          FROM attendance a JOIN courses c ON c.id = a.course_id
          WHERE a.student_id = ? ORDER BY a.date DESC LIMIT 100`,
    args: [req.user.id],
  });
  const summary = await db.execute({
    sql: `SELECT c.code, c.title, COUNT(*) AS total,
            SUM(CASE WHEN a.status = 'present' THEN 1 ELSE 0 END) AS present,
            SUM(CASE WHEN a.status = 'absent' THEN 1 ELSE 0 END) AS absent,
            SUM(CASE WHEN a.status = 'late' THEN 1 ELSE 0 END) AS late
          FROM attendance a JOIN courses c ON c.id = a.course_id
          WHERE a.student_id = ? GROUP BY c.id`,
    args: [req.user.id],
  });
  res.json({ records: records.rows, summary: summary.rows });
});

app.get('/api/my-live-classes', authStudent, async (req, res) => {
  const r = await db.execute({
    sql: `SELECT lc.*, c.code, c.title AS course_title
          FROM live_classes lc JOIN courses c ON c.id = lc.course_id
          JOIN enrollments e ON e.course_id = lc.course_id
          WHERE e.student_id = ? ORDER BY lc.scheduled_at ASC`,
    args: [req.user.id],
  });
  const now = new Date();
  const enriched = r.rows.map(row => {
    const start = new Date(row.scheduled_at);
    const end = new Date(start.getTime() + row.duration_minutes * 60000);
    let status = 'upcoming';
    if (now >= start && now <= end) status = 'live';
    else if (now > end) status = 'ended';
    return { ...row, status, ends_at: end.toISOString() };
  });
  res.json(enriched);
});

app.get('/api/my-materials', authStudent, async (req, res) => {
  const now = new Date();
  const r = await db.execute({
    sql: `SELECT m.id, m.title, m.description, m.material_type, m.file_path, m.file_name,
            m.external_url, m.release_date, m.created_at,
            c.code, c.title AS course_title
          FROM materials m
          JOIN courses c ON c.id = m.course_id
          JOIN enrollments e ON e.course_id = m.course_id
          WHERE e.student_id = ?
          ORDER BY m.release_date ASC, m.id ASC`,
    args: [req.user.id],
  });
  const enriched = r.rows.map(m => {
    const releaseDate = new Date(m.release_date);
    const isUnlocked = now >= releaseDate;
    const isToday = releaseDate.toDateString() === now.toDateString();
    return {
      ...m,
      unlocked: isUnlocked,
      isToday,
      release_date_formatted: releaseDate.toLocaleDateString('en-KE', {
        weekday: 'short', year: 'numeric', month: 'short', day: 'numeric',
      }),
    };
  });
  res.json(enriched);
});

app.get('/api/my-materials/:id', authStudent, async (req, res) => {
  const r = await db.execute({
    sql: `SELECT m.*, c.code, c.title AS course_title
          FROM materials m
          JOIN courses c ON c.id = m.course_id
          JOIN enrollments e ON e.course_id = m.course_id
          WHERE m.id = ? AND e.student_id = ?`,
    args: [req.params.id, req.user.id],
  });
  const m = r.rows[0];
  if (!m) return res.status(404).json({ error: 'Material not found' });
  if (new Date() < new Date(m.release_date)) {
    return res.status(423).json({ error: 'This material is not yet available', release_date: m.release_date });
  }
  await db.execute({
    sql: 'INSERT INTO material_views (material_id, student_id) VALUES (?, ?)',
    args: [m.id, req.user.id],
  });
  res.json(m);
});

app.get('/api/my-transcript', authStudent, async (req, res) => {
  const sRes = await db.execute({
    sql: 'SELECT reg_no, name, email, course FROM students WHERE id = ?',
    args: [req.user.id],
  });
  const student = sRes.rows[0];

  const rRes = await db.execute({
    sql: `SELECT r.marks, r.grade, r.term, c.code AS course_code, c.title AS course_title
          FROM results r JOIN courses c ON c.id = r.course_id
          WHERE r.student_id = ?
          ORDER BY r.term ASC, c.code ASC`,
    args: [req.user.id],
  });

  const results = rRes.rows;
  const byTerm = {};
  results.forEach(r => {
    if (!byTerm[r.term]) byTerm[r.term] = [];
    byTerm[r.term].push(r);
  });

  const gradePoints = { 'A': 4.0, 'A-': 3.7, 'B+': 3.3, 'B': 3.0, 'B-': 2.7, 'C+': 2.3, 'C': 2.0, 'D': 1.0, 'E': 0.0 };
  let totalPoints = 0, totalUnits = 0;
  results.forEach(r => { totalPoints += (gradePoints[r.grade] || 0); totalUnits += 1; });
  const gpa = totalUnits > 0 ? (totalPoints / totalUnits).toFixed(2) : '—';

  res.json({
    student,
    results,
    byTerm,
    summary: { totalUnits, gpa, generated_at: new Date().toISOString() },
  });
});

// ==================== LECTURER ROUTES ====================
app.post('/api/lecturer/register', async (req, res) => {
  const { name, email, phone, password, qualification, specialization, bio } = req.body;
  if (!name || !email || !password) return res.status(400).json({ error: 'Name, email, and password are required.' });
  if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters.' });
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: 'Please enter a valid email address.' });

  try {
    const staff_no = await generateStaffNo();
    const hash = bcrypt.hashSync(password, 10);
    const info = await db.execute({
      sql: `INSERT INTO lecturers (staff_no, name, email, phone, password, qualification, specialization, bio)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [staff_no, name.trim(), email.trim().toLowerCase(), phone || '', hash, qualification || '', specialization || '', bio || ''],
    });

    try {
      if (mailer && mailer.ENABLED && mailer.sendMail) {
        mailer.sendMail({
          to: process.env.GMAIL_USER || process.env.MAIL_FROM_EMAIL,
          subject: 'New Lecturer Registration — Pending Approval',
          html: `<h2>New Lecturer Application</h2>
                 <p><strong>${name}</strong> has registered as a lecturer.</p>
                 <div style="background:#f5f6f8; padding:14px; border-left:3px solid #b8860b; border-radius:6px; margin:16px 0;">
                   <div><strong>Staff No:</strong> ${staff_no}</div>
                   <div><strong>Email:</strong> ${email}</div>
                   <div><strong>Phone:</strong> ${phone || '—'}</div>
                 </div>`,
        }).catch(err => console.error('Lecturer notification failed:', err.message));
      }
    } catch (e) { console.error('Notification error:', e.message); }

    res.json({
      ok: true,
      staff_no,
      name: name.trim(),
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

app.post('/api/lecturer/login', async (req, res) => {
  const { staff_no, email, password } = req.body;
  if (!password || (!staff_no && !email)) return res.status(400).json({ error: 'Missing credentials' });

  const r = staff_no
    ? await db.execute({ sql: 'SELECT * FROM lecturers WHERE staff_no = ?', args: [staff_no] })
    : await db.execute({ sql: 'SELECT * FROM lecturers WHERE email = ?', args: [email.toLowerCase()] });

  const lecturer = r.rows[0];
  if (!lecturer || !bcrypt.compareSync(password, lecturer.password)) {
    return res.status(401).json({ error: 'Invalid staff number/email or password' });
  }
  if (!lecturer.approved) {
    return res.status(403).json({ error: 'Your account is pending approval. Contact the administrator.' });
  }
  if (lecturer.status === 'suspended') {
    return res.status(403).json({ error: 'Your account has been suspended.' });
  }

  res.cookie('lecturer_token', signLecturer(lecturer), { httpOnly: true, sameSite: 'lax' });
  res.json({ ok: true, name: lecturer.name, staff_no: lecturer.staff_no });
});

app.post('/api/lecturer/logout', (req, res) => { res.clearCookie('lecturer_token'); res.json({ ok: true }); });

app.get('/api/lecturer/me', authLecturer, async (req, res) => {
  const r = await db.execute({
    sql: `SELECT id, staff_no, name, email, phone, qualification, specialization, bio,
            photo_url, status, approved, created_at FROM lecturers WHERE id = ?`,
    args: [req.lecturer.id],
  });
  res.json(r.rows[0]);
});

app.put('/api/lecturer/me', authLecturer, async (req, res) => {
  const { name, phone, qualification, specialization, bio } = req.body;
  await db.execute({
    sql: `UPDATE lecturers SET name = ?, phone = ?, qualification = ?, specialization = ?, bio = ? WHERE id = ?`,
    args: [name, phone || '', qualification || '', specialization || '', bio || '', req.lecturer.id],
  });
  res.json({ ok: true });
});

app.post('/api/lecturer/change-password', authLecturer, async (req, res) => {
  const { currentPassword, newPassword } = req.body;
  if (!currentPassword || !newPassword) return res.status(400).json({ error: 'Missing fields' });
  if (newPassword.length < 6) return res.status(400).json({ error: 'New password must be at least 6 characters' });

  const r = await db.execute({ sql: 'SELECT password FROM lecturers WHERE id = ?', args: [req.lecturer.id] });
  const lecturer = r.rows[0];
  if (!bcrypt.compareSync(currentPassword, lecturer.password)) {
    return res.status(400).json({ error: 'Current password is incorrect' });
  }
  await db.execute({
    sql: 'UPDATE lecturers SET password = ? WHERE id = ?',
    args: [bcrypt.hashSync(newPassword, 10), req.lecturer.id],
  });
  res.json({ ok: true });
});

app.get('/api/lecturer/my-courses', authLecturer, async (req, res) => {
  try {
    const assigned = await db.execute({
      sql: `SELECT c.*, (SELECT COUNT(*) FROM enrollments WHERE course_id = c.id) AS enrolled_count
            FROM lecturer_courses lc
            JOIN courses c ON c.id = lc.course_id
            WHERE lc.lecturer_id = ?
            ORDER BY c.code`,
      args: [req.lecturer.id],
    });

    if (assigned.rows.length === 0) {
      const lr = await db.execute({ sql: 'SELECT name FROM lecturers WHERE id = ?', args: [req.lecturer.id] });
      const lecturer = lr.rows[0];
      const fallback = await db.execute({
        sql: `SELECT c.*, (SELECT COUNT(*) FROM enrollments WHERE course_id = c.id) AS enrolled_count
              FROM courses c WHERE c.trainer LIKE ? ORDER BY c.code`,
        args: [`%${lecturer.name}%`],
      });
      return res.json(fallback.rows);
    }

    res.json(assigned.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/lecturer/courses/:id/students', authLecturer, async (req, res) => {
  const r = await db.execute({
    sql: `SELECT s.id, s.reg_no, s.name, s.email, s.course, s.active
          FROM students s JOIN enrollments e ON e.student_id = s.id
          WHERE e.course_id = ? ORDER BY s.name`,
    args: [req.params.id],
  });
  res.json(r.rows);
});

app.get('/api/lecturer/results', authLecturer, async (req, res) => {
  const r = await db.execute(`
    SELECT r.id, r.marks, r.grade, r.term, s.reg_no, s.name AS student_name,
           c.code, c.title AS course_title
    FROM results r JOIN students s ON s.id = r.student_id
    JOIN courses c ON c.id = r.course_id
    ORDER BY r.id DESC LIMIT 200
  `);
  res.json(r.rows);
});

app.post('/api/lecturer/results', authLecturer, async (req, res) => {
  const { student_id, course_id, marks, term } = req.body;
  if (!student_id || !course_id || marks == null || !term) return res.status(400).json({ error: 'All fields required' });
  const grade = calcGrade(Number(marks));
  await db.execute({
    sql: 'INSERT INTO results (student_id, course_id, marks, grade, term) VALUES (?, ?, ?, ?, ?)',
    args: [student_id, course_id, marks, grade, term],
  });
  res.json({ ok: true, grade });
});

app.get('/api/lecturer/announcements', authLecturer, async (req, res) => {
  const r = await db.execute('SELECT * FROM announcements ORDER BY created_at DESC');
  res.json(r.rows);
});

app.post('/api/lecturer/announcements', authLecturer, async (req, res) => {
  const { title, body } = req.body;
  if (!title || !body) return res.status(400).json({ error: 'Title and body required' });
  await db.execute({ sql: 'INSERT INTO announcements (title, body) VALUES (?, ?)', args: [title, body] });
  res.json({ ok: true });
});

app.get('/api/lecturer/timetable', authLecturer, async (req, res) => {
  const r = await db.execute(`
    SELECT t.*, c.code, c.title FROM timetable t JOIN courses c ON c.id = t.course_id
    ORDER BY CASE t.day WHEN 'Monday' THEN 1 WHEN 'Tuesday' THEN 2 WHEN 'Wednesday' THEN 3
      WHEN 'Thursday' THEN 4 WHEN 'Friday' THEN 5 WHEN 'Saturday' THEN 6 ELSE 7 END, t.start_time
  `);
  res.json(r.rows);
});

app.get('/api/lecturer/attendance/:courseId', authLecturer, async (req, res) => {
  const r = await db.execute({
    sql: `SELECT a.*, s.reg_no, s.name AS student_name
          FROM attendance a JOIN students s ON s.id = a.student_id
          WHERE a.course_id = ? ORDER BY a.date DESC, s.name LIMIT 500`,
    args: [req.params.courseId],
  });
  res.json(r.rows);
});

app.post('/api/lecturer/attendance', authLecturer, async (req, res) => {
  const { course_id, date, records } = req.body;
  if (!course_id || !date || !Array.isArray(records)) {
    return res.status(400).json({ error: 'course_id, date, records[] required' });
  }
  for (const r of records) {
    await db.execute({
      sql: 'DELETE FROM attendance WHERE course_id = ? AND student_id = ? AND date = ?',
      args: [course_id, r.student_id, date],
    });
    await db.execute({
      sql: `INSERT INTO attendance (course_id, student_id, date, status, marked_by, notes)
            VALUES (?, ?, ?, ?, ?, ?)`,
      args: [course_id, r.student_id, date, r.status || 'present', req.lecturer.id, r.notes || ''],
    });
  }
  res.json({ ok: true, count: records.length });
});

app.get('/api/lecturer/materials', authLecturer, async (req, res) => {
  const r = await db.execute(`
    SELECT m.*, c.code, c.title AS course_title,
      (SELECT COUNT(*) FROM material_views WHERE material_id = m.id) AS view_count
    FROM materials m JOIN courses c ON c.id = m.course_id
    ORDER BY m.release_date DESC, m.id DESC LIMIT 200
  `);
  res.json(r.rows);
});

app.post('/api/lecturer/materials', authLecturer, async (req, res) => {
  const { course_id, title, description, material_type, file_path, file_name, external_url, release_date } = req.body;
  if (!course_id || !title || !release_date) {
    return res.status(400).json({ error: 'course_id, title, and release_date are required' });
  }
  const info = await db.execute({
    sql: `INSERT INTO materials (course_id, title, description, material_type, file_path, file_name, external_url, release_date, created_by)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [course_id, title, description || '', material_type || 'file', file_path || null, file_name || null, external_url || null, release_date, req.lecturer.id],
  });
  res.json({ ok: true, id: info.lastInsertRowid });
});

app.delete('/api/lecturer/materials/:id', authLecturer, async (req, res) => {
  await db.execute({ sql: 'DELETE FROM material_views WHERE material_id = ?', args: [req.params.id] });
  await db.execute({ sql: 'DELETE FROM materials WHERE id = ?', args: [req.params.id] });
  res.json({ ok: true });
});

app.get('/api/lecturer/materials/:id/views', authLecturer, async (req, res) => {
  const r = await db.execute({
    sql: `SELECT mv.viewed_at, s.reg_no, s.name
          FROM material_views mv JOIN students s ON s.id = mv.student_id
          WHERE mv.material_id = ? ORDER BY mv.viewed_at DESC`,
    args: [req.params.id],
  });
  res.json(r.rows);
});

app.post('/api/lecturer/materials/upload', authLecturer, materialUpload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  res.json({ ok: true, file_path: `/uploads/${req.file.filename}`, file_name: req.file.originalname });
});

// ==================== ADMIN ROUTES ====================
app.post('/api/admin/login', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Missing credentials' });
  const r = await db.execute({ sql: 'SELECT * FROM admins WHERE username = ?', args: [username] });
  const a = r.rows[0];
  if (!a || !bcrypt.compareSync(password, a.password))
    return res.status(401).json({ error: 'Invalid username or password' });
  res.cookie('admin_token', signAdmin(a), { httpOnly: true, sameSite: 'lax' });
  res.json({ ok: true, name: a.name, role: a.role });
});

app.post('/api/admin/logout', (req, res) => { res.clearCookie('admin_token'); res.json({ ok: true }); });

app.get('/api/admin/me', authAdmin, async (req, res) => {
  const r = await db.execute({ sql: 'SELECT id, username, name, role FROM admins WHERE id = ?', args: [req.admin.id] });
  res.json(r.rows[0]);
});

app.get('/api/admin/stats', authAdmin, async (req, res) => {
  const s = await db.execute('SELECT COUNT(*) AS c FROM students');
  const c = await db.execute('SELECT COUNT(*) AS c FROM courses');
  const e = await db.execute('SELECT COUNT(*) AS c FROM enrollments');
  const a = await db.execute('SELECT COUNT(*) AS c FROM announcements');
  res.json({ students: s.rows[0].c, courses: c.rows[0].c, enrollments: e.rows[0].c, announcements: a.rows[0].c });
});

// ---------- Lecturers (superadmin) ----------
app.get('/api/admin/lecturers', authAdmin, async (req, res) => {
  try {
    const r = await db.execute(`
      SELECT id, staff_no, name, email, phone, qualification, specialization,
             status, approved, created_at, approved_at
      FROM lecturers ORDER BY approved ASC, created_at DESC
    `);
    res.json(r.rows);
  } catch (err) {
    console.error('Failed to load lecturers:', err.message);
    res.status(500).json({ error: 'Failed to load lecturers: ' + err.message });
  }
});

app.post('/api/admin/lecturers/:id/approve', authAdmin, async (req, res) => {
  try {
    await db.execute({
      sql: 'UPDATE lecturers SET approved = 1, status = ?, approved_at = CURRENT_TIMESTAMP WHERE id = ?',
      args: ['active', req.params.id],
    });
    try {
      const lr = await db.execute({ sql: 'SELECT name, email, staff_no FROM lecturers WHERE id = ?', args: [req.params.id] });
      const lecturer = lr.rows[0];
      if (lecturer) {
        sendMailSafe('sendMail', {
          to: lecturer.email,
          subject: 'Your Herald Lecturer Account is Approved',
          html: `<h2>Account Approved</h2><p>Hello ${lecturer.name},</p>
                 <p>Your lecturer account has been approved.</p>
                 <p><strong>Staff No:</strong> ${lecturer.staff_no}</p>`,
        });
      }
    } catch (e) { console.error('Approval email failed:', e.message); }
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/admin/lecturers/:id/reject', authAdmin, async (req, res) => {
  try {
    await db.execute({
      sql: 'UPDATE lecturers SET approved = 0, status = ? WHERE id = ?',
      args: ['rejected', req.params.id],
    });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/admin/lecturers/:id/suspend', authAdmin, async (req, res) => {
  try {
    await db.execute({
      sql: 'UPDATE lecturers SET status = ? WHERE id = ?',
      args: ['suspended', req.params.id],
    });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/admin/lecturers/:id/reactivate', authAdmin, async (req, res) => {
  try {
    await db.execute({
      sql: 'UPDATE lecturers SET status = ?, approved = 1 WHERE id = ?',
      args: ['active', req.params.id],
    });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/admin/lecturers/:id', authAdmin, async (req, res) => {
  try {
    await db.execute({ sql: 'DELETE FROM lecturer_courses WHERE lecturer_id = ?', args: [req.params.id] });
    await db.execute({ sql: 'DELETE FROM lecturers WHERE id = ?', args: [req.params.id] });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/admin/lecturers', authAdmin, async (req, res) => {
  const { name, email, phone, password, qualification, specialization, bio } = req.body;
  if (!name || !email || !password) {
    return res.status(400).json({ error: 'Name, email, password required' });
  }
  try {
    const staff_no = await generateStaffNo();
    const hash = bcrypt.hashSync(password, 10);
    await db.execute({
      sql: `INSERT INTO lecturers (staff_no, name, email, phone, password, qualification, specialization, bio, approved, status, approved_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, 'active', CURRENT_TIMESTAMP)`,
      args: [staff_no, name, email.toLowerCase(), phone || '', hash, qualification || '', specialization || '', bio || ''],
    });
    res.json({ ok: true, staff_no });
  } catch (err) {
    if (String(err.message).includes('UNIQUE')) {
      return res.status(400).json({ error: 'Email already exists' });
    }
    res.status(500).json({ error: err.message });
  }
});

// ---------- Lecturer Course Assignments ----------
// Full list of courses with assigned lecturers
app.get('/api/admin/courses-full', authAdmin, async (req, res) => {
  try {
    const courses = await db.execute(`
      SELECT c.*,
        (SELECT COUNT(*) FROM enrollments WHERE course_id = c.id) AS enrolled_count,
        (SELECT COUNT(*) FROM lecturer_courses WHERE course_id = c.id) AS lecturer_count
      FROM courses c ORDER BY c.code
    `);

    const enriched = [];
    for (const c of courses.rows) {
      const lecturers = await db.execute({
        sql: `SELECT l.id, l.name, l.staff_no FROM lecturer_courses lc
              JOIN lecturers l ON l.id = lc.lecturer_id
              WHERE lc.course_id = ?`,
        args: [c.id],
      });
      enriched.push({ ...c, lecturers: lecturers.rows });
    }
    res.json(enriched);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Assign a lecturer to a course
app.post('/api/admin/courses/:courseId/assign-lecturer', authAdmin, async (req, res) => {
  const { lecturer_id } = req.body;
  if (!lecturer_id) return res.status(400).json({ error: 'lecturer_id required' });
  try {
    await db.execute({
      sql: 'INSERT OR IGNORE INTO lecturer_courses (lecturer_id, course_id) VALUES (?, ?)',
      args: [lecturer_id, req.params.courseId],
    });

    try {
      const lr = await db.execute({ sql: 'SELECT name, email FROM lecturers WHERE id = ?', args: [lecturer_id] });
      const cr = await db.execute({ sql: 'SELECT code, title FROM courses WHERE id = ?', args: [req.params.courseId] });
      const lecturer = lr.rows[0];
      const course = cr.rows[0];

      if (lecturer && course) {
        sendMailSafe('sendMail', {
          to: lecturer.email,
          subject: `New Course Assigned: ${course.code}`,
          html: `
            <h2>New Course Assignment</h2>
            <p>Hello ${lecturer.name},</p>
            <p>You have been assigned to teach <strong>${course.code} — ${course.title}</strong>.</p>
            <p>Log in to your lecturer dashboard to view enrolled students and post materials.</p>
            <p style="margin-top:24px;">
              <a href="${process.env.APP_URL || 'https://herald-portal.onrender.com'}/lecturer-login.html"
                 style="background:#0b1a33; color:#fff; padding:12px 22px; border-radius:6px; text-decoration:none; font-weight:600;">
                Open Lecturer Dashboard
              </a>
            </p>
          `,
        });
      }
    } catch (e) { console.error('Assignment email failed:', e.message); }

    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Remove a lecturer from a course
app.delete('/api/admin/courses/:courseId/lecturers/:lecturerId', authAdmin, async (req, res) => {
  try {
    await db.execute({
      sql: 'DELETE FROM lecturer_courses WHERE course_id = ? AND lecturer_id = ?',
      args: [req.params.courseId, req.params.lecturerId],
    });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// List courses assigned to a lecturer
app.get('/api/admin/lecturers/:id/courses', authAdmin, async (req, res) => {
  try {
    const r = await db.execute({
      sql: `SELECT c.id, c.code, c.title, c.trainer, lc.assigned_at
            FROM lecturer_courses lc
            JOIN courses c ON c.id = lc.course_id
            WHERE lc.lecturer_id = ?
            ORDER BY c.code`,
      args: [req.params.id],
    });
    res.json(r.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Assign a course to a lecturer
app.post('/api/admin/lecturers/:id/courses', authAdmin, async (req, res) => {
  const { course_id } = req.body;
  if (!course_id) return res.status(400).json({ error: 'course_id required' });
  try {
    await db.execute({
      sql: 'INSERT OR IGNORE INTO lecturer_courses (lecturer_id, course_id) VALUES (?, ?)',
      args: [req.params.id, course_id],
    });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Unassign a course
app.delete('/api/admin/lecturers/:id/courses/:courseId', authAdmin, async (req, res) => {
  try {
    await db.execute({
      sql: 'DELETE FROM lecturer_courses WHERE lecturer_id = ? AND course_id = ?',
      args: [req.params.id, req.params.courseId],
    });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Lecturer workload summary
app.get('/api/admin/lecturers-workload', authAdmin, async (req, res) => {
  try {
    const r = await db.execute(`
      SELECT l.id, l.staff_no, l.name, l.status,
        (SELECT COUNT(*) FROM lecturer_courses WHERE lecturer_id = l.id) AS course_count,
        (SELECT COUNT(DISTINCT e.student_id) FROM lecturer_courses lc
         JOIN enrollments e ON e.course_id = lc.course_id
         WHERE lc.lecturer_id = l.id) AS student_count
      FROM lecturers l
      WHERE l.approved = 1
      ORDER BY course_count DESC, l.name
    `);
    res.json(r.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Bulk assign
app.post('/api/admin/lecturers/bulk-assign', authAdmin, async (req, res) => {
  const { lecturer_ids, course_ids } = req.body;
  if (!Array.isArray(lecturer_ids) || !Array.isArray(course_ids)) {
    return res.status(400).json({ error: 'lecturer_ids[] and course_ids[] required' });
  }
  let added = 0;
  try {
    for (const lid of lecturer_ids) {
      for (const cid of course_ids) {
        const r = await db.execute({
          sql: 'INSERT OR IGNORE INTO lecturer_courses (lecturer_id, course_id) VALUES (?, ?)',
          args: [lid, cid],
        });
        if (r.rowsAffected > 0) added++;
      }
    }
    res.json({ ok: true, added });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------- Students (admin) ----------
app.get('/api/admin/students', authAdmin, async (req, res) => {
  const r = await db.execute('SELECT id, reg_no, name, email, course, active, created_at FROM students ORDER BY id DESC');
  res.json(r.rows);
});

app.post('/api/admin/students', authAdmin, async (req, res) => {
  let { reg_no, name, email, password, course } = req.body;
  if (!name || !email || !password || !course) return res.status(400).json({ error: 'Name, email, password, and course are required.' });
  if (!reg_no) reg_no = await generateRegNo();
  try {
    const hash = bcrypt.hashSync(password, 10);
    await db.execute({
      sql: 'INSERT INTO students (reg_no, name, email, password, course) VALUES (?, ?, ?, ?, ?)',
      args: [reg_no, name, email.trim().toLowerCase(), hash, course],
    });
    sendMailSafe('sendWelcomeEmail', { to: email, studentName: name, regNo: reg_no, course });
    res.json({ ok: true, reg_no });
  } catch (err) {
    if (String(err.message).includes('UNIQUE')) return res.status(400).json({ error: 'Reg no or email already exists.' });
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/admin/students/:id', authAdmin, async (req, res) => {
  const { name, email, course, active } = req.body;
  await db.execute({
    sql: 'UPDATE students SET name = ?, email = ?, course = ?, active = ? WHERE id = ?',
    args: [name, email, course, active ? 1 : 0, req.params.id],
  });
  res.json({ ok: true });
});

app.delete('/api/admin/students/:id', authAdmin, async (req, res) => {
  for (const t of ['enrollments', 'results', 'fees', 'submissions']) {
    await db.execute({ sql: `DELETE FROM ${t} WHERE student_id = ?`, args: [req.params.id] });
  }
  await db.execute({ sql: 'DELETE FROM students WHERE id = ?', args: [req.params.id] });
  res.json({ ok: true });
});

app.post('/api/admin/students/:id/reset-password', authAdmin, async (req, res) => {
  const { newPassword } = req.body;
  if (!newPassword || newPassword.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters.' });
  await db.execute({
    sql: 'UPDATE students SET password = ? WHERE id = ?',
    args: [bcrypt.hashSync(newPassword, 10), req.params.id],
  });
  const sr = await db.execute({ sql: 'SELECT name, email, reg_no FROM students WHERE id = ?', args: [req.params.id] });
  const student = sr.rows[0];
  if (student) {
    sendMailSafe('sendMail', {
      to: student.email,
      subject: 'Your Herald Portal password has been reset',
      html: `<h2>Password Reset</h2><p>Hello ${student.name},</p>
             <p>New password: <code>${newPassword}</code></p>
             <p>Reg No: ${student.reg_no}</p>`,
    });
  }
  res.json({ ok: true });
});

app.post('/api/admin/send-fee-reminders', authAdmin, async (req, res) => {
  try {
    if (!mailer || !mailer.ENABLED) return res.status(400).json({ error: 'Mailer not configured' });
    const r = await db.execute(`
      SELECT f.amount_due - f.amount_paid AS balance, f.term, s.email, s.name
      FROM fees f JOIN students s ON s.id = f.student_id
      WHERE f.amount_due > f.amount_paid
    `);
    let sent = 0;
    for (const row of r.rows) {
      try {
        await mailer.sendFeeReminder({ to: row.email, studentName: row.name, term: row.term, balance: row.balance });
        sent++;
      } catch (e) { console.error('Fee reminder failed:', e.message); }
    }
    res.json({ ok: true, sent, total: r.rows.length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ---------- Courses (admin) ----------
app.get('/api/admin/courses', authAdmin, async (req, res) => {
  const r = await db.execute(`
    SELECT c.*, (SELECT COUNT(*) FROM enrollments WHERE course_id = c.id) AS enrolled_count
    FROM courses c ORDER BY c.id
  `);
  res.json(r.rows);
});

app.post('/api/admin/courses', authAdmin, async (req, res) => {
  const { code, title, trainer, description } = req.body;
  if (!code || !title || !trainer) return res.status(400).json({ error: 'Code, title, trainer required' });
  try {
    await db.execute({
      sql: 'INSERT INTO courses (code, title, trainer, description) VALUES (?, ?, ?, ?)',
      args: [code, title, trainer, description || ''],
    });
    res.json({ ok: true });
  } catch { res.status(400).json({ error: 'Course code already exists' }); }
});

app.put('/api/admin/courses/:id', authAdmin, async (req, res) => {
  const { code, title, trainer, description } = req.body;
  await db.execute({
    sql: 'UPDATE courses SET code = ?, title = ?, trainer = ?, description = ? WHERE id = ?',
    args: [code, title, trainer, description || '', req.params.id],
  });
  res.json({ ok: true });
});

app.delete('/api/admin/courses/:id', authAdmin, async (req, res) => {
  for (const t of ['enrollments', 'results', 'timetable', 'assignments', 'lecturer_courses']) {
    await db.execute({ sql: `DELETE FROM ${t} WHERE course_id = ?`, args: [req.params.id] });
  }
  await db.execute({ sql: 'DELETE FROM courses WHERE id = ?', args: [req.params.id] });
  res.json({ ok: true });
});

app.get('/api/admin/courses/:id/students', authAdmin, async (req, res) => {
  const r = await db.execute({
    sql: `SELECT s.id, s.reg_no, s.name, s.email FROM students s
          JOIN enrollments e ON e.student_id = s.id WHERE e.course_id = ?`,
    args: [req.params.id],
  });
  res.json(r.rows);
});

// ---------- Announcements (admin) ----------
app.get('/api/admin/announcements', authAdmin, async (req, res) => {
  const r = await db.execute('SELECT * FROM announcements ORDER BY created_at DESC');
  res.json(r.rows);
});

app.post('/api/admin/announcements', authAdmin, async (req, res) => {
  const { title, body } = req.body;
  if (!title || !body) return res.status(400).json({ error: 'Title and body required' });
  await db.execute({ sql: 'INSERT INTO announcements (title, body) VALUES (?, ?)', args: [title, body] });
  res.json({ ok: true });
});

app.put('/api/admin/announcements/:id', authAdmin, async (req, res) => {
  const { title, body } = req.body;
  await db.execute({ sql: 'UPDATE announcements SET title = ?, body = ? WHERE id = ?', args: [title, body, req.params.id] });
  res.json({ ok: true });
});

app.delete('/api/admin/announcements/:id', authAdmin, async (req, res) => {
  await db.execute({ sql: 'DELETE FROM announcements WHERE id = ?', args: [req.params.id] });
  res.json({ ok: true });
});

// ---------- Results (admin) ----------
app.get('/api/admin/results', authAdmin, async (req, res) => {
  const r = await db.execute(`
    SELECT r.id, r.marks, r.grade, r.term, s.reg_no, s.name AS student_name, c.code, c.title AS course_title
    FROM results r JOIN students s ON s.id = r.student_id JOIN courses c ON c.id = r.course_id
    ORDER BY r.id DESC
  `);
  res.json(r.rows);
});

app.post('/api/admin/results', authAdmin, async (req, res) => {
  const { student_id, course_id, marks, term } = req.body;
  if (!student_id || !course_id || marks == null || !term) return res.status(400).json({ error: 'All fields required' });
  const grade = calcGrade(Number(marks));
  await db.execute({
    sql: 'INSERT INTO results (student_id, course_id, marks, grade, term) VALUES (?, ?, ?, ?, ?)',
    args: [student_id, course_id, marks, grade, term],
  });
  res.json({ ok: true, grade });
});

app.delete('/api/admin/results/:id', authAdmin, async (req, res) => {
  await db.execute({ sql: 'DELETE FROM results WHERE id = ?', args: [req.params.id] });
  res.json({ ok: true });
});

// ---------- Fees (admin) ----------
app.get('/api/admin/fees', authAdmin, async (req, res) => {
  const r = await db.execute(`
    SELECT f.*, s.reg_no, s.name AS student_name
    FROM fees f JOIN students s ON s.id = f.student_id ORDER BY f.id DESC
  `);
  res.json(r.rows);
});

app.get('/api/admin/fees/summary', authAdmin, async (req, res) => {
  const r = await db.execute(`
    SELECT COALESCE(SUM(amount_due), 0) AS total_due,
           COALESCE(SUM(amount_paid), 0) AS total_paid,
           COUNT(*) AS records,
           SUM(CASE WHEN status = 'paid' THEN 1 ELSE 0 END) AS paid_count,
           SUM(CASE WHEN status = 'partial' THEN 1 ELSE 0 END) AS partial_count,
           SUM(CASE WHEN status = 'unpaid' THEN 1 ELSE 0 END) AS unpaid_count
    FROM fees
  `);
  res.json(r.rows[0]);
});

app.post('/api/admin/fees', authAdmin, async (req, res) => {
  const { student_id, term, amount_due, amount_paid } = req.body;
  if (!student_id || !term || amount_due == null) return res.status(400).json({ error: 'Required fields missing' });
  const paid = Number(amount_paid || 0), due = Number(amount_due);
  const status = paid >= due ? 'paid' : (paid > 0 ? 'partial' : 'unpaid');
  await db.execute({
    sql: 'INSERT INTO fees (student_id, term, amount_due, amount_paid, status, paid_at) VALUES (?, ?, ?, ?, ?, ?)',
    args: [student_id, term, due, paid, status, paid > 0 ? new Date().toISOString() : null],
  });
  res.json({ ok: true });
});

app.put('/api/admin/fees/:id', authAdmin, async (req, res) => {
  const { amount_due, amount_paid } = req.body;
  const due = Number(amount_due), paid = Number(amount_paid);
  const status = paid >= due ? 'paid' : (paid > 0 ? 'partial' : 'unpaid');
  await db.execute({
    sql: 'UPDATE fees SET amount_due = ?, amount_paid = ?, status = ?, paid_at = ? WHERE id = ?',
    args: [due, paid, status, paid > 0 ? new Date().toISOString() : null, req.params.id],
  });
  res.json({ ok: true });
});

app.post('/api/admin/fees/:id/pay', authAdmin, async (req, res) => {
  const { amount } = req.body;
  if (!amount || Number(amount) <= 0) return res.status(400).json({ error: 'Amount must be > 0' });
  const fr = await db.execute({ sql: 'SELECT * FROM fees WHERE id = ?', args: [req.params.id] });
  const fee = fr.rows[0];
  if (!fee) return res.status(404).json({ error: 'Fee record not found' });
  const newPaid = Number(fee.amount_paid) + Number(amount);
  const status = newPaid >= fee.amount_due ? 'paid' : (newPaid > 0 ? 'partial' : 'unpaid');
  await db.execute({
    sql: 'UPDATE fees SET amount_paid = ?, status = ?, paid_at = ? WHERE id = ?',
    args: [newPaid, status, new Date().toISOString(), req.params.id],
  });
  res.json({ ok: true, new_paid: newPaid, status });
});

app.delete('/api/admin/fees/:id', authAdmin, async (req, res) => {
  await db.execute({ sql: 'DELETE FROM fees WHERE id = ?', args: [req.params.id] });
  res.json({ ok: true });
});

// ---------- Timetable (admin) ----------
app.get('/api/admin/timetable', authAdmin, async (req, res) => {
  const r = await db.execute(`
    SELECT t.*, c.code, c.title FROM timetable t JOIN courses c ON c.id = t.course_id
    ORDER BY CASE t.day WHEN 'Monday' THEN 1 WHEN 'Tuesday' THEN 2 WHEN 'Wednesday' THEN 3
      WHEN 'Thursday' THEN 4 WHEN 'Friday' THEN 5 WHEN 'Saturday' THEN 6 ELSE 7 END, t.start_time
  `);
  res.json(r.rows);
});

app.post('/api/admin/timetable', authAdmin, async (req, res) => {
  const { course_id, day, start_time, end_time, room, trainer } = req.body;
  if (!course_id || !day || !start_time || !end_time) return res.status(400).json({ error: 'Required fields missing' });
  await db.execute({
    sql: 'INSERT INTO timetable (course_id, day, start_time, end_time, room, trainer) VALUES (?, ?, ?, ?, ?, ?)',
    args: [course_id, day, start_time, end_time, room || '', trainer || ''],
  });
  res.json({ ok: true });
});

app.delete('/api/admin/timetable/:id', authAdmin, async (req, res) => {
  await db.execute({ sql: 'DELETE FROM timetable WHERE id = ?', args: [req.params.id] });
  res.json({ ok: true });
});

// ---------- Assignments (admin) ----------
app.get('/api/admin/assignments', authAdmin, async (req, res) => {
  const r = await db.execute(`
    SELECT a.*, c.code, c.title,
      (SELECT COUNT(*) FROM submissions WHERE assignment_id = a.id) AS submission_count,
      (SELECT COUNT(*) FROM submissions WHERE assignment_id = a.id AND grade IS NOT NULL AND grade != '') AS graded_count,
      (SELECT COUNT(*) FROM submissions WHERE assignment_id = a.id AND file_path IS NOT NULL) AS file_count
    FROM assignments a JOIN courses c ON c.id = a.course_id ORDER BY a.id DESC
  `);
  res.json(r.rows);
});

app.post('/api/admin/assignments', authAdmin, async (req, res) => {
  const { course_id, title, description, due_date } = req.body;
  if (!course_id || !title) return res.status(400).json({ error: 'Course and title required' });
  await db.execute({
    sql: 'INSERT INTO assignments (course_id, title, description, due_date) VALUES (?, ?, ?, ?)',
    args: [course_id, title, description || '', due_date || ''],
  });
  res.json({ ok: true });
});

app.delete('/api/admin/assignments/:id', authAdmin, async (req, res) => {
  await db.execute({ sql: 'DELETE FROM submissions WHERE assignment_id = ?', args: [req.params.id] });
  await db.execute({ sql: 'DELETE FROM assignments WHERE id = ?', args: [req.params.id] });
  res.json({ ok: true });
});

app.get('/api/admin/assignments/:id/submissions', authAdmin, async (req, res) => {
  const r = await db.execute({
    sql: `SELECT sub.*, s.reg_no, s.name AS student_name
          FROM submissions sub JOIN students s ON s.id = sub.student_id
          WHERE sub.assignment_id = ? ORDER BY sub.submitted_at DESC`,
    args: [req.params.id],
  });
  res.json(r.rows);
});

app.get('/api/admin/submission/:id/file', authAdmin, async (req, res) => {
  const r = await db.execute({ sql: 'SELECT * FROM submissions WHERE id = ?', args: [req.params.id] });
  const sub = r.rows[0];
  if (!sub || !sub.file_path) return res.status(404).json({ error: 'No file' });
  const fullPath = path.join(__dirname, sub.file_path);
  if (!fs.existsSync(fullPath)) return res.status(404).json({ error: 'File missing' });
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="${sub.file_name || 'submission.pdf'}"`);
  fs.createReadStream(fullPath).pipe(res);
});

app.put('/api/admin/submissions/:id', authAdmin, async (req, res) => {
  const { grade, feedback } = req.body;
  await db.execute({
    sql: 'UPDATE submissions SET grade = ?, feedback = ? WHERE id = ?',
    args: [grade || '', feedback || '', req.params.id],
  });
  if (grade) {
    const r = await db.execute({
      sql: `SELECT sub.*, s.email, s.name AS student_name, a.title AS assignment_title, c.code AS course_code
            FROM submissions sub JOIN students s ON s.id = sub.student_id
            JOIN assignments a ON a.id = sub.assignment_id
            JOIN courses c ON c.id = a.course_id WHERE sub.id = ?`,
      args: [req.params.id],
    });
    const sub = r.rows[0];
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

// ---------- Attendance (admin) ----------
app.get('/api/admin/attendance/:courseId', authAdmin, async (req, res) => {
  const r = await db.execute({
    sql: `SELECT a.*, s.reg_no, s.name AS student_name
          FROM attendance a JOIN students s ON s.id = a.student_id
          WHERE a.course_id = ? ORDER BY a.date DESC, s.name LIMIT 500`,
    args: [req.params.courseId],
  });
  res.json(r.rows);
});

app.post('/api/admin/attendance', authAdmin, async (req, res) => {
  const { course_id, date, records } = req.body;
  if (!course_id || !date || !Array.isArray(records)) {
    return res.status(400).json({ error: 'course_id, date, records[] required' });
  }
  for (const r of records) {
    await db.execute({
      sql: 'DELETE FROM attendance WHERE course_id = ? AND student_id = ? AND date = ?',
      args: [course_id, r.student_id, date],
    });
    await db.execute({
      sql: `INSERT INTO attendance (course_id, student_id, date, status, marked_by, notes)
            VALUES (?, ?, ?, ?, ?, ?)`,
      args: [course_id, r.student_id, date, r.status || 'present', req.admin.id, r.notes || ''],
    });
  }
  res.json({ ok: true, count: records.length });
});

app.get('/api/admin/attendance-summary/:courseId', authAdmin, async (req, res) => {
  const r = await db.execute({
    sql: `SELECT s.id, s.reg_no, s.name,
            COUNT(a.id) AS total,
            SUM(CASE WHEN a.status = 'present' THEN 1 ELSE 0 END) AS present,
            SUM(CASE WHEN a.status = 'absent' THEN 1 ELSE 0 END) AS absent,
            SUM(CASE WHEN a.status = 'late' THEN 1 ELSE 0 END) AS late
          FROM students s
          JOIN enrollments e ON e.student_id = s.id AND e.course_id = ?
          LEFT JOIN attendance a ON a.student_id = s.id AND a.course_id = ?
          GROUP BY s.id ORDER BY s.name`,
    args: [req.params.courseId, req.params.courseId],
  });
  res.json(r.rows);
});

app.delete('/api/admin/attendance/:id', authAdmin, async (req, res) => {
  await db.execute({ sql: 'DELETE FROM attendance WHERE id = ?', args: [req.params.id] });
  res.json({ ok: true });
});

// ---------- Live Classes (admin) ----------
app.get('/api/admin/live-classes', authAdmin, async (req, res) => {
  const r = await db.execute(`
    SELECT lc.*, c.code, c.title AS course_title
    FROM live_classes lc JOIN courses c ON c.id = lc.course_id
    ORDER BY lc.scheduled_at DESC
  `);
  res.json(r.rows);
});

app.post('/api/admin/live-classes', authAdmin, async (req, res) => {
  const { course_id, title, description, meeting_url, scheduled_at, duration_minutes, notify } = req.body;
  if (!course_id || !title || !meeting_url || !scheduled_at) {
    return res.status(400).json({ error: 'course_id, title, meeting_url, scheduled_at required' });
  }
  const info = await db.execute({
    sql: `INSERT INTO live_classes (course_id, title, description, meeting_url, scheduled_at, duration_minutes, created_by)
          VALUES (?, ?, ?, ?, ?, ?, ?)`,
    args: [course_id, title, description || '', meeting_url, scheduled_at, Number(duration_minutes) || 60, req.admin.id],
  });

  if (notify && mailer && mailer.ENABLED) {
    try {
      const sr = await db.execute({
        sql: `SELECT s.email, s.name FROM students s
              JOIN enrollments e ON e.student_id = s.id WHERE e.course_id = ?`,
        args: [course_id],
      });
      const cr = await db.execute({ sql: 'SELECT code, title FROM courses WHERE id = ?', args: [course_id] });
      const course = cr.rows[0];
      for (const s of sr.rows) {
        mailer.sendLiveClassNotification({
          to: s.email, studentName: s.name, courseCode: course.code, courseTitle: course.title,
          classTitle: title, scheduledAt: new Date(scheduled_at), meetingUrl: meeting_url,
        }).catch(err => console.error('Class email failed:', err.message));
      }
    } catch (e) { console.error('Class notification error:', e.message); }
  }

  res.json({ ok: true, id: info.lastInsertRowid });
});

app.delete('/api/admin/live-classes/:id', authAdmin, async (req, res) => {
  await db.execute({ sql: 'DELETE FROM live_classes WHERE id = ?', args: [req.params.id] });
  res.json({ ok: true });
});

app.listen(PORT, () => console.log(`Herald Portal running on http://localhost:${PORT}`));