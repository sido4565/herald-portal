const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');
const path = require('path');

const db = new Database(path.join(__dirname, 'herald.db'));
db.pragma('journal_mode = WAL');

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
  submitted_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  grade TEXT,
  feedback TEXT,
  FOREIGN KEY(assignment_id) REFERENCES assignments(id),
  FOREIGN KEY(student_id) REFERENCES students(id)
);
`);

function seed() {
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
    db.prepare('INSERT INTO announcements (title, body) VALUES (?, ?)').run('Welcome to Herald Portal', 'New term begins Monday. Check your timetable.');
    db.prepare('INSERT INTO announcements (title, body) VALUES (?, ?)').run('Fee Reminder', 'Term 1 fee balance due by end of month.');
    db.prepare('INSERT INTO fees (student_id, term, amount_due, amount_paid, status) VALUES (?, ?, ?, ?, ?)').run(sid, 'Term 1 2025', 25000, 15000, 'partial');
  }

  const adminCount = db.prepare('SELECT COUNT(*) AS c FROM admins').get().c;
  if (adminCount === 0) {
    const adminHash = bcrypt.hashSync('admin123', 10);
    db.prepare('INSERT INTO admins (username, name, password, role) VALUES (?, ?, ?, ?)')
      .run('admin', 'Herald Admin', adminHash, 'superadmin');
  }

  const ttCount = db.prepare('SELECT COUNT(*) AS c FROM timetable').get().c;
  if (ttCount === 0) {
    const insert = db.prepare('INSERT INTO timetable (course_id, day, start_time, end_time, room, trainer) VALUES (?, ?, ?, ?, ?, ?)');
    insert.run(1, 'Monday', '08:00', '10:00', 'Lab A', 'Mr. Herald K.');
    insert.run(3, 'Monday', '10:15', '12:15', 'Lab B', 'Mr. Herald K.');
    insert.run(2, 'Tuesday', '14:00', '16:00', 'Room 5', 'Ms. Amina T.');
    insert.run(1, 'Wednesday', '08:00', '10:00', 'Lab A', 'Mr. Herald K.');
    insert.run(4, 'Thursday', '09:00', '11:00', 'Lab C', 'Dr. Otieno M.');
  }

  const asgCount = db.prepare('SELECT COUNT(*) AS c FROM assignments').get().c;
  if (asgCount === 0) {
    db.prepare('INSERT INTO assignments (course_id, title, description, due_date) VALUES (?, ?, ?, ?)')
      .run(1, 'Build a Portfolio Page', 'Create a responsive HTML/CSS portfolio.', '2025-10-15');
    db.prepare('INSERT INTO assignments (course_id, title, description, due_date) VALUES (?, ?, ?, ?)')
      .run(3, 'Async/Await Exercise', 'Convert 5 callbacks to async/await.', '2025-10-20');
  }
}
seed();

module.exports = db;