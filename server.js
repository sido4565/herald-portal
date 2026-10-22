// Load .env only if it exists (local dev). On Render, env vars come from the dashboard.
if (require('fs').existsSync(require('path').join(__dirname, '.env'))) {
  require('dotenv').config();
}
const express = require('express');
const cookieParser = require('cookie-parser');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const db = require('./database');
const PDFDocument = require('pdfkit');
const { sendSMS } = require('./sms');

// ---------- Global BigInt JSON fix ----------
// Turso/libsql returns BigInt for large integers; JSON.stringify can't handle them.
BigInt.prototype.toJSON = function () { return Number(this); };

// ---------- R2 (Cloudflare) S3 client ----------
const { S3Client, PutObjectCommand, DeleteObjectCommand } = require('@aws-sdk/client-s3');

const R2_ACCOUNT_ID = process.env.R2_ACCOUNT_ID;
const R2_ACCESS_KEY_ID = process.env.R2_ACCESS_KEY_ID;
const R2_SECRET_ACCESS_KEY = process.env.R2_SECRET_ACCESS_KEY;
const R2_BUCKET = process.env.R2_BUCKET || 'herald-portal-uploads';
const R2_PUBLIC_URL = (process.env.R2_PUBLIC_URL || '').replace(/\/$/, ''); // strip trailing slash

