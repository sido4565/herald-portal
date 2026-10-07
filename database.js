const { createClient } = require('@libsql/client');
const bcrypt = require('bcryptjs');

const TURSO_URL = process.env.TURSO_DATABASE_URL;
const TURSO_TOKEN = process.env.TURSO_AUTH_TOKEN;

if (!TURSO_URL || !TURSO_TOKEN) {
  console.error('❌ TURSO_DATABASE_URL and TURSO_AUTH_TOKEN are required');
  process.exit(1);
}

const client = createClient({
  url: TURSO_URL,
  authToken: TURSO_TOKEN,
});

console.log(`📁 Database: Turso (${TURSO_URL.split('//')[1]?.split('.')[0] || 'connected'})`);

async function initSchema() {
  const statements = [
    `CREATE TABLE IF NOT EXISTS students (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      reg_no TEXT UNIQUE NOT NULL,
      name TEXT NOT NULL,
      email TEXT UNIQUE NOT NULL,
      password TEXT NOT NULL,
      course TEXT NOT NULL,
      active INTEGER DEFAULT 1,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE TABLE IF NOT EXISTS admins (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      name TEXT NOT NULL,
      password TEXT NOT NULL,
      role TEXT DEFAULT 'trainer',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE TABLE IF NOT EXISTS lecturers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      staff_no TEXT UNIQUE NOT NULL,
      name TEXT NOT NULL,
      email TEXT UNIQUE NOT NULL,
      phone TEXT,
      password TEXT NOT NULL,
      qualification TEXT,
      specialization TEXT,
      bio TEXT,
      photo_url TEXT,
      status TEXT DEFAULT 'pending',
      approved INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      approved_at DATETIME
    )`,
    `CREATE TABLE IF NOT EXISTS courses (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      code TEXT UNIQUE NOT NULL,
      title TEXT NOT NULL,
      trainer TEXT NOT NULL,
      description TEXT
    )`,
    `CREATE TABLE IF NOT EXISTS enrollments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      student_id INTEGER NOT NULL,
      course_id INTEGER NOT NULL,
      enrolled_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE TABLE IF NOT EXISTS results (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      student_id INTEGER NOT NULL,
      course_id INTEGER NOT NULL,
      marks INTEGER NOT NULL,
      grade TEXT NOT NULL,
      term TEXT NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS announcements (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      body TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE TABLE IF NOT EXISTS fees (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      student_id INTEGER NOT NULL,
      term TEXT NOT NULL,
      amount_due REAL NOT NULL,
      amount_paid REAL DEFAULT 0,
      paid_at DATETIME,
      status TEXT DEFAULT 'unpaid'
    )`,
    `CREATE TABLE IF NOT EXISTS timetable (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      course_id INTEGER NOT NULL,
      day TEXT NOT NULL,
      start_time TEXT NOT NULL,
      end_time TEXT NOT NULL,
      room TEXT,
      trainer TEXT
    )`,
    `CREATE TABLE IF NOT EXISTS assignments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      course_id INTEGER NOT NULL,
      title TEXT NOT NULL,
      description TEXT,
      due_date TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE TABLE IF NOT EXISTS submissions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      assignment_id INTEGER NOT NULL,
      student_id INTEGER NOT NULL,
      content TEXT,
      file_path TEXT,
      file_name TEXT,
      submitted_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      grade TEXT,
      feedback TEXT
    )`,
    `CREATE TABLE IF NOT EXISTS attendance (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      course_id INTEGER NOT NULL,
      student_id INTEGER NOT NULL,
      date TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'present',
      marked_by INTEGER,
      notes TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE TABLE IF NOT EXISTS live_classes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      course_id INTEGER NOT NULL,
      title TEXT NOT NULL,
      description TEXT,
      meeting_url TEXT NOT NULL,
      scheduled_at DATETIME NOT NULL,
      duration_minutes INTEGER DEFAULT 60,
      created_by INTEGER,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE TABLE IF NOT EXISTS materials (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      course_id INTEGER NOT NULL,
      title TEXT NOT NULL,
      description TEXT,
      material_type TEXT DEFAULT 'file',
      file_path TEXT,
      file_name TEXT,
      external_url TEXT,
      release_date TEXT NOT NULL,
      created_by INTEGER,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE TABLE IF NOT EXISTS material_views (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      material_id INTEGER NOT NULL,
      student_id INTEGER NOT NULL,
      viewed_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`,
        `CREATE TABLE IF NOT EXISTS lecturer_courses (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      lecturer_id INTEGER NOT NULL,
      course_id INTEGER NOT NULL,
      assigned_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(lecturer_id, course_id)
    )`,
        `CREATE TABLE IF NOT EXISTS lecturer_courses (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      lecturer_id INTEGER NOT NULL,
      course_id INTEGER NOT NULL,
      assigned_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(lecturer_id, course_id)
    )`,
  ];

  for (const sql of statements) {
    await client.execute(sql);
  }
  console.log('✅ Schema ready');
}

