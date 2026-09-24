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
      : '<li style="color:var(--muted);">No announcements at this time.</li>';
  } catch (e) { console.error(e); }

  // Courses
  try {
    const courseRes = await fetch('/api/courses');
    const courses = await courseRes.json();
    document.getElementById('courses').innerHTML = courses.map(c => `
      <li>
        <strong>${esc(c.code)} &mdash; ${esc(c.title)}</strong>
        <p>Trainer: ${esc(c.trainer)}</p>
        ${c.enrolled
          ? '<button class="btn-enroll" disabled>Enrolled</button>'
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
      : '<tr><td colspan="5" class="empty">No results published yet.</td></tr>';
  } catch (e) { console.error(e); }

    // Fees
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

  // Timetable
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

  // Assignments
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
                        <div style="margin-top:8px; display:flex; gap:8px; flex-wrap:wrap; align-items:center;">
              <button class="btn-xs" onclick="submitAssignment(${a.id})">
                ${a.submission_id ? 'Update Submission' : 'Submit'}
              </button>
              ${a.submission_id
                ? `<a class="pdf-link" href="/api/submission/${a.submission_id}/file" target="_blank" rel="noopener">View PDF</a>`
                : ''}
            </div>
          </li>`).join('')
      : '<li style="color:var(--muted);">No assignments posted.</li>';
  } catch (e) { console.error('assignments load', e); }
}

// ---------- Fee receipt (printable) ----------
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
        body {
          font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
          padding: 32px 28px;
          max-width: 400px;
          margin: auto;
          color: #1a1f2e;
          font-size: 12.5px;
          line-height: 1.5;
        }
        .letterhead {
          text-align: center;
          padding-bottom: 16px;
          border-bottom: 3px double #1a1f2e;
          margin-bottom: 20px;
        }
        .letterhead h1 {
          font-size: 14px;
          font-weight: 700;
          letter-spacing: 0.04em;
          text-transform: uppercase;
          margin-bottom: 4px;
        }
        .letterhead .tagline {
          font-size: 10px;
          color: #6b7280;
          text-transform: uppercase;
          letter-spacing: 0.12em;
        }
        .doc-title {
          text-align: center;
          font-size: 11px;
          font-weight: 700;
          text-transform: uppercase;
          letter-spacing: 0.15em;
          color: #6b7280;
          margin-bottom: 20px;
        }
        .row {
          display: flex;
          justify-content: space-between;
          padding: 7px 0;
          border-bottom: 1px solid #e5e8ed;
        }
        .row .lbl {
          color: #6b7280;
          font-size: 10px;
          text-transform: uppercase;
          letter-spacing: 0.06em;
          font-weight: 600;
        }
        .row .val { font-weight: 500; font-family: 'SF Mono', Menlo, monospace; font-size: 12px; }
        .section-lbl {
          font-size: 10px;
          font-weight: 700;
          text-transform: uppercase;
          letter-spacing: 0.1em;
          color: #6b7280;
          margin: 20px 0 8px;
          padding-bottom: 6px;
          border-bottom: 1px solid #e5e8ed;
        }
        .row.total {
          border-top: 2px solid #1a1f2e;
          border-bottom: 2px solid #1a1f2e;
          margin-top: 8px;
          font-weight: 700;
          padding: 10px 0;
          font-size: 13px;
        }
        .row.total .lbl { color: #1a1f2e; }
        .payment-block {
          background: #f5f6f8;
          border-left: 3px solid #b8860b;
          padding: 12px 14px;
          margin-top: 20px;
          border-radius: 3px;
        }
        .payment-block .pb-title {
          font-size: 10px;
          font-weight: 700;
          text-transform: uppercase;
          letter-spacing: 0.1em;
          color: #b8860b;
          margin-bottom: 8px;
        }
        .payment-block .pb-row {
          display: flex;
          justify-content: space-between;
          font-size: 11.5px;
          padding: 3px 0;
        }
        .payment-block .pb-row .lbl {
          color: #6b7280;
          font-size: 10px;
          text-transform: uppercase;
          letter-spacing: 0.05em;
          font-weight: 600;
        }
        .payment-block .pb-row .val {
          font-family: 'SF Mono', Menlo, monospace;
          font-weight: 700;
          color: #1a1f2e;
        }
        .footer {
          text-align: center;
          font-size: 10.5px;
          color: #6b7280;
          margin-top: 24px;
          padding-top: 16px;
          border-top: 1px solid #e5e8ed;
          line-height: 1.6;
        }
        .footer strong { color: #1a1f2e; }
        @media print {
          body { padding: 16px; }
          .no-print { display: none; }
        }
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
        This is a computer-generated receipt and does not require a signature.<br>
        For inquiries, contact the accounts office.
      </div>

      <script>window.onload = () => window.print();<\/script>
    </body>
    </html>`);
  win.document.close();
}

// ---------- Payment details (KCB) ----------
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
        Retain your M-Pesa confirmation SMS as proof of payment. Contact the accounts office
        if your payment is not reflected within 24 hours.
      </div>
    </div>`;
}

// ---------- Assignment submission (with PDF upload) ----------
function submitAssignment(assignmentId) {
  // Build custom modal
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

        <p class="hint" style="text-align:left; margin-top:4px;">
          You can submit text, a PDF, or both. Files are stored securely on the server.
        </p>
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

  // File selection UI
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

  // Drag & drop
  ['dragover', 'dragenter'].forEach(ev =>
    fileDrop.addEventListener(ev, e => {
      e.preventDefault();
      fileDrop.classList.add('has-file');
    })
  );
  ['dragleave', 'drop'].forEach(ev =>
    fileDrop.addEventListener(ev, e => {
      e.preventDefault();
      if (ev === 'dragleave') fileDrop.classList.remove('has-file');
    })
  );
  fileDrop.addEventListener('drop', e => {
    const f = e.dataTransfer.files[0];
    if (!f) return;
    if (f.type !== 'application/pdf' && !f.name.toLowerCase().endsWith('.pdf')) {
      return alert('Only PDF files are allowed.');
    }
    const dt = new DataTransfer();
    dt.items.add(f);
    fileInput.files = dt.files;
    fileInput.dispatchEvent(new Event('change'));
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
        // NOTE: do NOT set Content-Type — browser sets multipart boundary
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

// ---------- Auto-logout after 30 min inactivity ----------
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