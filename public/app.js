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
}
applyTheme();

function toggleTheme() {
  const isDark = document.body.classList.toggle('dark');
  localStorage.setItem('theme', isDark ? 'dark' : 'light');
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

// ---------- LOGIN / REGISTER PAGE ----------
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
      msg.textContent = 'Login successful. Redirecting…';
      location.href = 'dashboard.html';
    } else {
      msg.className = 'msg error';
      msg.textContent = json.error || 'Login failed';
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
}

// ---------- DASHBOARD ----------
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

  // Announcements
  try {
    const annRes = await fetch('/api/announcements');
    const anns = await annRes.json();
    document.getElementById('announcements').innerHTML = anns.length
      ? anns.map(a => `<li><strong>${esc(a.title)}</strong><p>${esc(a.body)}</p></li>`).join('')
      : '<li style="color:var(--muted);">No announcements yet.</li>';
  } catch (e) { console.error(e); }

  // Courses
  try {
    const courseRes = await fetch('/api/courses');
    const courses = await courseRes.json();
    document.getElementById('courses').innerHTML = courses.map(c => `
      <li>
        <strong>${esc(c.code)} — ${esc(c.title)}</strong>
        <p>Trainer: ${esc(c.trainer)}</p>
        ${c.enrolled
          ? '<button class="btn-enroll" disabled>Enrolled ✓</button>'
          : `<button class="btn-enroll" data-id="${c.id}">Enroll</button>`}
      </li>
    `).join('');

    document.querySelectorAll('.btn-enroll[data-id]').forEach(btn => {
      btn.addEventListener('click', async () => {
        await fetch(`/api/enroll/${btn.dataset.id}`, { method: 'POST' });
        loadDashboard();
      });
    });
  } catch (e) { console.error(e); }

  // Results
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
      : '<tr><td colspan="5" style="text-align:center;color:var(--muted);">No results yet.</td></tr>';
  } catch (e) { console.error(e); }

  // ---------- Fees ----------
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
      </div>`;

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
                  <p>Due: KES ${Number(f.amount_due).toLocaleString()} • Paid: KES ${Number(f.amount_paid).toLocaleString()}</p>
                </div>
                <span class="pill ${pillCls}">${esc(f.status)}</span>
              </div>
              ${bal > 0 ? `<p style="color:var(--danger); font-size:12px; margin-top:6px;">Outstanding: KES ${bal.toLocaleString()}</p>` : ''}
              ${Number(f.amount_paid) > 0 ? `<button class="btn-xs" onclick="printReceipt(${f.id}, '${esc(f.term)}', ${f.amount_due}, ${f.amount_paid})">🧾 Receipt</button>` : ''}
            </li>`;
        }).join('')
      : '<li style="color:var(--muted);">No fee records yet.</li>';
  } catch (e) { console.error('fees load', e); }

  // ---------- Timetable ----------
  try {
    const ttRes = await fetch('/api/my-timetable');
    const tt = await ttRes.json();
    document.getElementById('timetable').innerHTML = tt.length
      ? tt.map(t => `
          <li>
            <strong>${esc(t.day)} • ${esc(t.start_time)}–${esc(t.end_time)}</strong>
            <p>${esc(t.code)} — ${esc(t.title)}</p>
            <p style="font-size:12px;">📍 ${esc(t.room || 'TBA')} • 👤 ${esc(t.trainer || 'TBA')}</p>
          </li>`).join('')
      : '<li style="color:var(--muted);">No classes scheduled.</li>';
  } catch (e) { console.error('timetable load', e); }

  // ---------- Assignments ----------
  try {
    const asgRes = await fetch('/api/my-assignments');
    const asg = await asgRes.json();
    document.getElementById('assignments').innerHTML = asg.length
      ? asg.map(a => `
          <li>
            <div style="display:flex; justify-content:space-between; gap:12px; flex-wrap:wrap;">
              <div>
                <strong>${esc(a.title)}</strong>
                <p>${esc(a.code)} — ${esc(a.title)}</p>
              </div>
              <div style="text-align:right;">
                ${a.grade
                  ? `<span class="pill pill-green">Graded: ${esc(a.grade)}</span>`
                  : a.submission_id
                    ? '<span class="pill pill-amber">Submitted</span>'
                    : '<span class="pill pill-red">Not submitted</span>'}
                <p style="font-size:12px; color:var(--muted); margin-top:4px;">
                  Due: ${esc(a.due_date || 'N/A')}
                </p>
              </div>
            </div>
            <div style="margin-top:8px;">
              <button class="btn-xs" onclick="submitAssignment(${a.id})">
                ${a.submission_id ? 'Edit Submission' : 'Submit'}
              </button>
            </div>
          </li>`).join('')
      : '<li style="color:var(--muted);">No assignments yet.</li>';
  } catch (e) { console.error('assignments load', e); }
}

// ---------- Fee receipt (printable) ----------
function printReceipt(feeId, term, due, paid) {
  const balance = Number(due) - Number(paid);
  const win = window.open('', '_blank', 'width=420,height=600');
  win.document.write(`
    <!DOCTYPE html>
    <html>
    <head>
      <title>Receipt — ${esc(term)}</title>
      <style>
        body { font-family: 'Courier New', monospace; padding: 24px; max-width: 340px; margin: auto; }
        h1 { text-align: center; font-size: 18px; margin-bottom: 4px; }
        .sub { text-align: center; color: #666; font-size: 12px; margin-bottom: 20px; }
        .row { display: flex; justify-content: space-between; padding: 6px 0; border-bottom: 1px dashed #ccc; }
        .row.total { border-top: 2px solid #000; border-bottom: 2px solid #000; margin-top: 8px; font-weight: bold; }
        .footer { text-align: center; font-size: 11px; color: #666; margin-top: 24px; }
        @media print { body { padding: 0; } }
      </style>
    </head>
    <body>
      <h1>🎓 HERALD TRAINER CONSULTANT</h1>
      <div class="sub">Official Fee Receipt</div>
      <div class="row"><span>Receipt #</span><span>HR-${String(feeId).padStart(5, '0')}</span></div>
      <div class="row"><span>Date</span><span>${new Date().toLocaleDateString()}</span></div>
      <div class="row"><span>Term</span><span>${esc(term)}</span></div>
      <hr style="margin: 12px 0;">
      <div class="row"><span>Amount Due</span><span>KES ${Number(due).toLocaleString()}</span></div>
      <div class="row"><span>Amount Paid</span><span>KES ${Number(paid).toLocaleString()}</span></div>
      <div class="row total"><span>Balance</span><span>KES ${balance.toLocaleString()}</span></div>
      <div class="footer">
        Thank you for your payment.<br>
        This is a computer-generated receipt.
      </div>
      <script>window.onload = () => window.print();<\/script>
    </body>
    </html>`);
  win.document.close();
}

// ---------- Assignment submission ----------
async function submitAssignment(assignmentId) {
  const content = prompt('Enter your submission (text/answer):');
  if (content === null) return;
  if (!content.trim()) return alert('Submission cannot be empty');
  try {
    const res = await fetch(`/api/submit/${assignmentId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content })
    });
    if (!res.ok) throw new Error('Failed');
    toast('✅ Submitted successfully!');
    setTimeout(() => location.reload(), 800);
  } catch (e) {
    toast('❌ ' + e.message, 'error');
  }
  // ---------- Auto-logout after 30 min inactivity ----------
(function autoLogout() {
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
}
