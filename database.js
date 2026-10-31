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
    // ─── Core ───
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
    `CREATE TABLE IF NOT EXISTS password_reset_requests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      account_type TEXT NOT NULL CHECK(account_type IN ('student', 'lecturer')),
      account_id INTEGER NOT NULL,
      email TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'approved', 'rejected')),
      requested_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      resolved_at DATETIME,
      resolved_by INTEGER
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
      approved_at DATETIME,
      cv_url TEXT,
      cover_letter_url TEXT,
      testimonials_url TEXT
    )`,
    `CREATE TABLE IF NOT EXISTS courses (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      code TEXT UNIQUE NOT NULL,
      title TEXT NOT NULL,
      trainer TEXT NOT NULL,
      description TEXT,
      fee REAL,
      duration_weeks INTEGER NOT NULL DEFAULT 8
    )`,
    `CREATE TABLE IF NOT EXISTS enrollments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      student_id INTEGER NOT NULL,
      course_id INTEGER NOT NULL,
      learning_mode TEXT NOT NULL DEFAULT 'classroom',
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
    `CREATE TABLE IF NOT EXISTS jobs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      category TEXT NOT NULL DEFAULT 'Other',
      location TEXT,
      employment_type TEXT,
      description TEXT NOT NULL,
      requirements TEXT,
      application_email TEXT NOT NULL DEFAULT 'info@heraldtrainer.co.ke',
      closing_date TEXT,
      is_published INTEGER NOT NULL DEFAULT 1,
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
    `CREATE TABLE IF NOT EXISTS lecturer_attendance (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      lecturer_id INTEGER NOT NULL,
      date TEXT NOT NULL,
      status TEXT NOT NULL,
      notes TEXT,
      marked_by INTEGER,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(lecturer_id, date)
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
      resource_category TEXT DEFAULT 'other',
      is_paid INTEGER DEFAULT 0,
      price REAL DEFAULT 0,
      storage_key TEXT,
      storage_type TEXT,
      mime_type TEXT,
      created_by INTEGER,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE TABLE IF NOT EXISTS material_views (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      material_id INTEGER NOT NULL,
      student_id INTEGER NOT NULL,
      viewed_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE TABLE IF NOT EXISTS material_purchases (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      student_id INTEGER NOT NULL,
      material_id INTEGER NOT NULL,
      amount_due REAL NOT NULL,
      amount_received REAL,
      status TEXT NOT NULL DEFAULT 'pending',
      checkout_request_id TEXT UNIQUE,
      guest_phone TEXT,
      access_token_hash TEXT,
      payment_method TEXT DEFAULT 'mpesa',
      payment_reference TEXT,
      payer_name TEXT,
      mpesa_receipt TEXT,
      result_description TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      paid_at DATETIME
    )`,
    // ─── Lecturer-Course assignments (defined ONCE) ───
    `CREATE TABLE IF NOT EXISTS lecturer_courses (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      lecturer_id INTEGER NOT NULL,
      course_id INTEGER NOT NULL,
      assigned_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(lecturer_id, course_id)
    )`,

    // ─── EXAM SYSTEM ───
    `CREATE TABLE IF NOT EXISTS exams (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      course_id INTEGER NOT NULL,
      title TEXT NOT NULL,
      description TEXT,
      duration_minutes INTEGER NOT NULL DEFAULT 60,
      total_marks INTEGER NOT NULL DEFAULT 100,
      is_active INTEGER DEFAULT 1,
      created_by INTEGER,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE TABLE IF NOT EXISTS exam_questions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      exam_id INTEGER NOT NULL,
      question_text TEXT NOT NULL,
      option_a TEXT NOT NULL,
      option_b TEXT NOT NULL,
      option_c TEXT NOT NULL,
      option_d TEXT NOT NULL,
      correct_option TEXT NOT NULL,
      marks INTEGER DEFAULT 1
    )`,
    `CREATE TABLE IF NOT EXISTS exam_attempts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      exam_id INTEGER NOT NULL,
      student_id INTEGER NOT NULL,
      started_at DATETIME NOT NULL,
      submitted_at DATETIME,
      score INTEGER,
      total_marks INTEGER,
      status TEXT DEFAULT 'in_progress',
      answers_json TEXT
    )`,
    `CREATE TABLE IF NOT EXISTS learning_paths (
      course_id INTEGER PRIMARY KEY,
      status TEXT NOT NULL DEFAULT 'pending',
      error TEXT,
      generated_at DATETIME,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE TABLE IF NOT EXISTS learning_chapters (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      course_id INTEGER NOT NULL,
      position INTEGER NOT NULL,
      title TEXT NOT NULL,
      overview TEXT,
      study_notes TEXT,
      material_ids TEXT NOT NULL,
      estimated_hours REAL NOT NULL DEFAULT 2,
      UNIQUE(course_id, position)
    )`,
    `CREATE TABLE IF NOT EXISTS learning_quiz_questions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chapter_id INTEGER NOT NULL,
      question_text TEXT NOT NULL,
      option_a TEXT NOT NULL,
      option_b TEXT NOT NULL,
      option_c TEXT NOT NULL,
      option_d TEXT NOT NULL,
      correct_option TEXT NOT NULL,
      explanation TEXT,
      marks INTEGER NOT NULL DEFAULT 1
    )`,
    `CREATE TABLE IF NOT EXISTS student_chapter_progress (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      student_id INTEGER NOT NULL,
      chapter_id INTEGER NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      best_score INTEGER NOT NULL DEFAULT 0,
      total_marks INTEGER NOT NULL DEFAULT 0,
      passed INTEGER NOT NULL DEFAULT 0,
      materials_completed INTEGER NOT NULL DEFAULT 0,
      completed_at DATETIME,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(student_id, chapter_id)
    )`,
    `CREATE TABLE IF NOT EXISTS learning_quiz_attempts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      student_id INTEGER NOT NULL,
      chapter_id INTEGER NOT NULL,
      score INTEGER NOT NULL,
      total_marks INTEGER NOT NULL,
      passed INTEGER NOT NULL,
      answers_json TEXT NOT NULL,
      submitted_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`,
  ];

  for (const sql of statements) {
    await client.execute(sql);
  }
  const courseColumns = await client.execute('PRAGMA table_info(courses)');
  if (!courseColumns.rows.some(column => column.name === 'fee')) {
    await client.execute('ALTER TABLE courses ADD COLUMN fee REAL');
  }
  const hadCourseDuration = courseColumns.rows.some(column => column.name === 'duration_weeks');
  if (!hadCourseDuration) {
    await client.execute('ALTER TABLE courses ADD COLUMN duration_weeks INTEGER NOT NULL DEFAULT 8');
    const knownDurations = {
      SC001: 3, SC002: 2, SC003: 3, SC004: 4, SC005: 3, SC006: 6, SC007: 4, SC008: 2,
      SC009: 6, SC010: 3, SC011: 4, SC012: 4, SC013: 3, SC014: 3, SC015: 4, SC016: 6,
      SC017: 2, SC018: 2, SC019: 3, SC020: 2, SC021: 2, SC022: 4, SC023: 4, SC024: 4,
      SC025: 4, SC026: 4, BIZ101: 8, MKT201: 6, FIN301: 8, ENT401: 10, LDR501: 6,
      ELE101: 12, WEB101: 10, DB201: 8, JS301: 8, PY101: 10, NET210: 8,
    };
    for (const [code, weeks] of Object.entries(knownDurations)) {
      await client.execute({ sql: 'UPDATE courses SET duration_weeks = ? WHERE code = ?', args: [weeks, code] });
    }
  }
  const enrollmentColumns = await client.execute('PRAGMA table_info(enrollments)');
  if (!enrollmentColumns.rows.some(column => column.name === 'learning_mode')) {
    await client.execute("ALTER TABLE enrollments ADD COLUMN learning_mode TEXT NOT NULL DEFAULT 'classroom'");
  }
  const progressColumns = await client.execute('PRAGMA table_info(student_chapter_progress)');
  if (!progressColumns.rows.some(column => column.name === 'materials_completed')) {
    await client.execute('ALTER TABLE student_chapter_progress ADD COLUMN materials_completed INTEGER NOT NULL DEFAULT 0');
  }
  const chapterColumns = await client.execute('PRAGMA table_info(learning_chapters)');
  if (!chapterColumns.rows.some(column => column.name === 'study_notes')) {
    await client.execute('ALTER TABLE learning_chapters ADD COLUMN study_notes TEXT');
  }
  const materialColumns = await client.execute('PRAGMA table_info(materials)');
  for (const [name, definition] of [
    ['resource_category', "TEXT DEFAULT 'other'"], ['is_paid', 'INTEGER DEFAULT 0'], ['price', 'REAL DEFAULT 0'],
    ['storage_key', 'TEXT'], ['storage_type', 'TEXT'], ['mime_type', 'TEXT'],
  ]) {
    if (!materialColumns.rows.some(column => column.name === name)) {
      await client.execute(`ALTER TABLE materials ADD COLUMN ${name} ${definition}`);
    }
  }
  const purchaseColumns = await client.execute('PRAGMA table_info(material_purchases)');
  for (const [name, definition] of [
    ['guest_phone', 'TEXT'], ['access_token_hash', 'TEXT'], ['payment_method', "TEXT DEFAULT 'mpesa'"],
    ['payment_reference', 'TEXT'], ['payer_name', 'TEXT'],
  ]) {
    if (!purchaseColumns.rows.some(column => column.name === name)) {
      await client.execute(`ALTER TABLE material_purchases ADD COLUMN ${name} ${definition}`);
    }
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
      const durationValues = String(c[3] || '').match(/\d+/g)?.map(Number) || [8];
      const durationWeeks = Math.max(1, Math.round(durationValues.reduce((sum, value) => sum + value, 0) / durationValues.length));
      await client.execute({
        sql: 'INSERT OR IGNORE INTO courses (code, title, trainer, description, duration_weeks) VALUES (?, ?, ?, ?, ?)',
        args: [c[0], c[1], c[2], c[4], durationWeeks],
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
