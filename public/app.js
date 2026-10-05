// ============================================================
// app.js — Student portal
// ============================================================

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
}[c]));

// ---------- Theme ----------
function applyTheme() {
  const isDark = localStorage.getItem('theme') === 'dark';
  document.body.classList.toggle('dark', isDark);
  document.documentElement.classList.remove('dark-preload');
  updateThemeLabel();
}
applyTheme();

function toggleTheme() {
  const isDark = document.body.classList.toggle('dark');
  localStorage.setItem('theme', isDark ? 'dark' : 'light');
  updateThemeLabel();
}

function updateThemeLabel() {
  const btn = document.getElementById('themeToggle');
  if (!btn) return;
  btn.textContent = document.body.classList.contains('dark') ? 'Light' : 'Dark';
}

// ---------- Toast ----------
function toast(msg, type = 'success') {
  const wrap = document.getElementById('toastWrap');
  if (!wrap) { alert(msg); return; }
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

// ============================================================
// LOGIN / REGISTER PAGE
// ============================================================
if (document.getElementById('loginForm')) {
  const loginForm = document.getElementById('loginForm');
  const registerForm = document.getElementById('registerForm');
  const msg = document.getElementById('authMsg');

  document.querySelectorAll('.tab').forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      const target = tab.dataset.tab;
      loginForm.classList.toggle('hidden', target !== 'login');
      registerForm.classList.toggle('hidden', target !== 'register');
      msg.textContent = '';
    });
  });

  loginForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const data = Object.fromEntries(new FormData(loginForm));
    const res = await fetch('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data)
    });
    const json = await res.json();
    if (res.ok) {
      msg.className = 'msg success';
      msg.textContent = 'Signing in…';
      location.href = 'dashboard.html';
    } else {
      msg.className = 'msg error';
      msg.textContent = json.error || 'Sign in failed';
    }
  });

  registerForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const data = Object.fromEntries(new FormData(registerForm));
    const res = await fetch('/api/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data)
    });
    const json = await res.json();
    if (res.ok) location.href = 'dashboard.html';
    else {
      msg.className = 'msg error';
      msg.textContent = json.error || 'Registration failed';
    }
  });

  // ─────────────────────────────────────────────
  // Searchable Course Picker (register form)
  // ─────────────────────────────────────────────
  (function initCoursePicker() {
    const input = document.getElementById('reg-course');
    const dropdown = document.getElementById('courseDropdown');
    const picker = document.getElementById('coursePicker');
    if (!input || !dropdown || !picker) return;

    let courses = [];
    let filtered = [];
    let highlightedIndex = -1;

    fetch('/api/public/courses')
      .then(r => r.json())
      .then(data => {
        courses = Array.isArray(data) ? data.map(c =>
          typeof c === 'string' ? { code: '', title: c, category: 'Courses' } : c
        ) : [];
      })
      .catch(err => {
        console.error('Course load failed:', err);
        courses = [];
      });

    function escapeHtml(s) {
      return String(s ?? '').replace(/[&<>"']/g, c => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
      }[c]));
    }

    function renderOptions() {
      if (!filtered.length) {
        dropdown.innerHTML = '<div class="course-picker-empty">No courses match your search</div>';
        return;
      }

      const grouped = {};
      filtered.forEach(c => {
        const cat = c.category || 'Courses';
        if (!grouped[cat]) grouped[cat] = [];
        grouped[cat].push(c);
      });

      let html = '';
      let idx = 0;
      Object.entries(grouped).forEach(([category, items]) => {
        html += `<div class="course-picker-group">${escapeHtml(category)}</div>`;
        items.forEach(c => {
          const isSelected = input.value === c.title;
          html += `
            <div class="course-picker-option${idx === highlightedIndex ? ' highlighted' : ''}${isSelected ? ' selected' : ''}"
                 data-index="${idx}"
                 data-value="${escapeHtml(c.title)}">
              <span>${escapeHtml(c.title)}</span>
              ${c.code ? `<span class="course-picker-code">${escapeHtml(c.code)}</span>` : ''}
            </div>`;
          idx++;
        });
      });
      dropdown.innerHTML = html;
    }

    function filterCourses(query) {
      const q = (query || '').trim().toLowerCase();
      if (!q) {
        filtered = courses.slice(0, 50);
      } else {
        filtered = courses
          .map(c => {
            const title = c.title.toLowerCase();
            const code = (c.code || '').toLowerCase();
            let score = 0;
            if (title.startsWith(q) || code.startsWith(q)) score = 100;
            else if (title.includes(q) || code.includes(q)) score = 50;
            return { course: c, score };
          })
          .filter(x => x.score > 0)
          .sort((a, b) => b.score - a.score)
          .slice(0, 30)
          .map(x => x.course);
      }
      highlightedIndex = -1;
      renderOptions();
    }

    input.addEventListener('focus', () => {
      filterCourses(input.value);
      dropdown.classList.remove('hidden');
    });
    input.addEventListener('input', () => {
      filterCourses(input.value);
      dropdown.classList.remove('hidden');
    });

    input.addEventListener('keydown', (e) => {
      const options = dropdown.querySelectorAll('.course-picker-option');
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        if (!options.length) return;
        highlightedIndex = Math.min(highlightedIndex + 1, options.length - 1);
        renderOptions();
        dropdown.querySelector('.highlighted')?.scrollIntoView({ block: 'nearest' });
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        if (!options.length) return;
        highlightedIndex = Math.max(highlightedIndex - 1, 0);
        renderOptions();
        dropdown.querySelector('.highlighted')?.scrollIntoView({ block: 'nearest' });
      } else if (e.key === 'Enter') {
        if (highlightedIndex >= 0 && options[highlightedIndex]) {
          e.preventDefault();
          input.value = options[highlightedIndex].dataset.value;
          dropdown.classList.add('hidden');
        }
      } else if (e.key === 'Escape') {
        dropdown.classList.add('hidden');
      }
    });

    dropdown.addEventListener('mousedown', e => e.preventDefault());
    dropdown.addEventListener('click', e => {
      const opt = e.target.closest('.course-picker-option');
      if (!opt) return;
      input.value = opt.dataset.value;
      dropdown.classList.add('hidden');
    });

    document.addEventListener('click', e => {
      if (!picker.contains(e.target)) dropdown.classList.add('hidden');
    });
  })();
}

