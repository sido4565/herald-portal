const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');
const path = require('path');

const db = new Database(path.join(__dirname, 'herald.db'));
db.pragma('journal_mode = WAL');

// ---------- Schema ----------
db.exec(`
CREATE TABLE IF NOT EXISTS students (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  reg_no TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  email TEXT UNIQUE NOT NULL,
  password TEXT NOT NULL,
  course TEXT NOT NULL,
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
`);

// ---------- Seed ----------
function seed() {
  const courseCount = db.prepare('SELECT COUNT(*) AS c FROM courses').get().c;
  if (courseCount === 0) {
    const insertCourse = db.prepare(
      'INSERT INTO courses (code, title, trainer, description) VALUES (?, ?, ?, ?)'
    );
    const courses = [
      ['WD101', 'Web Development Fundamentals', 'Mr. Herald K.', 'HTML, CSS, JavaScript basics'],
      ['DB201', 'Database Design', 'Ms. Amina T.', 'SQL, normalization, ER diagrams'],
      ['JS301', 'Advanced JavaScript', 'Mr. Herald K.', 'ES6+, async, modules'],
      ['PY101', 'Python Programming', 'Dr. Otieno M.', 'Python basics & OOP'],
      ['NET210', 'Networking Essentials', 'Mr. Brian W.', 'TCP/IP, routing, security']
    ];
    courses.forEach(c => insertCourse.run(...c));

    // Demo student: reg=STU001, password=password123
    const hash = bcrypt.hashSync('password123', 10);
    db.prepare(
      'INSERT INTO students (reg_no, name, email, password, course) VALUES (?, ?, ?, ?, ?)'
    ).run('STU001', 'Jane Doe', 'jane@herald.test', hash, 'Web Development Fundamentals');

    const studentId = db.prepare('SELECT id FROM students WHERE reg_no = ?').get('STU001').id;
    db.prepare('INSERT INTO enrollments (student_id, course_id) VALUES (?, ?)').run(studentId, 1);
    db.prepare('INSERT INTO enrollments (student_id, course_id) VALUES (?, ?)').run(studentId, 3);
    db.prepare('INSERT INTO results (student_id, course_id, marks, grade, term) VALUES (?, ?, ?, ?, ?)')
      .run(studentId, 1, 82, 'A-', 'Term 1 2025');
    db.prepare('INSERT INTO results (student_id, course_id, marks, grade, term) VALUES (?, ?, ?, ?, ?)')
      .run(studentId, 3, 76, 'B+', 'Term 1 2025');

    db.prepare('INSERT INTO announcements (title, body) VALUES (?, ?)')
      .run('Welcome to Herald Portal', 'New term begins Monday. Check your timetable.');
    db.prepare('INSERT INTO announcements (title, body) VALUES (?, ?)')
      .run('Fee Reminder', 'Term 1 fee balance due by end of month.');
  }
}
seed();

module.exports = db;