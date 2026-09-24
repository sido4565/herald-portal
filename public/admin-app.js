// ============================================================
// admin-app.js — Herald Admin Panel
// ============================================================

const $  = (s, root = document) => root.querySelector(s);
const $$ = (s, root = document) => [...root.querySelectorAll(s)];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
}[c]));

// ---------- CSV helpers ----------
function toCSV(rows) {
  return rows.map(row =>
    row.map(cell => {
      const s = String(cell ?? '');
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    }).join(',')
  ).join('\n');
}

function downloadCSV(filename, csv) {
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

// ------------------------------------------------------------
// Theme
// ------------------------------------------------------------
function applyTheme() {
  const isDark = localStorage.getItem('theme') === 'dark';
  document.body.classList.toggle('dark', isDark);
  document.documentElement.classList.remove('dark-preload');
}
applyTheme();

function toggleTheme() {
  const isDark = document.body.classList.toggle('dark');
  localStorage.setItem('theme', isDark ? 'dark' : 'light');
}

// ------------------------------------------------------------
// Toast
// ------------------------------------------------------------
function toast(msg, type = 'success') {
  const wrap = $('#toastWrap');
  if (!wrap) return;
  const el = document.createElement('div');
  el.className = `toast toast-${type}`;
  el.textContent = msg;
  wrap.appendChild(el);
  requestAnimationFrame(() => el.classList.add('show'));
  setTimeout(() => {
    el.classList.remove('show');
    setTimeout(() => el.remove(), 300);
  }, 3000);
}

// ------------------------------------------------------------
// API helper
// ------------------------------------------------------------
async function api(url, opts = {}) {
  const res = await fetch(url, {
    headers: { 'Content-Type': 'application/json' },
    credentials: 'same-origin',
    ...opts,
    body: opts.body ? JSON.stringify(opts.body) : undefined
  });
  if (res.status === 401 && !url.includes('/login')) {
    location.href = 'admin-login.html';
    return;
  }
  let data = {};
  try { data = await res.json(); } catch (_) {}
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

// ============================================================
// ADMIN LOGIN PAGE
// ============================================================
if ($('#adminLoginForm')) {
  $('#adminLoginForm').addEventListener('submit', async e => {
    e.preventDefault();
    const data = Object.fromEntries(new FormData(e.target));
    const msg = $('#adminMsg');
    msg.textContent = '';
    try {
      await api('/api/admin/login', { method: 'POST', body: data });
      location.href = 'admin-dashboard.html';
    } catch (err) {
      msg.className = 'msg error';
      msg.textContent = err.message;
    }
  });

  const tgl = $('#themeToggle');
  if (tgl) tgl.addEventListener('click', toggleTheme);
}

// ============================================================
// ADMIN DASHBOARD
// ============================================================
if ($('#adminName')) {
  let coursesCache = [];
  let studentsCache = [];
  let ttCache = [];

  const themeBtn = $('#themeToggle');
  if (themeBtn) themeBtn.addEventListener('click', toggleTheme);

  (async () => {
    try {
      const me = await api('/api/admin/me');
      $('#adminName').textContent = me.name;
      $('#adminRole').textContent = me.role;
    } catch { return; }

    $('#adminLogoutBtn').addEventListener('click', async () => {
      try { await api('/api/admin/logout', { method: 'POST' }); } catch (_) {}
      location.href = 'admin-login.html';
    });

    $$('.admin-tab').forEach(tab => {
      tab.addEventListener('click', () => {
        $$('.admin-tab').forEach(t => t.classList.remove('active'));
        $$('.admin-panel').forEach(p => p.classList.remove('active'));
        tab.classList.add('active');
        const panel = $(`#panel-${tab.dataset.panel}`);
        if (panel) panel.classList.add('active');
        loadPanel(tab.dataset.panel).catch(e => toast(e.message, 'error'));
      });
    });

    $('#modalCancel').addEventListener('click', closeModal);
    $('#modal').addEventListener('click', e => {
      if (e.target.id === 'modal') closeModal();
    });
    document.addEventListener('keydown', e => {
      if (e.key === 'Escape' && !$('#modal').classList.contains('hidden')) closeModal();
    });

    wireButtons();
    await loadPanel('overview');
  })();

  async function loadPanel(name) {
    switch (name) {
      case 'overview':      return loadOverview();
      case 'students':      return loadStudents();
      case 'courses':       return loadCourses();
      case 'announcements': return loadAnnouncements();
      case 'results':       return loadResults();
      case 'fees':          return loadFees();
      case 'timetable':     return loadTimetable();
      case 'assignments':   return loadAssignments();
    }
  }

  async function refreshCaches() {
    coursesCache = await api('/api/admin/courses');
    studentsCache = await api('/api/admin/students');
  }

  async function ensureCache() {
    if (!coursesCache.length || !studentsCache.length) await refreshCaches();
  }

  async function loadOverview() {
    const s = await api('/api/admin/stats');
    $('#statStudents').textContent      = s.students;
    $('#statCourses').textContent       = s.courses;
    $('#statEnrollments').textContent   = s.enrollments;
    $('#statAnnouncements').textContent = s.announcements;
  }

  let currentSubmit = null;
  function openModal(title, fields, onSubmit) {
    $('#modalTitle').textContent = title;
    const form = $('#modalForm');
    form.innerHTML = fields.map(f => {
      const req = f.required ? 'required' : '';
      const val = f.value ?? '';
      if (f.type === 'select') {
        const opts = [
          `<option value="">— Select —</option>`,
          ...f.options.map(o =>
            `<option value="${esc(o.value)}"${String(o.value) === String(val) ? ' selected' : ''}>${esc(o.label)}</option>`
          )
        ].join('');
        return `<label>${esc(f.label)}</label><select name="${esc(f.name)}" ${req}>${opts}</select>`;
      }
      if (f.type === 'textarea') {
        return `<label>${esc(f.label)}</label><textarea name="${esc(f.name)}" rows="4" ${req}>${esc(val)}</textarea>`;
      }
      return `<label>${esc(f.label)}</label><input name="${esc(f.name)}" type="${esc(f.type || 'text')}" value="${esc(val)}" ${req} />`;
    }).join('');

    form.onsubmit = async e => {
      e.preventDefault();
      if (!currentSubmit) return;
      const data = Object.fromEntries(new FormData(form));
      try {
        await currentSubmit(data);
        closeModal();
        toast('Saved ✅');
      } catch (err) {
        toast(err.message, 'error');
      }
    };
    currentSubmit = onSubmit;
    $('#modal').classList.remove('hidden');
    setTimeout(() => form.querySelector('input,select,textarea')?.focus(), 50);
  }

  function closeModal() {
    $('#modal').classList.add('hidden');
    currentSubmit = null;
  }

  function showCustomModal(title, bodyHtml, onReady) {
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.innerHTML = `
      <div class="modal" style="max-width:720px;">
        <h3>${title}</h3>
        ${bodyHtml}
        <div class="modal-actions">
          <button class="btn-ghost dark" data-close type="button">Close</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);
    overlay.addEventListener('click', e => {
      if (e.target === overlay || e.target.closest('[data-close]')) overlay.remove();
    });
    if (onReady) onReady(overlay);
  }

  function wireButtons() {
    // Students
    $('#addStudentBtn').addEventListener('click', () => openModal('Add Student', [
      { name: 'reg_no',   label: 'Registration No', required: true },
      { name: 'name',     label: 'Full Name',       required: true },
      { name: 'email',    label: 'Email', type: 'email', required: true },
      { name: 'password', label: 'Password', type: 'password', required: true },
      { name: 'course',   label: 'Course',          required: true }
    ], async d => {
      await api('/api/admin/students', { method: 'POST', body: d });
      studentsCache = [];
      await loadStudents();
    }));

    // Courses
    $('#addCourseBtn').addEventListener('click', () => openModal('Add Course', [
      { name: 'code',        label: 'Code', required: true },
      { name: 'title',       label: 'Title', required: true },
      { name: 'trainer',     label: 'Trainer', required: true },
      { name: 'description', label: 'Description', type: 'textarea' }
    ], async d => {
      await api('/api/admin/courses', { method: 'POST', body: d });
      coursesCache = [];
      await loadCourses();
    }));

    // Announcements
    $('#addAnnBtn').addEventListener('click', () => openModal('New Announcement', [
      { name: 'title', label: 'Title', required: true },
      { name: 'body',  label: 'Body', type: 'textarea', required: true }
    ], async d => {
      await api('/api/admin/announcements', { method: 'POST', body: d });
      await loadAnnouncements();
    }));

    // Results
    $('#addResultBtn').addEventListener('click', async () => {
      try { await ensureCache(); } catch (e) { return toast(e.message, 'error'); }
      openModal('Add Result', [
        { name: 'student_id', label: 'Student', type: 'select', required: true,
          options: studentsCache.map(s => ({ value: s.id, label: `${s.reg_no} — ${s.name}` })) },
        { name: 'course_id', label: 'Course', type: 'select', required: true,
          options: coursesCache.map(c => ({ value: c.id, label: `${c.code} — ${c.title}` })) },
        { name: 'marks', label: 'Marks (0-100)', type: 'number', required: true },
        { name: 'term',  label: 'Term', value: 'Term 1 2025', required: true }
      ], async d => {
        d.student_id = Number(d.student_id);
        d.course_id  = Number(d.course_id);
        await api('/api/admin/results', { method: 'POST', body: d });
        await loadResults();
      });
    });

    // Fees
    $('#addFeeBtn').addEventListener('click', async () => {
      try { await ensureCache(); } catch (e) { return toast(e.message, 'error'); }
      openModal('Add Fee Record', [
        { name: 'student_id', label: 'Student', type: 'select', required: true,
          options: studentsCache.map(s => ({ value: s.id, label: `${s.reg_no} — ${s.name}` })) },
        { name: 'term',        label: 'Term', value: 'Term 1 2025', required: true },
        { name: 'amount_due',  label: 'Amount Due',  type: 'number', required: true },
        { name: 'amount_paid', label: 'Amount Paid', type: 'number', value: 0 }
      ], async d => {
        d.student_id = Number(d.student_id);
        await api('/api/admin/fees', { method: 'POST', body: d });
        await loadFees();
      });
    });

    // Timetable
    $('#addTTBtn').addEventListener('click', async () => {
      try { await ensureCache(); } catch (e) { return toast(e.message, 'error'); }
      openModal('Add Timetable Slot', [
        { name: 'course_id', label: 'Course', type: 'select', required: true,
          options: coursesCache.map(c => ({ value: c.id, label: `${c.code} — ${c.title}` })) },
        { name: 'day', label: 'Day', type: 'select', required: true,
          options: ['Monday','Tuesday','Wednesday','Thursday','Friday','Saturday']
            .map(d => ({ value: d, label: d })) },
        { name: 'start_time', label: 'Start (HH:MM)', value: '08:00', required: true },
        { name: 'end_time',   label: 'End (HH:MM)',   value: '10:00', required: true },
        { name: 'room',    label: 'Room' },
        { name: 'trainer', label: 'Trainer' }
      ], async d => {
        d.course_id = Number(d.course_id);
        const conflict = ttCache.find(t =>
          t.day === d.day && !(d.end_time <= t.start_time || d.start_time >= t.end_time)
        );
        if (conflict) {
          if (!confirm(`⚠️ Conflict with ${conflict.code} (${conflict.start_time}–${conflict.end_time}). Continue anyway?`)) return;
        }
        await api('/api/admin/timetable', { method: 'POST', body: d });
        await loadTimetable();
      });
    });

    const exportBtn = $('#exportTTCsvBtn');
    if (exportBtn) {
      exportBtn.addEventListener('click', () => {
        if (!ttCache.length) return toast('No data to export', 'error');
        const rows = [['Day', 'Start', 'End', 'Code', 'Title', 'Room', 'Trainer']];
        ttCache.forEach(t => rows.push([t.day, t.start_time, t.end_time, t.code, t.title, t.room, t.trainer]));
        downloadCSV(`timetable-${Date.now()}.csv`, toCSV(rows));
        toast('CSV downloaded ✅');
      });
    }

    const bulkDel = $('#ttBulkDeleteBtn');
    if (bulkDel) {
      bulkDel.addEventListener('click', async () => {
        const ids = [...document.querySelectorAll('.tt-check:checked')].map(cb => Number(cb.dataset.id));
        if (!ids.length) return toast('Select at least one slot', 'error');
        if (!confirm(`Delete ${ids.length} slot(s)?`)) return;
        try {
          for (const id of ids) await api(`/api/admin/timetable/${id}`, { method: 'DELETE' });
          toast(`${ids.length} slot(s) deleted ✅`);
          await loadTimetable();
        } catch (e) { toast(e.message, 'error'); }
      });
    }

    // Assignments
    $('#addAsgBtn').addEventListener('click', async () => {
      try { await ensureCache(); } catch (e) { return toast(e.message, 'error'); }
      openModal('New Assignment', [
        { name: 'course_id', label: 'Course', type: 'select', required: true,
          options: coursesCache.map(c => ({ value: c.id, label: `${c.code} — ${c.title}` })) },
        { name: 'title',       label: 'Title', required: true },
        { name: 'description', label: 'Description', type: 'textarea' },
        { name: 'due_date',    label: 'Due Date', type: 'date' }
      ], async d => {
        d.course_id = Number(d.course_id);
        await api('/api/admin/assignments', { method: 'POST', body: d });
        await loadAssignments();
      });
    });
  }

  // ---------------- Students ----------------
  async function loadStudents() {
    const rows = await api('/api/admin/students');
    studentsCache = rows;
    const tb = $('#studentsTable tbody');
    tb.innerHTML = rows.map(s => `
      <tr>
        <td>${esc(s.reg_no)}</td>
        <td>${esc(s.name)}</td>
        <td>${esc(s.email)}</td>
        <td>${esc(s.course)}</td>
        <td><span class="pill ${s.active ? 'pill-green' : 'pill-red'}">${s.active ? 'Active' : 'Inactive'}</span></td>
        <td>
          <button class="btn-xs" data-act="edit-student" data-id="${s.id}" type="button">Edit</button>
          <button class="btn-xs" data-act="reset-pw"     data-id="${s.id}" type="button">Reset PW</button>
          <button class="btn-xs danger" data-act="del-student" data-id="${s.id}" type="button">Delete</button>
        </td>
      </tr>`).join('') || '<tr><td colspan="6" class="empty">No students yet</td></tr>';
    wireTableActions(tb);
  }

  function wireTableActions(scope) {
    scope.addEventListener('click', async e => {
      const btn = e.target.closest('button[data-act]');
      if (!btn) return;
      const id = Number(btn.dataset.id);
      const act = btn.dataset.act;
      try {
        if (act === 'edit-student')  return editStudent(id);
        if (act === 'reset-pw')      return resetPwd(id);
        if (act === 'del-student')   return deleteStudent(id);
        if (act === 'edit-course')   return editCourse(id);
        if (act === 'del-course')    return deleteCourse(id);
        if (act === 'view-course')   return viewCourseStudents(id);
        if (act === 'edit-ann')      return editAnn(id);
        if (act === 'del-ann')       return delAnn(id);
        if (act === 'del-result')    return delResult(id);
        if (act === 'edit-fee')      return editFee(id);
        if (act === 'del-fee')       return delFee(id);
        if (act === 'pay-fee')       return payFee(id);
        if (act === 'del-tt')        return delTT(id);
        if (act === 'view-subs')     return viewSubs(id);
        if (act === 'del-asg')       return delAsg(id);
      } catch (err) { toast(err.message, 'error'); }
    });
  }

  function editStudent(id) {
    const s = studentsCache.find(x => x.id === id);
    if (!s) return;
    openModal('Edit Student', [
      { name: 'name',   label: 'Full Name', value: s.name,   required: true },
      { name: 'email',  label: 'Email',     value: s.email,  required: true },
      { name: 'course', label: 'Course',    value: s.course, required: true },
      { name: 'active', label: 'Active (1=yes, 0=no)', value: s.active ? 1 : 0 }
    ], async d => {
      d.active = Number(d.active);
      await api(`/api/admin/students/${id}`, { method: 'PUT', body: d });
      await loadStudents();
    });
  }

  async function resetPwd(id) {
    const pwd = prompt('New password (min 6 chars):');
    if (!pwd) return;
    if (pwd.length < 6) return toast('Password must be at least 6 characters', 'error');
    try {
      await api(`/api/admin/students/${id}/reset-password`, { method: 'POST', body: { newPassword: pwd } });
      toast('Password reset ✅');
    } catch (e) { toast(e.message, 'error'); }
  }

  async function deleteStudent(id) {
    if (!confirm('Delete this student and all their data?')) return;
    try {
      await api(`/api/admin/students/${id}`, { method: 'DELETE' });
      studentsCache = [];
      await loadStudents();
      toast('Student deleted');
    } catch (e) { toast(e.message, 'error'); }
  }

  // ---------------- Courses ----------------
  async function loadCourses() {
    const rows = await api('/api/admin/courses');
    coursesCache = rows;
    const tb = $('#coursesTable tbody');
    tb.innerHTML = rows.map(c => `
      <tr>
        <td>${esc(c.code)}</td>
        <td>${esc(c.title)}</td>
        <td>${esc(c.trainer)}</td>
        <td>${c.enrolled_count}</td>
        <td>
          <button class="btn-xs" data-act="edit-course" data-id="${c.id}" type="button">Edit</button>
          <button class="btn-xs" data-act="view-course" data-id="${c.id}" type="button">Students</button>
          <button class="btn-xs danger" data-act="del-course" data-id="${c.id}" type="button">Delete</button>
        </td>
      </tr>`).join('') || '<tr><td colspan="5" class="empty">No courses yet</td></tr>';
    wireTableActions(tb);
  }

  function editCourse(id) {
    const c = coursesCache.find(x => x.id === id);
    if (!c) return;
    openModal('Edit Course', [
      { name: 'code',        label: 'Code',    value: c.code,    required: true },
      { name: 'title',       label: 'Title',   value: c.title,   required: true },
      { name: 'trainer',     label: 'Trainer', value: c.trainer, required: true },
      { name: 'description', label: 'Description', type: 'textarea', value: c.description || '' }
    ], async d => {
      await api(`/api/admin/courses/${id}`, { method: 'PUT', body: d });
      coursesCache = [];
      await loadCourses();
    });
  }

  async function deleteCourse(id) {
    if (!confirm('Delete course and related records?')) return;
    try {
      await api(`/api/admin/courses/${id}`, { method: 'DELETE' });
      coursesCache = [];
      await loadCourses();
      toast('Course deleted');
    } catch (e) { toast(e.message, 'error'); }
  }

  async function viewCourseStudents(id) {
    const course = coursesCache.find(c => c.id === id);
    const list = await api(`/api/admin/courses/${id}/students`);
    const body = list.length
      ? `<div class="table-wrap"><table>
          <thead><tr><th>Reg No</th><th>Name</th><th>Email</th></tr></thead>
          <tbody>${list.map(s => `
            <tr><td>${esc(s.reg_no)}</td><td>${esc(s.name)}</td><td>${esc(s.email)}</td></tr>
          `).join('')}</tbody>
        </table></div>`
      : `<p class="empty">No students enrolled in ${esc(course?.code || 'this course')} yet.</p>`;
    showCustomModal(`Students — ${esc(course?.code || '')}`, body);
  }

  // ---------------- Announcements ----------------
  async function loadAnnouncements() {
    const list = await api('/api/admin/announcements');
    const wrap = $('#annList');
    wrap.innerHTML = list.map(a => `
      <div class="ann-card">
        <div class="ann-head">
          <strong>${esc(a.title)}</strong>
          <span class="ann-date">${new Date(a.created_at).toLocaleDateString()}</span>
        </div>
        <p>${esc(a.body)}</p>
        <div class="ann-actions">
          <button class="btn-xs" data-act="edit-ann" data-id="${a.id}" type="button">Edit</button>
          <button class="btn-xs danger" data-act="del-ann" data-id="${a.id}" type="button">Delete</button>
        </div>
      </div>`).join('') || '<p class="empty">No announcements</p>';
    wireTableActions(wrap);
  }

  async function editAnn(id) {
    const list = await api('/api/admin/announcements');
    const a = list.find(x => x.id === id);
    if (!a) return;
    openModal('Edit Announcement', [
      { name: 'title', label: 'Title', value: a.title, required: true },
      { name: 'body',  label: 'Body',  type: 'textarea', value: a.body, required: true }
    ], async d => {
      await api(`/api/admin/announcements/${id}`, { method: 'PUT', body: d });
      await loadAnnouncements();
    });
  }

  async function delAnn(id) {
    if (!confirm('Delete this announcement?')) return;
    try {
      await api(`/api/admin/announcements/${id}`, { method: 'DELETE' });
      await loadAnnouncements();
      toast('Announcement deleted');
    } catch (e) { toast(e.message, 'error'); }
  }

  // ---------------- Results ----------------
  async function loadResults() {
    const rows = await api('/api/admin/results');
    const tb = $('#resultsTable tbody');
    tb.innerHTML = rows.map(r => `
      <tr>
        <td>${esc(r.reg_no)} — ${esc(r.student_name)}</td>
        <td>${esc(r.code)} — ${esc(r.course_title)}</td>
        <td>${r.marks}</td>
        <td><strong>${esc(r.grade)}</strong></td>
        <td>${esc(r.term)}</td>
        <td><button class="btn-xs danger" data-act="del-result" data-id="${r.id}" type="button">Delete</button></td>
      </tr>`).join('') || '<tr><td colspan="6" class="empty">No results yet</td></tr>';
    wireTableActions(tb);
  }

  async function delResult(id) {
    if (!confirm('Delete this result?')) return;
    try {
      await api(`/api/admin/results/${id}`, { method: 'DELETE' });
      await loadResults();
      toast('Result deleted');
    } catch (e) { toast(e.message, 'error'); }
  }

  // ---------------- Fees ----------------
  async function loadFees() {
    const summary = await api('/api/admin/fees/summary');
    const outstanding = summary.total_due - summary.total_paid;

    let bar = document.querySelector('.fees-summary-bar');
    if (!bar) {
      bar = document.createElement('div');
      bar.className = 'fees-summary-bar';
      const panel = document.querySelector('#panel-fees');
      const tableWrap = panel.querySelector('.table-wrap');
      panel.insertBefore(bar, tableWrap);
    }
    bar.innerHTML = `
      <div class="stat-card">
        <div class="stat-num">KES ${Number(summary.total_due).toLocaleString()}</div>
        <div class="stat-lbl">Total Due</div>
      </div>
      <div class="stat-card">
        <div class="stat-num" style="color:#16a34a;">KES ${Number(summary.total_paid).toLocaleString()}</div>
        <div class="stat-lbl">Collected</div>
      </div>
      <div class="stat-card">
        <div class="stat-num" style="color:#dc2626;">KES ${Number(outstanding).toLocaleString()}</div>
        <div class="stat-lbl">Outstanding</div>
      </div>
      <div class="stat-card">
        <div class="stat-num">${summary.records}</div>
        <div class="stat-lbl">Records</div>
      </div>
    `;

    const rows = await api('/api/admin/fees');
    const tb = $('#feesTable tbody');
    tb.innerHTML = rows.map(f => {
      const balance = Number(f.amount_due) - Number(f.amount_paid);
      const pillCls = f.status === 'paid' ? 'pill-green'
                     : f.status === 'partial' ? 'pill-amber'
                     : 'pill-red';
      return `
        <tr>
          <td>${esc(f.reg_no)} — ${esc(f.student_name)}</td>
          <td>${esc(f.term)}</td>
          <td>${Number(f.amount_due).toLocaleString()}</td>
          <td>${Number(f.amount_paid).toLocaleString()}</td>
          <td>${balance.toLocaleString()}</td>
          <td><span class="pill ${pillCls}">${esc(f.status)}</span></td>
          <td>
            ${f.status !== 'paid' ? `<button class="btn-pay" data-act="pay-fee" data-id="${f.id}" type="button">💵 Pay</button>` : ''}
            <button class="btn-xs" data-act="edit-fee" data-id="${f.id}" type="button">Edit</button>
            <button class="btn-xs danger" data-act="del-fee" data-id="${f.id}" type="button">Delete</button>
          </td>
        </tr>`;
    }).join('') || '<tr><td colspan="7" class="empty">No fee records</td></tr>';
    wireTableActions(tb);
  }

  async function editFee(id) {
    const rows = await api('/api/admin/fees');
    const f = rows.find(x => x.id === id);
    if (!f) return;
    openModal('Edit Fee', [
      { name: 'amount_due',  label: 'Amount Due',  type: 'number', value: f.amount_due,  required: true },
      { name: 'amount_paid', label: 'Amount Paid', type: 'number', value: f.amount_paid }
    ], async d => {
      await api(`/api/admin/fees/${id}`, { method: 'PUT', body: d });
      await loadFees();
    });
  }

  async function delFee(id) {
    if (!confirm('Delete this fee record?')) return;
    try {
      await api(`/api/admin/fees/${id}`, { method: 'DELETE' });
      await loadFees();
      toast('Fee record deleted');
    } catch (e) { toast(e.message, 'error'); }
  }

  async function payFee(id) {
    const rows = await api('/api/admin/fees');
    const f = rows.find(x => x.id === id);
    if (!f) return;
    const balance = Number(f.amount_due) - Number(f.amount_paid);
    const amountStr = prompt(
      `Record payment for ${f.reg_no} — ${f.student_name}\n` +
      `Term: ${f.term}\n` +
      `Balance: KES ${balance.toLocaleString()}\n\n` +
      `Enter payment amount:`
    );
    if (amountStr === null) return;
    const amount = Number(amountStr);
    if (!amount || amount <= 0) return toast('Invalid amount', 'error');
    if (amount > balance) {
      if (!confirm(`Amount exceeds balance (KES ${balance.toLocaleString()}). Continue anyway?`)) return;
    }
    try {
      await api(`/api/admin/fees/${id}/pay`, { method: 'POST', body: { amount } });
      toast('Payment recorded ✅');
      await loadFees();
    } catch (e) { toast(e.message, 'error'); }
  }

  // ---------------- Timetable ----------------
  const DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

  async function loadTimetable() {
    ttCache = await api('/api/admin/timetable');

    const grid = $('#ttGrid');
    if (!grid) return;

    const times = [...new Set(ttCache.map(t => `${t.start_time}-${t.end_time}`))].sort();

    if (!times.length) {
      grid.innerHTML = '<p class="empty" style="grid-column:1/-1;">No slots scheduled. Click <strong>+ Add Slot</strong> to begin.</p>';
    } else {
      let html = '<div class="tt-cell tt-head"></div>';
      DAYS.forEach(d => { html += `<div class="tt-cell tt-head">${d}</div>`; });
      times.forEach(timeStr => {
        const [start, end] = timeStr.split('-');
        html += `<div class="tt-cell tt-time">${start}<br>${end}</div>`;
        DAYS.forEach(day => {
          const slot = ttCache.find(t => t.day === day && `${t.start_time}-${t.end_time}` === timeStr);
          if (slot) {
            html += `<div class="tt-cell tt-slot">
              <div class="tt-slot-code">${esc(slot.code)}</div>
              <div class="tt-slot-title">${esc(slot.title)}</div>
              <div class="tt-slot-meta">📍${esc(slot.room || '—')}</div>
              <div class="tt-slot-meta">👤${esc(slot.trainer || '—')}</div>
            </div>`;
          } else {
            html += '<div class="tt-cell tt-empty">—</div>';
          }
        });
      });
      grid.innerHTML = html;
    }

    const tb = $('#ttTable tbody');
    tb.innerHTML = ttCache.map(t => `
      <tr>
        <td><input type="checkbox" class="tt-check" data-id="${t.id}" /></td>
        <td>${esc(t.day)}</td>
        <td>${esc(t.start_time)} – ${esc(t.end_time)}</td>
        <td>${esc(t.code)} — ${esc(t.title)}</td>
        <td>${esc(t.room || '')}</td>
        <td>${esc(t.trainer || '')}</td>
        <td>
          <button class="btn-xs danger" data-act="del-tt" data-id="${t.id}" type="button">Delete</button>
        </td>
      </tr>`).join('') || '<tr><td colspan="7" class="empty">No slots</td></tr>';
    wireTableActions(tb);

    const selAll = $('#ttSelectAll');
    if (selAll) {
      selAll.checked = false;
      selAll.onclick = () => {
        document.querySelectorAll('.tt-check').forEach(cb => cb.checked = selAll.checked);
      };
    }
  }

  async function delTT(id) {
    if (!confirm('Delete this slot?')) return;
    try {
      await api(`/api/admin/timetable/${id}`, { method: 'DELETE' });
      await loadTimetable();
      toast('Slot deleted');
    } catch (e) { toast(e.message, 'error'); }
  }

  // ---------------- Assignments ----------------
  async function loadAssignments() {
    const rows = await api('/api/admin/assignments');
    const tb = $('#asgTable tbody');

    tb.innerHTML = rows.map(a => {
      const dueBadge = (() => {
        if (!a.due_date) return '—';
        const due = new Date(a.due_date);
        const now = new Date();
        const days = Math.ceil((due - now) / (1000 * 60 * 60 * 24));
        if (days < 0)  return `<span class="pill pill-red">Overdue (${-days}d)</span>`;
        if (days <= 3) return `<span class="pill pill-amber">Due in ${days}d</span>`;
        return esc(a.due_date);
      })();

      const subCount = a.submission_count || 0;
      const gradedCount = a.graded_count || 0;
      const gradedBadge = subCount
        ? `<span class="pill ${gradedCount === subCount ? 'pill-green' : 'pill-amber'}">${gradedCount}/${subCount}</span>`
        : '<span class="pill pill-red">0</span>';

      return `
        <tr>
          <td>${esc(a.code)}</td>
          <td>${esc(a.title)}</td>
          <td>${dueBadge}</td>
          <td><strong>${subCount}</strong></td>
          <td>${gradedBadge}</td>
          <td>
            <button class="btn-xs" data-act="view-subs" data-id="${a.id}" type="button">📥 Submissions</button>
            <button class="btn-xs danger" data-act="del-asg" data-id="${a.id}" type="button">Delete</button>
          </td>
        </tr>`;
    }).join('') || '<tr><td colspan="6" class="empty">No assignments</td></tr>';
    wireTableActions(tb);
  }

  async function delAsg(id) {
    if (!confirm('Delete assignment and all submissions?')) return;
    try {
      await api(`/api/admin/assignments/${id}`, { method: 'DELETE' });
      await loadAssignments();
      toast('Assignment deleted');
    } catch (e) { toast(e.message, 'error'); }
  }

  async function viewSubs(id) {
    const subs = await api(`/api/admin/assignments/${id}/submissions`);
    const assignments = await api('/api/admin/assignments');
    const asg = assignments.find(a => a.id === id);
    const title = asg ? `${esc(asg.code)} — ${esc(asg.title)}` : 'Submissions';

    const body = subs.length
      ? `
        <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:12px; flex-wrap:wrap; gap:8px;">
          <span class="pill pill-amber">${subs.length} submission(s)</span>
          <div style="display:flex; gap:6px;">
            <button class="btn-xs" data-export-subs type="button">⬇ CSV</button>
            <button class="btn-xs" data-save-all type="button">💾 Save All</button>
          </div>
        </div>
        <div style="max-height:60vh; overflow:auto;">
          ${subs.map(s => `
            <div class="sub-card" data-sub="${s.id}">
              <div class="sub-head">
                <strong>${esc(s.reg_no)} — ${esc(s.student_name)}</strong>
                <span class="sub-date">${new Date(s.submitted_at).toLocaleString()}</span>
              </div>
              <div class="sub-content">${esc(s.content || '(no content)')}</div>
              <div class="sub-grade-row">
                <div>
                  <label>Grade</label>
                  <input class="grade-input" data-field="grade" data-id="${s.id}" value="${esc(s.grade || '')}" placeholder="A" />
                </div>
                <div style="flex:1;">
                  <label>Feedback</label>
                  <input class="feedback-input" data-field="feedback" data-id="${s.id}" value="${esc(s.feedback || '')}" placeholder="Optional feedback…" />
                </div>
                <button class="btn-xs" data-save-one="${s.id}" type="button">Save</button>
              </div>
            </div>
          `).join('')}
        </div>`
      : '<p class="empty">No submissions yet.</p>';

    showCustomModal(title, body, overlay => {
      overlay.addEventListener('click', async e => {
        const saveOne = e.target.closest('[data-save-one]');
        const saveAll = e.target.closest('[data-save-all]');
        const exportBtn = e.target.closest('[data-export-subs]');

        if (saveOne) {
          const subId = Number(saveOne.dataset.saveOne);
          const grade = overlay.querySelector(`[data-field="grade"][data-id="${subId}"]`).value;
          const feedback = overlay.querySelector(`[data-field="feedback"][data-id="${subId}"]`).value;
          try {
            await api(`/api/admin/submissions/${subId}`, { method: 'PUT', body: { grade, feedback } });
            toast('Saved ✅');
          } catch (err) { toast(err.message, 'error'); }
        }

        if (saveAll) {
          try {
            for (const s of subs) {
              const grade = overlay.querySelector(`[data-field="grade"][data-id="${s.id}"]`).value;
              const feedback = overlay.querySelector(`[data-field="feedback"][data-id="${s.id}"]`).value;
              await api(`/api/admin/submissions/${s.id}`, { method: 'PUT', body: { grade, feedback } });
            }
            toast('All saved ✅');
          } catch (err) { toast(err.message, 'error'); }
        }

        if (exportBtn) {
          const rows = [['Reg No', 'Name', 'Submitted', 'Content', 'Grade', 'Feedback']];
          subs.forEach(s => rows.push([
            s.reg_no, s.student_name, s.submitted_at, s.content || '',
            overlay.querySelector(`[data-field="grade"][data-id="${s.id}"]`).value,
            overlay.querySelector(`[data-field="feedback"][data-id="${s.id}"]`).value
          ]));
          downloadCSV(`submissions-${id}-${Date.now()}.csv`, toCSV(rows));
          toast('CSV downloaded ✅');
        }
      });
    });
  }
    // ---------- Auto-logout after 30 min inactivity ----------
  (function autoLogout() {
    const TIMEOUT = 30 * 60 * 1000;
    let timer;
    function reset() {
      clearTimeout(timer);
      timer = setTimeout(() => {
        fetch('/api/admin/logout', { method: 'POST' })
          .catch(() => {})
          .finally(() => location.href = 'admin-login.html');
      }, TIMEOUT);
    }
    ['click', 'keypress', 'scroll', 'mousemove'].forEach(ev =>
      document.addEventListener(ev, reset, { passive: true })
    );
    reset();
  })();
}