// ============================================================
// DASHBOARD
// ============================================================
if (document.getElementById('announcements')) {
  const themeBtn = document.getElementById('themeToggle');
  if (themeBtn) themeBtn.addEventListener('click', toggleTheme);

  loadDashboard();
}

async function loadDashboard() {
  const meRes = await fetch('/api/me');
  if (!meRes.ok) return (location.href = 'login.html');
  const me = await meRes.json();

  document.getElementById('userName').textContent = me.name;
  document.getElementById('welcomeName').textContent = me.name;
  document.getElementById('regNo').textContent = me.reg_no;
  document.getElementById('studentCourse').textContent = me.course;

  document.getElementById('logoutBtn').addEventListener('click', async () => {
    await fetch('/api/logout', { method: 'POST' });
    location.href = 'login.html';
  });

  // ─── Announcements ───
  try {
    const annRes = await fetch('/api/announcements');
    const anns = await annRes.json();
    document.getElementById('announcements').innerHTML = anns.length
      ? anns.map(a => `<li><strong>${esc(a.title)}</strong><p>${esc(a.body)}</p></li>`).join('')
      : '<li style="color:var(--muted);">No announcements at this time.</li>';
  } catch (e) { console.error(e); }

  // ─── Courses ───
  try {
    const courseRes = await fetch('/api/courses');
    const courses = await courseRes.json();

    const courseImageMap = {
      'WD101':  'web.jpg',
      'DB201':  'db.jpg',
      'JS301':  'js.jpg',
      'PY101':  'python.jpg',
      'NET210': 'networking.jpg',
    };

    document.getElementById('courses').innerHTML = courses.map(c => {
      const img = courseImageMap[c.code] || 'web.jpg';
      return `
        <li style="display: flex; gap: 16px; align-items: center; padding: 14px 0;">
          <img
            src="images/courses/${img}"
            alt="${esc(c.title)}"
            style="width: 84px; height: 84px; object-fit: cover; border-radius: 10px; flex-shrink: 0; border: 1px solid var(--border-soft);"
            onerror="this.style.display='none'"
          />
          <div style="flex: 1; min-width: 0;">
            <strong style="display: block; margin-bottom: 4px;">${esc(c.code)} — ${esc(c.title)}</strong>
            <p style="margin: 0 0 6px; font-size: 12px; color: var(--muted);">Trainer: ${esc(c.trainer)}</p>
            ${c.enrolled
              ? '<button class="btn-enroll" disabled>Enrolled ✓</button>'
              : `<button class="btn-enroll" data-id="${c.id}">Enroll</button>`}
          </div>
        </li>`;
    }).join('');

    document.querySelectorAll('.btn-enroll[data-id]').forEach(btn => {
      btn.addEventListener('click', async () => {
        await fetch(`/api/enroll/${btn.dataset.id}`, { method: 'POST' });
        loadDashboard();
      });
    });
  } catch (e) { console.error(e); }

  // ─── Results ───
  try {
    const resRes = await fetch('/api/results');
    const results = await resRes.json();
    document.querySelector('#resultsTable tbody').innerHTML = results.length
      ? results.map(r => `
          <tr>
            <td>${esc(r.code)}</td>
            <td>${esc(r.title)}</td>
            <td>${esc(r.term)}</td>
            <td>${r.marks}</td>
            <td><strong>${esc(r.grade)}</strong></td>
          </tr>
        `).join('')
      : '<tr><td colspan="5" class="empty">No results published yet.</td></tr>';
  } catch (e) { console.error(e); }

  // ─── Fees ───
  try {
    const feeRes = await fetch('/api/my-fees');
    const fees = await feeRes.json();

    const totalDue  = fees.reduce((s, f) => s + Number(f.amount_due), 0);
    const totalPaid = fees.reduce((s, f) => s + Number(f.amount_paid), 0);
    const balance   = totalDue - totalPaid;

    document.getElementById('feesSummary').innerHTML = `
      <div class="fee-summary-grid">
        <div class="fee-summary-item">
          <div class="fee-summary-lbl">Total Due</div>
          <div class="fee-summary-num">KES ${totalDue.toLocaleString()}</div>
        </div>
        <div class="fee-summary-item">
          <div class="fee-summary-lbl">Paid</div>
          <div class="fee-summary-num success">KES ${totalPaid.toLocaleString()}</div>
        </div>
        <div class="fee-summary-item">
          <div class="fee-summary-lbl">Balance</div>
          <div class="fee-summary-num ${balance > 0 ? 'danger' : 'success'}">KES ${balance.toLocaleString()}</div>
        </div>
      </div>
      ${balance > 0 ? renderPaymentBox() : ''}
    `;

    document.getElementById('feesList').innerHTML = fees.length
      ? fees.map(f => {
          const bal = Number(f.amount_due) - Number(f.amount_paid);
          const pillCls = f.status === 'paid' ? 'pill-green'
                        : f.status === 'partial' ? 'pill-amber'
                        : 'pill-red';
          return `
            <li>
              <div style="display:flex; justify-content:space-between; align-items:center; gap:12px;">
                <div>
                  <strong>${esc(f.term)}</strong>
                  <p>Due: KES ${Number(f.amount_due).toLocaleString()} &middot; Paid: KES ${Number(f.amount_paid).toLocaleString()}</p>
                </div>
                <span class="pill ${pillCls}">${esc(f.status)}</span>
              </div>
              ${bal > 0 ? `<p style="color:var(--danger); font-size:12px; margin-top:6px;">Outstanding: KES ${bal.toLocaleString()}</p>` : ''}
              ${Number(f.amount_paid) > 0 ? `<button class="btn-xs" onclick="printReceipt(${f.id}, '${esc(f.term)}', ${f.amount_due}, ${f.amount_paid})">Receipt</button>` : ''}
            </li>`;
        }).join('')
      : '<li style="color:var(--muted);">No fee records on file.</li>';
  } catch (e) { console.error('fees load', e); }

  // ─── Attendance ───
  try {
    const attRes = await fetch('/api/my-attendance');
    const att = await attRes.json();

    const summaryHtml = att.summary && att.summary.length ? `
      <div style="display:grid; gap:6px; margin-bottom:12px;">
        ${att.summary.map(s => {
          const rate = s.total ? Math.round((s.present / s.total) * 100) : 0;
          const pillCls = rate >= 75 ? 'pill-green' : rate >= 50 ? 'pill-amber' : 'pill-red';
          return `
            <div style="display:flex; justify-content:space-between; align-items:center; padding:8px 10px; background:var(--bg-alt); border-radius:6px;">
              <div>
                <strong style="font-size:13px;">${esc(s.code)}</strong>
                <div style="font-size:11px; color:var(--muted);">${esc(s.title)}</div>
              </div>
              <span class="pill ${pillCls}">${rate}%</span>
            </div>`;
        }).join('')}
      </div>` : '<p style="color:var(--muted); font-size:13px; margin-bottom:8px;">No attendance records yet.</p>';

    const attSummaryEl = document.getElementById('attendanceSummary');
    if (attSummaryEl) attSummaryEl.innerHTML = summaryHtml;

    const attListEl = document.getElementById('attendanceList');
    if (attListEl) {
      attListEl.innerHTML = att.records && att.records.length
        ? att.records.slice(0, 10).map(r => `
            <li>
              <div style="display:flex; justify-content:space-between; align-items:center; gap:12px;">
                <div>
                  <strong>${esc(r.date)}</strong>
                  <p>${esc(r.code)} — ${esc(r.title)}</p>
                </div>
                <span class="pill ${r.status === 'present' ? 'pill-green' : r.status === 'absent' ? 'pill-red' : 'pill-amber'}">${esc(r.status)}</span>
              </div>
            </li>`).join('')
        : '';
    }
  } catch (e) { console.error('attendance load', e); }

  // ─── Live Classes ───
  try {
    const lcRes = await fetch('/api/my-live-classes');
    const lcs = await lcRes.json();

    const lcEl = document.getElementById('liveClasses');
    if (lcEl) {
      lcEl.innerHTML = lcs.length
        ? lcs.map(c => {
            const pillCls = c.status === 'live' ? 'pill-green' : c.status === 'upcoming' ? 'pill-amber' : 'pill-red';
            const label = c.status === 'live' ? 'LIVE NOW' : c.status.toUpperCase();
            const start = new Date(c.scheduled_at);
            return `
              <li>
                <div style="display:flex; justify-content:space-between; align-items:flex-start; gap:12px; flex-wrap:wrap;">
                  <div>
                    <strong>${esc(c.title)}</strong>
                    <p>${esc(c.code)} — ${esc(c.course_title)}</p>
                    <p style="font-size:12px; color:var(--muted);">${start.toLocaleString()} &middot; ${c.duration_minutes} min</p>
                  </div>
                  <div style="text-align:right;">
                    <span class="pill ${pillCls}">${label}</span>
                    ${c.status !== 'ended' ? `<div style="margin-top:6px;"><a class="btn-enroll" href="${esc(c.meeting_url)}" target="_blank" rel="noopener" style="text-decoration:none; display:inline-block;">Join</a></div>` : ''}
                  </div>
                </div>
              </li>`;
          }).join('')
        : '<li style="color:var(--muted);">No live classes scheduled.</li>';
    }
  } catch (e) { console.error('live classes load', e); }

  // ─── Timetable ───
  try {
    const ttRes = await fetch('/api/my-timetable');
    const tt = await ttRes.json();
    document.getElementById('timetable').innerHTML = tt.length
      ? tt.map(t => `
          <li>
            <strong>${esc(t.day)} &middot; ${esc(t.start_time)}&ndash;${esc(t.end_time)}</strong>
            <p>${esc(t.code)} &mdash; ${esc(t.title)}</p>
            <p style="font-size:12px;">Room: ${esc(t.room || 'TBA')} &middot; Trainer: ${esc(t.trainer || 'TBA')}</p>
          </li>`).join('')
      : '<li style="color:var(--muted);">No classes scheduled.</li>';
  } catch (e) { console.error('timetable load', e); }

  // ─── Assignments ───
  try {
    const asgRes = await fetch('/api/my-assignments');
    const asg = await asgRes.json();
    document.getElementById('assignments').innerHTML = asg.length
      ? asg.map(a => `
          <li>
            <div style="display:flex; justify-content:space-between; gap:12px; flex-wrap:wrap;">
              <div>
                <strong>${esc(a.title)}</strong>
                <p>${esc(a.code)} &mdash; ${esc(a.title)}</p>
              </div>
              <div style="text-align:right;">
                ${a.grade
                  ? `<span class="pill pill-green">Graded: ${esc(a.grade)}</span>`
                  : a.submission_id
                    ? '<span class="pill pill-amber">Submitted</span>'
                    : '<span class="pill pill-red">Not submitted</span>'}
                <p style="font-size:12px; color:var(--muted); margin-top:4px;">
                  Due: ${esc(a.due_date || 'Not set')}
                </p>
              </div>
            </div>
            <div style="margin-top:8px;">
              <button class="btn-xs" onclick="submitAssignment(${a.id})">
                ${a.submission_id ? 'Update Submission' : 'Submit'}
              </button>
            </div>
          </li>`).join('')
      : '<li style="color:var(--muted);">No assignments posted.</li>';
  } catch (e) { console.error('assignments load', e); }

  // ─── Study Materials (time-locked) ───
  try {
    const matRes = await fetch('/api/my-materials');
    const materials = await matRes.json();

    const matEl = document.getElementById('materialsList');
    if (matEl) {
      matEl.innerHTML = materials.length
        ? materials.map(m => {
            if (!m.unlocked) {
              return `
                <li style="opacity: 0.7;">
                  <div style="display: flex; justify-content: space-between; gap: 12px; align-items: flex-start;">
                    <div style="flex: 1;">
                      <strong>🔒 ${esc(m.title)}</strong>
                      <p style="color: var(--muted); font-size: 12px; margin-top: 3px;">
                        ${esc(m.code)} — ${esc(m.course_title)}
                      </p>
                      <p style="color: var(--warning); font-size: 12px; margin-top: 6px; font-weight: 600;">
                        Unlocks ${esc(m.release_date_formatted)}
                      </p>
                    </div>
                    <span class="pill pill-amber">Locked</span>
                  </div>
                </li>`;
            }
            const links = [];
            if (m.file_path) links.push(`<a href="${esc(m.file_path)}" target="_blank" class="btn-xs" style="text-decoration:none; display:inline-block;">📎 Open File</a>`);
            if (m.external_url) links.push(`<a href="${esc(m.external_url)}" target="_blank" class="btn-xs" style="text-decoration:none; display:inline-block;">🔗 Open Link</a>`);

            return `
              <li>
                <div style="display: flex; justify-content: space-between; gap: 12px; align-items: flex-start; flex-wrap: wrap;">
                  <div style="flex: 1; min-width: 200px;">
                    <strong>${esc(m.title)}</strong>
                    <p style="color: var(--muted); font-size: 12px; margin-top: 3px;">
                      ${esc(m.code)} — ${esc(m.course_title)}
                    </p>
                    ${m.description ? `<p style="color: var(--text-soft); font-size: 13px; margin-top: 6px;">${esc(m.description)}</p>` : ''}
                    <div style="margin-top: 10px; display: flex; gap: 8px; flex-wrap: wrap;">
                      ${links.join('')}
                    </div>
                  </div>
                  <span class="pill ${m.isToday ? 'pill-green' : 'pill-green'}">${m.isToday ? 'Today' : 'Available'}</span>
                </div>
              </li>`;
          }).join('')
        : '<li style="color: var(--muted);">No materials posted yet.</li>';
    }
  } catch (e) { console.error('materials load', e); }

  // ─── Transcript Download ───
  const dlBtn = document.getElementById('downloadTranscriptBtn');
  if (dlBtn) {
    dlBtn.addEventListener('click', async () => {
      try {
        const res = await fetch('/api/my-transcript');
        if (!res.ok) throw new Error('Failed to load transcript');
        const data = await res.json();
        generateTranscriptHTML(data);
      } catch (e) {
        toast('Could not generate transcript: ' + e.message, 'error');
      }
    });
  }
}

