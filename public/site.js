// ===================================================================
// Herald Trainer and Consultant — Shared Site JavaScript
// ===================================================================

// ---------- Sticky header shadow on scroll ----------
(function () {
  const header = document.querySelector('.site-header');
  if (!header) return;
  window.addEventListener('scroll', () => {
    header.classList.toggle('scrolled', window.scrollY > 8);
  }, { passive: true });
})();

// ---------- Reveal-on-scroll animations ----------
(function () {
  const els = document.querySelectorAll('.reveal');
  if (!els.length) return;

  if (!('IntersectionObserver' in window)) {
    // Fallback: just show everything
    els.forEach(el => el.classList.add('visible'));
    return;
  }

  const observer = new IntersectionObserver((entries) => {
    entries.forEach(entry => {
      if (entry.isIntersecting) {
        entry.target.classList.add('visible');
        observer.unobserve(entry.target);
      }
    });
  }, { threshold: 0.1, rootMargin: '0px 0px -50px 0px' });

  els.forEach(el => observer.observe(el));
})();

// ---------- Set current year in footer ----------
(function () {
  const y = document.getElementById('year');
  if (y) y.textContent = new Date().getFullYear();
})();

// ---------- Highlight active nav link ----------
(function () {
  const path = location.pathname.split('/').pop() || 'index.html';
  document.querySelectorAll('.nav-links a').forEach(a => {
    const href = a.getAttribute('href') || '';
    if (href === path || (path === '' && href === 'index.html')) {
      a.classList.add('active');
    }
  });
})();

// ---------- Animated counter for stats ----------
(function () {
  const counters = document.querySelectorAll('[data-count]');
  if (!counters.length) return;

  const observer = new IntersectionObserver((entries) => {
    entries.forEach(entry => {
      if (!entry.isIntersecting) return;
      const el = entry.target;
      const target = parseFloat(el.dataset.count);
      const suffix = el.dataset.suffix || '';
      const duration = 1200;
      const start = performance.now();

      function tick(now) {
        const t = Math.min((now - start) / duration, 1);
        const eased = 1 - Math.pow(1 - t, 3);
        const value = Math.round(target * eased);
        el.textContent = value + suffix;
        if (t < 1) requestAnimationFrame(tick);
      }
      requestAnimationFrame(tick);
      observer.unobserve(el);
    });
  }, { threshold: 0.4 });

  counters.forEach(el => observer.observe(el));
})();

// ---------- Back to top button ----------
(function () {
  const btn = document.getElementById('backToTop');
  if (!btn) return;
  window.addEventListener('scroll', () => {
    btn.classList.toggle('visible', window.scrollY > 400);
  }, { passive: true });
  btn.addEventListener('click', () => window.scrollTo({ top: 0, behavior: 'smooth' }));
})();


// ---------- Contact form handler ----------
async function handleContactSubmit(e) {
  e.preventDefault();
  const form = e.target;
  const msg = document.getElementById('contactMsg');
  const btn = form.querySelector('button[type="submit"]');

  if (msg) { msg.textContent = ''; msg.style.color = ''; }
  if (btn) { btn.disabled = true; btn.dataset.originalText = btn.textContent; btn.textContent = 'Sending...'; }

  try {
    const res = await fetch('/api/contact', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(Object.fromEntries(new FormData(form))),
    });
    const json = await res.json().catch(() => ({}));
    if (res.ok) {
      if (msg) { msg.style.color = '#16a34a'; msg.textContent = 'Thank you! Your message was sent.'; }
      form.reset();
      setTimeout(() => { if (msg) msg.textContent = ''; }, 8000);
    } else {
      if (msg) { msg.style.color = '#dc2626'; msg.textContent = json.error || 'Could not send. Try WhatsApp.'; }
    }
  } catch {
    if (msg) { msg.style.color = '#dc2626'; msg.textContent = 'Network error. Please try again.'; }
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = btn.dataset.originalText || 'Send Message'; }
  }
}
