const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');
const path = require('path');
const fs = require('fs');
const { uploadBackup, downloadBackup, ENABLED } = require('./backup');

const DATA_DIR = process.env.DATA_DIR || __dirname;
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const DB_PATH = path.join(DATA_DIR, 'herald.db');

// ---------- Startup: restore DB synchronously before opening ----------
(async () => {
  if (!ENABLED) {
    console.log('ℹ️  Cloud backup disabled (no Google Drive credentials)');
    bootDatabase();
    return;
  }

  if (!fs.existsSync(DB_PATH)) {
    console.log('🔄 Local DB missing — downloading from Google Drive...');
    try {
      const result = await downloadBackup(DB_PATH);
      if (result.ok) console.log(`✅ Database restored from Google Drive (${result.size} bytes)`);
      else if (result.notFound) console.log('ℹ️  No cloud backup yet — starting fresh');
    } catch (err) {
      console.error('⚠️  Restore failed:', err.message);
    }
  }

  bootDatabase();
})();

// ---------- Everything else runs after restore ----------
function bootDatabase() {
  const db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');

  console.log(`📁 Database: ${DB_PATH}`);

  // ---------- Schema (creates all tables) ----------
  db.exec(`
CREATE TABLE IF NOT EXISTS students (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  reg_no TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  email TEXT UNIQUE NOT NULL,
  password TEXT NOT NULL,
  course TEXT NOT NULL,
  active INTEGER DEFAULT 1,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS admins (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  password TEXT NOT NULL,
  role TEXT DEFAULT 'trainer',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS courses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT UNIQUE NOT NULL,
  title TEXT NOT NULL,
  trainer TEXT NOT NULL,
  description TEXT
);

CREATE TABLE IF NOT EXISTS enrollments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  student_id INTEGER NOT NULL,
  course_id INTEGER NOT NULL,
  enrolled_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(student_id) REFERENCES students(id),
  FOREIGN KEY(course_id) REFERENCES courses(id)
);

CREATE TABLE IF NOT EXISTS results (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  student_id INTEGER NOT NULL,
  course_id INTEGER NOT NULL,
  marks INTEGER NOT NULL,
  grade TEXT NOT NULL,
  term TEXT NOT NULL,
  FOREIGN KEY(student_id) REFERENCES students(id),
  FOREIGN KEY(course_id) REFERENCES courses(id)
);

CREATE TABLE IF NOT EXISTS announcements (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS fees (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  student_id INTEGER NOT NULL,
  term TEXT NOT NULL,
  amount_due REAL NOT NULL,
  amount_paid REAL DEFAULT 0,
  paid_at DATETIME,
  status TEXT DEFAULT 'unpaid',
  FOREIGN KEY(student_id) REFERENCES students(id)
);

CREATE TABLE IF NOT EXISTS timetable (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  course_id INTEGER NOT NULL,
  day TEXT NOT NULL,
  start_time TEXT NOT NULL,
  end_time TEXT NOT NULL,
  room TEXT,
  trainer TEXT,
  FOREIGN KEY(course_id) REFERENCES courses(id)
);

CREATE TABLE IF NOT EXISTS assignments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  course_id INTEGER NOT NULL,
  title TEXT NOT NULL,
  description TEXT,
  due_date TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(course_id) REFERENCES courses(id)
);

CREATE TABLE IF NOT EXISTS submissions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  assignment_id INTEGER NOT NULL,
  student_id INTEGER NOT NULL,
  content TEXT,
  file_path TEXT,
  file_name TEXT,
  submitted_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  grade TEXT,
  feedback TEXT,
  FOREIGN KEY(assignment_id) REFERENCES assignments(id),
  FOREIGN KEY(student_id) REFERENCES students(id)
);

CREATE TABLE IF NOT EXISTS attendance (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  course_id INTEGER NOT NULL,
  student_id INTEGER NOT NULL,
  date TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'present',
  marked_by INTEGER,
  notes TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(course_id) REFERENCES courses(id),
  FOREIGN KEY(student_id) REFERENCES students(id)
);

CREATE TABLE IF NOT EXISTS live_classes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  course_id INTEGER NOT NULL,
  title TEXT NOT NULL,
  description TEXT,
  meeting_url TEXT NOT NULL,
  scheduled_at DATETIME NOT NULL,
  duration_minutes INTEGER DEFAULT 60,
  created_by INTEGER,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(course_id) REFERENCES courses(id)
);
`);

  // ---------- Safe migrations for older DBs ----------
  try {
    db.prepare('SELECT file_path FROM submissions LIMIT 1').get();
  } catch (e) {
    console.log('🔄 Migrating: adding file_path, file_name to submissions');
    db.exec('ALTER TABLE submissions ADD COLUMN file_path TEXT');
    db.exec('ALTER TABLE submissions ADD COLUMN file_name TEXT');
  }

  // ---------- Seed if empty ----------
  seed(db);

  // ---------- Auto-backup every 2 minutes ----------
  if (ENABLED) {
    setInterval(async () => {
      try {
        const snapshotPath = path.join('/tmp', `herald-auto-${Date.now()}.db`);
        const { createSnapshot } = require('./backup');
        await createSnapshot(db, snapshotPath);
        const stats = fs.statSync(snapshotPath);
        console.log(`📊 [auto] Snapshot size: ${stats.size} bytes`);
        await uploadBackup(snapshotPath);
        fs.unlinkSync(snapshotPath);
        console.log(`☁️  Auto-backup uploaded @ ${new Date().toISOString()}`);
      } catch (err) {
        console.error('⚠️  Auto-backup failed:', err.message);
      }
    }, 2 * 60 * 1000);
  }

  // ---------- Export for use elsewhere ----------
  module.exports = db;
}