async function seed() {
  const courseCount = await client.execute('SELECT COUNT(*) AS c FROM courses');
  if (courseCount.rows[0].c === 0) {
        const courses = [
      // Short courses
      ['SC001', 'Digital Marketing & Social Media Marketing', 'Unassigned', '2-4 weeks', 'Short'],
      ['SC002', 'AI for Business & Productivity', 'Unassigned', '1-2 weeks', 'Short'],
      ['SC003', 'E-Commerce & Online Business', 'Unassigned', '2-4 weeks', 'Short'],
      ['SC004', 'Business Management & Entrepreneurship', 'Unassigned', '4 weeks', 'Short'],
      ['SC005', 'Advanced Excel for Business', 'Unassigned', '2-4 weeks', 'Short'],
      ['SC006', 'Data Analytics for Business', 'Unassigned', '4-8 weeks', 'Short'],
      ['SC007', 'Graphic Design for Business', 'Unassigned', '4 weeks', 'Short'],
      ['SC008', 'Canva Design & Content Creation', 'Unassigned', '1-2 weeks', 'Short'],
      ['SC009', 'Website Design for Small Businesses', 'Unassigned', '4-8 weeks', 'Short'],
      ['SC010', 'Content Creation & Video Editing', 'Unassigned', '2-4 weeks', 'Short'],
      ['SC011', 'Bookkeeping & QuickBooks', 'Unassigned', '4 weeks', 'Short'],
      ['SC012', 'Accounting for Small Businesses', 'Unassigned', '4 weeks', 'Short'],
      ['SC013', 'Sales & Customer Relationship Management', 'Unassigned', '2-4 weeks', 'Short'],
      ['SC014', 'Professional Selling & Sales Management', 'Unassigned', '2-4 weeks', 'Short'],
      ['SC015', 'Procurement & Supply Chain Basics', 'Unassigned', '4 weeks', 'Short'],
      ['SC016', 'Project Management', 'Unassigned', '4-8 weeks', 'Short'],
      ['SC017', 'Business Proposal Writing', 'Unassigned', '1-2 weeks', 'Short'],
      ['SC018', 'Business Plan Development', 'Unassigned', '1-2 weeks', 'Short'],
      ['SC019', 'Grant & Tender Proposal Writing', 'Unassigned', '2-4 weeks', 'Short'],
      ['SC020', 'Personal Branding & LinkedIn Marketing', 'Unassigned', '1-2 weeks', 'Short'],
      ['SC021', 'Cybersecurity Awareness for Businesses', 'Unassigned', '1-2 weeks', 'Short'],
      ['SC022', 'Freelancing & Online Work Skills', 'Unassigned', '2-6 weeks', 'Short'],
      ['SC023', 'Digital Office & Computer Applications', 'Unassigned', '2-6 weeks', 'Short'],
      ['SC024', 'Leadership & Team Management', 'Unassigned', '2-6 weeks', 'Short'],
      ['SC025', 'Business Communication & Professional Writing', 'Unassigned', '2-6 weeks', 'Short'],
      // Certificate courses
      ['BIZ101', 'Business Management Fundamentals', 'Mr. Herald K.', '8 weeks', 'Certificate'],
      ['MKT201', 'Digital Marketing & Sales (Certificate)', 'Ms. Amina T.', '6 weeks', 'Certificate'],
      ['FIN301', 'Finance for Decision Makers', 'Mr. Brian W.', '8 weeks', 'Certificate'],
      ['ENT401', 'Entrepreneurship & Startup Building', 'Mr. Herald K.', '10 weeks', 'Certificate'],
      ['LDR501', 'Leadership & Strategy (Certificate)', 'Dr. Otieno M.', '6 weeks', 'Certificate'],
      // Technical
      ['ELE101', 'Electrical Engineering Basics', 'Mr. Brian W.', '12 weeks', 'Technical'],
      ['WEB101', 'Web Development Fundamentals', 'Mr. Herald K.', '10 weeks', 'Technical'],
      ['DB201', 'Database Design & SQL', 'Ms. Amina T.', '8 weeks', 'Technical'],
      ['JS301', 'Advanced JavaScript', 'Mr. Herald K.', '8 weeks', 'Technical'],
      ['PY101', 'Python Programming', 'Dr. Otieno M.', '10 weeks', 'Technical'],
      ['NET210', 'Networking Essentials', 'Mr. Brian W.', '8 weeks', 'Technical'],
    ];
    for (const c of courses) {
      await client.execute({
        sql: 'INSERT OR IGNORE INTO courses (code, title, trainer, description) VALUES (?, ?, ?, ?)',
        args: [c[0], c[1], c[2], c[4]],  // code, title, trainer, category as description
      });
    }

    const hash = bcrypt.hashSync('password123', 10);
    await client.execute({
      sql: 'INSERT INTO students (reg_no, name, email, password, course) VALUES (?, ?, ?, ?, ?)',
      args: ['STU001', 'Jane Doe', 'jane@herald.test', hash, 'Web Development Fundamentals'],
    });

    const sidRes = await client.execute({ sql: 'SELECT id FROM students WHERE reg_no = ?', args: ['STU001'] });
    const sid = sidRes.rows[0].id;

    await client.execute({ sql: 'INSERT INTO enrollments (student_id, course_id) VALUES (?, ?)', args: [sid, 1] });
    await client.execute({ sql: 'INSERT INTO enrollments (student_id, course_id) VALUES (?, ?)', args: [sid, 3] });
    await client.execute({ sql: 'INSERT INTO results (student_id, course_id, marks, grade, term) VALUES (?, ?, ?, ?, ?)', args: [sid, 1, 82, 'A-', 'Term 1 2025'] });
    await client.execute({ sql: 'INSERT INTO results (student_id, course_id, marks, grade, term) VALUES (?, ?, ?, ?, ?)', args: [sid, 3, 76, 'B+', 'Term 1 2025'] });
    await client.execute({ sql: 'INSERT INTO announcements (title, body) VALUES (?, ?)', args: ['Welcome to Herald Portal', 'New term begins Monday.'] });
    await client.execute({ sql: 'INSERT INTO fees (student_id, term, amount_due, amount_paid, status) VALUES (?, ?, ?, ?, ?)', args: [sid, 'Term 1 2025', 25000, 15000, 'partial'] });
  }

  const adminCount = await client.execute('SELECT COUNT(*) AS c FROM admins');
  if (adminCount.rows[0].c === 0) {
    const adminHash = bcrypt.hashSync('admin123', 10);
    await client.execute({
      sql: 'INSERT INTO admins (username, name, password, role) VALUES (?, ?, ?, ?)',
      args: ['admin', 'Herald Admin', adminHash, 'superadmin'],
    });
  }
}

// Boot
(async () => {
  try {
    await initSchema();
    await seed();
    console.log('✅ Database boot complete');
  } catch (err) {
    console.error('❌ Database boot failed:', err.message);
    process.exit(1);
  }
})();

module.exports = client;
