// home-button.js
// Automatically adds a floating "Home" button on every page except welcome.html
(function () {
  'use strict';

  var path = (window.location.pathname || '').toLowerCase();
  if (path.endsWith('/welcome.html') || path.endsWith('welcome.html')) return;
  if (document.querySelector('.home-fab')) return;

  function inject() {
    var btn = document.createElement('a');
    btn.className = 'home-fab';
    btn.href = 'welcome.html';
    btn.setAttribute('aria-label', 'Return to home page');
    btn.innerHTML =
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">' +
        '<path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>' +
        '<polyline points="9 22 9 12 15 12 15 22"/>' +
      '</svg>' +
      '<span class="home-label">Home</span>';
    document.body.appendChild(btn);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', inject);
  } else {
    inject();
  }
})();