// ============================================================
// PAYMENT DETAILS (KCB)
// ============================================================
const PAYMENT = {
  bank: 'KCB Bank Kenya',
  paybill: '522522',
  account: '1279021640',
  name: 'HERALD TRAINER AND CONSULTANT'
};

function renderPaymentBox() {
  return `
    <div class="payment-box">
      <div class="payment-box-head">
        <span class="payment-box-title">Payment Instructions</span>
        <span class="payment-box-bank">${PAYMENT.bank}</span>
      </div>
      <div class="payment-grid">
        <div class="payment-field">
          <span class="payment-field-lbl">Paybill Number</span>
          <span class="payment-field-val paybill">${PAYMENT.paybill}</span>
        </div>
        <div class="payment-field">
          <span class="payment-field-lbl">Account Number</span>
          <span class="payment-field-val">${PAYMENT.account}</span>
        </div>
        <div class="payment-field">
          <span class="payment-field-lbl">Account Name</span>
          <span class="payment-field-val" style="font-size:12px; letter-spacing:0.01em;">${PAYMENT.name}</span>
        </div>
      </div>
      <div class="payment-note">
        Use your <strong>registration number</strong> as the payment reference where required.
        Retain your M-Pesa confirmation SMS as proof of payment.
      </div>
    </div>`;
}

