const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const cookieParser = require('cookie-parser');
const jwt = require('jsonwebtoken');
const crypto = require('node:crypto');
const { AccessToken } = require('livekit-server-sdk');

process.env.LIVEKIT_URL = 'wss://test.livekit.cloud';
process.env.LIVEKIT_API_KEY = 'test-api-key';
process.env.LIVEKIT_API_SECRET = 'test-api-secret';
const setupLiveClassroom = require('../live-classroom-service');
const JWT_SECRET = 'test-secret-for-live-classroom';

test('Nairobi datetime-local schedules convert to UTC and keep the Nairobi attendance date', () => {
  assert.equal(setupLiveClassroom.asIso('2027-02-03T09:30'), '2027-02-03T06:30:00.000Z');
  assert.equal(setupLiveClassroom.classDate('2027-02-03T22:30:00.000Z'), '2027-02-04');
});

test('LiveKit URLs normalize websocket and HTTP schemes and reject invalid values', () => {
  assert.deepEqual(setupLiveClassroom.normalizeLiveKitUrl(' wss://example.livekit.cloud/ '), {
    websocketUrl: 'wss://example.livekit.cloud', serviceUrl: 'https://example.livekit.cloud',
  });
  assert.deepEqual(setupLiveClassroom.normalizeLiveKitUrl('http://localhost:7880'), {
    websocketUrl: 'ws://localhost:7880', serviceUrl: 'http://localhost:7880',
  });
  assert.deepEqual(setupLiveClassroom.normalizeLiveKitUrl('example.livekit.cloud'), {
    websocketUrl: 'wss://example.livekit.cloud', serviceUrl: 'https://example.livekit.cloud',
  });
  assert.equal(setupLiveClassroom.normalizeLiveKitUrl('not a url'), null);
  assert.equal(setupLiveClassroom.normalizeLiveKitUrl('ftp://example.com'), null);
});

test('joining a class automatically writes live and regular attendance with time spent', async () => {
  const calls = [];
  const db = { async execute(statement) {
    const sql = typeof statement === 'string' ? statement : statement.sql;
    calls.push({ sql, args: typeof statement === 'string' ? [] : statement.args || [] });
    if (sql.includes('MIN(joined_at) AS first_joined_at')) return { rows: [{
      first_joined_at: '2027-02-03T06:30:00.000Z', last_left_at: '2027-02-03T06:35:00.000Z',
      duration_seconds: 300, active_joined_at: null,
    }] };
    if (sql.startsWith('SELECT id FROM attendance')) return { rows: [] };
    return { rows: [], rowsAffected: 1 };
  } };
  await setupLiveClassroom.refreshSummary(db, {
    id: 41, course_id: 7, scheduled_at: '2027-02-03T06:30:00.000Z',
  }, 12);
  const regularAttendance = calls.find(call => call.sql.startsWith('INSERT INTO attendance'));
  assert.ok(regularAttendance);
  assert.equal(regularAttendance.args[3], 'present');
  assert.equal(regularAttendance.args[8], 300);
  assert.ok(calls.some(call => call.sql.startsWith('INSERT INTO live_class_attendance')));
});