// ---------- Seed function ----------
function seed(db) {
  const courseCount = db.prepare('SELECT COUNT(*) AS c FROM courses').get().c;
  if (courseCount === 0) {
    const insertCourse = db.prepare(
      'INSERT INTO courses (code, title, trainer, description) VALUES (?, ?, ?, ?)'
    );
    [
      ['WD101', 'Web Development Fundamentals', 'Mr. Herald K.', 'HTML, CSS, JavaScript basics'],
      ['DB201', 'Database Design', 'Ms. Amina T.', 'SQL, normalization, ER diagrams'],
      ['JS301', 'Advanced JavaScript', 'Mr. Herald K.', 'ES6+, async, modules'],
      ['PY101', 'Python Programming', 'Dr. Otieno M.', 'Python basics & OOP'],
      ['NET210', 'Networking Essentials', 'Mr. Brian W.', 'TCP/IP, routing, security']
    ].forEach(c => insertCourse.run(...c));

    const hash = bcrypt.hashSync('password123', 10);
    db.prepare(
      'INSERT INTO students (reg_no, name, email, password, course) VALUES (?, ?, ?, ?, ?)'
    ).run('STU001', 'Jane Doe', 'jane@herald.test', hash, 'Web Development Fundamentals');

    const sid = db.prepare('SELECT id FROM students WHERE reg_no = ?').get('STU001').id;
    db.prepare('INSERT INTO enrollments (student_id, course_id) VALUES (?, ?)').run(sid, 1);
    db.prepare('INSERT INTO enrollments (student_id, course_id) VALUES (?, ?)').run(sid, 3);
    db.prepare('INSERT INTO results (student_id, course_id, marks, grade, term) VALUES (?, ?, ?, ?, ?)').run(sid, 1, 82, 'A-', 'Term 1 2025');
    db.prepare('INSERT INTO results (student_id, course_id, marks, grade, term) VALUES (?, ?, ?, ?, ?)').run(sid, 3, 76, 'B+', 'Term 1 2025');
    db.prepare('INSERT INTO announcements (title, body) VALUES (?, ?)').run('Welcome to Herald Portal', 'New term begins Monday.');
    db.prepare('INSERT INTO fees (student_id, term, amount_due, amount_paid, status) VALUES (?, ?, ?, ?, ?)').run(sid, 'Term 1 2025', 25000, 15000, 'partial');
  }

  const adminCount = db.prepare('SELECT COUNT(*) AS c FROM admins').get().c;
  if (adminCount === 0) {
    const adminHash = bcrypt.hashSync('admin123', 10);
    db.prepare('INSERT INTO admins (username, name, password, role) VALUES (?, ?, ?, ?)')
      .run('admin', 'Herald Admin', adminHash, 'superadmin');
  }
}