let r2 = null;
if (R2_ACCOUNT_ID && R2_ACCESS_KEY_ID && R2_SECRET_ACCESS_KEY) {
  r2 = new S3Client({
    region: 'auto',
    endpoint: `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: R2_ACCESS_KEY_ID,
      secretAccessKey: R2_SECRET_ACCESS_KEY,
    },
  });
  console.log('☁️  R2 storage configured');
} else {
  console.warn('⚠️  R2 env vars missing — falling back to local disk storage');
}

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'herald-dev-secret-change-me';

app.use(express.json());
app.use(cookieParser());
app.use(express.static(path.join(__dirname, 'public')));

// ---------- File uploads (R2 with local fallback) ----------
const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(__dirname, 'uploads');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// Use memory storage — we'll stream the buffer to R2 (or write to disk in fallback)
const storage = multer.memoryStorage();

async function saveFile(file) {
  const safe = file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_');
  const key = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}-${safe}`;

  if (r2 && R2_PUBLIC_URL) {
    await r2.send(new PutObjectCommand({
      Bucket: R2_BUCKET,
      Key: key,
      Body: file.buffer,
      ContentType: file.mimetype,
      ContentDisposition: 'inline',
    }));
    return {
      file_path: `${R2_PUBLIC_URL}/${key}`,
      file_key: key,
      file_name: file.originalname,
      storage: 'r2',
    };
  } else {
    const fullPath = path.join(UPLOAD_DIR, key);
    fs.writeFileSync(fullPath, file.buffer);
    return {
      file_path: `/uploads/${key}`,
      file_key: key,
      file_name: file.originalname,
      storage: 'local',
    };
  }
}

async function deleteFile(fileKey, storageType = 'r2') {
  try {
    if (storageType === 'r2' && r2) {
      await r2.send(new DeleteObjectCommand({ Bucket: R2_BUCKET, Key: fileKey }));
    } else {
      const fullPath = path.join(UPLOAD_DIR, fileKey);
      if (fs.existsSync(fullPath)) fs.unlinkSync(fullPath);
    }
  } catch (e) {
    console.error('Delete file failed:', e.message);
  }
}

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

// Legacy static route — still serves old local uploads if any exist
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

// ---------- Google Sheets webhook ----------
const GOOGLE_SHEETS_WEBHOOK_URL = process.env.GOOGLE_SHEETS_WEBHOOK_URL;

async function sendToGoogleSheets(payload) {
  if (!GOOGLE_SHEETS_WEBHOOK_URL) return;
  try {
    const res = await fetch(GOOGLE_SHEETS_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      console.warn('Google Sheets webhook returned', res.status);
    }
  } catch (err) {
    console.error('Google Sheets webhook failed:', err.message);
  }
}

async function pushAttendanceToSheets({ course_id, date, records, markedBy }) {
  if (!GOOGLE_SHEETS_WEBHOOK_URL) return;

  try {
    // Fetch course details once
    const cr = await db.execute({
      sql: 'SELECT code, title FROM courses WHERE id = ?',
      args: [course_id],
    });
    const course = cr.rows[0] || { code: '?', title: 'Unknown course' };
    const courseLabel = `${course.code} — ${course.title}`;

    // Fetch all student details in one go
    const studentIds = records.map(r => r.student_id);
    if (!studentIds.length) return;

    const placeholders = studentIds.map(() => '?').join(',');
    const sr = await db.execute({
      sql: `SELECT id, reg_no, name FROM students WHERE id IN (${placeholders})`,
      args: studentIds,
    });
    const studentMap = {};
    sr.rows.forEach(s => { studentMap[s.id] = s; });

    // Build one row per record
    const rows = records.map(r => {
      const s = studentMap[r.student_id] || {};
      return {
        student_name: s.name || 'Unknown',
        reg_no: s.reg_no || '',
        course: courseLabel,
        date,
        status: r.status || 'present',
      };
    });

    // Send as an array — the Apps Script handles batches
    await sendToGoogleSheets(rows);
    console.log(`📊 Sent ${rows.length} attendance rows to Google Sheets`);
  } catch (err) {
    console.error('pushAttendanceToSheets failed:', err.message);
  }
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
    
  // NEW: Check approval status
  if (s.status === 'pending') return res.status(403).json({ error: 'Your application is pending admin approval.' });
  if (s.status === 'rejected') return res.status(403).json({ error: 'Your application was rejected. Contact admin.' });
  
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

    // 1. Insert the student (FORCE Status to 'pending')
    const info = await db.execute({
      sql: 'INSERT INTO students (reg_no, name, email, password, course, status) VALUES (?, ?, ?, ?, ?, ?)',
      args: [reg_no, name.trim(), email.trim().toLowerCase(), hash, course, 'pending'],
    });

    const studentId = info.lastInsertRowid;

    // 2. Fetch the newly created student to sign the token
    const sRes = await db.execute({
      sql: 'SELECT * FROM students WHERE id = ?',
      args: [studentId],
    });
    const s = sRes.rows[0];
    
    // 3. Set the cookie (so they are technically logged in, but restricted by status)
    res.cookie('token', signStudent(s), { httpOnly: true, sameSite: 'lax' });

    // 4. Auto-enroll in the selected course
        // 4. Auto-enroll in the selected course (with detailed logging)
    try {
      const trimmedCourse = String(course || '').trim();
      
      const courseRes = await db.execute({
        sql: 'SELECT id FROM courses WHERE LOWER(title) = LOWER(?) OR LOWER(code) = LOWER(?) LIMIT 1',
        args: [trimmedCourse, trimmedCourse]
      });
      
      if (courseRes.rows.length) {
        const courseId = Number(courseRes.rows[0].id);
        await db.execute({
          sql: 'INSERT OR IGNORE INTO enrollments (student_id, course_id) VALUES (?, ?)',
          args: [studentId, courseId]
        });
        console.log(`✅ Auto-enrolled student ${studentId} in course ${courseId} (${trimmedCourse})`);
      } else {
        console.warn(`⚠️  Course not found for auto-enrollment: "${trimmedCourse}"`);
      }
    } catch (enrollErr) {
      console.error('❌ Auto-enrollment error:', enrollErr.message);
    }

    // 6. Return success with the pending message
    res.json({ 
      ok: true, 
      reg_no: s.reg_no, 
      name: s.name, 
      message: `Application received! Your registration number is ${s.reg_no}. Await admin approval to log in.` 
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

app.get('/api/me', authStudent, async (req, res) => {
  const r = await db.execute({
    sql: 'SELECT id, reg_no, name, email, course FROM students WHERE id = ?',
    args: [req.user.id],
  });
  res.json(r.rows[0]);
});

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
  try {
    const courses = await db.execute('SELECT * FROM courses');
    
    // Fetch enrollments for this student
    const enrolled = await db.execute({
      sql: 'SELECT course_id FROM enrollments WHERE student_id = ?',
      args: [req.user.id],
    });
    
    // Ensure IDs are treated as standard numbers to prevent BigInt mismatch
    const enrolledIds = enrolled.rows.map(r => Number(r.course_id));

    res.json(courses.rows.map(c => {
      const cid = Number(c.id);
      return {
        ...c,
        id: cid,
        enrolled: enrolledIds.includes(cid)
      };
    }));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
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
  try {
    const aid = Number(req.params.assignmentId);
    const content = (req.body.content || '').trim();

    let filePath = null, fileName = null, fileKey = null;
    if (req.file) {
      const saved = await saveFile(req.file);
      filePath = saved.file_path;
      fileName = saved.file_name;
      fileKey = saved.file_key;
    }

    if (!content && !filePath) return res.status(400).json({ error: 'Provide text and/or a PDF file' });

    const existing = await db.execute({
      sql: 'SELECT * FROM submissions WHERE assignment_id = ? AND student_id = ?',
      args: [aid, req.user.id],
    });

    if (existing.rows.length) {
      const old = existing.rows[0];
      if (old.file_key && fileKey && old.file_key !== fileKey) {
        await deleteFile(old.file_key, 'r2');
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
  } catch (err) {
    console.error('Submission error:', err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/submission/:id/file', authStudent, async (req, res) => {
  const r = await db.execute({ sql: 'SELECT * FROM submissions WHERE id = ?', args: [req.params.id] });
  const sub = r.rows[0];
  if (!sub || !sub.file_path) return res.status(404).json({ error: 'No file' });
  if (sub.student_id !== req.user.id) return res.status(403).json({ error: 'Not yours' });

  // If R2 URL, redirect
  if (sub.file_path.startsWith('http')) return res.redirect(sub.file_path);

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


// ---------- Download PDF Transcript ----------

// ---------- Download PDF Transcript ----------
app.get('/api/student/transcript/pdf', authStudent, async (req, res) => {
  try {
    // 1. Fetch student details
    const sRes = await db.execute({
      sql: 'SELECT reg_no, name, email, course FROM students WHERE id = ?',
      args: [req.user.id],
    });
    const student = sRes.rows[0];

    // 2. Fetch results
    const rRes = await db.execute({
      sql: `SELECT r.marks, r.grade, r.term, c.code AS course_code, c.title AS course_title
            FROM results r JOIN courses c ON c.id = r.course_id
            WHERE r.student_id = ?
            ORDER BY r.term ASC, c.code ASC`,
      args: [req.user.id],
    });
    const results = rRes.rows;

    // 3. Create the PDF
    const doc = new PDFDocument({ margin: 50, size: 'A4' });

    // Set response headers to trigger a file download
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="Herald-Transcript-${student.reg_no}.pdf"`);

    // Pipe the PDF directly to the response
    doc.pipe(res);

    // --- 1. BACKGROUND COLOR (Light Brown / Parchment) ---
    doc.rect(0, 0, doc.page.width, doc.page.height).fill('#fcf8f2');
    
    // Draw a thin border
    doc.rect(20, 20, doc.page.width - 40, doc.page.height - 40).lineWidth(2).stroke('#d4c4b7');
    doc.rect(25, 25, doc.page.width - 50, doc.page.height - 50).lineWidth(1).stroke('#d4c4b7');

        // --- 2. LOGO & HEADER ---
    const logoPath = path.join(__dirname, 'public', 'images', 'herald-logo.png');
    try {
      if (fs.existsSync(logoPath)) {
        // --- WATERMARK LOGO (Big & Translucent) ---
        // Save the current graphics state
        doc.save();
        
        // Set opacity to 15% (0.15)
        doc.opacity(0.15);
        
        // Draw the logo in the center of the page (A4 is 595 x 842 points)
        // width: 350 makes it much bigger
        doc.image(logoPath, doc.page.width / 2 - 175, doc.page.height / 2 - 175, { width: 350 });
        
        // Restore the graphics state so the next text is fully opaque
        doc.restore();
      } else {
        console.log('Logo not found at:', logoPath);
      }
    } catch (imgErr) {
      console.error('Error loading logo into PDF:', imgErr);
    }

    // --- HEADER TEXT ---
    // We keep the header text at the top
    doc.fontSize(22).font('Helvetica-Bold').fillColor('#10243a').text('HERALD TRAINER AND CONSULTANT', { align: 'center' });
    doc.fontSize(10).font('Helvetica').fillColor('#555555').text('Mombasa, Kenya | info@heraldtrainer.co.ke | +254 107 004 000', { align: 'center' });
    doc.moveDown(1.5);

    doc.fontSize(16).font('Helvetica-Bold').fillColor('#10243a').text('OFFICIAL ACADEMIC TRANSCRIPT', { align: 'center', underline: true });
    doc.moveDown(2);

    // --- 3. STUDENT INFO ---
    doc.fontSize(12).font('Helvetica-Bold').fillColor('#10243a').text('Student Information:');
    doc.font('Helvetica').fontSize(11).fillColor('#333333');
    doc.text(`Name: ${student.name}`);
    doc.text(`Registration Number: ${student.reg_no}`);
    doc.text(`Program: ${student.course}`);
    doc.text(`Email: ${student.email}`);
    doc.moveDown(2);

    // --- 4. RESULTS TABLE ---
    doc.fontSize(12).font('Helvetica-Bold').fillColor('#10243a').text('Academic Results:');
    doc.moveDown(0.5);

    const colCode = 50;
    const colTitle = 100;
    const colTerm = 320;
    const colMarks = 460;
    const colGrade = 510;

    const tableTop = doc.y;
    doc.fontSize(10).font('Helvetica-Bold').fillColor('#333333');
    doc.text('Code', colCode, tableTop);
    doc.text('Course Title', colTitle, tableTop);
    doc.text('Term', colTerm, tableTop);
    doc.text('Marks', colMarks, tableTop);
    doc.text('Grade', colGrade, tableTop);

    doc.moveTo(50, tableTop + 15).lineTo(550, tableTop + 15).strokeColor('#d4c4b7').lineWidth(1).stroke();

    let y = tableTop + 25;
    doc.font('Helvetica').fontSize(10).fillColor('#000000');
    
    results.forEach(r => {
      doc.text(r.course_code, colCode, y);
      doc.text(r.course_title, colTitle, y, { width: 210 }); 
      doc.text(r.term, colTerm, y, { width: 130 });
      doc.text(r.marks.toString(), colMarks, y);
      doc.text(r.grade, colGrade, y);
      y = Math.max(y + 20, doc.y + 20); 
    });

    doc.moveDown(4);
    
    // --- 5. OFFICIAL DATED STAMP ---
    const stampX = 420;
    const stampY = doc.y + 20;
    const stampRadius = 45;

    // Draw the stamp (Double circle + text)
    doc.save();
    doc.translate(stampX, stampY);
    doc.rotate(-15); // Slight tilt for a physical stamp effect
    
    // Outer circle
    doc.circle(0, 0, stampRadius).lineWidth(2).strokeColor('#b91c1c').stroke();
    // Inner circle
    doc.circle(0, 0, stampRadius - 4).lineWidth(1).strokeColor('#b91c1c').stroke();
    
    // Stamp Text
    doc.fontSize(8).font('Helvetica-Bold').fillColor('#b91c1c').text('HERALD TRAINER', -40, -20, { width: 80, align: 'center' });
    doc.text('AND CONSULTANT', -40, -10, { width: 80, align: 'center' });
    
    // The Date inside the stamp
    const dateStr = new Date().toLocaleDateString('en-GB').replace(/\//g, ' . ');
    doc.fontSize(10).text(dateStr, -40, 5, { width: 80, align: 'center' });
    
    doc.text('VERIFIED', -40, 20, { width: 80, align: 'center' });
    doc.restore();

    // --- 6. SIGNATURE & FOOTER ---
    doc.fontSize(10).font('Helvetica-Oblique').fillColor('#555555').text(
      'This is a computer-generated transcript and does not require a physical signature.', 
      50, 
      doc.page.height - 80, 
      { align: 'center', width: 500 }
    );
    
    // Finalize the PDF
    doc.end();

  } catch (err) {
    console.error('PDF Generation Error:', err);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Could not generate PDF transcript.' });
    }
  }
});

// ==================== LECTURER ROUTES ====================
app.post('/api/lecturer/register', materialUpload.fields([
  { name: 'cv', maxCount: 1 },
  { name: 'cover_letter', maxCount: 1 },
  { name: 'testimonials', maxCount: 1 }
]), async (req, res) => {
  const { name, email, phone, password, qualification, specialization, bio, id_number, location, address } = req.body;
  
  if (!name || !email || !password) {
    return res.status(400).json({ error: 'Name, email, and password are required.' });
  }

  try {
    const staff_no = await generateStaffNo();
    const hash = bcrypt.hashSync(password, 10);

    let cv_url = null, cover_letter_url = null, testimonials_url = null;

    // 1. Safely upload files
    if (req.files) {
      try {
        if (req.files.cv && req.files.cv[0]) {
          const saved = await saveFile(req.files.cv[0]);
          cv_url = saved.file_path;
        }
        if (req.files.cover_letter && req.files.cover_letter[0]) {
          const saved = await saveFile(req.files.cover_letter[0]);
          cover_letter_url = saved.file_path;
        }
        if (req.files.testimonials && req.files.testimonials[0]) {
          const saved = await saveFile(req.files.testimonials[0]);
          testimonials_url = saved.file_path;
        }
      } catch (uploadErr) {
        console.error('❌ FILE UPLOAD FAILED:', uploadErr);
        return res.status(500).json({ error: 'File upload failed. ' + uploadErr.message });
      }
    }

    // 2. Save to Database
    await db.execute({
      sql: `INSERT INTO lecturers (staff_no, name, email, phone, password, qualification, specialization, bio, cv_url, cover_letter_url, testimonials_url)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [staff_no, name.trim(), email.trim().toLowerCase(), phone || '', hash, qualification || '', specialization || '', bio || '', cv_url, cover_letter_url, testimonials_url],
    });

    // 3. Send email notification
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
                   <div><strong>CV:</strong> ${cv_url ? 'Uploaded ✅' : 'Not provided'}</div>
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
    console.error('❌ LECTURER REGISTRATION CRASH:', err);
    res.status(500).json({ error: 'Server error: ' + err.message });
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

// List results — only for courses this lecturer is assigned to
app.get('/api/lecturer/results', authLecturer, async (req, res) => {
  try {
    const r = await db.execute({
      sql: `
        SELECT r.id, r.marks, r.grade, r.term,
               s.id AS student_id, s.reg_no, s.name AS student_name,
               c.id AS course_id, c.code, c.title AS course_title
        FROM results r
        JOIN students s ON s.id = r.student_id
        JOIN courses c ON c.id = r.course_id
        JOIN lecturer_courses lc ON lc.course_id = c.id
        WHERE lc.lecturer_id = ?
        ORDER BY r.term DESC, c.code ASC, s.name ASC
      `,
      args: [req.lecturer.id],
    });
    res.json(r.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/lecturer/results', authLecturer, async (req, res) => {
  const { student_id, course_id, marks, term } = req.body;
  if (!student_id || !course_id || marks == null || !term) {
    return res.status(400).json({ error: 'All fields required' });
  }
  try {
    // Verify this lecturer teaches this course
    const check = await db.execute({
      sql: 'SELECT 1 FROM lecturer_courses WHERE lecturer_id = ? AND course_id = ?',
      args: [req.lecturer.id, course_id],
    });
    if (!check.rows.length) {
      return res.status(403).json({ error: 'You are not assigned to this course' });
    }

    const grade = calcGrade(Number(marks));
    const info = await db.execute({
      sql: 'INSERT INTO results (student_id, course_id, marks, grade, term) VALUES (?, ?, ?, ?, ?)',
      args: [student_id, course_id, Number(marks), grade, term],
    });

    res.json({ ok: true, id: Number(info.lastInsertRowid), grade });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Update an existing result (only if course belongs to this lecturer)
app.put('/api/lecturer/results/:id', authLecturer, async (req, res) => {
  const { marks, term } = req.body;
  if (marks == null || !term) return res.status(400).json({ error: 'marks and term required' });
  try {
    const check = await db.execute({
      sql: `SELECT r.id FROM results r
            JOIN lecturer_courses lc ON lc.course_id = r.course_id
            WHERE r.id = ? AND lc.lecturer_id = ?`,
      args: [req.params.id, req.lecturer.id],
    });
    if (!check.rows.length) return res.status(403).json({ error: 'Not allowed' });

    const grade = calcGrade(Number(marks));
    await db.execute({
      sql: 'UPDATE results SET marks = ?, grade = ?, term = ? WHERE id = ?',
      args: [Number(marks), grade, term, req.params.id],
    });
    res.json({ ok: true, grade });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Delete a result (only if course belongs to this lecturer)
app.delete('/api/lecturer/results/:id', authLecturer, async (req, res) => {
  try {
    const check = await db.execute({
      sql: `SELECT r.id FROM results r
            JOIN lecturer_courses lc ON lc.course_id = r.course_id
            WHERE r.id = ? AND lc.lecturer_id = ?`,
      args: [req.params.id, req.lecturer.id],
    });
    if (!check.rows.length) return res.status(403).json({ error: 'Not allowed' });

    await db.execute({ sql: 'DELETE FROM results WHERE id = ?', args: [req.params.id] });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
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

// Attendance for a specific course on a specific date (roster + saved status)
app.get('/api/lecturer/attendance/:courseId/:date', authLecturer, async (req, res) => {
  try {
    const { courseId, date } = req.params;

    // Verify lecturer is assigned to this course
    const check = await db.execute({
      sql: 'SELECT 1 FROM lecturer_courses WHERE lecturer_id = ? AND course_id = ?',
      args: [req.lecturer.id, courseId],
    });
    if (!check.rows.length) return res.status(403).json({ error: 'Not assigned to this course' });

    // Get roster + any saved status for that date
    const r = await db.execute({
      sql: `
        SELECT s.id AS student_id, s.reg_no, s.name AS student_name,
               a.status, a.notes
        FROM students s
        JOIN enrollments e ON e.student_id = s.id AND e.course_id = ?
        LEFT JOIN attendance a ON a.student_id = s.id AND a.course_id = ? AND a.date = ?
        ORDER BY s.name
      `,
      args: [courseId, courseId, date],
    });

    res.json(r.rows.map(row => ({
      student_id: row.student_id,
      reg_no: row.reg_no,
      student_name: row.student_name,
      status: row.status || null,   // null = not marked yet
      notes: row.notes || '',
    })));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/lecturer/attendance', authLecturer, async (req, res) => {
  const { course_id, date, records } = req.body;
  if (!course_id || !date || !Array.isArray(records)) {
    return res.status(400).json({ error: 'course_id, date, records[] required' });
  }

  try {
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

    // Fire-and-forget sync to Google Sheets
    pushAttendanceToSheets({ course_id, date, records, markedBy: req.lecturer.id })
      .catch(err => console.error('Sheets sync error:', err.message));

    res.json({ ok: true, count: records.length });
  } catch (err) {
    console.error('Attendance save failed:', err);
    res.status(500).json({ error: err.message });
  }
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
  try {
    const { course_id, title, description, material_type, file_path, file_name, external_url, release_date } = req.body;
    if (!course_id || !title || !release_date) {
      return res.status(400).json({ error: 'course_id, title, and release_date are required' });
    }
    const info = await db.execute({
      sql: `INSERT INTO materials (course_id, title, description, material_type, file_path, file_name, external_url, release_date, created_by)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [course_id, title, description || '', material_type || 'file', file_path || null, file_name || null, external_url || null, release_date, req.lecturer.id],
    });
    res.json({ ok: true, id: Number(info.lastInsertRowid) });
  } catch (err) {
    console.error('Material save failed:', err);
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/lecturer/materials/:id', authLecturer, async (req, res) => {
  try {
    await db.execute({ sql: 'DELETE FROM material_views WHERE material_id = ?', args: [req.params.id] });
    await db.execute({ sql: 'DELETE FROM materials WHERE id = ?', args: [req.params.id] });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
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

app.post('/api/lecturer/materials/upload', authLecturer, materialUpload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  try {
    const saved = await saveFile(req.file);
    res.json({
      ok: true,
      file_path: saved.file_path,
      file_key: saved.file_key,
      file_name: saved.file_name,
      storage: saved.storage,
    });
  } catch (err) {
    console.error('Upload failed:', err);
    res.status(500).json({ error: 'Upload failed: ' + err.message });
  }
});

// ---------- Live Classes (lecturer) ----------
app.get('/api/lecturer/live-classes', authLecturer, async (req, res) => {
  try {
    const r = await db.execute({
      sql: `
        SELECT lc.*, c.code, c.title AS course_title
        FROM live_classes lc
        JOIN courses c ON c.id = lc.course_id
        JOIN lecturer_courses lc2 ON lc2.course_id = c.id
        WHERE lc2.lecturer_id = ?
        ORDER BY lc.scheduled_at DESC
      `,
      args: [req.lecturer.id],
    });
    res.json(r.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/lecturer/live-classes', authLecturer, async (req, res) => {
  const { course_id, title, description, meeting_url, scheduled_at, duration_minutes, notify } = req.body;
  if (!course_id || !title || !meeting_url || !scheduled_at) {
    return res.status(400).json({ error: 'course_id, title, meeting_url, scheduled_at required' });
  }
  try {
    const check = await db.execute({
      sql: 'SELECT 1 FROM lecturer_courses WHERE lecturer_id = ? AND course_id = ?',
      args: [req.lecturer.id, course_id],
    });
    if (check.rows.length === 0) {
      return res.status(403).json({ error: 'You are not assigned to this course' });
    }

    const info = await db.execute({
      sql: `INSERT INTO live_classes (course_id, title, description, meeting_url, scheduled_at, duration_minutes, created_by)
            VALUES (?, ?, ?, ?, ?, ?, ?)`,
      args: [course_id, title, description || '', meeting_url, scheduled_at, Number(duration_minutes) || 60, req.lecturer.id],
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
            to: s.email, studentName: s.name,
            courseCode: course.code, courseTitle: course.title,
            classTitle: title, scheduledAt: new Date(scheduled_at), meetingUrl: meeting_url,
          }).catch(err => console.error('Class email failed:', err.message));
        }
      } catch (e) { console.error('Class notification error:', e.message); }
    }

    res.json({ ok: true, id: Number(info.lastInsertRowid) });
  } catch (err) {
    console.error('Live class create failed:', err);
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/lecturer/live-classes/:id', authLecturer, async (req, res) => {
  try {
    const check = await db.execute({
      sql: `SELECT 1 FROM live_classes lc
            JOIN lecturer_courses lc2 ON lc2.course_id = lc.course_id
            WHERE lc.id = ? AND lc2.lecturer_id = ?`,
      args: [req.params.id, req.lecturer.id],
    });
    if (check.rows.length === 0) return res.status(403).json({ error: 'Not allowed' });
    await db.execute({ sql: 'DELETE FROM live_classes WHERE id = ?', args: [req.params.id] });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
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

// Approve a student
// Approve a student
app.post('/api/admin/students/:id/approve', authAdmin, async (req, res) => {
  try {
    // 1. Update status to active
    await db.execute({ 
      sql: "UPDATE students SET status = 'active' WHERE id = ?", 
      args: [req.params.id] 
    });

    // 2. Fetch student details
    const sRes = await db.execute({
      sql: 'SELECT name, email, reg_no, course FROM students WHERE id = ?',
      args: [req.params.id]
    });
    const student = sRes.rows[0];

    // 3. Send the welcome email with their new Reg No
    if (student) {
      sendMailSafe('sendWelcomeEmail', {
        to: student.email,
        studentName: student.name,
        regNo: student.reg_no,
        course: student.course,
      });
    }

    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Reject a student
app.post('/api/admin/students/:id/reject', authAdmin, async (req, res) => {
  await db.execute({ sql: "UPDATE students SET status = 'rejected' WHERE id = ?", args: [req.params.id] });
  res.json({ ok: true });
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
      sql: `INSERT INTO lecturers (staff_no, name, email, phone, password, qualification, specialization, bio, id_number, location, address, cv_url, cover_letter_url, testimonials_url)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [staff_no, name.trim(), email.trim().toLowerCase(), phone || '', hash, qualification || '', specialization || '', bio || '', id_number || '', location || '', address || '', cv_url, cover_letter_url, testimonials_url],
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
              <a href="${process.env.APP_URL || 'https://heraldtrainer.co.ke'}/lecturer-login.html"
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
  const r = await db.execute('SELECT id, reg_no, name, email, course, active, status, created_at FROM students ORDER BY id DESC');
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
  if (sub.file_path.startsWith('http')) return res.redirect(sub.file_path);
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

  try {
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

    // Fire-and-forget sync to Google Sheets
    pushAttendanceToSheets({ course_id, date, records, markedBy: req.admin.id })
      .catch(err => console.error('Sheets sync error:', err.message));

    res.json({ ok: true, count: records.length });
  } catch (err) {
    console.error('Attendance save failed:', err);
    res.status(500).json({ error: err.message });
  }
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

  res.json({ ok: true, id: Number(info.lastInsertRowid) });
});

app.delete('/api/admin/live-classes/:id', authAdmin, async (req, res) => {
  await db.execute({ sql: 'DELETE FROM live_classes WHERE id = ?', args: [req.params.id] });
  res.json({ ok: true });
});


// ---------- Contact form (Brevo + SMS) ----------
app.post('/api/contact', async (req, res) => {
  const { name, email, phone, subject, message } = req.body || {};

  if (!name || !email || !message) {
    return res.status(400).json({ error: 'Name, email and message are required.' });
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ error: 'Please enter a valid email address.' });
  }
  if (message.length > 5000) {
    return res.status(400).json({ error: 'Message is too long (max 5000 characters).' });
  }

  const esc = s => String(s || '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const BREVO_KEY  = process.env.BREVO_API_KEY;
  const FROM_EMAIL = process.env.MAIL_FROM_EMAIL || 'info@heraldtrainer.co.ke';
  const TO_EMAIL   = process.env.MAIL_TO || 'info@heraldtrainer.co.ke';

  if (!BREVO_KEY) {
    console.error('Contact: BREVO_API_KEY missing');
    return res.status(503).json({ error: 'Email service not configured.' });
  }

  const htmlBody = '<h2>New Website Message</h2>' +
    '<p><strong>Name:</strong> ' + esc(name) + '</p>' +
    '<p><strong>Email:</strong> ' + esc(email) + '</p>' +
    '<p><strong>Phone:</strong> ' + (esc(phone) || '-') + '</p>' +
    '<p><strong>Subject:</strong> ' + (esc(subject) || '-') + '</p>' +
    '<h3>Message</h3><p>' + esc(message).replace(/\n/g, '<br>') + '</p>';

  try {
    const r = await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: {
        'accept': 'application/json',
        'api-key': BREVO_KEY,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        sender:   { name: 'Herald Website', email: FROM_EMAIL },
        to:       [{ email: TO_EMAIL }],
        replyTo:  { email, name },
        subject:  'Website Contact: ' + (subject || 'General inquiry'),
        htmlContent: htmlBody,
      }),
    });

    if (!r.ok) {
      const t = await r.text();
      console.error('Brevo error:', r.status, t);
      return res.status(502).json({ error: 'Could not send your message.' });
    }

    console.log('Contact: message from ' + email + ' sent to ' + TO_EMAIL);

    // Fire-and-forget SMS alert to admin
    sendSMS(
      '+254101700400',
      '📩 New inquiry from ' + name + ': "' + message.slice(0, 60) + (message.length > 60 ? '...' : '') + '"'
    ).catch(err => console.error('Admin SMS alert failed:', err.message));

    res.json({ ok: true });
  } catch (err) {
    console.error('Contact error:', err);
    res.status(500).json({ error: 'Could not send your message.' });
  }
});

// ═══════════════════════════════════════════════════════════
// EXAM SYSTEM
// ═══════════════════════════════════════════════════════════

// ─── ADMIN: Create exam ───
app.post('/api/admin/exams', authAdmin, async (req, res) => {
  const { course_id, title, description, duration_minutes, total_marks } = req.body;
  if (!course_id || !title || !duration_minutes) {
    return res.status(400).json({ error: 'course_id, title, and duration_minutes required' });
  }
  try {
    const info = await db.execute({
      sql: `INSERT INTO exams (course_id, title, description, duration_minutes, total_marks, created_by)
            VALUES (?, ?, ?, ?, ?, ?)`,
      args: [course_id, title, description || '', duration_minutes, total_marks || 100, req.admin.id],
    });
    res.json({ ok: true, id: Number(info.lastInsertRowid) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── ADMIN: List exams ───
app.get('/api/admin/exams', authAdmin, async (req, res) => {
  try {
    const r = await db.execute(`
      SELECT e.*, c.code, c.title AS course_title,
        (SELECT COUNT(*) FROM exam_questions WHERE exam_id = e.id) AS question_count,
        (SELECT COUNT(*) FROM exam_attempts WHERE exam_id = e.id AND status = 'submitted') AS submission_count
        FROM exams e LEFT JOIN courses c ON c.id = e.course_id
        ORDER BY e.id DESC
    `);
    res.json(r.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── ADMIN: Add questions to an exam ───
app.post('/api/admin/exams/:id/questions', authAdmin, async (req, res) => {
  const examId = req.params.id;
  const { questions } = req.body; // Array of { question_text, option_a, option_b, option_c, option_d, correct_option, marks }
  if (!Array.isArray(questions) || !questions.length) {
    return res.status(400).json({ error: 'questions[] required' });
  }
  try {
    for (const q of questions) {
      if (!q.question_text || !q.option_a || !q.option_b || !q.option_c || !q.option_d || !q.correct_option) {
        return res.status(400).json({ error: 'All question fields required (text + 4 options + correct)' });
      }
      await db.execute({
        sql: `INSERT INTO exam_questions (exam_id, question_text, option_a, option_b, option_c, option_d, correct_option, marks)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        args: [examId, q.question_text, q.option_a, q.option_b, q.option_c, q.option_d,
               q.correct_option.toUpperCase(), Number(q.marks) || 1],
      });
    }
    res.json({ ok: true, added: questions.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── ADMIN: Delete exam ───
app.delete('/api/admin/exams/:id', authAdmin, async (req, res) => {
  try {
    await db.execute({ sql: 'DELETE FROM exam_attempts WHERE exam_id = ?', args: [req.params.id] });
    await db.execute({ sql: 'DELETE FROM exam_questions WHERE exam_id = ?', args: [req.params.id] });
    await db.execute({ sql: 'DELETE FROM exams WHERE id = ?', args: [req.params.id] });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── LECTURER: Create exam (only for their assigned courses) ───
app.post('/api/lecturer/exams', authLecturer, async (req, res) => {
  const { course_id, title, description, duration_minutes, total_marks, questions } = req.body;
  if (!course_id || !title || !duration_minutes) {
    return res.status(400).json({ error: 'course_id, title, and duration_minutes required' });
  }
  try {
    // Verify lecturer teaches this course
    const check = await db.execute({
      sql: 'SELECT 1 FROM lecturer_courses WHERE lecturer_id = ? AND course_id = ?',
      args: [req.lecturer.id, course_id],
    });
    if (!check.rows.length) {
      return res.status(403).json({ error: 'You are not assigned to this course' });
    }

    const info = await db.execute({
      sql: `INSERT INTO exams (course_id, title, description, duration_minutes, total_marks, created_by)
            VALUES (?, ?, ?, ?, ?, ?)`,
      args: [course_id, title, description || '', duration_minutes, total_marks || 100, req.lecturer.id],
    });
    const examId = Number(info.lastInsertRowid);

    // Insert questions if provided
    if (Array.isArray(questions) && questions.length) {
      for (const q of questions) {
        if (q.question_text && q.option_a && q.option_b && q.option_c && q.option_d && q.correct_option) {
          await db.execute({
            sql: `INSERT INTO exam_questions (exam_id, question_text, option_a, option_b, option_c, option_d, correct_option, marks)
                  VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            args: [examId, q.question_text, q.option_a, q.option_b, q.option_c, q.option_d,
                   q.correct_option.toUpperCase(), Number(q.marks) || 1],
          });
        }
      }
    }

    res.json({ ok: true, id: examId, question_count: (questions || []).length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── LECTURER: List exams for their courses ───
app.get('/api/lecturer/exams', authLecturer, async (req, res) => {
  try {
    const r = await db.execute({
      sql: `
        SELECT e.*, c.code, c.title AS course_title,
          (SELECT COUNT(*) FROM exam_questions WHERE exam_id = e.id) AS question_count,
          (SELECT COUNT(*) FROM exam_attempts WHERE exam_id = e.id AND status = 'submitted') AS submission_count
        FROM exams e
        JOIN courses c ON c.id = e.course_id
        JOIN lecturer_courses lc ON lc.course_id = c.id
        WHERE lc.lecturer_id = ?
        ORDER BY e.id DESC
      `,
      args: [req.lecturer.id],
    });
    res.json(r.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── LECTURER: View exam submissions ───
app.get('/api/lecturer/exams/:id/submissions', authLecturer, async (req, res) => {
  try {
    const check = await db.execute({
      sql: `SELECT 1 FROM exams e
            JOIN lecturer_courses lc ON lc.course_id = e.course_id
            WHERE e.id = ? AND lc.lecturer_id = ?`,
      args: [req.params.id, req.lecturer.id],
    });
    if (!check.rows.length) return res.status(403).json({ error: 'Not allowed' });

    const r = await db.execute({
      sql: `SELECT a.*, s.reg_no, s.name AS student_name
            FROM exam_attempts a
            JOIN students s ON s.id = a.student_id
            WHERE a.exam_id = ? AND a.status = 'submitted'
            ORDER BY a.submitted_at DESC`,
      args: [req.params.id],
    });
    res.json(r.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── STUDENT: List available exams ───
app.get('/api/student/exams', authStudent, async (req, res) => {
  try {
    const r = await db.execute({
      sql: `SELECT DISTINCT e.*, c.code, c.title AS course_title,
              (SELECT id FROM exam_attempts WHERE exam_id = e.id AND student_id = ? AND status = 'submitted') as submitted_attempt,
              (SELECT status FROM exam_attempts WHERE exam_id = e.id AND student_id = ? AND status = 'in_progress' LIMIT 1) as in_progress
              FROM exams e
              LEFT JOIN courses c ON c.id = e.course_id
              JOIN enrollments en ON en.course_id = e.course_id AND en.student_id = ?
            WHERE e.is_active = 1
            ORDER BY e.id DESC`,
      args: [req.user.id, req.user.id, req.user.id],
    });
    res.json(r.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── STUDENT: Start or resume an exam ───
app.post('/api/student/exams/:id/start', authStudent, async (req, res) => {
  const examId = req.params.id;
  try {
    const exam = await db.execute({ sql: 'SELECT * FROM exams WHERE id = ? AND is_active = 1', args: [examId] });
    if (!exam.rows.length) return res.status(404).json({ error: 'Exam not found or inactive' });
    const e = exam.rows[0];

    // Verify student is enrolled in the course
    const enrolled = await db.execute({
      sql: 'SELECT 1 FROM enrollments WHERE student_id = ? AND course_id = ?',
      args: [req.user.id, e.course_id],
    });
    if (!enrolled.rows.length) return res.status(403).json({ error: 'You are not enrolled in this course' });

    // Check for existing attempt
    const existing = await db.execute({
      sql: "SELECT * FROM exam_attempts WHERE exam_id = ? AND student_id = ?",
      args: [examId, req.user.id],
    });

    let attemptId, startedAt, answers = {};

    if (existing.rows.length) {
      const att = existing.rows[0];
      if (att.status === 'submitted') {
        return res.status(403).json({ error: 'You have already submitted this exam.' });
      }
      attemptId = att.id;
      startedAt = att.started_at;
      try { answers = JSON.parse(att.answers_json || '{}'); } catch (_) {}
    } else {
      startedAt = new Date().toISOString();
      const ins = await db.execute({
        sql: 'INSERT INTO exam_attempts (exam_id, student_id, started_at) VALUES (?, ?, ?)',
        args: [examId, req.user.id, startedAt],
      });
      attemptId = Number(ins.lastInsertRowid);
    }

    // Calculate remaining time based on server clock
    const durationMs = e.duration_minutes * 60000;
    const elapsed = Date.now() - new Date(startedAt).getTime();
    const remainingSeconds = Math.max(0, Math.floor((durationMs - elapsed) / 1000));

    // Auto-submit if time ran out while they were away
    if (remainingSeconds === 0) {
      const qs = await db.execute({ sql: 'SELECT id, correct_option, marks FROM exam_questions WHERE exam_id = ?', args: [examId] });
      let score = 0, total = 0;
      qs.rows.forEach(q => {
        total += q.marks;
        if (answers[q.id] === q.correct_option) score += q.marks;
      });
      await db.execute({
        sql: "UPDATE exam_attempts SET submitted_at = CURRENT_TIMESTAMP, score = ?, total_marks = ?, status = 'submitted' WHERE id = ?",
        args: [score, total, attemptId],
      });
      return res.status(403).json({ error: 'Time expired. Exam auto-submitted.', score, total });
    }

    // Fetch questions without correct answers
    const questions = await db.execute({
      sql: 'SELECT id, question_text, option_a, option_b, option_c, option_d, marks FROM exam_questions WHERE exam_id = ? ORDER BY id',
      args: [examId],
    });

    res.json({
      attempt_id: attemptId,
      remaining_seconds: remainingSeconds,
      exam: { id: e.id, title: e.title, description: e.description, duration_minutes: e.duration_minutes, total_marks: e.total_marks, code: e.code },
      questions: questions.rows,
      saved_answers: answers,
    });
  } catch (err) {
    console.error('Exam start error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ─── STUDENT: Save answers (autosave) ───
app.post('/api/student/exams/:attemptId/save', authStudent, async (req, res) => {
  const { answers } = req.body;
  try {
    const check = await db.execute({
      sql: "SELECT * FROM exam_attempts WHERE id = ? AND student_id = ? AND status = 'in_progress'",
      args: [req.params.attemptId, req.user.id],
    });
    if (!check.rows.length) return res.status(403).json({ error: 'Invalid or already submitted' });

    await db.execute({
      sql: 'UPDATE exam_attempts SET answers_json = ? WHERE id = ?',
      args: [JSON.stringify(answers || {}), req.params.attemptId],
    });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── STUDENT: Submit exam ───
app.post('/api/student/exams/:attemptId/submit', authStudent, async (req, res) => {
  const attemptId = req.params.attemptId;
  const { answers } = req.body;

  try {
    const attempt = await db.execute({
      sql: 'SELECT * FROM exam_attempts WHERE id = ? AND student_id = ?',
      args: [attemptId, req.user.id],
    });
    if (!attempt.rows.length || attempt.rows[0].status === 'submitted') {
      return res.status(400).json({ error: 'Invalid attempt or already submitted.' });
    }

    const att = attempt.rows[0];
    const examId = att.exam_id;

    // Enforce server-side time limit
    const exam = await db.execute({ sql: 'SELECT duration_minutes FROM exams WHERE id = ?', args: [examId] });
    const durationMs = exam.rows[0].duration_minutes * 60000;
    const elapsed = Date.now() - new Date(att.started_at).getTime();
    const isLate = elapsed > durationMs + 60000; // allow 60s grace for network

    // Grade
    const questions = await db.execute({
      sql: 'SELECT id, correct_option, marks FROM exam_questions WHERE exam_id = ?',
      args: [examId],
    });
    let score = 0, total = 0;
    questions.rows.forEach(q => {
      total += q.marks;
      if (answers && answers[q.id] === q.correct_option) score += q.marks;
    });

    await db.execute({
      sql: "UPDATE exam_attempts SET submitted_at = CURRENT_TIMESTAMP, score = ?, total_marks = ?, status = 'submitted', answers_json = ? WHERE id = ?",
      args: [score, total, JSON.stringify(answers || {}), attemptId],
    });

    // Sync to results table so it appears on transcripts
    const examMeta = await db.execute({ sql: 'SELECT course_id, title FROM exams WHERE id = ?', args: [examId] });
    if (examMeta.rows.length) {
      const { course_id, title } = examMeta.rows[0];
      const percentage = total > 0 ? Math.round((score / total) * 100) : 0;
      await db.execute({
        sql: 'INSERT INTO results (student_id, course_id, marks, grade, term) VALUES (?, ?, ?, ?, ?)',
        args: [req.user.id, course_id, percentage, calcGrade(percentage), `Exam: ${title}`],
      });
    }

    res.json({
      ok: true,
      score,
      total,
      percentage: total > 0 ? Math.round((score / total) * 100) : 0,
      late: isLate,
    });
  } catch (err) {
    console.error('Exam submit error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ─── ADMIN: List questions for an exam ───
app.get('/api/admin/exams/:id/questions', authAdmin, async (req, res) => {
  try {
    const r = await db.execute({
      sql: 'SELECT * FROM exam_questions WHERE exam_id = ? ORDER BY id',
      args: [req.params.id],
    });
    res.json(r.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── ADMIN: Delete a single question ───
app.delete('/api/admin/exams/:examId/questions/:questionId', authAdmin, async (req, res) => {
  try {
    await db.execute({
      sql: 'DELETE FROM exam_questions WHERE id = ? AND exam_id = ?',
      args: [req.params.questionId, req.params.examId],
    });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── LECTURER: List questions for own exam ───
app.get('/api/lecturer/exams/:id/questions', authLecturer, async (req, res) => {
  try {
    const check = await db.execute({
      sql: `SELECT 1 FROM exams e JOIN lecturer_courses lc ON lc.course_id = e.course_id
            WHERE e.id = ? AND lc.lecturer_id = ?`,
      args: [req.params.id, req.lecturer.id],
    });
    if (!check.rows.length) return res.status(403).json({ error: 'Not your exam' });

    const r = await db.execute({
      sql: 'SELECT * FROM exam_questions WHERE exam_id = ? ORDER BY id',
      args: [req.params.id],
    });
    res.json(r.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── LECTURER: Add questions to own exam ───
app.post('/api/lecturer/exams/:id/questions', authLecturer, async (req, res) => {
  const examId = req.params.id;
  const { questions } = req.body;
  if (!Array.isArray(questions) || !questions.length) return res.status(400).json({ error: 'questions[] required' });

  try {
    const check = await db.execute({
      sql: `SELECT 1 FROM exams e JOIN lecturer_courses lc ON lc.course_id = e.course_id
            WHERE e.id = ? AND lc.lecturer_id = ?`,
      args: [examId, req.lecturer.id],
    });
    if (!check.rows.length) return res.status(403).json({ error: 'Not your exam' });

    for (const q of questions) {
      if (!q.question_text || !q.option_a || !q.option_b || !q.option_c || !q.option_d || !q.correct_option) {
        return res.status(400).json({ error: 'All question fields required' });
      }
      await db.execute({
        sql: `INSERT INTO exam_questions (exam_id, question_text, option_a, option_b, option_c, option_d, correct_option, marks)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        args: [examId, q.question_text, q.option_a, q.option_b, q.option_c, q.option_d,
               q.correct_option.toUpperCase(), Number(q.marks) || 1],
      });
    }
    res.json({ ok: true, added: questions.length });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ---------- SEO: dynamic sitemap ----------
app.get('/sitemap.xml', async (req, res) => {
  const base = 'https://heraldtrainer.co.ke';
  const today = new Date().toISOString().slice(0, 10);

  const staticPages = [
    { loc: '/',                         changefreq: 'weekly',  priority: '1.0' },
    { loc: '/welcome.html',             changefreq: 'weekly',  priority: '0.9' },
    { loc: '/courses.html',             changefreq: 'weekly',  priority: '0.9' },
    { loc: '/about.html',               changefreq: 'monthly', priority: '0.7' },
    { loc: '/services.html',            changefreq: 'monthly', priority: '0.7' },
    { loc: '/why-us.html',              changefreq: 'monthly', priority: '0.6' },
    { loc: '/contact.html',             changefreq: 'monthly', priority: '0.6' },
    { loc: '/register.html',            changefreq: 'monthly', priority: '0.8' },
    { loc: '/lecturer-register.html',   changefreq: 'monthly', priority: '0.6' },
  ];

  let courseUrls = [];
  try {
    const r = await db.execute('SELECT code, title FROM courses ORDER BY code');
    courseUrls = r.rows.map(c => ({
      loc: `/welcome.html#course-${c.code.toLowerCase()}`,
      changefreq: 'monthly',
      priority: '0.7',
    }));
  } catch (e) { /* ignore if table doesn't exist */ }

  const allUrls = [...staticPages, ...courseUrls];

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${allUrls.map(u => `  <url>
    <loc>${base}${u.loc}</loc>
    <lastmod>${today}</lastmod>
    <changefreq>${u.changefreq}</changefreq>
    <priority>${u.priority}</priority>
  </url>`).join('\n')}
</urlset>`;

  res.type('application/xml').send(xml);
});


// ---------- SEO: robots.txt ----------
app.get('/robots.txt', (req, res) => {
  const txt = `User-agent: *
Allow: /
Allow: /welcome.html
Allow: /courses.html
Allow: /about.html
Allow: /services.html
Allow: /why-us.html
Allow: /contact.html
Allow: /register.html
Allow: /lecturer-register.html

# Keep private areas out of search results
Disallow: /admin-
Disallow: /dashboard.html
Disallow: /lecturer-dashboard
Disallow: /lecturer-login
Disallow: /login.html
Disallow: /api/
Disallow: /uploads/

Sitemap: https://heraldtrainer.co.ke/sitemap.xml
`;
  res.type('text/plain').send(txt);
});

// ---------- Global error handler (must be last) ----------
app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    return res.status(400).json({ error: `Upload error: ${err.message}` });
  }
  if (err) {
    console.error('Unhandled error:', err);
    return res.status(500).json({ error: err.message || 'Server error' });
  }
  next();
});


// ---------- Health check (env debug) ----------
app.get('/api/health', (req, res) => {
  const k = process.env.BREVO_API_KEY || '';
  res.json({
    hasBrevoKey: k.length > 0,
    brevoKeyPrefix: k ? k.slice(0, 12) + '...' : null,
    brevoKeyLength: k.length,
    mailFrom: process.env.MAIL_FROM_EMAIL || null,
    mailTo: process.env.MAIL_TO || null,
  });
});
app.listen(PORT, () => console.log(`Herald Portal running on http://localhost:${PORT}`));

app.get('/api/student/exams', authStudent, async (req, res) => {
  try {
    const r = await db.execute({
      sql: `SELECT e.*, c.code, c.title AS course_title,
              (SELECT id FROM exam_attempts WHERE exam_id = e.id AND student_id = ? AND status = 'submitted') as submitted_attempt
            FROM exams e 
            JOIN courses c ON c.id = e.course_id
            JOIN enrollments en ON en.course_id = e.course_id AND en.student_id = ?
            WHERE e.is_active = 1`,
      args: [req.user.id, req.user.id]
    });
    res.json(r.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/student/exams/:id/start', authStudent, async (req, res) => {
  const examId = req.params.id;
  try {
    const exam = await db.execute({ sql: 'SELECT * FROM exams WHERE id = ?', args: [examId] });
    if (!exam.rows.length) return res.status(404).json({ error: 'Exam not found' });
    
    const existing = await db.execute({
      sql: "SELECT * FROM exam_attempts WHERE exam_id = ? AND student_id = ? AND status = 'in_progress'",
      args: [examId, req.user.id]
    });

    let attemptId, startedAt;
    if (existing.rows.length) {
      attemptId = existing.rows[0].id;
      startedAt = existing.rows[0].started_at;
    } else {
      // Check if they already submitted
      const submitted = await db.execute({
        sql: "SELECT id FROM exam_attempts WHERE exam_id = ? AND student_id = ? AND status = 'submitted'",
        args: [examId, req.user.id]
      });
      if (submitted.rows.length) return res.status(403).json({ error: 'You have already taken this exam.' });

      startedAt = new Date().toISOString();
      const ins = await db.execute({
        sql: 'INSERT INTO exam_attempts (exam_id, student_id, started_at) VALUES (?, ?, ?)',
        args: [examId, req.user.id, startedAt]
      });
      attemptId = ins.lastInsertRowid;
    }

    // Calculate remaining time (in seconds)
    const durationMs = exam.rows[0].duration_minutes * 60000;
    const elapsed = Date.now() - new Date(startedAt).getTime();
    const remainingSeconds = Math.max(0, Math.floor((durationMs - elapsed) / 1000));

    // Fetch questions WITHOUT the correct answers
    const questions = await db.execute({
      sql: 'SELECT id, question_text, option_a, option_b, option_c, option_d, marks FROM exam_questions WHERE exam_id = ?',
      args: [examId]
    });

    res.json({
      attempt_id: attemptId,
      remaining_seconds: remainingSeconds,
      exam: exam.rows[0],
      questions: questions.rows
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/student/exams/:attemptId/submit', authStudent, async (req, res) => {
  const attemptId = req.params.attemptId;
  const { answers } = req.body; // { questionId: 'A' }

  try {
    const attempt = await db.execute({
      sql: 'SELECT * FROM exam_attempts WHERE id = ? AND student_id = ?',
      args: [attemptId, req.user.id]
    });
    if (!attempt.rows.length || attempt.rows[0].status === 'submitted') {
      return res.status(400).json({ error: 'Invalid attempt or already submitted.' });
    }

    const examId = attempt.rows[0].exam_id;
    const questions = await db.execute({ sql: 'SELECT id, correct_option, marks FROM exam_questions WHERE exam_id = ?', args: [examId] });
    
    let score = 0;
    questions.rows.forEach(q => {
      if (answers[q.id] === q.correct_option) score += q.marks;
    });

    await db.execute({
      sql: "UPDATE exam_attempts SET submitted_at = CURRENT_TIMESTAMP, score = ?, status = 'submitted', answers_json = ? WHERE id = ?",
      args: [score, JSON.stringify(answers), attemptId]
    });

    // Automatically sync this score to the main results table so it shows on transcripts
    const examMeta = await db.execute({ sql: 'SELECT course_id, title FROM exams WHERE id = ?', args: [examId] });
    await db.execute({
      sql: 'INSERT INTO results (student_id, course_id, marks, grade, term) VALUES (?, ?, ?, ?, ?)',
      args: [req.user.id, examMeta.rows[0].course_id, score, calcGrade(score), `Exam: ${examMeta.rows[0].title}`]
    });

    res.json({ ok: true, score, total: questions.rows.reduce((a, b) => a + b.marks, 0) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

const { Mpesa, isStkCallbackSuccess, getCallbackValue } = require('pesafy');

// Initialize the client (place this near the top with other imports)
// Safer initialization
let mpesa = null;
try {
  if (process.env.MPESA_CONSUMER_KEY && process.env.MPESA_CONSUMER_SECRET) {
    mpesa = new Mpesa({
      consumerKey: process.env.MPESA_CONSUMER_KEY,
      consumerSecret: process.env.MPESA_CONSUMER_SECRET,
      environment: process.env.MPESA_ENV || 'sandbox',
      lipaNaMpesaShortCode: process.env.MPESA_SHORTCODE,
      lipaNaMpesaPassKey: process.env.MPESA_PASSKEY,
    });
    console.log('📱 M-Pesa configured');
  } else {
    console.warn('⚠️ M-Pesa keys missing. M-Pesa routes disabled.');
  }
} catch (err) {
  console.error('⚠️ M-Pesa initialization failed:', err.message);
}

// 1. Trigger the STK Push (Student clicks "Pay with M-Pesa")
app.post('/api/mpesa/stk-push', authStudent, async (req, res) => {
  if (!mpesa) return res.status(503).json({ error: 'M-Pesa is not configured on this server.' });
  
  try {
    // ... rest of the route
    const { phoneNumber, amount } = req.body;
    
    // pesafy handles the 2547... format automatically
    const push = await mpesa.stkPush({
      amount: Number(amount), // Must be whole numbers, e.g., 100
      phoneNumber: phoneNumber, // e.g., "0712345678"
      callbackUrl: 'https://heraldtrainer.co.ke/api/mpesa/callback', // MUST be your live HTTPS domain
      accountReference: 'HERALD FEE', // Max 12 chars
      transactionDesc: 'Fee Payment', // Max 13 chars
    });

    // Save push.CheckoutRequestID to your DB if you want to track it
    res.json({ 
        ok: true, 
        message: 'Check your phone for the M-Pesa prompt',
        checkoutRequestId: push.CheckoutRequestID 
    });
  } catch (err) {
    console.error('M-Pesa STK Error:', err);
    res.status(500).json({ error: err.message });
  }
});

// 2. The Callback (Safaricom sends the result here)
// IMPORTANT: This route must NOT have authStudent middleware, because Safaricom is the one calling it.
// 2. The Callback (Safaricom sends the result here)
app.post('/api/mpesa/callback', async (req, res) => {
  try {
    const callback = req.body;
    
    if (isStkCallbackSuccess(callback.Body.stkCallback)) {
      const receipt = getCallbackValue(callback, 'MpesaReceiptNumber');
      const amount = getCallbackValue(callback, 'Amount');
      const phone = getCallbackValue(callback, 'PhoneNumber');
      
      console.log(`✅ M-Pesa Success: ${receipt} for KES ${amount} from ${phone}`);
      
      // --- SAVE TO DATABASE ---
      // Format the phone number to match your DB format (e.g., +254703379980)
      const formattedPhone = `+${phone}`;
      
      // Find the student by phone (assuming your students table has a phone column, 
      // or you can look up the pending payment by CheckoutRequestID)
      const studentRes = await db.execute({
        sql: 'SELECT id FROM students WHERE phone = ?',
        args: [formattedPhone]
      });

      if (studentRes.rows.length) {
        const studentId = studentRes.rows[0].id;
        
        // Add the payment to the fees table
        await db.execute({
          sql: `INSERT INTO fees (student_id, term, amount_due, amount_paid, status, paid_at) 
                VALUES (?, 'M-Pesa Payment', ?, ?, 'paid', CURRENT_TIMESTAMP)`,
          args: [studentId, amount, amount]
        });
        
        console.log(`💰 Updated fees for student ID ${studentId}`);
      } else {
        console.log(`⚠️ Student not found for phone ${formattedPhone}`);
      }

    } else {
      console.log('❌ M-Pesa Failed:', callback.Body.stkCallback.ResultDesc);
    }

    // ALWAYS respond to Safaricom with this exact JSON
    res.json({ ResultCode: 0, ResultDesc: 'Accepted' });
  } catch (err) {
    console.error('Callback Error:', err);
    res.status(500).send('Error');
  }
});