// ============================================================
// FEE RECEIPT (printable)
// ============================================================
function printReceipt(feeId, term, due, paid) {
  const balance = Number(due) - Number(paid);
  const win = window.open('', '_blank', 'width=460,height=720');
  win.document.write(`
    <!DOCTYPE html>
    <html>
    <head>
      <title>Fee Receipt &mdash; ${esc(term)}</title>
      <style>
        * { box-sizing: border-box; margin: 0; padding: 0; }
        body { font-family: 'Inter', -apple-system, sans-serif; padding: 32px 28px; max-width: 400px; margin: auto; color: #1a1f2e; font-size: 12.5px; line-height: 1.5; }
        .letterhead { text-align: center; padding-bottom: 16px; border-bottom: 3px double #1a1f2e; margin-bottom: 20px; }
        .letterhead h1 { font-size: 14px; font-weight: 700; letter-spacing: 0.04em; text-transform: uppercase; margin-bottom: 4px; }
        .letterhead .tagline { font-size: 10px; color: #6b7280; text-transform: uppercase; letter-spacing: 0.12em; }
        .doc-title { text-align: center; font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.15em; color: #6b7280; margin-bottom: 20px; }
        .row { display: flex; justify-content: space-between; padding: 7px 0; border-bottom: 1px solid #e5e8ed; }
        .row .lbl { color: #6b7280; font-size: 10px; text-transform: uppercase; letter-spacing: 0.06em; font-weight: 600; }
        .row .val { font-weight: 500; font-family: 'SF Mono', Menlo, monospace; font-size: 12px; }
        .section-lbl { font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.1em; color: #6b7280; margin: 20px 0 8px; padding-bottom: 6px; border-bottom: 1px solid #e5e8ed; }
        .row.total { border-top: 2px solid #1a1f2e; border-bottom: 2px solid #1a1f2e; margin-top: 8px; font-weight: 700; padding: 10px 0; font-size: 13px; }
        .payment-block { background: #f5f6f8; border-left: 3px solid #b8860b; padding: 12px 14px; margin-top: 20px; border-radius: 3px; }
        .payment-block .pb-title { font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.1em; color: #b8860b; margin-bottom: 8px; }
        .payment-block .pb-row { display: flex; justify-content: space-between; font-size: 11.5px; padding: 3px 0; }
        .payment-block .pb-row .lbl { color: #6b7280; font-size: 10px; text-transform: uppercase; letter-spacing: 0.05em; font-weight: 600; }
        .payment-block .pb-row .val { font-family: 'SF Mono', Menlo, monospace; font-weight: 700; color: #1a1f2e; }
        .footer { text-align: center; font-size: 10.5px; color: #6b7280; margin-top: 24px; padding-top: 16px; border-top: 1px solid #e5e8ed; line-height: 1.6; }
        @media print { body { padding: 16px; } }
      </style>
    </head>
    <body>
      <div class="letterhead">
        <h1>Herald Trainer and Consultant</h1>
        <div class="tagline">Training &middot; Consulting &middot; Excellence</div>
      </div>
      <div class="doc-title">Official Fee Receipt</div>
      <div class="row"><span class="lbl">Receipt No.</span><span class="val">HR-${String(feeId).padStart(5, '0')}</span></div>
      <div class="row"><span class="lbl">Date Issued</span><span class="val">${new Date().toLocaleDateString()}</span></div>
      <div class="row"><span class="lbl">Term</span><span class="val">${esc(term)}</span></div>
      <div class="section-lbl">Fee Breakdown</div>
      <div class="row"><span class="lbl">Amount Due</span><span class="val">KES ${Number(due).toLocaleString()}</span></div>
      <div class="row"><span class="lbl">Amount Paid</span><span class="val">KES ${Number(paid).toLocaleString()}</span></div>
      <div class="row total"><span class="lbl">Balance</span><span class="val">KES ${balance.toLocaleString()}</span></div>
      <div class="payment-block">
        <div class="pb-title">Payment Details</div>
        <div class="pb-row"><span class="lbl">Bank</span><span class="val">KCB Bank Kenya</span></div>
        <div class="pb-row"><span class="lbl">Paybill No.</span><span class="val">522522</span></div>
        <div class="pb-row"><span class="lbl">Account No.</span><span class="val">1279021640</span></div>
        <div class="pb-row"><span class="lbl">Account Name</span><span class="val" style="font-size:10.5px;">HERALD TRAINER AND CONSULTANT</span></div>
      </div>
      <div class="footer">
        <strong>Thank you for your payment.</strong><br>
        This is a computer-generated receipt and does not require a signature.
      </div>
      <script>window.onload = () => window.print();<\/script>
    </body>
    </html>`);
  win.document.close();
}

