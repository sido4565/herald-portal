'use strict';

const express = require('express');
const { AccessToken, RoomServiceClient, WebhookReceiver } = require('livekit-server-sdk');

const LIVEKIT_API_KEY = process.env.LIVEKIT_API_KEY;
const LIVEKIT_API_SECRET = process.env.LIVEKIT_API_SECRET;
function normalizeLiveKitUrl(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  try {
    const raw = value.trim();
    const parsed = new URL(/^[a-z][a-z\d+.-]*:\/\//i.test(raw) ? raw : `wss://${raw}`);
    if (!['ws:', 'wss:', 'http:', 'https:'].includes(parsed.protocol) || !parsed.hostname || parsed.username || parsed.password) return null;
    const secure = parsed.protocol === 'wss:' || parsed.protocol === 'https:';
    parsed.protocol = secure ? 'wss:' : 'ws:';
    const websocketUrl = parsed.toString().replace(/\/$/, '');
    parsed.protocol = secure ? 'https:' : 'http:';
    return { websocketUrl, serviceUrl: parsed.toString().replace(/\/$/, '') };
  } catch {
    return null;
  }
}
const liveKitEndpoints = normalizeLiveKitUrl(process.env.LIVEKIT_URL);
const LIVEKIT_URL = liveKitEndpoints?.websocketUrl || '';
const configured = Boolean(LIVEKIT_API_KEY && LIVEKIT_API_SECRET && liveKitEndpoints);
const httpUrl = liveKitEndpoints?.serviceUrl || '';
const roomService = configured ? new RoomServiceClient(httpUrl, LIVEKIT_API_KEY, LIVEKIT_API_SECRET) : null;
const webhookReceiver = configured ? new WebhookReceiver(LIVEKIT_API_KEY, LIVEKIT_API_SECRET) : null;
const CLASS_END_GRACE_MINUTES = Math.max(0, Number(process.env.LIVE_CLASS_JOIN_GRACE_MINUTES) || 0);
const CLASS_TIMEZONE_OFFSET_MINUTES = Number.isFinite(Number(process.env.LIVE_CLASS_TIMEZONE_OFFSET_MINUTES))
  ? Number(process.env.LIVE_CLASS_TIMEZONE_OFFSET_MINUTES) : 180;
const expiryTimers = new Map();
let notificationMailer = null;
try { notificationMailer = require('./mailer'); } catch (_) {}

function classUrl(id) { return `/live-classroom.html?classId=${encodeURIComponent(id)}`; }
function asIso(value) {
  let normalized = value;
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?$/.test(value)) {
    const offset = CLASS_TIMEZONE_OFFSET_MINUTES;
    const sign = offset < 0 ? '-' : '+';
    const absolute = Math.abs(offset);
    normalized = `${value}${sign}${String(Math.floor(absolute / 60)).padStart(2, '0')}:${String(absolute % 60).padStart(2, '0')}`;
  }
  const date = new Date(normalized);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}
