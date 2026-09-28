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
  limits: { fileSize: 10 * 1024 * 1024 }, // 10 MB
  fileFilter: (req, file, cb) => {
    if (file.mimetype !== 'application/pdf') {
      return cb(new Error('Only PDF files are allowed'));
    }
    cb(null, true);
  }
});

// Serve uploaded PDFs (protected — only authenticated users via /api route)
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

// Helper: generate next registration number for the current year
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

app.post('/api/register', async (req, res) => {
  const { name, email, password, course } = req.body;

  // Validate required fields
  if (!name || !email || !password || !course) {
    return res.status(400).json({ error: 'All fields are required.' });
  }

  // Password validation
  if (password.length < 6) {
    return res.status(400).json({ error: 'Password must be at least 6 characters.' });
  }

  // Basic email validation
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ error: 'Please enter a valid email address.' });
  }

  try {
    const hash = bcrypt.hashSync(password, 10);
    const reg_no = generateRegNo();

    const info = db.prepare(
      'INSERT INTO students (reg_no, name, email, password, course) VALUES (?, ?, ?, ?, ?)'
    ).run(reg_no, name.trim(), email.trim().toLowerCase(), hash, course);

    const s = db.prepare('SELECT * FROM students WHERE id = ?').get(info.lastInsertRowid);
    res.cookie('token', signStudent(s), { httpOnly: true, sameSite: 'lax' });

    // Send welcome email with generated reg_no
    if (process.env.GMAIL_USER) {
      try {
        const { sendWelcomeEmail } = require('./mailer');
        sendWelcomeEmail({
          to: s.email,
          studentName: s.name,
          regNo: s.reg_no,
          course: s.course,
        }).catch(err => console.error('Welcome email failed:', err.message));
      } catch (e) {
        console.error('Welcome email error:', e.message);
      }
    }

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

// Public: list course names for the registration dropdown
app.get('/api/public/courses', (req, res) => {
  const rows = db.prepare('SELECT DISTINCT title FROM courses ORDER BY title').all();
  res.json(rows.map(r => r.title));
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

  if (!content && !filePath) {
    return res.status(400).json({ error: 'Provide text and/or a PDF file' });
  }

  const existing = db.prepare('SELECT * FROM submissions WHERE assignment_id = ? AND student_id = ?').get(aid, req.user.id);

  if (existing) {
    if (existing.file_path && filePath && existing.file_path !== filePath) {
      const oldPath = path.join(__dirname, existing.file_path);
      if (fs.existsSync(oldPath)) fs.unlinkSync(oldPath);
    }
    db.prepare(`
      UPDATE submissions
      SET content = ?,
          file_path = COALESCE(?, file_path),
          file_name = COALESCE(?, file_name),
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
  const sub = db.prepare(`
    SELECT sub.*, a.student_id AS owner_id
    FROM submissions sub
    JOIN assignments a ON a.id = sub.assignment_id
    WHERE sub.id = ?
  `).get(req.params.id);
  if (!sub || !sub.file_path) return res.status(404).json({ error: 'No file' });
  if (sub.student_id !== req.user.id) return res.status(403).json({ error: 'Not yours' });

  const fullPath = path.join(__dirname, sub.file_path);
  if (!fs.existsSync(fullPath)) return res.status(404).json({ error: 'File missing' });
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="${sub.file_name || 'submission.pdf'}"`);
  fs.createReadStream(fullPath).pipe(res);
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

app.get('/api/admin/stats', authAdmin, (req, res) => {
  res.json({
    students: db.prepare('SELECT COUNT(*) AS c FROM students').get().c,
    courses: db.prepare('SELECT COUNT(*) AS c FROM courses').get().c,
    enrollments: db.prepare('SELECT COUNT(*) AS c FROM enrollments').get().c,
    announcements: db.prepare('SELECT COUNT(*) AS c FROM announcements').get().c
  });
});

// ---------- Manual backup trigger ----------
app.post('/api/admin/backup', authAdmin, async (req, res) => {
  try {
    const { uploadBackup, createSnapshot, ENABLED } = require('./backup');
    if (!ENABLED) return res.status(400).json({ error: 'Backup not configured' });

    const snapshotPath = path.join('/tmp', `herald-snapshot-${Date.now()}.db`);

    // 1. Create a consistent snapshot using SQLite's backup API
    //    This captures ALL data including uncommitted WAL pages.
    await createSnapshot(db, snapshotPath);

    // 2. Log snapshot size for diagnostics
    const stats = fs.statSync(snapshotPath);
    console.log(`📊 Snapshot size: ${stats.size} bytes`);

    // 3. Upload the snapshot
    const result = await uploadBackup(snapshotPath);

    // 4. Cleanup snapshot
    fs.unlinkSync(snapshotPath);

    res.json({
      ok: true,
      size: result.size,
      snapshot_size: stats.size,
      at: new Date().toISOString()
    });
  } catch (err) {
    console.error('Backup error:', err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/admin/students', authAdmin, (req, res) => {
  res.json(db.prepare('SELECT id, reg_no, name, email, course, active, created_at FROM students ORDER BY id DESC').all());
});

app.post('/api/admin/students', authAdmin, (req, res) => {
  let { reg_no, name, email, password, course } = req.body;
  if (!name || !email || !password || !course) {
    return res.status(400).json({ error: 'Name, email, password, and course are required.' });
  }
  if (!reg_no) {
    reg_no = generateRegNo();  // auto-generate if blank
  }
  try {
    const hash = bcrypt.hashSync(password, 10);
    db.prepare('INSERT INTO students (reg_no, name, email, password, course) VALUES (?, ?, ?, ?, ?)')
      .run(reg_no, name, email.trim().toLowerCase(), hash, course);

    if (process.env.GMAIL_USER) {
      try {
        const { sendWelcomeEmail } = require('./mailer');
        sendWelcomeEmail({ to: email, studentName: name, regNo: reg_no, course })
          .catch(err => console.error('Welcome email error:', err.message));
      } catch (e) { console.error(e.message); }
    }

    res.json({ ok: true, reg_no });
  } catch (err) {
    if (String(err.message).includes('UNIQUE')) {
      return res.status(400).json({ error: 'Reg no or email already exists.' });
    }
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/admin/send-fee-reminders', authAdmin, async (req, res) => {
  try {
    const { sendFeeReminder } = require('./mailer');
    const rows = db.prepare(`
      SELECT f.amount_due - f.amount_paid AS balance, f.term, s.email, s.name
      FROM fees f JOIN students s ON s.id = f.student_id
      WHERE f.amount_due > f.amount_paid
    `).all();

    let sent = 0;
    for (const r of rows) {
      try {
        await sendFeeReminder({
          to: r.email,
          studentName: r.name,
          term: r.term,
          balance: r.balance,
        });
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
  if (!newPassword || newPassword.length < 6) {
    return res.status(400).json({ error: 'Password must be at least 6 characters.' });
  }
  try {
    db.prepare('UPDATE students SET password = ? WHERE id = ?')
      .run(bcrypt.hashSync(newPassword, 10), req.params.id);

    // Optionally email the new password to the student
    const student = db.prepare('SELECT name, email, reg_no FROM students WHERE id = ?').get(req.params.id);
    if (student && process.env.GMAIL_USER) {
      try {
        const { sendMail } = require('./mailer');
        sendMail({
          to: student.email,
          subject: 'Your Herald Portal password has been reset',
          html: `
            <h2>Password Reset</h2>
            <p>Hello ${student.name},</p>
            <p>Your password has been reset by an administrator.</p>
            <p><strong>New password:</strong> <code style="background:#f0f0f0; padding:4px 8px; border-radius:4px; font-family:monospace;">${newPassword}</code></p>
            <p>Please log in and change it immediately if you wish.</p>
            <p>Reg No: ${student.reg_no}</p>
          `,
        }).catch(err => console.error('Reset email failed:', err.message));
      } catch (e) { console.error(e.message); }
    }

    res.json({ ok: true, emailed: !!(student && process.env.GMAIL_USER) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

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

app.get('/api/admin/fees', authAdmin, (req, res) => {
  res.json(db.prepare(`
    SELECT f.*, s.reg_no, s.name AS student_name
    FROM fees f JOIN students s ON s.id = f.student_id ORDER BY f.id DESC
  `).all());
});

app.get('/api/admin/fees/summary', authAdmin, (req, res) => {
  const row = db.prepare(`
    SELECT
      COALESCE(SUM(amount_due), 0) AS total_due,
      COALESCE(SUM(amount_paid), 0) AS total_paid,
      COUNT(*) AS records,
      SUM(CASE WHEN status = 'paid' THEN 1 ELSE 0 END) AS paid_count,
      SUM(CASE WHEN status = 'partial' THEN 1 ELSE 0 END) AS partial_count,
      SUM(CASE WHEN status = 'unpaid' THEN 1 ELSE 0 END) AS unpaid_count
    FROM fees
  `).get();
  res.json(row);
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

app.put('/api/admin/submissions/:id', authAdmin, async (req, res) => {
  const { grade, feedback } = req.body;
  db.prepare('UPDATE submissions SET grade = ?, feedback = ? WHERE id = ?')
    .run(grade || '', feedback || '', req.params.id);

  // Notify student (fire-and-forget)
  try {
    if (process.env.GMAIL_USER) {
      const sub = db.prepare(`
        SELECT sub.*, s.email, s.name AS student_name, a.title AS assignment_title, c.code AS course_code
        FROM submissions sub
        JOIN students s ON s.id = sub.student_id
        JOIN assignments a ON a.id = sub.assignment_id
        JOIN courses c ON c.id = a.course_id
        WHERE sub.id = ?
      `).get(req.params.id);

      if (sub && grade) {
        const { sendAssignmentGraded } = require('./mailer');
        sendAssignmentGraded({
          to: sub.email,
          studentName: sub.student_name,
          assignmentTitle: sub.assignment_title,
          courseCode: sub.course_code,
          grade,
          feedback,
        }).catch(e => console.error('Email error:', e.message));
      }
    }
  } catch (e) { console.error('Notification error:', e.message); }

  res.json({ ok: true });
});

// ==================== ATTENDANCE — STUDENT ====================
app.get('/api/my-attendance', authStudent, (req, res) => {
  const rows = db.prepare(`
    SELECT a.id, a.date, a.status, a.notes, c.code, c.title
    FROM attendance a
    JOIN courses c ON c.id = a.course_id
    WHERE a.student_id = ?
    ORDER BY a.date DESC
    LIMIT 100
  `).all(req.user.id);

  // Summary per course
  const summary = db.prepare(`
    SELECT c.code, c.title,
      COUNT(*) AS total,
      SUM(CASE WHEN a.status = 'present' THEN 1 ELSE 0 END) AS present,
      SUM(CASE WHEN a.status = 'absent' THEN 1 ELSE 0 END) AS absent,
      SUM(CASE WHEN a.status = 'late' THEN 1 ELSE 0 END) AS late
    FROM attendance a
    JOIN courses c ON c.id = a.course_id
    WHERE a.student_id = ?
    GROUP BY c.id
  `).all(req.user.id);

  res.json({ records: rows, summary });
});

// ==================== ATTENDANCE — ADMIN ====================
app.get('/api/admin/attendance/:courseId', authAdmin, (req, res) => {
  const rows = db.prepare(`
    SELECT a.*, s.reg_no, s.name AS student_name
    FROM attendance a
    JOIN students s ON s.id = a.student_id
    WHERE a.course_id = ?
    ORDER BY a.date DESC, s.name ASC
    LIMIT 500
  `).all(req.params.courseId);
  res.json(rows);
});

app.post('/api/admin/attendance', authAdmin, (req, res) => {
  const { course_id, date, records } = req.body;
  if (!course_id || !date || !Array.isArray(records)) {
    return res.status(400).json({ error: 'course_id, date, records[] required' });
  }

  const insert = db.prepare(`
    INSERT INTO attendance (course_id, student_id, date, status, marked_by, notes)
    VALUES (?, ?, ?, ?, ?, ?)
  `);

  const del = db.prepare(`
    DELETE FROM attendance WHERE course_id = ? AND student_id = ? AND date = ?
  `);

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
  const rows = db.prepare(`
    SELECT s.id, s.reg_no, s.name,
      COUNT(a.id) AS total,
      SUM(CASE WHEN a.status = 'present' THEN 1 ELSE 0 END) AS present,
      SUM(CASE WHEN a.status = 'absent' THEN 1 ELSE 0 END) AS absent,
      SUM(CASE WHEN a.status = 'late' THEN 1 ELSE 0 END) AS late
    FROM students s
    JOIN enrollments e ON e.student_id = s.id AND e.course_id = ?
    LEFT JOIN attendance a ON a.student_id = s.id AND a.course_id = ?
    GROUP BY s.id
    ORDER BY s.name
  `).all(req.params.courseId, req.params.courseId);
  res.json(rows);
});

app.delete('/api/admin/attendance/:id', authAdmin, (req, res) => {
  db.prepare('DELETE FROM attendance WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// ==================== LIVE CLASSES ====================
app.get('/api/my-live-classes', authStudent, (req, res) => {
  const rows = db.prepare(`
    SELECT lc.*, c.code, c.title AS course_title
    FROM live_classes lc
    JOIN courses c ON c.id = lc.course_id
    JOIN enrollments e ON e.course_id = lc.course_id
    WHERE e.student_id = ?
    ORDER BY lc.scheduled_at ASC
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

app.get('/api/admin/live-classes', authAdmin, (req, res) => {
  const rows = db.prepare(`
    SELECT lc.*, c.code, c.title AS course_title
    FROM live_classes lc
    JOIN courses c ON c.id = lc.course_id
    ORDER BY lc.scheduled_at DESC
  `).all();
  res.json(rows);
});

app.post('/api/admin/live-classes', authAdmin, (req, res) => {
  const { course_id, title, description, meeting_url, scheduled_at, duration_minutes } = req.body;
  if (!course_id || !title || !meeting_url || !scheduled_at) {
    return res.status(400).json({ error: 'course_id, title, meeting_url, scheduled_at required' });
  }
  db.prepare(`
    INSERT INTO live_classes (course_id, title, description, meeting_url, scheduled_at, duration_minutes, created_by)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    course_id, title, description || '', meeting_url,
    scheduled_at, Number(duration_minutes) || 60, req.admin.id
  );
  res.json({ ok: true });
});

app.delete('/api/admin/live-classes/:id', authAdmin, (req, res) => {
  db.prepare('DELETE FROM live_classes WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// ==================== ATTENDANCE — STUDENT ====================
app.get('/api/my-attendance', authStudent, (req, res) => {
  const records = db.prepare(`
    SELECT a.id, a.date, a.status, a.notes, c.code, c.title
    FROM attendance a
    JOIN courses c ON c.id = a.course_id
    WHERE a.student_id = ?
    ORDER BY a.date DESC
    LIMIT 100
  `).all(req.user.id);

  const summary = db.prepare(`
    SELECT c.code, c.title,
      COUNT(*) AS total,
      SUM(CASE WHEN a.status = 'present' THEN 1 ELSE 0 END) AS present,
      SUM(CASE WHEN a.status = 'absent' THEN 1 ELSE 0 END) AS absent,
      SUM(CASE WHEN a.status = 'late' THEN 1 ELSE 0 END) AS late
    FROM attendance a
    JOIN courses c ON c.id = a.course_id
    WHERE a.student_id = ?
    GROUP BY c.id
  `).all(req.user.id);

  res.json({ records, summary });
});

// ==================== ATTENDANCE — ADMIN ====================
app.get('/api/admin/attendance/:courseId', authAdmin, (req, res) => {
  const rows = db.prepare(`
    SELECT a.*, s.reg_no, s.name AS student_name
    FROM attendance a
    JOIN students s ON s.id = a.student_id
    WHERE a.course_id = ?
    ORDER BY a.date DESC, s.name ASC
    LIMIT 500
  `).all(req.params.courseId);
  res.json(rows);
});

app.post('/api/admin/attendance', authAdmin, (req, res) => {
  const { course_id, date, records } = req.body;
  if (!course_id || !date || !Array.isArray(records)) {
    return res.status(400).json({ error: 'course_id, date, records[] required' });
  }

  const insert = db.prepare(`
    INSERT INTO attendance (course_id, student_id, date, status, marked_by, notes)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  const del = db.prepare(`
    DELETE FROM attendance WHERE course_id = ? AND student_id = ? AND date = ?
  `);

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
  const rows = db.prepare(`
    SELECT s.id, s.reg_no, s.name,
      COUNT(a.id) AS total,
      SUM(CASE WHEN a.status = 'present' THEN 1 ELSE 0 END) AS present,
      SUM(CASE WHEN a.status = 'absent' THEN 1 ELSE 0 END) AS absent,
      SUM(CASE WHEN a.status = 'late' THEN 1 ELSE 0 END) AS late
    FROM students s
    JOIN enrollments e ON e.student_id = s.id AND e.course_id = ?
    LEFT JOIN attendance a ON a.student_id = s.id AND a.course_id = ?
    GROUP BY s.id
    ORDER BY s.name
  `).all(req.params.courseId, req.params.courseId);
  res.json(rows);
});

app.delete('/api/admin/attendance/:id', authAdmin, (req, res) => {
  db.prepare('DELETE FROM attendance WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// ==================== LIVE CLASSES ====================
app.get('/api/my-live-classes', authStudent, (req, res) => {
  const rows = db.prepare(`
    SELECT lc.*, c.code, c.title AS course_title
    FROM live_classes lc
    JOIN courses c ON c.id = lc.course_id
    JOIN enrollments e ON e.course_id = lc.course_id
    WHERE e.student_id = ?
    ORDER BY lc.scheduled_at ASC
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

app.get('/api/admin/live-classes', authAdmin, (req, res) => {
  const rows = db.prepare(`
    SELECT lc.*, c.code, c.title AS course_title
    FROM live_classes lc
    JOIN courses c ON c.id = lc.course_id
    ORDER BY lc.scheduled_at DESC
  `).all();
  res.json(rows);
});

app.post('/api/admin/live-classes', authAdmin, async (req, res) => {
  const { course_id, title, description, meeting_url, scheduled_at, duration_minutes, notify } = req.body;
  if (!course_id || !title || !meeting_url || !scheduled_at) {
    return res.status(400).json({ error: 'course_id, title, meeting_url, scheduled_at required' });
  }

  const info = db.prepare(`
    INSERT INTO live_classes (course_id, title, description, meeting_url, scheduled_at, duration_minutes, created_by)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    course_id, title, description || '', meeting_url,
    scheduled_at, Number(duration_minutes) || 60, req.admin.id
  );

  // Optional: send email notifications to enrolled students
  if (notify && process.env.GMAIL_USER && process.env.GMAIL_PASS) {
    try {
      const students = db.prepare(`
        SELECT s.email, s.name FROM students s
        JOIN enrollments e ON e.student_id = s.id
        WHERE e.course_id = ?
      `).all(course_id);

      const course = db.prepare('SELECT code, title FROM courses WHERE id = ?').get(course_id);
      const { sendLiveClassNotification } = require('./mailer');

      for (const s of students) {
        sendLiveClassNotification({
          to: s.email,
          studentName: s.name,
          courseCode: course.code,
          courseTitle: course.title,
          classTitle: title,
          scheduledAt: new Date(scheduled_at),
          meetingUrl: meeting_url,
        }).catch(err => console.error('Email failed:', err.message));
      }
    } catch (e) {
      console.error('Notification error:', e.message);
    }
  }

  res.json({ ok: true, id: info.lastInsertRowid });
});

app.delete('/api/admin/live-classes/:id', authAdmin, (req, res) => {
  db.prepare('DELETE FROM live_classes WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

app.listen(PORT, () => console.log(`Herald Portal running on http://localhost:${PORT}`));