// ============================================================
// ASSIGNMENT SUBMISSION
// ============================================================
function submitAssignment(assignmentId) {
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal" style="max-width:520px;">
      <h3>Submit Assignment</h3>
      <form id="uploadForm" class="modal-form" enctype="multipart/form-data">
        <label for="sub-content">Submission Notes (optional)</label>
        <textarea id="sub-content" name="content" rows="4" placeholder="Add any notes or comments..."></textarea>

        <label>PDF File (max 10MB)</label>
        <label class="file-upload" id="fileDrop" for="fileInput">
          <div class="file-upload-icon">Click to upload or drag &amp; drop</div>
          <div class="file-upload-hint">Only PDF files &middot; Max 10 MB</div>
          <div class="file-upload-filename" id="fileName" style="display:none;"></div>
          <input type="file" id="fileInput" name="file" accept="application/pdf,.pdf" />
        </label>
      </form>
      <div class="modal-actions">
        <button class="btn-ghost dark" type="button" data-cancel>Cancel</button>
        <button class="btn-primary" type="submit" form="uploadForm">Submit</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);

  const form = overlay.querySelector('#uploadForm');
  const fileInput = overlay.querySelector('#fileInput');
  const fileDrop = overlay.querySelector('#fileDrop');
  const fileNameEl = overlay.querySelector('#fileName');

  fileInput.addEventListener('change', () => {
    const f = fileInput.files[0];
    if (!f) return;
    if (f.type !== 'application/pdf' && !f.name.toLowerCase().endsWith('.pdf')) {
      alert('Only PDF files are allowed.');
      fileInput.value = '';
      return;
    }
    if (f.size > 10 * 1024 * 1024) {
      alert('File is too large. Maximum size is 10 MB.');
      fileInput.value = '';
      return;
    }
    fileNameEl.textContent = f.name;
    fileNameEl.style.display = 'block';
    fileDrop.classList.add('has-file');
    fileDrop.querySelector('.file-upload-icon').textContent = 'File attached';
  });

  overlay.addEventListener('click', e => {
    if (e.target === overlay || e.target.closest('[data-cancel]')) overlay.remove();
  });

  form.addEventListener('submit', async e => {
    e.preventDefault();
    const submitBtn = overlay.querySelector('button[type="submit"][form="uploadForm"]');
    submitBtn.classList.add('btn-loading');
    submitBtn.disabled = true;

    try {
      const fd = new FormData(form);
      const res = await fetch(`/api/submit/${assignmentId}`, {
        method: 'POST',
        body: fd
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || 'Submission failed');
      }
      overlay.remove();
      toast('Assignment submitted successfully.');
      setTimeout(() => location.reload(), 800);
    } catch (err) {
      submitBtn.classList.remove('btn-loading');
      submitBtn.disabled = false;
      toast(err.message, 'error');
    }
  });
}

