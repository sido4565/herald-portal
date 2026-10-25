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
    const userMsg = { role: 'user', text };
    messages.push(userMsg);
    renderMessage(container, userMsg);
    saveHistory(messages);

    removeSuggestions();
    showTyping(container);

    const sendBtn = document.getElementById('hhSend');
    const input = document.getElementById('hhInput');
    sendBtn.disabled = true;
    input.disabled = true;

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
        messages.push(botMsg);
        renderMessage(container, botMsg);
      } else {
        const botMsg = {
          role: 'bot',
          text: data.answer,
          links: data.links || [],
          source: data.source || 'faq',
        };
        messages.push(botMsg);
        renderMessage(container, botMsg);
      }
      saveHistory(messages);
    } catch (err) {
      hideTyping();
      const botMsg = {
        role: 'bot',
        text: 'Network error. Please check your connection and try again.',
        source: 'error',
      };
      messages.push(botMsg);
      renderMessage(container, botMsg);
    } finally {
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
    const form = document.getElementById('hhForm');
    const input = document.getElementById('hhInput');
    const messagesEl = document.getElementById('hhMessages');
    const badge = document.getElementById('hhBadge');

    let messages = loadHistory() || [];
    let opened = false;

    // Render existing history
    if (messages.length) {
      messages.forEach(m => renderMessage(messagesEl, m));
    } else {
      // First-time greeting
      const greeting = {
        role: 'bot',
        text: "Hi! 👋 I'm the Herald help bot. Ask about courses, monthly tuition, exams, registration, or payments. I’ll include direct links to the relevant pages.",
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
