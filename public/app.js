const isLoginPage = location.pathname.endsWith('login.html') ||
                    location.pathname === '/' ||
                    location.pathname.endsWith('/');

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

// ---------- DASHBOARD PAGE ----------
if (document.getElementById('announcements')) {
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
  const annRes = await fetch('/api/announcements');
  const anns = await annRes.json();
  document.getElementById('announcements').innerHTML = anns.length
    ? anns.map(a => `<li><strong>${esc(a.title)}</strong><p>${esc(a.body)}</p></li>`).join('')
    : '<li>No announcements yet.</li>';

  // Courses
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

  // Results
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
    : '<tr><td colspan="5" style="text-align:center;color:#64748b;">No results yet.</td></tr>';
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}