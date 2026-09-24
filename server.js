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
function signToken(student) {
  return jwt.sign({ id: student.id, reg: student.reg_no }, JWT_SECRET, { expiresIn: '7d' });
}

function auth(req, res, next) {
  const token = req.cookies.token;
  if (!token) return res.status(401).json({ error: 'Not authenticated' });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: 'Invalid token' });
  }
}

// ---------- Routes ----------
app.post('/api/login', (req, res) => {
  const { reg_no, password } = req.body;
  if (!reg_no || !password) return res.status(400).json({ error: 'Missing credentials' });

  const student = db.prepare('SELECT * FROM students WHERE reg_no = ?').get(reg_no);
  if (!student) return res.status(401).json({ error: 'Invalid registration number or password' });
  if (!bcrypt.compareSync(password, student.password))
    return res.status(401).json({ error: 'Invalid registration number or password' });

  const token = signToken(student);
  res.cookie('token', token, { httpOnly: true, sameSite: 'lax' });
  res.json({ ok: true, name: student.name });
});

app.post('/api/register', (req, res) => {
  const { reg_no, name, email, password, course } = req.body;
  if (!reg_no || !name || !email || !password || !course)
    return res.status(400).json({ error: 'All fields required' });

  try {
    const hash = bcrypt.hashSync(password, 10);
    const info = db.prepare(
      'INSERT INTO students (reg_no, name, email, password, course) VALUES (?, ?, ?, ?, ?)'
    ).run(reg_no, name, email, hash, course);
    const student = db.prepare('SELECT * FROM students WHERE id = ?').get(info.lastInsertRowid);
    res.cookie('token', signToken(student), { httpOnly: true, sameSite: 'lax' });
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: 'Registration number or email already exists' });
  }
});

app.post('/api/logout', (req, res) => {
  res.clearCookie('token');
  res.json({ ok: true });
});

app.get('/api/me', auth, (req, res) => {
  const student = db.prepare(
    'SELECT id, reg_no, name, email, course FROM students WHERE id = ?'
  ).get(req.user.id);
  res.json(student);
});

app.get('/api/courses', auth, (req, res) => {
  const courses = db.prepare('SELECT * FROM courses').all();
  const enrolled = db.prepare(
    'SELECT course_id FROM enrollments WHERE student_id = ?'
  ).all(req.user.id).map(r => r.course_id);
  res.json(courses.map(c => ({ ...c, enrolled: enrolled.includes(c.id) })));
});

app.post('/api/enroll/:courseId', auth, (req, res) => {
  const courseId = Number(req.params.courseId);
  const exists = db.prepare(
    'SELECT 1 FROM enrollments WHERE student_id = ? AND course_id = ?'
  ).get(req.user.id, courseId);
  if (exists) return res.status(400).json({ error: 'Already enrolled' });
  db.prepare('INSERT INTO enrollments (student_id, course_id) VALUES (?, ?)')
    .run(req.user.id, courseId);
  res.json({ ok: true });
});

app.get('/api/results', auth, (req, res) => {
  const rows = db.prepare(`
    SELECT r.marks, r.grade, r.term, c.code, c.title
    FROM results r JOIN courses c ON c.id = r.course_id
    WHERE r.student_id = ?
    ORDER BY r.term DESC
  `).all(req.user.id);
  res.json(rows);
});

app.get('/api/announcements', auth, (req, res) => {
  const rows = db.prepare(
    'SELECT * FROM announcements ORDER BY created_at DESC LIMIT 20'
  ).all();
  res.json(rows);
});

app.listen(PORT, () => console.log(`Herald Portal running on http://localhost:${PORT}`));