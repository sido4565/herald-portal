/* ═══════════════════════════════════════════════════════════════
   Herald Help Bot Widget
   Self-contained IIFE — injects bubble + panel, handles chat
   ═══════════════════════════════════════════════════════════════ */
(function () {
  'use strict';

  // Guard: only load once
  if (window.__heraldHelpLoaded) return;
  window.__heraldHelpLoaded = true;

  const STORAGE_KEY = 'herald_help_chat_v2';
  const API_URL = '/api/help/ask';

  const SUGGESTIONS = [
    'How much is KASNEB tuition?',
    'How much is Python course?',
    'Which KNEC exams can I prepare for?',
    'How do I pay fees?',
    'Exam schedule',
    'Show my timetable',
    'What assignments are due?',
  ];

  // ─── Load chat history ───
  function loadHistory() {
    try {
      const raw = sessionStorage.getItem(STORAGE_KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : null;
    } catch (_) { return null; }
  }

  function saveHistory(messages) {
    try {
      // Keep last 40 messages to avoid storage bloat
      sessionStorage.setItem(STORAGE_KEY, JSON.stringify(messages.slice(-40)));
    } catch (_) {}
  }

  // ─── Build DOM ───
  function buildWidget() {
    const root = document.createElement('div');
    root.className = 'herald-help-root';
    root.setAttribute('aria-label', 'Help chat');

    root.innerHTML = `
      <div class="hh-panel" id="hhPanel" role="dialog" aria-modal="false" aria-label="Help chat">
        <div class="hh-header">
          <div>
            <div class="hh-header-title">💬 Herald Help</div>
            <div class="hh-header-sub">Ask me anything about the portal</div>
          </div>
          <button class="hh-voice-toggle" id="hhVoiceToggle" type="button" aria-pressed="false" title="Turn on spoken replies">🔇</button>
          <button class="hh-close" id="hhClose" aria-label="Close chat" type="button">×</button>
        </div>
        <div class="hh-messages" id="hhMessages"></div>
        <form class="hh-input-wrap" id="hhForm">
          <input
            class="hh-input"
            id="hhInput"
            type="text"
            placeholder="Type your question…"
            autocomplete="off"
            maxlength="500"
            aria-label="Your message"
          />
          <button class="hh-send" id="hhSend" type="submit">Send</button>
          <button class="hh-mic" id="hhMic" type="button" aria-label="Speak to Herald Help" title="Speak">🎙️</button>
        </form>
        <div class="hh-footer">
          Need a human? <a href="mailto:support@heraldtrainer.co.ke">Email support</a>
        </div>
      </div>
      <button class="hh-bubble" id="hhBubble" aria-label="Open help chat" type="button">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path>
        </svg>
        <span class="hh-bubble-badge" id="hhBadge">1</span>
      </button>
    `;

    document.body.appendChild(root);

    // ─── Attach CSS (inject <link> once) ───
    if (!document.getElementById('hhStyles')) {
      const link = document.createElement('link');
      link.id = 'hhStyles';
      link.rel = 'stylesheet';
      link.href = '/help-widget.css';
      document.head.appendChild(link);
    }

    return root;
  }

  // ─── Escape HTML ───
  function esc(s) {
    return String(s || '').replace(/[&<>"']/g, c => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));
  }

  // ─── Render a message ───
  function renderMessage(container, msg) {
    const el = document.createElement('div');
    el.className = 'hh-msg ' + msg.role;
    let inner = '';
    if (msg.role === 'bot' && msg.source === 'faq') {
      inner += `<span class="hh-msg-source">📖 From FAQ</span><br>`;
    } else if (msg.role === 'bot' && msg.source === 'knowledge') {
      inner += `<span class="hh-msg-source">✓ Herald information</span><br>`;
    } else if (msg.role === 'bot' && msg.source === 'ai') {
      inner += `<span class="hh-msg-source">✨ AI answer</span><br>`;
    }
    inner += esc(msg.text);
    el.innerHTML = inner;
    if (msg.role === 'bot' && Array.isArray(msg.links) && msg.links.length) {
      const linkList = document.createElement('div');
      linkList.className = 'hh-msg-links';
      for (const item of msg.links.slice(0, 4)) {
        if (!item || typeof item.label !== 'string' || typeof item.url !== 'string') continue;
        let url;
        try { url = new URL(item.url, window.location.origin); } catch (_) { continue; }
        if (url.origin !== window.location.origin && url.hostname !== 'www.knec.ac.ke') continue;
        const link = document.createElement('a');
        link.href = url.href;
        link.textContent = item.label;
        if (url.origin !== window.location.origin) {
          link.target = '_blank';
          link.rel = 'noopener noreferrer';
        }
        linkList.appendChild(link);
      }
      if (linkList.childElementCount) el.appendChild(linkList);
    }
    container.appendChild(el);
    container.scrollTop = container.scrollHeight;
  }

  // ─── Render typing indicator ───
  function showTyping(container) {
    const el = document.createElement('div');
    el.className = 'hh-typing';
    el.id = 'hhTyping';
    el.innerHTML = '<span></span><span></span><span></span>';
    container.appendChild(el);
    container.scrollTop = container.scrollHeight;
    return el;
  }

  function hideTyping() {
    const t = document.getElementById('hhTyping');
    if (t) t.remove();
  }

  let voiceRepliesEnabled = false;
  function speakReply(text) {
    if (!voiceRepliesEnabled || !('speechSynthesis' in window) || !text) return;
    window.speechSynthesis.cancel();
    const spokenText = String(text).replace(/https?:\/\/\S+/g, ' link ').replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu, ' ').trim();
    if (!spokenText) return;
    const utterance = new SpeechSynthesisUtterance(spokenText);
    utterance.lang = 'en-KE';
    window.speechSynthesis.speak(utterance);
  }

  function addBotMessage(container, messages, msg) {
    messages.push(msg);
    renderMessage(container, msg);
    saveHistory(messages);
    speakReply(msg.text);
  }

  let pendingStudentAction = null;

  async function portalRequest(url, options = {}) {
    const response = await fetch(url, { credentials: 'same-origin', ...options });
    let data = {};
    try { data = await response.json(); } catch (_) {}
    if (!response.ok) throw new Error(data.error || 'Please sign in to use this student feature.');
    return data;
  }
  const portalGet = url => portalRequest(url);

  function isStudentPortal() {
    return !document.getElementById('adminName') && !document.getElementById('lecturerName') &&
      /dashboard\.html|student-exams\.html|exam\.html/.test(location.pathname);
  }

  async function handlePortalTask(text) {
    const query = text.trim().toLowerCase();
    const role = document.getElementById('adminName') ? 'admin' : document.getElementById('lecturerName') ? 'lecturer' : null;
    if (role === 'lecturer' && /\bwhat can you (?:actually )?do\b|\bwhat can i do (?:with|on) (?:my )?dashboard\b|\blecturer dashboard (?:help|features)\b/.test(query)) {
      return 'Your lecturer dashboard lets you view assigned courses and enrolment counts; add or edit results; manage attendance; post announcements; post, edit, or delete study materials; schedule or delete live classes; manage and publish exams; and update your profile. In this chat, I can directly schedule a live class for a course or mark one attendance status for that course roster. I will show the details for confirmation before saving. A scheduled class is available to students enrolled in that course.';
    }
    const classCommand = /\b(schedule|create|plan)\b/.test(query) && /\b(class|session|live)\b/.test(query);
    if (role && (window.heraldVoiceTaskActive || classCommand || /\b(assign|allocate|attendance|register|mark present|mark absent|mark late|mark excused)\b/.test(query))) {
      window.dispatchEvent(new CustomEvent('herald-help-command', { detail: text }));
      return true;
    }
    if (!isStudentPortal()) return null;
    if (pendingStudentAction && /^(yes|confirm|enroll|do it|save)$/i.test(query)) {
      const course = pendingStudentAction;
      pendingStudentAction = null;
      await portalRequest(`/api/enroll/${course.id}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      return `You are now enrolled in ${course.code} — ${course.title}.`;
    }
    if (pendingStudentAction && /^(no|cancel|never mind)$/i.test(query)) {
      pendingStudentAction = null;
      return 'Enrollment cancelled.';
    }

    if (/\b(enrol|enroll|sign up)\b/.test(query)) {
      const courses = await portalGet('/api/courses');
      const course = courses.find(c => query.includes(String(c.title || '').toLowerCase()) || query.includes(String(c.code || '').toLowerCase()));
      if (!course) return 'I could not identify the course. Tell me its course code or full title, for example “enroll in Python Programming”.';
      if (course.enrolled) return `You are already enrolled in ${course.code} — ${course.title}.`;
      pendingStudentAction = course;
      return `This will enroll you in ${course.code} — ${course.title}. Reply “confirm” to continue or “cancel” to stop.`;
    }

    if (/\b(timetable|class schedule|my schedule)\b/.test(query)) {
      const rows = await portalGet('/api/my-timetable');
      return rows.length ? rows.map(r => `${r.day}: ${r.code} ${r.title}, ${r.start_time}–${r.end_time}${r.room ? ` (${r.room})` : ''}`).join('\n') : 'There are no timetable entries for your courses yet.';
    }
    if (/\b(assignment|assignments|due)\b/.test(query)) {
      const rows = await portalGet('/api/my-assignments');
      return rows.length ? rows.map(r => `${r.title} (${r.code}) — due ${r.due_date || 'date not set'}${r.submission_id ? ', submitted' : ', not submitted'}`).join('\n') : 'You have no assignments listed for your courses.';
    }
    if (/\b(attendance|register)\b/.test(query)) {
      const data = await portalGet('/api/my-attendance');
      return data.summary?.length ? data.summary.map(r => `${r.code} ${r.title}: ${r.present || 0} present of ${r.total} recorded`).join('\n') : 'I could not find attendance records for your courses yet.';
    }
    if (/\b(fees?|balance|payment)\b/.test(query)) {
      const rows = await portalGet('/api/my-fees');
      return rows.length ? rows.map(r => `${r.term || 'Fee'}: amount due ${r.amount_due}, paid ${r.amount_paid || 0}, balance ${Math.max(0, Number(r.amount_due || 0) - Number(r.amount_paid || 0))} (${r.status || 'unpaid'})`).join('\n') : 'There are no fee records to show yet.';
    }
    if (/\b(my results|grades|marks|results)\b/.test(query)) {
      const rows = await portalGet('/api/results');
      return rows.length ? rows.map(r => `${r.code} ${r.title}: ${r.marks} marks, grade ${r.grade} (${r.term})`).join('\n') : 'No results have been published for your account yet.';
    }
    if (/\b(live classes?|class links?)\b/.test(query)) {
      const rows = await portalGet('/api/my-live-classes');
      return rows.length ? rows.map(r => `${r.title} (${r.code}) — ${new Date(r.scheduled_at).toLocaleString()} [${r.status}] ${r.meeting_url}`).join('\n') : 'There are no live classes scheduled for your courses.';
    }
    if (/\b(materials?|notes|books)\b/.test(query)) {
      const rows = await portalGet('/api/my-materials');
      return rows.length ? rows.map(r => `${r.title} (${r.code || r.course_code || 'course'})${r.release_date ? ` — available ${r.release_date}` : ''}`).join('\n') : 'There are no study materials listed for your courses yet.';
    }
    if (/\b(exams?|exam schedule)\b/.test(query)) {
      const rows = await portalGet('/api/student/exams');
      return rows.length ? rows.map(r => `${r.title} (${r.code || r.course_title}) — ${r.submitted_attempt ? 'completed' : r.in_progress ? 'in progress' : 'available'}`).join('\n') : 'There are no active exams available for your enrolled courses.';
    }
    if (/\b(my courses|course list|available courses)\b/.test(query)) {
      const rows = await portalGet('/api/courses');
      return rows.length ? rows.map(r => `${r.code} — ${r.title}${r.enrolled ? ' (enrolled)' : ` (not enrolled, ${r.fee_type || ''} ${r.fee || ''})`}`).join('\n') : 'No courses are listed right now.';
    }
    return null;
  }

  // ─── Render suggestion chips (once, at start) ───
  function renderSuggestions(container) {
    const wrap = document.createElement('div');
    wrap.className = 'hh-suggestions';
    wrap.id = 'hhSuggestions';
    SUGGESTIONS.forEach(text => {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'hh-chip';
      chip.textContent = text;
      chip.addEventListener('click', () => {
        const input = document.getElementById('hhInput');
        input.value = text;
        document.getElementById('hhForm').requestSubmit();
      });
      wrap.appendChild(chip);
    });
    container.appendChild(wrap);
  }

  function removeSuggestions() {
    const s = document.getElementById('hhSuggestions');
    if (s) s.remove();
  }

  // ─── Send message ───
  async function sendMessage(text, messages, container) {
    if (sendMessage.inFlight) return;
    sendMessage.inFlight = true;
    const userMsg = { role: 'user', text };
    messages.push(userMsg);
    renderMessage(container, userMsg);
    saveHistory(messages);

    removeSuggestions();
    const sendBtn = document.getElementById('hhSend');
    const input = document.getElementById('hhInput');
    sendBtn.disabled = true;
    input.disabled = true;

    // Signed-in portal tasks use the authenticated portal APIs. The FAQ bot
    // remains the fallback for general questions and public pages.
    try {
      const taskAnswer = await handlePortalTask(text);
      if (taskAnswer === true) {
        sendMessage.inFlight = false;
        sendBtn.disabled = false;
        input.disabled = false;
        input.focus();
        return;
      }
      if (taskAnswer) {
        const botMsg = { role: 'bot', text: taskAnswer, source: 'portal' };
        addBotMessage(container, messages, botMsg);
        sendMessage.inFlight = false;
        sendBtn.disabled = false;
        input.disabled = false;
        input.focus();
        return;
      }
    } catch (err) {
      const botMsg = { role: 'bot', text: err.message || 'I could not complete that portal request.', source: 'error' };
      addBotMessage(container, messages, botMsg);
      sendMessage.inFlight = false;
      sendBtn.disabled = false;
      input.disabled = false;
      input.focus();
      return;
    }
    showTyping(container);

    try {
      const res = await fetch(API_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ message: text }),
      });

      const data = await res.json();
      hideTyping();

      if (!res.ok) {
        const errText = data.error || 'Something went wrong.';
        const botMsg = { role: 'bot', text: errText, source: 'error' };
        addBotMessage(container, messages, botMsg);
      } else {
        const botMsg = {
          role: 'bot',
          text: data.answer,
          links: data.links || [],
          source: data.source || 'faq',
        };
        addBotMessage(container, messages, botMsg);
      }
    } catch (err) {
      hideTyping();
      const botMsg = {
        role: 'bot',
        text: 'Network error. Please check your connection and try again.',
        source: 'error',
      };
      addBotMessage(container, messages, botMsg);
    } finally {
      sendMessage.inFlight = false;
      sendBtn.disabled = false;
      input.disabled = false;
      input.focus();
    }
  }

  // ─── Init ───
  function init() {
    if (!document.body) {
      document.addEventListener('DOMContentLoaded', init);
      return;
    }

    buildWidget();

    const bubble = document.getElementById('hhBubble');
    const panel = document.getElementById('hhPanel');
    const closeBtn = document.getElementById('hhClose');
    const voiceToggle = document.getElementById('hhVoiceToggle');
    const form = document.getElementById('hhForm');
    const input = document.getElementById('hhInput');
    const messagesEl = document.getElementById('hhMessages');
    const badge = document.getElementById('hhBadge');

    // Web Speech API is available in Chromium based browsers. Typed input
    // stays available everywhere, and spoken requests enter the same chat.
    const mic = document.getElementById('hhMic');
    if (!('speechSynthesis' in window)) {
      voiceToggle.disabled = true;
      voiceToggle.title = 'Spoken replies are not available in this browser';
    }
    voiceToggle.addEventListener('click', () => {
      voiceRepliesEnabled = !voiceRepliesEnabled;
      voiceToggle.textContent = voiceRepliesEnabled ? '🔊' : '🔇';
      voiceToggle.setAttribute('aria-pressed', String(voiceRepliesEnabled));
      voiceToggle.title = voiceRepliesEnabled ? 'Turn off spoken replies' : 'Turn on spoken replies';
      if (!voiceRepliesEnabled && 'speechSynthesis' in window) window.speechSynthesis.cancel();
    });
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (SpeechRecognition) {
      mic.addEventListener('click', () => {
        const recognition = new SpeechRecognition();
        recognition.lang = 'en-KE';
        recognition.interimResults = true;
        let transcript = '';
        let failed = false;
        recognition.onresult = event => {
          for (let i = event.resultIndex; i < event.results.length; i += 1) {
            if (event.results[i].isFinal) transcript += `${event.results[i][0].transcript} `;
          }
        };
        recognition.onerror = () => {
          failed = true;
          const msg = { role: 'bot', text: 'I could not access speech recognition. Check microphone permission or type your request.', source: 'error' };
          messages.push(msg); renderMessage(messagesEl, msg);
        };
        recognition.onend = () => {
          const spokenRequest = transcript.trim();
          if (failed || !spokenRequest || sendMessage.inFlight) return;
          voiceRepliesEnabled = true;
          voiceToggle.textContent = '🔊';
          voiceToggle.setAttribute('aria-pressed', 'true');
          voiceToggle.title = 'Turn off spoken replies';
          input.value = spokenRequest;
          form.requestSubmit();
        };
        recognition.start();
      });
    } else {
      mic.disabled = true;
      mic.title = 'Speech recognition is not available in this browser. You can type your request.';
    }

    let messages = loadHistory() || [];
    let opened = false;

    window.addEventListener('herald-help-bot-reply', event => {
      if (event.detail?.who !== 'Assistant') return;
      const msg = { role: 'bot', text: event.detail.msg, source: 'portal' };
      addBotMessage(messagesEl, messages, msg);
    });

    // Render existing history
    if (messages.length) {
      messages.forEach(m => renderMessage(messagesEl, m));
    } else {
      // First-time greeting
      const greeting = {
        role: 'bot',
      text: "Hi! 👋 I’m Herald Help. Ask portal questions, speak using the microphone, or ask me to check your timetable, assignments, fees, results, attendance, materials, live classes, and exams. Students can also request course enrollment. Admins and lecturers can schedule classes, assign courses, and mark attendance.",
        source: 'faq',
      };
      messages.push(greeting);
      renderMessage(messagesEl, greeting);
      renderSuggestions(messagesEl);
      saveHistory(messages);
    }

    // ─── Open / close ───
    function openPanel() {
      panel.classList.add('open');
      opened = true;
      badge.classList.remove('visible');
      setTimeout(() => input.focus(), 200);
    }

    function closePanel() {
      panel.classList.remove('open');
      opened = false;
    }

    bubble.addEventListener('click', () => {
      if (opened) closePanel();
      else openPanel();
    });

    closeBtn.addEventListener('click', closePanel);

    // Close on Escape
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && opened) closePanel();
    });

    // ─── Submit ───
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const text = input.value.trim();
      if (!text) return;
      input.value = '';
      sendMessage(text, messages, messagesEl);
    });

    // Pulse badge on first load after 3 seconds if not opened
    setTimeout(() => {
      if (!opened && messages.length === 1) {
        badge.classList.add('visible');
      }
    }, 3000);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