function classDate(value) {
  return new Date(new Date(value).getTime() + CLASS_TIMEZONE_OFFSET_MINUTES * 60000).toISOString().slice(0, 10);
}
function webhookTime(event, fallback = Date.now()) {
  const timestamp = Number(event.createdAt);
  const milliseconds = timestamp > 0 ? (timestamp < 1e12 ? timestamp * 1000 : timestamp) : fallback;
  return new Date(milliseconds).toISOString();
}
function sendConfigError(res) {
  const invalidUrl = Boolean(process.env.LIVEKIT_URL && !liveKitEndpoints);
  return res.status(503).json({ error: invalidUrl
    ? 'Live classrooms are unavailable because LIVEKIT_URL is invalid. Set it to the LiveKit server WebSocket URL (wss://...) and restart the server.'
    : 'Live classrooms are not configured yet. Add LIVEKIT_URL, LIVEKIT_API_KEY, and LIVEKIT_API_SECRET to the backend environment.' });
}
function numericId(value) {
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

async function getClass(db, id) {
  const result = await db.execute({
    sql: `SELECT lc.*, c.code, c.title AS course_title,
            CASE WHEN lc.created_by_type = 'admin' THEN COALESCE(pl.name, (SELECT assigned.name FROM lecturer_courses ax JOIN lecturers assigned ON assigned.id = ax.lecturer_id
              WHERE ax.course_id = lc.course_id AND assigned.status = 'active' AND assigned.approved = 1 ORDER BY assigned.id LIMIT 1), 'Unassigned')
              ELSE COALESCE(l.name, pl.name, c.trainer, 'Herald Trainer') END AS lecturer_name
          FROM live_classes lc JOIN courses c ON c.id = lc.course_id
          LEFT JOIN lecturers l ON lc.created_by_type = 'lecturer' AND l.id = lc.created_by
          LEFT JOIN lecturers pl ON pl.id = lc.presenter_lecturer_id
          LEFT JOIN admins a ON lc.created_by_type = 'admin' AND a.id = lc.created_by
          WHERE lc.id = ?`, args: [id],
  });
  return result.rows[0] || null;
}

async function courseAccess(db, type, userId, courseId) {
  if (type === 'admin') return true;
  if (type === 'lecturer') {
    const result = await db.execute({
      sql: 'SELECT 1 FROM lecturer_courses WHERE lecturer_id = ? AND course_id = ?',
      args: [userId, courseId],
    });
    return result.rows.length > 0;
  }
  const result = await db.execute({
    sql: 'SELECT 1 FROM enrollments WHERE student_id = ? AND course_id = ?',
    args: [userId, courseId],
  });
  return result.rows.length > 0;
}
async function activeLecturer(db, lecturerId) {
  const result = await db.execute({ sql: 'SELECT status, approved FROM lecturers WHERE id = ?', args: [lecturerId] });
  return Boolean(result.rows[0] && result.rows[0].status === 'active' && Number(result.rows[0].approved) === 1);
}

async function closeOpenSessions(db, liveClass, endedAt) {
  const end = Math.min(new Date(endedAt).getTime(), new Date(liveClass.scheduled_end_at).getTime());
  const endIso = new Date(Math.max(end, new Date(liveClass.scheduled_at).getTime())).toISOString();
  const open = await db.execute({
    sql: 'SELECT id, student_id, joined_at FROM live_class_attendance_sessions WHERE live_class_id = ? AND left_at IS NULL',
    args: [liveClass.id],
  });
  for (const session of open.rows) {
    const joinedMs = new Date(session.joined_at).getTime();
    const leftIso = new Date(Math.max(joinedMs, new Date(endIso).getTime())).toISOString();
    await db.execute({
      sql: 'UPDATE live_class_attendance_sessions SET left_at = ?, duration_seconds = ? WHERE id = ? AND left_at IS NULL',
      args: [leftIso, Math.max(0, Math.floor((new Date(leftIso).getTime() - joinedMs) / 1000)), session.id],
    });
    await refreshSummary(db, liveClass, session.student_id);
  }
  await db.execute({
    sql: `UPDATE live_class_participant_sessions SET left_at = ?,
          duration_seconds = MAX(0, CAST((julianday(?) - julianday(joined_at)) * 86400 AS INTEGER))
          WHERE live_class_id = ? AND left_at IS NULL`,
    args: [endIso, endIso, liveClass.id],
  });
}

async function refreshSummary(db, liveClass, studentId) {
  const stats = await db.execute({
    sql: `SELECT MIN(joined_at) AS first_joined_at, MAX(left_at) AS last_left_at,
            COALESCE(SUM(duration_seconds), 0) AS duration_seconds,
            MAX(CASE WHEN left_at IS NULL THEN joined_at END) AS active_joined_at
          FROM live_class_attendance_sessions WHERE live_class_id = ? AND student_id = ?`,
    args: [liveClass.id, studentId],
  });
  const row = stats.rows[0];
  const first = row.first_joined_at || null;
  const status = first ? 'present' : 'absent';
  const day = classDate(liveClass.scheduled_at);
  const activeSeconds = row.active_joined_at
    ? Math.max(0, Math.floor((Date.now() - new Date(row.active_joined_at).getTime()) / 1000)) : 0;
  const durationSeconds = (Number(row.duration_seconds) || 0) + activeSeconds;
  await db.execute({
    sql: `INSERT INTO live_class_attendance
            (live_class_id, course_id, student_id, attendance_date, first_joined_at, last_left_at, duration_seconds, status, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
          ON CONFLICT(live_class_id, student_id) DO UPDATE SET
            first_joined_at = excluded.first_joined_at, last_left_at = excluded.last_left_at,
            duration_seconds = excluded.duration_seconds, status = excluded.status, updated_at = CURRENT_TIMESTAMP`,
    args: [liveClass.id, liveClass.course_id, studentId, day, first, row.last_left_at || null, durationSeconds, status],
  });
  const legacy = await db.execute({
    sql: 'SELECT id FROM attendance WHERE live_class_id = ? AND student_id = ? LIMIT 1',
    args: [liveClass.id, studentId],
  });
  const attendanceArgs = [liveClass.course_id, studentId, day, status, `Live class ${liveClass.id} (automatic)`, liveClass.id, first, row.last_left_at || null, durationSeconds];
  if (legacy.rows.length) {
    await db.execute({
      sql: `UPDATE attendance SET status = ?, notes = ?, first_joined_at = ?, last_left_at = ?, duration_seconds = ? WHERE id = ?`,
      args: [status, attendanceArgs[4], first, row.last_left_at || null, durationSeconds, legacy.rows[0].id],
    });
  } else {
    await db.execute({
      sql: `INSERT INTO attendance (course_id, student_id, date, status, marked_by, notes, live_class_id, first_joined_at, last_left_at, duration_seconds)
            VALUES (?, ?, ?, ?, NULL, ?, ?, ?, ?, ?)`,
      args: attendanceArgs,
    });
  }
  // A live class join counts as daily course attendance, including other class
  // entries for the same course and date.
  if (first) {
    await db.execute({
      sql: `UPDATE attendance SET status = 'present' WHERE course_id = ? AND student_id = ? AND date = ?`,
      args: [liveClass.course_id, studentId, day],
    });
  }
}

const reconcilingRooms = new Set();
function participantJoinDate(value, liveClass) {
  const normalizedValue = typeof value === 'bigint' ? Number(value) : value;
  let timestamp = normalizedValue ? new Date(normalizedValue).getTime() : Date.now();
  if (typeof normalizedValue === 'number' && normalizedValue > 0 && normalizedValue < 1e12) timestamp *= 1000;
  if (!Number.isFinite(timestamp)) timestamp = Date.now();
  timestamp = Math.max(new Date(liveClass.scheduled_at).getTime(), Math.min(timestamp, new Date(liveClass.scheduled_end_at).getTime()));
  return new Date(timestamp).toISOString();
}

async function reconcileRoomParticipants(db, liveClass) {
  if (!configured || liveClass.status !== 'LIVE' || !liveClass.room_name || reconcilingRooms.has(Number(liveClass.id))) return;
  reconcilingRooms.add(Number(liveClass.id));
  try {
    const now = Math.min(Date.now(), new Date(liveClass.scheduled_end_at).getTime());
    const roomParticipants = await roomService.listParticipants(liveClass.room_name);
    const active = new Map();
    for (const participant of roomParticipants) {
      const match = /^(student|lecturer)-(\d+)$/.exec(String(participant.identity || ''));
      if (!match) continue;
      const [, type, rawId] = match;
      const id = Number(rawId);
      const allowed = type === 'student'
        ? await courseAccess(db, 'student', id, liveClass.course_id)
        : await activeLecturer(db, id) && await courseAccess(db, 'lecturer', id, liveClass.course_id);
      if (!allowed) continue;
      const identity = `${type}-${id}`;
      const joinedAt = participantJoinDate(participant.joinedAt, liveClass);
      active.set(identity, { type, id });
      const openParticipant = await db.execute({ sql: `SELECT id FROM live_class_participant_sessions
        WHERE live_class_id = ? AND participant_type = ? AND participant_id = ? AND left_at IS NULL LIMIT 1`, args: [liveClass.id, type, id] });
      if (!openParticipant.rows.length) {
        await db.execute({ sql: `INSERT INTO live_class_participant_sessions
          (live_class_id, participant_type, participant_id, participant_name, attendance_date, identity, joined_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)`, args: [liveClass.id, type, id, participant.name || identity, classDate(liveClass.scheduled_at), identity, joinedAt] });
      }
      if (type === 'student') {
        const openAttendance = await db.execute({ sql: `SELECT id FROM live_class_attendance_sessions
          WHERE live_class_id = ? AND student_id = ? AND left_at IS NULL LIMIT 1`, args: [liveClass.id, id] });
        if (!openAttendance.rows.length) await db.execute({ sql: 'INSERT INTO live_class_attendance_sessions (live_class_id, student_id, joined_at) VALUES (?, ?, ?)', args: [liveClass.id, id, joinedAt] });
        await refreshSummary(db, liveClass, id);
      } else {
        const day = classDate(liveClass.scheduled_at);
        await db.execute({
          sql: `INSERT INTO lecturer_attendance (lecturer_id, date, status, notes, marked_by)
                VALUES (?, ?, 'present', ?, NULL)
                ON CONFLICT(lecturer_id, date) DO UPDATE SET status = 'present', notes = excluded.notes`,
          args: [id, day, `Live class ${liveClass.id} (automatic)`],
        });
      }
    }

    const openSessions = await db.execute({ sql: `SELECT id, participant_type, participant_id, joined_at FROM live_class_participant_sessions
      WHERE live_class_id = ? AND left_at IS NULL`, args: [liveClass.id] });
    for (const session of openSessions.rows) {
      const identity = `${session.participant_type}-${session.participant_id}`;
      if (active.has(identity)) continue;
      const leftAt = new Date(Math.max(new Date(session.joined_at).getTime(), now)).toISOString();
      await db.execute({ sql: `UPDATE live_class_participant_sessions SET left_at = ?, duration_seconds = ? WHERE id = ? AND left_at IS NULL`, args: [leftAt, Math.max(0, Math.floor((new Date(leftAt).getTime() - new Date(session.joined_at).getTime()) / 1000)), session.id] });
      if (session.participant_type === 'student') {
        const studentSession = await db.execute({ sql: `SELECT id, joined_at FROM live_class_attendance_sessions
          WHERE live_class_id = ? AND student_id = ? AND left_at IS NULL ORDER BY id DESC LIMIT 1`, args: [liveClass.id, session.participant_id] });
        if (studentSession.rows[0]) {
          const joinedAt = new Date(studentSession.rows[0].joined_at);
          const closedAt = new Date(Math.max(joinedAt.getTime(), new Date(leftAt).getTime()));
          await db.execute({ sql: 'UPDATE live_class_attendance_sessions SET left_at = ?, duration_seconds = ? WHERE id = ? AND left_at IS NULL', args: [closedAt.toISOString(), Math.floor((closedAt.getTime() - joinedAt.getTime()) / 1000), studentSession.rows[0].id] });
        }
        await refreshSummary(db, liveClass, session.participant_id);
      }
    }
  } finally {
    reconcilingRooms.delete(Number(liveClass.id));
  }
}

async function finalizeClass(db, id, reason = 'scheduled') {
  const liveClass = await getClass(db, id);
  if (!liveClass || liveClass.status === 'COMPLETED') return true;
  if (!['SCHEDULED', 'LIVE', 'ENDING'].includes(liveClass.status)) return false;
  const endAt = new Date(Math.min(Date.now(), new Date(liveClass.scheduled_end_at).getTime())).toISOString();
  await db.execute({ sql: "UPDATE live_classes SET status = 'ENDING' WHERE id = ? AND status IN ('SCHEDULED', 'LIVE', 'ENDING')", args: [id] });
  if (liveClass.room_name && liveClass.started_at && !configured) {
    console.error(`Live class ${id} cannot be terminated until LiveKit credentials are restored.`);
    return false;
  }
  if (configured && liveClass.room_name && liveClass.started_at) {
    try {
      await roomService.deleteRoom(liveClass.room_name);
    } catch (error) {
      // A room may already have been removed during a retry or a prior shutdown.
      if (!/not found|does not exist|no room/i.test(error.message || '')) {
        console.error(`Live class ${id} room termination will retry:`, error.message);
        return false;
      }
    }
  }
  const latest = await getClass(db, id);
  await closeOpenSessions(db, latest, endAt);
  const enrolled = await db.execute({
    sql: 'SELECT DISTINCT student_id FROM enrollments WHERE course_id = ?', args: [liveClass.course_id],
  });
  const classDay = classDate(liveClass.scheduled_at);
  for (const student of enrolled.rows) {
    await refreshSummary(db, liveClass, student.student_id);
    const summary = await db.execute({
      sql: 'SELECT first_joined_at, last_left_at, duration_seconds, status FROM live_class_attendance WHERE live_class_id = ? AND student_id = ?',
      args: [id, student.student_id],
    });
    const attendance = summary.rows[0] || { first_joined_at: null, last_left_at: null, duration_seconds: 0, status: 'absent' };
    await db.execute({
      sql: `INSERT OR IGNORE INTO attendance (course_id, student_id, date, status, marked_by, notes, live_class_id, first_joined_at, last_left_at, duration_seconds)
            VALUES (?, ?, ?, ?, NULL, ?, ?, ?, ?, ?)`,
      args: [liveClass.course_id, student.student_id, classDay, attendance.status, `Live class ${id} (${reason})`, id, attendance.first_joined_at, attendance.last_left_at, attendance.duration_seconds],
    });
  }
  await db.execute({
    sql: `UPDATE attendance SET status = 'present'
          WHERE course_id = ? AND date = ? AND student_id IN (
            SELECT student_id FROM live_class_attendance
            WHERE course_id = ? AND attendance_date = ? AND first_joined_at IS NOT NULL
          )`,
    args: [liveClass.course_id, classDay, liveClass.course_id, classDay],
  });
  await db.execute({
    sql: "UPDATE live_classes SET status = 'COMPLETED', ended_at = ? WHERE id = ? AND status IN ('LIVE', 'ENDING')",
    args: [endAt, id],
  });
  const timer = expiryTimers.get(Number(id));
  if (timer) clearTimeout(timer.handle);
  expiryTimers.delete(Number(id));
  return true;
}

function scheduleTermination(db, id, scheduledEndAt) {
  const numeric = Number(id);
  const target = new Date(scheduledEndAt).getTime();
  if (!Number.isSafeInteger(numeric) || !Number.isFinite(target)) return;
  const existing = expiryTimers.get(numeric);
  if (existing?.target === target) return;
  if (existing) clearTimeout(existing.handle);
  const delay = Math.max(0, Math.min(target + CLASS_END_GRACE_MINUTES * 60000 - Date.now(), 2147483000));
  const handle = setTimeout(async () => {
    expiryTimers.delete(numeric);
    if (Date.now() < target + CLASS_END_GRACE_MINUTES * 60000) {
      scheduleTermination(db, numeric, scheduledEndAt);
      return;
    }
    const completed = await finalizeClass(db, numeric, 'scheduled').catch(error => {
      console.error(`Live class ${numeric} expiry failed:`, error.message);
      return false;
    });
    if (!completed) scheduleTermination(db, numeric, new Date(Date.now() + 5000).toISOString());
  }, delay);
  expiryTimers.set(numeric, { target, handle });
  handle.unref();
}

async function recoverClassTerminationSchedules(db) {
  try {
    const pending = await db.execute({
      sql: "SELECT id, scheduled_end_at FROM live_classes WHERE status IN ('SCHEDULED', 'LIVE', 'ENDING') ORDER BY scheduled_end_at",
    });
    for (const row of pending.rows) scheduleTermination(db, row.id, row.scheduled_end_at);
  } catch (error) {
    console.error('Live class schedule recovery failed:', error.message);
  }
}

function setupLiveClassroom({ app, db, authStudent, authLecturer, authAdmin, jwt, jwtSecret }) {
  const authAny = (req, res, next) => {
    const tokens = [req.cookies.token, req.cookies.lecturer_token, req.cookies.admin_token].filter(Boolean);
    for (const token of tokens) {
      try {
        const payload = jwt.verify(token, jwtSecret);
        if (!['student', 'lecturer', 'admin'].includes(payload.type)) continue;
        req.portalUser = payload;
        return next();
      } catch { /* Another role cookie may still hold a valid session. */ }
    }
    return res.status(401).json({ error: 'Not authenticated.' });
  };
  const requireConfig = (req, res, next) => configured ? next() : sendConfigError(res);

  app.get('/api/my-live-classes', authStudent, async (req, res) => {
    try {
      const result = await db.execute({
        sql: `SELECT lc.*, c.code, c.title AS course_title, COALESCE(pl.name, l.name, c.trainer, 'Herald Trainer') AS lecturer_name
              FROM live_classes lc JOIN courses c ON c.id = lc.course_id
              JOIN enrollments e ON e.course_id = lc.course_id
              LEFT JOIN lecturers l ON lc.created_by_type = 'lecturer' AND l.id = lc.created_by
              LEFT JOIN lecturers pl ON pl.id = lc.presenter_lecturer_id
              WHERE e.student_id = ? ORDER BY lc.scheduled_at`, args: [req.user.id],
      });
      res.json(result.rows.map(row => ({ ...row,
        status: row.status === 'LIVE' ? 'live' : ['COMPLETED', 'ENDING'].includes(row.status) ? 'ended' : 'upcoming',
        meeting_url: classUrl(row.id), server_time: new Date().toISOString(),
        ends_at: row.scheduled_end_at || new Date(new Date(row.scheduled_at).getTime() + row.duration_minutes * 60000).toISOString(),
      })));
    } catch (error) { res.status(500).json({ error: error.message }); }
  });

  app.get('/api/lecturer/live-classes', authLecturer, async (req, res) => {
    try {
      if (!(await activeLecturer(db, req.lecturer.id))) return res.status(403).json({ error: 'An active, approved lecturer account is required.' });
      const result = await db.execute({
        sql: `SELECT lc.*, c.code, c.title AS course_title, COALESCE(pl.name, l.name, c.trainer, 'Herald Trainer') AS lecturer_name
              FROM live_classes lc JOIN courses c ON c.id = lc.course_id
              JOIN lecturer_courses x ON x.course_id = c.id
              LEFT JOIN lecturers l ON lc.created_by_type = 'lecturer' AND l.id = lc.created_by
              LEFT JOIN lecturers pl ON pl.id = lc.presenter_lecturer_id
              WHERE x.lecturer_id = ? ORDER BY lc.scheduled_at DESC`,
        args: [req.lecturer.id],
      });
      res.json(result.rows.map(row => ({ ...row, meeting_url: classUrl(row.id) })));
    } catch (error) { res.status(500).json({ error: error.message }); }
  });

  app.get('/api/admin/live-classes', authAdmin, async (req, res) => {
    try {
      const result = await db.execute(`SELECT lc.*, c.code, c.title AS course_title,
        CASE WHEN lc.created_by_type = 'admin' THEN COALESCE(pl.name, (SELECT assigned.name FROM lecturer_courses ax JOIN lecturers assigned ON assigned.id = ax.lecturer_id
          WHERE ax.course_id = lc.course_id AND assigned.status = 'active' AND assigned.approved = 1 ORDER BY assigned.id LIMIT 1), 'Unassigned')
          ELSE COALESCE(l.name, pl.name, c.trainer, a.name, 'Herald Trainer') END AS lecturer_name FROM live_classes lc JOIN courses c ON c.id = lc.course_id
        LEFT JOIN lecturers l ON lc.created_by_type = 'lecturer' AND l.id = lc.created_by
        LEFT JOIN lecturers pl ON pl.id = lc.presenter_lecturer_id
        LEFT JOIN admins a ON lc.created_by_type = 'admin' AND a.id = lc.created_by ORDER BY lc.scheduled_at DESC`);
      res.json(result.rows.map(row => ({ ...row, meeting_url: classUrl(row.id) })));
    } catch (error) { res.status(500).json({ error: error.message }); }
  });

  app.get('/api/admin/live-class-lecturers', authAdmin, async (req, res) => {
    try {
      const result = await db.execute(`SELECT DISTINCT l.id, l.name, lc.course_id FROM lecturer_courses lc
        JOIN lecturers l ON l.id = lc.lecturer_id WHERE l.status = 'active' AND l.approved = 1 ORDER BY l.name, lc.course_id`);
      res.json(result.rows);
    } catch (error) { res.status(500).json({ error: error.message }); }
  });

  app.get('/api/admin/live-classes/:id/progress', authAdmin, async (req, res) => {
    try {
      const item = await getClass(db, numericId(req.params.id));
      if (!item) return res.status(404).json({ error: 'Live class not found.' });
      const now = Date.now();
      const start = new Date(item.started_at || item.scheduled_at).getTime();
      const end = new Date(item.scheduled_end_at).getTime();
      const elapsedSeconds = Math.max(0, Math.floor((Math.min(now, end) - start) / 1000));
      const enrolled = await db.execute({
        sql: `SELECT s.id AS participant_id, s.name, s.reg_no,
                COALESCE(SUM(p.duration_seconds), 0) AS completed_seconds,
                MAX(CASE WHEN p.left_at IS NULL THEN p.joined_at END) AS active_joined_at
              FROM enrollments e JOIN students s ON s.id = e.student_id
              LEFT JOIN live_class_participant_sessions p ON p.live_class_id = ? AND p.participant_type = 'student' AND p.participant_id = s.id
              WHERE e.course_id = ? AND s.status = 'active'
              GROUP BY s.id, s.name, s.reg_no ORDER BY s.name`, args: [item.id, item.course_id],
      });
      const participants = enrolled.rows.map(row => {
        const seconds = (Number(row.completed_seconds) || 0) + (row.active_joined_at ? Math.max(0, Math.floor((now - new Date(row.active_joined_at).getTime()) / 1000)) : 0);
        return { name: row.name, reg_no: row.reg_no, duration_seconds: seconds, attendance_percentage: elapsedSeconds ? Math.min(100, Math.round(seconds / elapsedSeconds * 100)) : 0, connected: Boolean(row.active_joined_at) };
      });
      res.json({ class_id: item.id, status: item.status, elapsed_seconds: elapsedSeconds, participants });
    } catch (error) { res.status(500).json({ error: error.message }); }
  });

  async function createClass(req, res, creatorType) {
    const courseId = numericId(req.body.course_id);
    const title = String(req.body.title || '').trim().slice(0, 180);
    const description = String(req.body.description || '').trim().slice(0, 3000);
    const scheduledAt = asIso(req.body.scheduled_at);
    const duration = Number(req.body.duration_minutes);
    if (!courseId || !title || !scheduledAt || !Number.isInteger(duration) || duration < 5 || duration > 480) {
      return res.status(400).json({ error: 'Choose a course, title, valid start time, and duration from 5 to 480 minutes.' });
    }
    if (new Date(scheduledAt).getTime() <= Date.now()) return res.status(400).json({ error: 'Choose a future class start time.' });
    if (creatorType === 'lecturer' && !(await activeLecturer(db, req.lecturer.id))) return res.status(403).json({ error: 'An active, approved lecturer account is required.' });
    const courseExists = await db.execute({ sql: 'SELECT 1 FROM courses WHERE id = ?', args: [courseId] });
    if (!courseExists.rows.length) return res.status(404).json({ error: 'Selected course not found.' });
    if (!(await courseAccess(db, creatorType, creatorType === 'lecturer' ? req.lecturer.id : req.admin.id, courseId))) {
      return res.status(403).json({ error: 'You are not authorized to schedule a class for this course.' });
    }
    let presenterLecturerId = creatorType === 'lecturer' ? req.lecturer.id : numericId(req.body.lecturer_id);
    if (creatorType === 'admin') {
      if (!presenterLecturerId) return res.status(400).json({ error: 'Choose a lecturer assigned to this course.' });
      const assignment = await db.execute({ sql: `SELECT 1 FROM lecturer_courses x JOIN lecturers l ON l.id = x.lecturer_id
        WHERE x.course_id = ? AND x.lecturer_id = ? AND l.status = 'active' AND l.approved = 1 LIMIT 1`, args: [courseId, presenterLecturerId] });
      if (!assignment.rows.length) return res.status(400).json({ error: 'The selected lecturer is not assigned to this course.' });
    }
    const endAt = new Date(new Date(scheduledAt).getTime() + duration * 60000).toISOString();
    try {
      const inserted = await db.execute({
        sql: `INSERT INTO live_classes (course_id, title, description, meeting_url, scheduled_at, duration_minutes,
              created_by, presenter_lecturer_id, created_by_type, status, scheduled_end_at)
              VALUES (?, ?, ?, '', ?, ?, ?, ?, ?, 'SCHEDULED', ?)`,
        args: [courseId, title, description, scheduledAt, duration, creatorType === 'lecturer' ? req.lecturer.id : req.admin.id, presenterLecturerId, creatorType, endAt],
      });
      const id = Number(inserted.lastInsertRowid);
      const roomName = `herald-class-${id}`;
      await db.execute({ sql: 'UPDATE live_classes SET room_name = ? WHERE id = ?', args: [roomName, id] });
      scheduleTermination(db, id, endAt);
      if (req.body.notify && notificationMailer?.ENABLED && typeof notificationMailer.sendLiveClassNotification === 'function') {
        try {
          const [students, course] = await Promise.all([
            db.execute({ sql: 'SELECT s.email, s.name FROM students s JOIN enrollments e ON e.student_id=s.id WHERE e.course_id=?', args: [courseId] }),
            db.execute({ sql: 'SELECT code,title FROM courses WHERE id=?', args: [courseId] }),
          ]);
          for (const student of students.rows) notificationMailer.sendLiveClassNotification({ to: student.email, studentName: student.name,
            courseCode: course.rows[0]?.code, courseTitle: course.rows[0]?.title, classTitle: title, scheduledAt: new Date(scheduledAt),
            meetingUrl: `${String(process.env.APP_URL || 'https://heraldtrainer.co.ke').replace(/\/$/, '')}${classUrl(id)}`,
          }).catch(error => console.error('Live class email failed:', error.message));
        } catch (error) { console.error('Live class notification setup failed:', error.message); }
      }
      res.json({ ok: true, id, meeting_url: classUrl(id), status: 'SCHEDULED' });
    } catch (error) { res.status(500).json({ error: error.message }); }
  }
  app.post('/api/lecturer/live-classes', authLecturer, (req, res) => createClass(req, res, 'lecturer'));
  app.post('/api/admin/live-classes', authAdmin, (req, res) => createClass(req, res, 'admin'));

  async function startClass(req, res, type) {
    if (!configured) return sendConfigError(res);
    const id = numericId(req.params.id);
    const item = id && await getClass(db, id);
    if (!item) return res.status(404).json({ error: 'Live class not found.' });
    if (type === 'lecturer' && !(await activeLecturer(db, req.lecturer.id))) return res.status(403).json({ error: 'An active, approved lecturer account is required.' });
    if (!(await courseAccess(db, type, type === 'lecturer' ? req.lecturer.id : req.admin.id, item.course_id))) return res.status(403).json({ error: 'You are not assigned to this course.' });
    const now = Date.now();
    if (item.status === 'COMPLETED' || now >= new Date(item.scheduled_end_at).getTime()) {
      await finalizeClass(db, id, 'scheduled');
      return res.status(410).json({ error: 'This scheduled class has ended.' });
    }
    if (now < new Date(item.scheduled_at).getTime()) return res.status(409).json({ error: 'You can start this class at its scheduled start time.' });
    try {
      if (item.status !== 'LIVE') {
        try {
          await roomService.createRoom({ name: item.room_name, emptyTimeout: 0, departureTimeout: 20, metadata: JSON.stringify({ classId: id }) });
        } catch (error) {
          const current = await getClass(db, id);
          if (current?.status === 'LIVE') return res.json({ ok: true, status: 'LIVE', ends_at: current.scheduled_end_at, server_time: new Date().toISOString() });
          const existing = await roomService.listRooms([item.room_name]).catch(() => []);
          if (!existing.length) throw error;
        }
        await db.execute({ sql: "UPDATE live_classes SET status = 'LIVE', started_at = ? WHERE id = ? AND status = 'SCHEDULED'", args: [new Date().toISOString(), id] });
      }
      res.json({ ok: true, status: 'LIVE', ends_at: item.scheduled_end_at, server_time: new Date().toISOString() });
    } catch (error) { res.status(502).json({ error: `Could not start the LiveKit room: ${error.message}` }); }
  }
  app.post('/api/lecturer/live-classes/:id/start', authLecturer, (req, res) => startClass(req, res, 'lecturer'));
  app.post('/api/admin/live-classes/:id/start', authAdmin, (req, res) => startClass(req, res, 'admin'));

  async function endByManager(req, res, type) {
    const id = numericId(req.params.id);
    const item = id && await getClass(db, id);
    if (!item) return res.status(404).json({ error: 'Live class not found.' });
    if (type === 'lecturer' && !(await activeLecturer(db, req.lecturer.id))) return res.status(403).json({ error: 'An active, approved lecturer account is required.' });
    if (!(await courseAccess(db, type, type === 'lecturer' ? req.lecturer.id : req.admin.id, item.course_id))) return res.status(403).json({ error: 'You are not authorized to end this class.' });
    if (item.status === 'LIVE' || item.status === 'ENDING') {
      const completed = await finalizeClass(db, id, 'manual');
      if (!completed) return res.status(502).json({ error: 'The room could not be ended yet. The server will retry.' });
    }
    res.json({ ok: true, status: 'COMPLETED' });
  }
  app.post('/api/lecturer/live-classes/:id/end', authLecturer, (req, res) => endByManager(req, res, 'lecturer'));
  app.post('/api/admin/live-classes/:id/end', authAdmin, (req, res) => endByManager(req, res, 'admin'));

  app.delete('/api/lecturer/live-classes/:id', authLecturer, async (req, res) => {
    const item = await getClass(db, numericId(req.params.id));
    if (!item) return res.status(404).json({ error: 'Live class not found.' });
    if (!(await activeLecturer(db, req.lecturer.id))) return res.status(403).json({ error: 'An active, approved lecturer account is required.' });
    if (!(await courseAccess(db, 'lecturer', req.lecturer.id, item.course_id))) return res.status(403).json({ error: 'Not allowed.' });
    if (item.status !== 'SCHEDULED') return res.status(409).json({ error: 'Only a scheduled class can be deleted; completed class attendance is retained.' });
    await db.execute({ sql: 'DELETE FROM live_classes WHERE id = ?', args: [item.id] });
    res.json({ ok: true });
  });
  app.delete('/api/admin/live-classes/:id', authAdmin, async (req, res) => {
    const item = await getClass(db, numericId(req.params.id));
    if (!item) return res.status(404).json({ error: 'Live class not found.' });
    if (item.status !== 'SCHEDULED') return res.status(409).json({ error: 'Only a scheduled class can be deleted; completed class attendance is retained.' });
    await db.execute({ sql: 'DELETE FROM live_classes WHERE id = ?', args: [item.id] });
    res.json({ ok: true });
  });

  app.get('/api/live-classes/:id/status', authAny, async (req, res) => {
    const item = await getClass(db, numericId(req.params.id));
    if (!item) return res.status(404).json({ error: 'Live class not found.' });
    if (req.portalUser.type === 'lecturer' && !(await activeLecturer(db, req.portalUser.id))) return res.status(403).json({ error: 'An active, approved lecturer account is required.' });
    if (!(await courseAccess(db, req.portalUser.type, req.portalUser.id, item.course_id))) return res.status(403).json({ error: 'Course access required.' });
    const result = { status: item.status, title: item.title, course_title: item.course_title, scheduled_at: item.scheduled_at, ends_at: item.scheduled_end_at, server_time: new Date().toISOString(), lecturer_name: item.lecturer_name, is_lecturer: req.portalUser.type === 'lecturer' };
    if (configured && item.status === 'LIVE') {
      try {
        await reconcileRoomParticipants(db, item);
        const participants = await roomService.listParticipants(item.room_name);
        result.participants = participants.map(p => ({ identity: p.identity, name: p.name, joined_at: p.joinedAt }));
        result.active_students = participants.filter(p => String(p.identity).startsWith('student-')).length;
      } catch { result.participants = []; result.active_students = 0; }
    }
    res.json(result);
  });

  app.post('/api/live-classes/:id/token', authAny, requireConfig, async (req, res) => {
    const id = numericId(req.params.id);
    const item = id && await getClass(db, id);
    if (!item) return res.status(404).json({ error: 'Live class not found.' });
    const user = req.portalUser;
    if (!(await courseAccess(db, user.type, user.id, item.course_id))) return res.status(403).json({ error: 'You are not enrolled in this course.' });
    if (item.status !== 'LIVE') return res.status(410).json({ error: item.status === 'COMPLETED' ? 'This class has ended.' : 'The lecturer has not started this classroom yet.' });
    if (Date.now() >= new Date(item.scheduled_end_at).getTime()) return res.status(410).json({ error: 'The scheduled class time has ended.' });
    let identity, displayName;
    if (user.type === 'student') {
      const student = await db.execute({ sql: 'SELECT name, status FROM students WHERE id = ?', args: [user.id] });
      if (!student.rows[0] || student.rows[0].status !== 'active') return res.status(403).json({ error: 'Active student account required.' });
      identity = `student-${user.id}`; displayName = student.rows[0].name;
    } else if (user.type === 'lecturer') {
      const lecturer = await db.execute({ sql: 'SELECT name, status, approved FROM lecturers WHERE id = ?', args: [user.id] });
      if (!lecturer.rows[0] || lecturer.rows[0].status !== 'active' || Number(lecturer.rows[0].approved) !== 1) return res.status(403).json({ error: 'Active, approved lecturer account required.' });
      identity = `lecturer-${user.id}`; displayName = lecturer.rows[0].name;
    } else {
      const admin = await db.execute({ sql: 'SELECT name FROM admins WHERE id = ?', args: [user.id] });
      if (!admin.rows[0]) return res.status(403).json({ error: 'Admin account not found.' });
      identity = `admin-${user.id}`; displayName = admin.rows[0].name;
    }
    const tokenTtlSeconds = Math.max(1, Math.min(600, Math.ceil((new Date(item.scheduled_end_at).getTime() - Date.now()) / 1000)));
    const token = new AccessToken(LIVEKIT_API_KEY, LIVEKIT_API_SECRET, { identity, name: displayName, ttl: `${tokenTtlSeconds}s` });
    token.addGrant({ roomJoin: true, room: item.room_name, canPublish: true, canSubscribe: true, canPublishData: true });
    res.json({ token: await token.toJwt(), url: LIVEKIT_URL, class: { id, title: item.title, course_title: item.course_title, status: item.status, scheduled_at: item.scheduled_at, ends_at: item.scheduled_end_at, lecturer_name: item.lecturer_name }, server_time: new Date().toISOString() });
  });

  app.get('/api/lecturer/live-classes/:id/attendance', authLecturer, async (req, res) => {
    const item = await getClass(db, numericId(req.params.id));
    if (!item) return res.status(404).json({ error: 'Live class not found.' });
    if (!(await courseAccess(db, 'lecturer', req.lecturer.id, item.course_id))) return res.status(403).json({ error: 'Not allowed.' });
    const rows = await db.execute({
      sql: `SELECT s.id AS student_id, s.name, s.reg_no, a.status, a.first_joined_at,
        a.last_left_at, a.duration_seconds,
        (SELECT MAX(joined_at) FROM live_class_attendance_sessions x WHERE x.live_class_id = ? AND x.student_id = s.id AND x.left_at IS NULL) AS active_joined_at
        FROM enrollments e JOIN students s ON s.id = e.student_id
        LEFT JOIN live_class_attendance a ON a.student_id = s.id AND a.live_class_id = ?
        WHERE e.course_id = ? ORDER BY s.name`, args: [item.id, item.id, item.course_id],
    });
    const lecturerSessions = await db.execute({
      sql: `SELECT MIN(joined_at) AS first_joined_at, MAX(left_at) AS last_left_at,
            COALESCE(SUM(duration_seconds), 0) AS duration_seconds,
            MAX(participant_name) AS participant_name,
            MAX(CASE WHEN left_at IS NULL THEN joined_at END) AS active_joined_at
            FROM live_class_participant_sessions
            WHERE live_class_id = ? AND participant_type = 'lecturer' AND participant_id = ?`,
      args: [item.id, req.lecturer.id],
    });
    const lecturerPresence = lecturerSessions.rows[0] || {};
    const lecturerSeconds = (Number(lecturerPresence.duration_seconds) || 0) + (lecturerPresence.active_joined_at
      ? Math.max(0, Math.floor((Date.now() - new Date(lecturerPresence.active_joined_at).getTime()) / 1000)) : 0);
    res.json([
      ...(lecturerPresence.first_joined_at ? [{
        participant_type: 'lecturer', name: lecturerPresence.participant_name || item.lecturer_name || 'Lecturer', reg_no: '', status: 'present',
        first_joined_at: lecturerPresence.first_joined_at, last_left_at: lecturerPresence.last_left_at,
        duration_seconds: lecturerSeconds, active_joined_at: lecturerPresence.active_joined_at,
      }] : []),
      ...rows.rows.map(row => ({ ...row, participant_type: 'student', status: row.active_joined_at ? (row.status || 'present') : row.status,
      duration_seconds: (Number(row.duration_seconds) || 0) + (row.active_joined_at ? Math.max(0, Math.floor((Date.now() - new Date(row.active_joined_at).getTime()) / 1000)) : 0),
    }))]);
  });

  app.get('/api/admin/live-class-attendance', authAdmin, async (req, res) => {
    const filters = [];
    const args = [];
    if (numericId(req.query.course_id)) { filters.push('lc.course_id = ?'); args.push(numericId(req.query.course_id)); }
    if (numericId(req.query.student_id)) { filters.push('s.id = ?'); args.push(numericId(req.query.student_id)); }
    if (numericId(req.query.lecturer_id)) { filters.push("COALESCE(lc.presenter_lecturer_id, CASE WHEN lc.created_by_type = 'lecturer' THEN lc.created_by END) = ?"); args.push(numericId(req.query.lecturer_id)); }
    if (req.query.date && /^\d{4}-\d{2}-\d{2}$/.test(req.query.date)) { filters.push('a.attendance_date = ?'); args.push(req.query.date); }
    if (req.query.date_from && /^\d{4}-\d{2}-\d{2}$/.test(req.query.date_from)) { filters.push('a.attendance_date >= ?'); args.push(req.query.date_from); }
    if (req.query.date_to && /^\d{4}-\d{2}-\d{2}$/.test(req.query.date_to)) { filters.push('a.attendance_date <= ?'); args.push(req.query.date_to); }
    const where = filters.length ? `WHERE ${filters.join(' AND ')}` : '';
    const report = await db.execute({
      sql: `SELECT a.*, ss.first_joined_at AS session_first_joined_at, ss.last_left_at AS session_last_left_at,
        ss.duration_seconds AS session_duration_seconds, ss.active_joined_at AS session_active_joined_at,
        'student' AS participant_type, s.name AS student_name, s.reg_no, c.code, c.title AS course_title,
        lc.title AS class_title, lc.scheduled_at, CASE WHEN lc.created_by_type = 'admin' THEN COALESCE(pl.name, 'Unassigned') ELSE COALESCE(l.name, pl.name, c.trainer, 'Herald Trainer') END AS lecturer_name
        FROM live_class_attendance a JOIN students s ON s.id = a.student_id
        JOIN courses c ON c.id = a.course_id JOIN live_classes lc ON lc.id = a.live_class_id
        LEFT JOIN lecturers l ON lc.created_by_type = 'lecturer' AND l.id = lc.created_by
        LEFT JOIN lecturers pl ON pl.id = lc.presenter_lecturer_id
        LEFT JOIN (SELECT live_class_id, student_id, MIN(joined_at) AS first_joined_at, MAX(left_at) AS last_left_at,
            COALESCE(SUM(duration_seconds), 0) AS duration_seconds,
            MAX(CASE WHEN left_at IS NULL THEN joined_at END) AS active_joined_at
          FROM live_class_attendance_sessions GROUP BY live_class_id, student_id) ss
          ON ss.live_class_id = a.live_class_id AND ss.student_id = a.student_id
        ${where} ORDER BY a.attendance_date DESC, c.code, s.name LIMIT 5000`, args,
    });
    const participantFilters = [];
    const participantArgs = [];
    if (numericId(req.query.course_id)) { participantFilters.push('lc.course_id = ?'); participantArgs.push(numericId(req.query.course_id)); }
    if (numericId(req.query.student_id)) { participantFilters.push("p.participant_type = 'student' AND p.participant_id = ?"); participantArgs.push(numericId(req.query.student_id)); }
    if (numericId(req.query.lecturer_id)) { participantFilters.push("COALESCE(lc.presenter_lecturer_id, CASE WHEN lc.created_by_type = 'lecturer' THEN lc.created_by END) = ?"); participantArgs.push(numericId(req.query.lecturer_id)); }
    if (req.query.date && /^\d{4}-\d{2}-\d{2}$/.test(req.query.date)) { participantFilters.push('p.attendance_date = ?'); participantArgs.push(req.query.date); }
    if (req.query.date_from && /^\d{4}-\d{2}-\d{2}$/.test(req.query.date_from)) { participantFilters.push('p.attendance_date >= ?'); participantArgs.push(req.query.date_from); }
    if (req.query.date_to && /^\d{4}-\d{2}-\d{2}$/.test(req.query.date_to)) { participantFilters.push('p.attendance_date <= ?'); participantArgs.push(req.query.date_to); }
    const participantWhere = participantFilters.length ? `AND ${participantFilters.join(' AND ')}` : '';
    const participants = await db.execute({
      sql: `SELECT p.attendance_date, p.live_class_id, p.participant_type, p.participant_id,
            COALESCE(MAX(p.participant_name), l.name, 'Lecturer') AS student_name, 'Lecturer' AS reg_no,
            c.code, c.title AS course_title, lc.title AS class_title,
            CASE WHEN lc.created_by_type = 'admin' THEN COALESCE(pl.name, 'Unassigned') ELSE COALESCE(l.name, pl.name, c.trainer, 'Herald Trainer') END AS lecturer_name,
            MIN(p.joined_at) AS first_joined_at, MAX(p.left_at) AS last_left_at,
            COALESCE(SUM(p.duration_seconds), 0) AS duration_seconds,
            MAX(CASE WHEN p.left_at IS NULL THEN p.joined_at END) AS active_joined_at
            FROM live_class_participant_sessions p JOIN live_classes lc ON lc.id = p.live_class_id
            JOIN courses c ON c.id = lc.course_id
            LEFT JOIN lecturers l ON p.participant_type = 'lecturer' AND l.id = p.participant_id
            LEFT JOIN lecturers pl ON pl.id = lc.presenter_lecturer_id
            WHERE p.participant_type = 'lecturer' ${participantWhere}
            GROUP BY p.live_class_id, p.participant_type, p.participant_id, p.attendance_date
            ORDER BY p.attendance_date DESC, c.code, student_name LIMIT 5000`, args: participantArgs,
    });
    const now = Date.now();
    const studentRows = report.rows.map(row => {
      const firstJoinedAt = row.session_first_joined_at || row.first_joined_at;
      const activeJoinedAt = row.session_active_joined_at || row.active_joined_at;
      const duration = Number(row.session_duration_seconds ?? row.duration_seconds ?? 0);
      return { ...row, first_joined_at: firstJoinedAt, last_left_at: row.session_last_left_at || row.last_left_at,
        active_joined_at: activeJoinedAt, status: firstJoinedAt ? 'present' : row.status,
        duration_seconds: duration + (activeJoinedAt ? Math.max(0, Math.floor((now - new Date(activeJoinedAt).getTime()) / 1000)) : 0) };
    });
    const lecturerRows = participants.rows.map(row => ({ ...row, status: 'present',
      duration_seconds: Number(row.duration_seconds || 0) + (row.active_joined_at
        ? Math.max(0, Math.floor((now - new Date(row.active_joined_at).getTime()) / 1000)) : 0),
    }));
    res.json([...studentRows, ...lecturerRows].sort((a, b) => String(b.attendance_date).localeCompare(String(a.attendance_date))));
  });
  app.get('/api/admin/live-class-attendance.csv', authAdmin, async (req, res) => {
    const report = await db.execute(`SELECT a.attendance_date,'student' AS participant_type,s.name,s.reg_no,c.code,c.title AS course_title,lc.title AS class_title,
      CASE WHEN ss.first_joined_at IS NOT NULL THEN 'present' ELSE a.status END AS status,
      COALESCE(ss.first_joined_at,a.first_joined_at) AS first_joined_at,COALESCE(ss.last_left_at,a.last_left_at) AS last_left_at,
      COALESCE(ss.duration_seconds,a.duration_seconds,0) + CASE WHEN ss.active_joined_at IS NOT NULL THEN MAX(0,CAST((julianday('now')-julianday(ss.active_joined_at))*86400 AS INTEGER)) ELSE 0 END AS duration_seconds
      FROM live_class_attendance a JOIN students s ON s.id=a.student_id JOIN courses c ON c.id=a.course_id JOIN live_classes lc ON lc.id=a.live_class_id
      LEFT JOIN (SELECT live_class_id,student_id,MIN(joined_at) first_joined_at,MAX(left_at) last_left_at,COALESCE(SUM(duration_seconds),0) duration_seconds,
        MAX(CASE WHEN left_at IS NULL THEN joined_at END) active_joined_at FROM live_class_attendance_sessions GROUP BY live_class_id,student_id) ss
        ON ss.live_class_id=a.live_class_id AND ss.student_id=a.student_id
      ORDER BY a.attendance_date DESC,s.name LIMIT 10000`);
    const lecturerReport = await db.execute(`SELECT p.attendance_date,'lecturer' AS participant_type,
      COALESCE(MAX(p.participant_name),l.name,'Lecturer') AS name,'' AS reg_no,c.code,c.title AS course_title,lc.title AS class_title,
      'present' AS status,MIN(p.joined_at) AS first_joined_at,MAX(p.left_at) AS last_left_at,
      COALESCE(SUM(p.duration_seconds),0) + COALESCE(SUM(CASE WHEN p.left_at IS NULL THEN MAX(0,CAST((julianday('now')-julianday(p.joined_at))*86400 AS INTEGER)) ELSE 0 END),0) AS duration_seconds
      FROM live_class_participant_sessions p JOIN live_classes lc ON lc.id=p.live_class_id JOIN courses c ON c.id=lc.course_id
      LEFT JOIN lecturers l ON l.id=p.participant_id WHERE p.participant_type='lecturer'
      GROUP BY p.live_class_id,p.participant_id,p.attendance_date ORDER BY p.attendance_date DESC,name LIMIT 10000`);
    const rows = [...report.rows, ...lecturerReport.rows];
    const fields = ['attendance_date', 'participant_type', 'name', 'reg_no', 'code', 'course_title', 'class_title', 'status', 'first_joined_at', 'last_left_at', 'duration_seconds'];
    const quote = value => `"${String(value ?? '').replace(/"/g, '""')}"`;
    res.type('text/csv').attachment('live-class-attendance.csv').send([fields.join(','), ...rows.map(row => fields.map(key => quote(row[key])).join(','))].join('\r\n'));
  });

  app.post('/api/livekit/webhook', express.raw({ type: 'application/webhook+json', limit: '1mb' }), async (req, res) => {
    if (!configured) return sendConfigError(res);
    try {
      const rawBody = Buffer.isBuffer(req.body) ? req.body.toString('utf8') : '';
      const event = await webhookReceiver.receive(rawBody, req.get('Authorization'));
      if (!event.id) return res.status(400).json({ error: 'Webhook event ID is required.' });
      const duplicate = await db.execute({ sql: 'SELECT 1 FROM live_class_webhook_events WHERE event_id = ?', args: [event.id] });
      const roomName = event.room?.name;
      if (!roomName) return res.json({ ok: true });
      const classResult = await db.execute({ sql: 'SELECT * FROM live_classes WHERE room_name = ?', args: [roomName] });
      const item = classResult.rows[0];
      if (!item) return res.json({ ok: true });
      const identity = event.participant?.identity || '';
      const participantMatch = /^(student|lecturer)-(\d+)$/.exec(identity);
      const studentMatch = /^student-(\d+)$/.exec(identity);
      if (duplicate.rows.length) {
        if (studentMatch) await refreshSummary(db, item, Number(studentMatch[1]));
        if (event.event === 'room_finished') await finalizeClass(db, item.id, 'room_finished');
        return res.status(200).json({ ok: true, duplicate: true });
      }
      const eventInsert = { sql: 'INSERT INTO live_class_webhook_events (event_id, event_type) VALUES (?, ?)', args: [event.id, event.event || 'unknown'] };
      if (event.event === 'participant_joined' && participantMatch && item.status === 'LIVE') {
        const participantType = participantMatch[1];
        const participantId = Number(participantMatch[2]);
        const allowed = participantType === 'student'
          ? await courseAccess(db, 'student', participantId, item.course_id)
          : await activeLecturer(db, participantId) && await courseAccess(db, 'lecturer', participantId, item.course_id);
        if (allowed) {
          const joinedAt = participantJoinDate(event.participant?.joinedAt || webhookTime(event), item);
          const statements = [eventInsert];
          const openParticipant = await db.execute({ sql: `SELECT id, joined_at FROM live_class_participant_sessions
            WHERE live_class_id = ? AND participant_type = ? AND participant_id = ? AND left_at IS NULL ORDER BY id DESC LIMIT 1`, args: [item.id, participantType, participantId] });
          const sameOpenParticipant = openParticipant.rows[0] && Math.abs(new Date(openParticipant.rows[0].joined_at).getTime() - new Date(joinedAt).getTime()) < 15000;
          if (!sameOpenParticipant) statements.push(
            { sql: `UPDATE live_class_participant_sessions SET left_at = ?, duration_seconds = MAX(0, CAST((julianday(?) - julianday(joined_at)) * 86400 AS INTEGER))
                    WHERE live_class_id = ? AND participant_type = ? AND participant_id = ? AND left_at IS NULL`, args: [joinedAt, joinedAt, item.id, participantType, participantId] },
            { sql: `INSERT INTO live_class_participant_sessions
                    (live_class_id, participant_type, participant_id, participant_name, attendance_date, identity, joined_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?)`, args: [item.id, participantType, participantId, event.participant?.name || identity, classDate(item.scheduled_at), identity, joinedAt] },
          );
          if (participantType === 'student') {
            const openAttendance = await db.execute({ sql: `SELECT id, joined_at FROM live_class_attendance_sessions
              WHERE live_class_id = ? AND student_id = ? AND left_at IS NULL ORDER BY id DESC LIMIT 1`, args: [item.id, participantId] });
            const sameOpenAttendance = openAttendance.rows[0] && Math.abs(new Date(openAttendance.rows[0].joined_at).getTime() - new Date(joinedAt).getTime()) < 15000;
            if (!sameOpenAttendance) statements.push(
              { sql: 'UPDATE live_class_attendance_sessions SET left_at = ?, duration_seconds = MAX(0, CAST((julianday(?) - julianday(joined_at)) * 86400 AS INTEGER)) WHERE live_class_id = ? AND student_id = ? AND left_at IS NULL', args: [joinedAt, joinedAt, item.id, participantId] },
              { sql: 'INSERT INTO live_class_attendance_sessions (live_class_id, student_id, joined_at) VALUES (?, ?, ?)', args: [item.id, participantId, joinedAt] },
            );
          }
          await db.batch(statements, 'write');
          if (participantType === 'student') await refreshSummary(db, item, participantId);
          else await db.execute({
            sql: `INSERT INTO lecturer_attendance (lecturer_id, date, status, notes, marked_by)
                  VALUES (?, ?, 'present', ?, NULL)
                  ON CONFLICT(lecturer_id, date) DO UPDATE SET status = 'present', notes = excluded.notes`,
            args: [participantId, classDate(item.scheduled_at), `Live class ${item.id} (automatic)`],
          });
        } else {
          await db.execute(eventInsert);
        }
      } else if (event.event === 'participant_left' && participantMatch) {
        const participantType = participantMatch[1];
        const participantId = Number(participantMatch[2]);
        const sessions = await db.execute({
          sql: `SELECT id, joined_at FROM live_class_participant_sessions
                WHERE live_class_id = ? AND participant_type = ? AND participant_id = ? AND left_at IS NULL
                ORDER BY id DESC LIMIT 1`, args: [item.id, participantType, participantId],
        });
        const session = sessions.rows[0];
        const statements = [eventInsert];
        if (session) {
          const leftAt = new Date(Math.max(new Date(session.joined_at).getTime(), Math.min(new Date(webhookTime(event)).getTime(), new Date(item.scheduled_end_at).getTime()))).toISOString();
          statements.push({
            sql: 'UPDATE live_class_participant_sessions SET left_at = ?, duration_seconds = ? WHERE id = ? AND left_at IS NULL',
            args: [leftAt, Math.max(0, Math.floor((new Date(leftAt) - new Date(session.joined_at)) / 1000)), session.id],
          });
        }
        let studentSession;
        if (participantType === 'student') {
          const studentSessions = await db.execute({
            sql: 'SELECT id, joined_at FROM live_class_attendance_sessions WHERE live_class_id = ? AND student_id = ? AND left_at IS NULL ORDER BY id DESC LIMIT 1',
            args: [item.id, participantId],
          });
          studentSession = studentSessions.rows[0];
          if (studentSession) {
            const leftAt = new Date(Math.max(new Date(studentSession.joined_at).getTime(), Math.min(new Date(webhookTime(event)).getTime(), new Date(item.scheduled_end_at).getTime()))).toISOString();
            statements.push({
              sql: 'UPDATE live_class_attendance_sessions SET left_at = ?, duration_seconds = ? WHERE id = ? AND left_at IS NULL',
              args: [leftAt, Math.max(0, Math.floor((new Date(leftAt) - new Date(studentSession.joined_at)) / 1000)), studentSession.id],
            });
          }
        }
        await db.batch(statements, 'write');
        if (participantType === 'student') await refreshSummary(db, item, participantId);
      } else if (event.event === 'room_finished') {
        await finalizeClass(db, item.id, 'room_finished');
        await db.execute({ sql: 'INSERT OR IGNORE INTO live_class_webhook_events (event_id, event_type) VALUES (?, ?)', args: [event.id, event.event || 'unknown'] });
      } else await db.execute(eventInsert);
      res.json({ ok: true });
    } catch (error) {
      console.error('LiveKit webhook rejected or failed:', error.message);
      res.status(400).json({ error: 'Webhook validation or processing failed.' });
    }
  });

  const reconcileLiveClasses = async () => {
    if (!configured) return;
    try {
      const live = await db.execute("SELECT * FROM live_classes WHERE status = 'LIVE'");
      for (const item of live.rows) await reconcileRoomParticipants(db, item).catch(error => console.error(`Live class ${item.id} attendance reconciliation failed:`, error.message));
    } catch (error) { console.error('Live class attendance reconciliation failed:', error.message); }
  };
  if (db.ready && typeof db.ready.then === 'function') db.ready.then(() => { recoverClassTerminationSchedules(db); reconcileLiveClasses(); });
  else { recoverClassTerminationSchedules(db); reconcileLiveClasses(); }
  const recovery = setInterval(() => recoverClassTerminationSchedules(db), 60000);
  recovery.unref();
  const attendanceReconciliation = setInterval(reconcileLiveClasses, 15000);
  attendanceReconciliation.unref();
  if (!configured) {
    console.warn('Live classrooms disabled: LIVEKIT_URL, LIVEKIT_API_KEY, and LIVEKIT_API_SECRET are required.');
  }
}

setupLiveClassroom.asIso = asIso;
setupLiveClassroom.classDate = classDate;
setupLiveClassroom.normalizeLiveKitUrl = normalizeLiveKitUrl;
setupLiveClassroom.refreshSummary = refreshSummary;
module.exports = setupLiveClassroom;