// ============================================================
// TRANSCRIPT GENERATION
// ============================================================
function generateTranscriptHTML(data) {
  const { student, byTerm, summary } = data;

  const termSections = Object.entries(byTerm).map(([term, items]) => `
    <div style="margin-bottom: 24px;">
      <h3 style="font-size: 13px; text-transform: uppercase; letter-spacing: 0.08em; color: #0b1a33; padding-bottom: 8px; border-bottom: 2px solid #b8860b; margin-bottom: 12px;">
        ${esc(term)}
      </h3>
      <table style="width: 100%; border-collapse: collapse; font-size: 13px;">
        <thead>
          <tr>
            <th style="text-align: left; padding: 8px 6px; border-bottom: 1px solid #e5e8ed; color: #6b7280; font-size: 11px; text-transform: uppercase;">Code</th>
            <th style="text-align: left; padding: 8px 6px; border-bottom: 1px solid #e5e8ed; color: #6b7280; font-size: 11px; text-transform: uppercase;">Unit / Course</th>
            <th style="text-align: center; padding: 8px 6px; border-bottom: 1px solid #e5e8ed; color: #6b7280; font-size: 11px; text-transform: uppercase;">Marks</th>
            <th style="text-align: center; padding: 8px 6px; border-bottom: 1px solid #e5e8ed; color: #6b7280; font-size: 11px; text-transform: uppercase;">Grade</th>
          </tr>
        </thead>
        <tbody>
          ${items.map(r => `
            <tr>
              <td style="padding: 10px 6px; border-bottom: 1px solid #f0f0f0; font-family: 'Courier New', monospace; font-weight: 600;">${esc(r.course_code)}</td>
              <td style="padding: 10px 6px; border-bottom: 1px solid #f0f0f0;">${esc(r.course_title)}</td>
              <td style="padding: 10px 6px; border-bottom: 1px solid #f0f0f0; text-align: center;">${r.marks}</td>
              <td style="padding: 10px 6px; border-bottom: 1px solid #f0f0f0; text-align: center; font-weight: 700; color: ${r.grade.startsWith('A') ? '#15803d' : r.grade.startsWith('B') ? '#0b1a33' : '#a16207'};">${esc(r.grade)}</td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    </div>
  `).join('');

  const win = window.open('', '_blank');
  win.document.write(`
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="utf-8" />
      <title>Academic Transcript — ${esc(student.name)}</title>
      <style>
        * { box-sizing: border-box; margin: 0; padding: 0; }
        body {
          font-family: 'Inter', -apple-system, sans-serif;
          padding: 40px 32px;
          max-width: 820px;
          margin: auto;
          color: #1a1f2e;
          line-height: 1.5;
        }
        .letterhead {
          text-align: center;
          padding-bottom: 24px;
          border-bottom: 4px double #0b1a33;
          margin-bottom: 24px;
        }
        .letterhead h1 {
          font-size: 22px;
          font-weight: 800;
          letter-spacing: 0.04em;
          color: #0b1a33;
          margin-bottom: 6px;
        }
        .letterhead .sub {
          font-size: 11px;
          text-transform: uppercase;
          letter-spacing: 0.15em;
          color: #6b7280;
          font-weight: 600;
        }
        .doc-title {
          text-align: center;
          font-size: 15px;
          font-weight: 800;
          text-transform: uppercase;
          letter-spacing: 0.15em;
          color: #0b1a33;
          margin: 24px 0 32px;
          padding: 12px;
          background: #f5f6f8;
          border-radius: 8px;
        }
        .student-info {
          display: grid;
          grid-template-columns: 1fr 1fr;
          gap: 14px 32px;
          margin-bottom: 32px;
          padding: 20px;
          background: #f9fafb;
          border-left: 4px solid #b8860b;
          border-radius: 6px;
        }
        .info-row { display: flex; flex-direction: column; gap: 3px; }
        .info-lbl {
          font-size: 10px;
          text-transform: uppercase;
          letter-spacing: 0.1em;
          color: #94a3b8;
          font-weight: 700;
        }
        .info-val { font-size: 14px; font-weight: 600; color: #0b1a33; }
        .summary {
          display: grid;
          grid-template-columns: 1fr 1fr 1fr;
          gap: 16px;
          margin: 32px 0;
        }
        .summary-item {
          text-align: center;
          padding: 20px;
          background: linear-gradient(135deg, #f9fafb, #f0f3f7);
          border-radius: 10px;
          border: 1px solid #e5e8ed;
        }
        .summary-lbl {
          font-size: 10px;
          text-transform: uppercase;
          letter-spacing: 0.1em;
          color: #6b7280;
          font-weight: 700;
          margin-bottom: 8px;
        }
        .summary-val {
          font-size: 26px;
          font-weight: 800;
          color: #0b1a33;
          font-family: 'SF Mono', 'Monaco', monospace;
        }
        .footer {
          margin-top: 48px;
          padding-top: 24px;
          border-top: 1px solid #e5e8ed;
          text-align: center;
          font-size: 11px;
          color: #6b7280;
          line-height: 1.7;
        }
        .seal {
          display: inline-block;
          padding: 12px 24px;
          border: 2px dashed #b8860b;
          border-radius: 8px;
          color: #b8860b;
          font-weight: 700;
          font-size: 12px;
          letter-spacing: 0.1em;
          text-transform: uppercase;
          margin-bottom: 16px;
        }
        @media print {
          body { padding: 20px; }
          .no-print { display: none; }
        }
        .no-print-bar {
          position: fixed;
          top: 0; left: 0; right: 0;
          background: #0b1a33;
          color: white;
          padding: 12px 20px;
          text-align: center;
          font-size: 14px;
          z-index: 100;
          box-shadow: 0 2px 12px rgba(0,0,0,0.2);
        }
        .no-print-bar button {
          background: #b8860b;
          color: white;
          border: none;
          padding: 8px 20px;
          border-radius: 6px;
          font-weight: 700;
          cursor: pointer;
          margin-left: 16px;
          font-family: inherit;
        }
        .no-print-bar button:hover { background: #d4a017; }
      </style>
    </head>
    <body>
      <div class="no-print-bar">
        📄 Your transcript is ready.
        <button onclick="window.print()">Print / Save as PDF</button>
      </div>
      <div style="height: 60px;"></div>

      <div class="letterhead">
        <h1>HERALD TRAINER AND CONSULTANT</h1>
        <div class="sub">Skills · Knowledge · Better Futures</div>
      </div>

      <div class="doc-title">Official Academic Transcript</div>

      <div class="student-info">
        <div class="info-row">
          <span class="info-lbl">Student Name</span>
          <span class="info-val">${esc(student.name)}</span>
        </div>
        <div class="info-row">
          <span class="info-lbl">Registration Number</span>
          <span class="info-val">${esc(student.reg_no)}</span>
        </div>
        <div class="info-row">
          <span class="info-lbl">Program</span>
          <span class="info-val">${esc(student.course)}</span>
        </div>
        <div class="info-row">
          <span class="info-lbl">Email</span>
          <span class="info-val">${esc(student.email)}</span>
        </div>
      </div>

      ${termSections || '<p style="text-align:center; color:#6b7280; padding:40px;">No results recorded yet.</p>'}

      <div class="summary">
        <div class="summary-item">
          <div class="summary-lbl">Total Units</div>
          <div class="summary-val">${summary.totalUnits}</div>
        </div>
        <div class="summary-item">
          <div class="summary-lbl">Cumulative GPA</div>
          <div class="summary-val">${summary.gpa}</div>
        </div>
        <div class="summary-item">
          <div class="summary-lbl">Date Generated</div>
          <div class="summary-val" style="font-size:16px;">${new Date(summary.generated_at).toLocaleDateString()}</div>
        </div>
      </div>

      <div class="footer">
        <div class="seal">Official Transcript</div>
        <div>This is a computer-generated transcript and does not require a signature.</div>
        <div>For verification, contact sidzac33@gmail.com or +254 796 071 997</div>
        <div style="margin-top: 8px; color: #94a3b8;">Herald Trainer and Consultant · Mombasa, Kenya</div>
      </div>
    </body>
    </html>
  `);
  win.document.close();
}

// ============================================================
// AUTO-LOGOUT AFTER 30 MIN INACTIVITY
// ============================================================
(function autoLogout() {
  if (!document.getElementById('userName')) return;
  const TIMEOUT = 30 * 60 * 1000;
  let timer;
  function reset() {
    clearTimeout(timer);
    timer = setTimeout(() => {
      fetch('/api/logout', { method: 'POST' })
        .catch(() => {})
        .finally(() => location.href = 'login.html');
    }, TIMEOUT);
  }
  ['click', 'keypress', 'scroll', 'mousemove'].forEach(ev =>
    document.addEventListener(ev, reset, { passive: true })
  );
  reset();
})();