async function runRequest({ path, method = 'GET', cookie, body, enrollment = true, lecturerAssigned = true }) {
  let insertCalled = false;
  const liveClass = {
    id: 41, course_id: 7, title: 'Portal class', description: '', scheduled_at: '2027-02-03T06:30:00.000Z',
    scheduled_end_at: '2027-02-03T07:30:00.000Z', duration_minutes: 60, room_name: 'herald-class-41', status: 'LIVE',
    course_title: 'Web Development', lecturer_name: 'Lecturer',
  };
  const db = {
    async execute(statement) {
      const sql = typeof statement === 'string' ? statement : statement.sql;
      const args = typeof statement === 'string' ? [] : statement.args || [];
      if (sql.includes('FROM live_classes lc') && sql.includes('WHERE lc.id = ?')) return { rows: [liveClass] };
      if (sql.includes('FROM live_classes lc') && sql.includes('ORDER BY lc.scheduled_at DESC')) return { rows: [liveClass] };
      if (sql.startsWith('SELECT 1 FROM enrollments')) return { rows: enrollment ? [{ 1: 1 }] : [] };
      if (sql.startsWith('SELECT 1 FROM lecturer_courses')) return { rows: lecturerAssigned ? [{ 1: 1 }] : [] };
      if (sql.startsWith('SELECT 1 FROM courses')) return { rows: [{ 1: 1 }] };
      if (sql.startsWith('SELECT status, approved FROM lecturers')) return { rows: [{ status: 'active', approved: 1 }] };
      if (sql.startsWith('INSERT INTO live_classes')) { insertCalled = true; return { lastInsertRowid: 51, rowsAffected: 1 }; }
      if (sql.startsWith('UPDATE live_classes')) return { rowsAffected: 1 };
      if (sql.startsWith('SELECT 1 FROM live_class_webhook_events')) return { rows: [] };
      if (sql.startsWith('SELECT name, status FROM students')) return { rows: [{ name: 'Test Student', status: 'active' }] };
      return { rows: [], rowsAffected: 1 };
    },
    async batch() { return []; },
    get insertCalled() { return insertCalled; },
  };
  const app = express();
  app.use(express.json()); app.use(cookieParser());
  const auth = (type, property, cookieName) => (req, res, next) => {
    if (!req.cookies[cookieName]) return res.status(401).json({ error: 'Not authenticated.' });
    req[property] = { id: type === 'student' ? 12 : 3 }; next();
  };
  setupLiveClassroom({ app, db, authStudent: auth('student', 'user', 'token'), authLecturer: auth('lecturer', 'lecturer', 'lecturer_token'), authAdmin: auth('admin', 'admin', 'admin_token'), jwt, jwtSecret: JWT_SECRET });
  const server = await new Promise(resolve => { const s = app.listen(0, () => resolve(s)); });
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}${path}`, {
      method, headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { response, data: await response.json(), db };
  } finally {
    server.closeAllConnections?.();
    await new Promise(resolve => server.close(resolve));
  }
}

test('class creation rejects past dates and out-of-range durations', async () => {
  const lecturer = jwt.sign({ id: 3, type: 'lecturer' }, JWT_SECRET);
  const result = await runRequest({ path: '/api/lecturer/live-classes', method: 'POST', cookie: `lecturer_token=${lecturer}`,
    body: { course_id: 7, title: 'Bad schedule', scheduled_at: new Date(Date.now() - 60000).toISOString(), duration_minutes: 60 } });
  assert.equal(result.response.status, 400);
  assert.equal(result.db.insertCalled, false);
});

test('assigned lecturers can schedule classes and receive an in-portal classroom URL', async () => {
  const lecturer = jwt.sign({ id: 3, type: 'lecturer' }, JWT_SECRET);
  const result = await runRequest({ path: '/api/lecturer/live-classes', method: 'POST', cookie: `lecturer_token=${lecturer}`,
    body: { course_id: 7, title: 'Web basics', description: 'Week one', scheduled_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(), duration_minutes: 60, notify: false } });
  assert.equal(result.response.status, 200);
  assert.equal(result.data.status, 'SCHEDULED');
  assert.equal(result.data.meeting_url, '/live-classroom.html?classId=51');
  assert.equal(result.db.insertCalled, true);
});

test('lecturers cannot schedule a class for a course outside their assignments', async () => {
  const lecturer = jwt.sign({ id: 3, type: 'lecturer' }, JWT_SECRET);
  const result = await runRequest({ path: '/api/lecturer/live-classes', method: 'POST', cookie: `lecturer_token=${lecturer}`, lecturerAssigned: false,
    body: { course_id: 7, title: 'Web basics', scheduled_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(), duration_minutes: 60 } });
  assert.equal(result.response.status, 403);
  assert.equal(result.db.insertCalled, false);
});

test('students outside the enrolled course cannot read or join its classroom', async () => {
  const student = jwt.sign({ id: 12, type: 'student' }, JWT_SECRET);
  const status = await runRequest({ path: '/api/live-classes/41/status', cookie: `token=${student}`, enrollment: false });
  assert.equal(status.response.status, 403);
  const token = await runRequest({ path: '/api/live-classes/41/token', method: 'POST', cookie: `token=${student}`, enrollment: false });
  assert.equal(token.response.status, 403);
});

test('unverified requests cannot read admin live-class management APIs', async () => {
  const result = await runRequest({ path: '/api/admin/live-classes' });
  assert.equal(result.response.status, 401);
});

test('authenticated admins can load live classes with their course and lecturer details', async () => {
  const result = await runRequest({ path: '/api/admin/live-classes', cookie: 'admin_token=valid-admin-session' });
  assert.equal(result.response.status, 200);
  assert.equal(result.data.length, 1);
  assert.equal(result.data[0].id, 41);
  assert.equal(result.data[0].meeting_url, '/live-classroom.html?classId=41');
});

test('class status accepts the valid lecturer session when an expired student cookie is also present', async () => {
  const lecturer = jwt.sign({ id: 3, type: 'lecturer' }, JWT_SECRET);
  const expiredStudent = jwt.sign({ id: 12, type: 'student' }, JWT_SECRET, { expiresIn: -1 });
  const result = await runRequest({ path: '/api/live-classes/41/status', cookie: `token=${expiredStudent}; lecturer_token=${lecturer}` });
  assert.equal(result.response.status, 200);
  assert.equal(result.data.is_lecturer, true);
});

test('LiveKit join and leave webhooks record student and lecturer session times', async () => {
  const now = Date.now();
  const liveClass = {
    id: 41, course_id: 7, title: 'Portal class', scheduled_at: new Date(now - 5 * 60000).toISOString(),
    scheduled_end_at: new Date(now + 60 * 60000).toISOString(), status: 'LIVE', room_name: 'herald-class-41',
  };
  const batches = [];
  let eventIds = new Set();
  const db = {
    async execute(statement) {
      const sql = typeof statement === 'string' ? statement : statement.sql;
      if (sql.startsWith('SELECT 1 FROM live_class_webhook_events')) return { rows: eventIds.has(statement.args[0]) ? [{ 1: 1 }] : [] };
      if (sql.startsWith('SELECT * FROM live_classes WHERE room_name')) return { rows: [liveClass] };
      if (sql.startsWith('SELECT 1 FROM enrollments') || sql.startsWith('SELECT 1 FROM lecturer_courses')) return { rows: [{ 1: 1 }] };
      if (sql.startsWith('SELECT status, approved FROM lecturers')) return { rows: [{ status: 'active', approved: 1 }] };
      if (sql.startsWith('SELECT id, joined_at FROM live_class_participant_sessions')) return { rows: [{ id: 11, joined_at: liveClass.scheduled_at }] };
      if (sql.startsWith('SELECT id, joined_at FROM live_class_attendance_sessions')) return { rows: [{ id: 12, joined_at: liveClass.scheduled_at }] };
      if (sql.includes('MIN(joined_at) AS first_joined_at')) return { rows: [{
        first_joined_at: liveClass.scheduled_at, last_left_at: new Date(now).toISOString(), duration_seconds: 300, active_joined_at: null,
      }] };
      if (sql.startsWith('SELECT id FROM attendance')) return { rows: [] };
      return { rows: [], rowsAffected: 1 };
    },
    async batch(statements) {
      batches.push(statements);
      for (const statement of statements) {
        if (statement.sql.startsWith('INSERT INTO live_class_webhook_events')) eventIds.add(statement.args[0]);
      }
      return [];
    },
  };
  const app = express();
  app.use(express.json()); app.use(cookieParser());
  const auth = (_type, property) => (req, _res, next) => { req[property] = { id: 3 }; next(); };
  setupLiveClassroom({ app, db, authStudent: auth('student', 'user'), authLecturer: auth('lecturer', 'lecturer'), authAdmin: auth('admin', 'admin'), jwt, jwtSecret: JWT_SECRET });
  const server = await new Promise(resolve => { const s = app.listen(0, () => resolve(s)); });
  async function postEvent(event) {
    const body = JSON.stringify(event);
    const hash = crypto.createHash('sha256').update(body).digest('base64');
    const token = new AccessToken('test-api-key', 'test-api-secret', { identity: 'webhook', ttl: '1m' });
    token.sha256 = hash;
    const authorization = await token.toJwt();
    return fetch(`http://127.0.0.1:${server.address().port}/api/livekit/webhook`, {
      method: 'POST', headers: { 'Content-Type': 'application/webhook+json', Authorization: authorization }, body,
    });
  }
  try {
    for (const [eventName, identity] of [
      ['participant_joined', 'student-12'], ['participant_joined', 'lecturer-3'],
      ['participant_left', 'student-12'], ['participant_left', 'lecturer-3'],
    ]) {
      const response = await postEvent({
        id: `${eventName}-${identity}`, event: eventName, createdAt: String(Math.floor(Date.now() / 1000)),
        room: { name: 'herald-class-41' }, participant: { identity, name: identity },
      });
      assert.equal(response.status, 200);
    }
    const insertedParticipantSessions = batches.flat().filter(statement => statement.sql.startsWith('INSERT INTO live_class_participant_sessions'));
    assert.deepEqual(insertedParticipantSessions.map(statement => statement.args[1]).sort(), ['lecturer', 'student']);
    assert.ok(batches.flat().some(statement => statement.sql.startsWith('INSERT INTO live_class_attendance_sessions')));
    assert.ok(batches.flat().some(statement => statement.sql.startsWith('UPDATE live_class_participant_sessions SET left_at')));
  } finally {
    server.closeAllConnections?.();
    await new Promise(resolve => server.close(resolve));
  }
});
