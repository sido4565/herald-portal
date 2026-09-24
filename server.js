const express = require('express');
const cookieParser = require('cookie-parser');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const path = require('path');
const db = require('./database');

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'herald-dev-secret-change-me';

app.use(express.json());
app.use(cookieParser());
app.use(express.static(path.join(__dirname, 'public')));

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

app.post('/api/register', (req, res) => {
  const { reg_no, name, email, password, course } = req.body;
  if (!reg_no || !name || !email || !password || !course)
    return res.status(400).json({ error: 'All fields required' });
  try {
    const hash = bcrypt.hashSync(password, 10);
    const info = db.prepare('INSERT INTO students (reg_no, name, email, password, course) VALUES (?, ?, ?, ?, ?)')
      .run(reg_no, name, email, hash, course);
    const s = db.prepare('SELECT * FROM students WHERE id = ?').get(info.lastInsertRowid);
    res.cookie('token', signStudent(s), { httpOnly: true, sameSite: 'lax' });
    res.json({ ok: true });
  } catch { res.status(400).json({ error: 'Registration number or email already exists' }); }
});

app.post('/api/logout', (req, res) => { res.clearCookie('token'); res.json({ ok: true }); });

app.get('/api/me', authStudent, (req, res) => {
  res.json(db.prepare('SELECT id, reg_no, name, email, course FROM students WHERE id = ?').get(req.user.id));
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
      (SELECT feedback FROM submissions WHERE assignment_id = a.id AND student_id = ?) AS feedback
    FROM assignments a JOIN courses c ON c.id = a.course_id
    JOIN enrollments e ON e.course_id = a.course_id
    WHERE e.student_id = ?
    ORDER BY a.due_date ASC
  `).all(req.user.id, req.user.id, req.user.id, req.user.id));
});

app.post('/api/submit/:assignmentId', authStudent, (req, res) => {
  const { content } = req.body;
  const aid = Number(req.params.assignmentId);
  const existing = db.prepare('SELECT id FROM submissions WHERE assignment_id = ? AND student_id = ?').get(aid, req.user.id);
  if (existing) {
    db.prepare('UPDATE submissions SET content = ?, submitted_at = CURRENT_TIMESTAMP WHERE id = ?').run(content, existing.id);
  } else {
    db.prepare('INSERT INTO submissions (assignment_id, student_id, content) VALUES (?, ?, ?)').run(aid, req.user.id, content);
  }
  res.json({ ok: true });
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

// --- Students
app.get('/api/admin/students', authAdmin, (req, res) => {
  res.json(db.prepare('SELECT id, reg_no, name, email, course, active, created_at FROM students ORDER BY id DESC').all());
});

app.post('/api/admin/students', authAdmin, (req, res) => {
  const { reg_no, name, email, password, course } = req.body;
  if (!reg_no || !name || !email || !password || !course) return res.status(400).json({ error: 'All fields required' });
  try {
    const hash = bcrypt.hashSync(password, 10);
    db.prepare('INSERT INTO students (reg_no, name, email, password, course) VALUES (?, ?, ?, ?, ?)')
      .run(reg_no, name, email, hash, course);
    res.json({ ok: true });
  } catch { res.status(400).json({ error: 'Reg no or email already exists' }); }
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

app.post('/api/admin/students/:id/reset-password', authAdmin, (req, res) => {
  const { newPassword } = req.body;
  if (!newPassword || newPassword.length < 6) return res.status(400).json({ error: 'Min 6 chars' });
  db.prepare('UPDATE students SET password = ? WHERE id = ?').run(bcrypt.hashSync(newPassword, 10), req.params.id);
  res.json({ ok: true });
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
      (SELECT COUNT(*) FROM submissions WHERE assignment_id = a.id AND grade IS NOT NULL AND grade != '') AS graded_count
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

app.put('/api/admin/submissions/:id', authAdmin, (req, res) => {
  const { grade, feedback } = req.body;
  db.prepare('UPDATE submissions SET grade = ?, feedback = ? WHERE id = ?')
    .run(grade || '', feedback || '', req.params.id);
  res.json({ ok: true });
});

app.listen(PORT, () => console.log(`Herald Portal running on http://localhost:${PORT}`));