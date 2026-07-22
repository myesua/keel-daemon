//! JavaScript snippets injected into live pages over CDP.
//!
//! These run inside the user's REAL tab. They must be self-contained,
//! idempotent, and leave no trace beyond `data-glide-id` markers and the
//! (temporary) highlight overlay.

/// Installs `window.__glideHighlight(el, label, holdMs)` — draws a rounded
/// orange glow rectangle over an element so the user always sees what Keel
/// is about to touch. Returns the same function on re-injection.
pub const HIGHLIGHT_LIB: &str = r#"
(() => {
  if (window.__glideHighlight) return true;
  window.__glideHighlight = (el, label, holdMs) => {
    try {
      el.scrollIntoView({ block: 'center', behavior: 'instant' });
    } catch (e) { /* older engines */ }
    const rect = el.getBoundingClientRect();
    const overlay = document.createElement('div');
    overlay.setAttribute('data-glide-overlay', '1');
    Object.assign(overlay.style, {
      position: 'fixed',
      left: (rect.left - 4) + 'px',
      top: (rect.top - 4) + 'px',
      width: (rect.width + 8) + 'px',
      height: (rect.height + 8) + 'px',
      border: '2px solid #ec6f2c',
      borderRadius: '8px',
      boxShadow: '0 0 0 4px rgba(236,111,44,0.25), 0 0 18px rgba(236,111,44,0.55)',
      pointerEvents: 'none',
      zIndex: '2147483647',
      transition: 'opacity 300ms ease',
    });
    if (label) {
      const tag = document.createElement('div');
      tag.textContent = label;
      Object.assign(tag.style, {
        position: 'absolute',
        top: '-26px',
        left: '0',
        background: '#ec6f2c',
        color: '#fff',
        font: '600 11px system-ui, sans-serif',
        padding: '3px 8px',
        borderRadius: '6px',
        whiteSpace: 'nowrap',
      });
      overlay.appendChild(tag);
    }
    document.documentElement.appendChild(overlay);
    setTimeout(() => {
      overlay.style.opacity = '0';
      setTimeout(() => overlay.remove(), 350);
    }, holdMs || 900);
    return true;
  };
  return true;
})()
"#;

/// Reads the live DOM: every interactive element gets a stable
/// `data-glide-id` marker and is described (tag, type, label, value,
/// options, required, visibility). Password/file values are never read.
pub const READ_DOM: &str = r#"
(() => {
  const MAX = 200;
  const nextId = () => {
    window.__glideIdCounter = (window.__glideIdCounter || 0) + 1;
    return 'g' + window.__glideIdCounter;
  };
  const labelFor = (el) => {
    if (el.getAttribute('aria-label')) return el.getAttribute('aria-label');
    if (el.id) {
      const l = document.querySelector('label[for="' + CSS.escape(el.id) + '"]');
      if (l) return l.textContent.trim();
    }
    const wrap = el.closest('label');
    if (wrap) return wrap.textContent.trim().slice(0, 120);
    const describedBy = el.getAttribute('aria-labelledby');
    if (describedBy) {
      const parts = describedBy.split(/\s+/).map(id => {
        const n = document.getElementById(id);
        return n ? n.textContent.trim() : '';
      }).filter(Boolean);
      if (parts.length) return parts.join(' ').slice(0, 120);
    }
    let prev = el.previousElementSibling;
    for (let i = 0; i < 2 && prev; i++, prev = prev.previousElementSibling) {
      const t = prev.textContent && prev.textContent.trim();
      if (t && t.length < 120) return t;
    }
    return el.getAttribute('placeholder') || el.name || '';
  };
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) return false;
    const s = getComputedStyle(el);
    return s.visibility !== 'hidden' && s.display !== 'none';
  };
  const sel = 'input, textarea, select, button, a[href], [role="button"], [role="link"], [role="checkbox"], [role="radio"], [role="combobox"], [contenteditable="true"]';
  const out = [];
  for (const el of document.querySelectorAll(sel)) {
    if (out.length >= MAX) break;
    if (el.closest('[data-glide-overlay]')) continue;
    let gid = el.getAttribute('data-glide-id');
    if (!gid) { gid = nextId(); el.setAttribute('data-glide-id', gid); }
    const tag = el.tagName.toLowerCase();
    const type = (el.getAttribute('type') || (tag === 'select' ? 'select' : tag === 'textarea' ? 'textarea' : tag === 'a' ? 'link' : tag === 'button' ? 'button' : el.getAttribute('role') || 'text')).toLowerCase();
    const sensitive = type === 'password' || type === 'file';
    const item = {
      glide_id: gid,
      selector: '[data-glide-id="' + gid + '"]',
      tag, type,
      name: el.name || el.id || null,
      label: labelFor(el).slice(0, 140),
      placeholder: el.getAttribute('placeholder') || null,
      required: el.required || el.getAttribute('aria-required') === 'true' || false,
      disabled: el.disabled || false,
      visible: visible(el),
      sensitive,
      value: sensitive ? null : (tag === 'select' || tag === 'input' || tag === 'textarea' ? String(el.value || '').slice(0, 200) : null),
      checked: (type === 'checkbox' || type === 'radio') ? !!el.checked : null,
      href: tag === 'a' ? (el.getAttribute('href') || '').slice(0, 300) : null,
      text: (tag === 'button' || tag === 'a' || el.getAttribute('role')) ? (el.textContent || '').trim().slice(0, 120) : null,
      options: tag === 'select' ? Array.from(el.options).slice(0, 60).map(o => ({ value: o.value, label: o.textContent.trim().slice(0, 80) })) : null,
    };
    out.push(item);
  }
  const headings = Array.from(document.querySelectorAll('h1, h2, h3')).slice(0, 30)
    .map(h => ({ level: h.tagName.toLowerCase(), text: (h.textContent || '').trim().slice(0, 160) }))
    .filter(h => h.text);
  const captcha = !!document.querySelector('iframe[src*="recaptcha"], iframe[src*="hcaptcha"], iframe[src*="turnstile"], .g-recaptcha, .h-captcha, [class*="captcha" i]');
  return JSON.stringify({
    url: location.href,
    title: document.title,
    headings,
    captcha_detected: captcha,
    element_count: out.length,
    elements: out,
    scroll: { y: Math.round(scrollY), max: Math.max(0, document.documentElement.scrollHeight - innerHeight) },
  });
})()
"#;
