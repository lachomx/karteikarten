// Kleine UI-Helfer: Icons, Escaping, HTML-Bereinigung, Bottom-Sheets, Toasts.

const svg = (d, extra = '') =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" ${extra}>${d}</svg>`;

export const icon = {
  back: svg('<path d="M19 12H5"/><path d="m12 19-7-7 7-7"/>'),
  close: svg('<path d="M18 6 6 18"/><path d="m6 6 12 12"/>'),
  more: svg('<circle cx="12" cy="5" r="1.2" fill="currentColor"/><circle cx="12" cy="12" r="1.2" fill="currentColor"/><circle cx="12" cy="19" r="1.2" fill="currentColor"/>'),
  plus: svg('<path d="M12 5v14"/><path d="M5 12h14"/>'),
  check: svg('<path d="M20 6 9 17l-5-5"/>'),
  folder: svg('<path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/>'),
  folderPlus: svg('<path d="M12 10v6"/><path d="M9 13h6"/><path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/>'),
  deck: svg('<rect x="3" y="7" width="15" height="13" rx="2"/><path d="M7 4h12a2 2 0 0 1 2 2v10"/>'),
  pencil: svg('<path d="M21.2 6.8a1 1 0 0 0-4-4L3.8 16.2a2 2 0 0 0-.5.8l-1.3 4.4a.5.5 0 0 0 .6.6l4.4-1.3a2 2 0 0 0 .8-.5Z"/><path d="m15 5 4 4"/>'),
  search: svg('<circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/>'),
  flame: svg('<path d="M8.5 14.5A2.5 2.5 0 0 0 11 12c0-1.38-.5-2-1-3-1.07-2.14-.22-4.05 2-6 .5 2.5 2 4.9 4 6.5 2 1.6 3 3.5 3 5.5a7 7 0 1 1-14 0c0-1.15.43-2.29 1-3a2.5 2.5 0 0 0 2.5 2.5z"/>'),
  home: svg('<path d="M3 10.5 12 3l9 7.5"/><path d="M5 9.5V20a1 1 0 0 0 1 1h4v-6h4v6h4a1 1 0 0 0 1-1V9.5"/>'),
  gear: svg('<path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/>'),
  clock: svg('<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>'),
  newCard: svg('<rect x="4" y="4" width="16" height="16" rx="2"/><path d="M12 8v8"/><path d="M8 12h8"/>'),
  mastered: svg('<path d="m12 3 10 5-10 5L2 8z"/><path d="M6 10.5V16c3 2 9 2 12 0v-5.5"/>'),
  undo: svg('<path d="M9 14 4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11"/>'),
  swap: svg('<path d="m16 3 4 4-4 4"/><path d="M20 7H4"/><path d="m8 21-4-4 4-4"/><path d="M4 17h16"/>'),
  image: svg('<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.1-3.1a2 2 0 0 0-2.8 0L6 21"/>'),
  bold: svg('<path d="M6 12h9a4 4 0 0 1 0 8H6V4h8a4 4 0 0 1 0 8"/>', 'stroke-width="2.5"'),
  italic: svg('<path d="M19 4h-9"/><path d="M14 20H5"/><path d="M15 4 9 20"/>'),
  underline: svg('<path d="M6 4v6a6 6 0 0 0 12 0V4"/><path d="M4 20h16"/>'),
  list: svg('<path d="M8 6h13"/><path d="M8 12h13"/><path d="M8 18h13"/><path d="M3 6h.01"/><path d="M3 12h.01"/><path d="M3 18h.01"/>'),
  sort: svg('<path d="m3 16 4 4 4-4"/><path d="M7 20V4"/><path d="m21 8-4-4-4 4"/><path d="M17 4v16"/>'),
  chevron: svg('<path d="m9 18 6-6-6-6"/>'),
  minus: svg('<path d="M5 12h14"/>'),
  strike: svg('<path d="M16 4H9a3 3 0 0 0-2.83 4"/><path d="M14 12a4 4 0 0 1 0 8H6"/><path d="M4 12h16"/>'),
  heading: svg('<path d="M6 12h12"/><path d="M6 20V4"/><path d="M18 20V4"/>'),
  olist: svg('<path d="M10 6h11"/><path d="M10 12h11"/><path d="M10 18h11"/><path d="M4 6h1v4"/><path d="M4 10h2"/><path d="M6 18H4c0-1 2-2 2-3s-1-1.5-2-1"/>'),
  sup: svg('<path d="m4 19 8-8"/><path d="m12 19-8-8"/><path d="M20 12h-4c0-1.5.44-2 1.5-2.5S20 8.33 20 7c0-.47-.17-.93-.48-1.29a2 2 0 0 0-2.62-.44c-.42.24-.74.62-.9 1.07"/>'),
  sub: svg('<path d="m4 5 8 8"/><path d="m12 5-8 8"/><path d="M20 19h-4c0-1.5.44-2 1.5-2.5S20 15.33 20 14c0-.47-.17-.93-.48-1.29a2 2 0 0 0-2.62-.44c-.42.24-.74.62-.9 1.07"/>'),
  color: svg('<path d="M4 20h16" stroke-width="3" class="color-line"/><path d="m6 16 6-12 6 12"/><path d="M8 12h8"/>'),
  link: svg('<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>'),
  upload: svg('<path d="M12 3v12"/><path d="m17 8-5-5-5 5"/><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>'),
  share: svg('<path d="M12 2v13"/><path d="m16 6-4-4-4 4"/><path d="M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8"/>'),
  trophy: svg('<path d="M6 9H4.5a2.5 2.5 0 0 1 0-5H6"/><path d="M18 9h1.5a2.5 2.5 0 0 0 0-5H18"/><path d="M4 22h16"/><path d="M10 14.66V17c0 .55-.47.98-.97 1.21C7.85 18.75 7 20.24 7 22"/><path d="M14 14.66V17c0 .55.47.98.97 1.21C16.15 18.75 17 20.24 17 22"/><path d="M18 2H6v7a6 6 0 0 0 12 0V2Z"/>'),
  checkCircle: svg('<circle cx="12" cy="12" r="10"/><path d="m9 12 2 2 4-4"/>'),
  chevLeft: svg('<path d="m15 18-6-6 6-6"/>'),
};

/** Farben für die Textfarbe im Editor */
export const TEXT_COLORS = ['#ff3b5c', '#ff8a00', '#46c800', '#0a9bff', '#8a4dff', '#8f8f8f'];

export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

const ALLOWED = new Set(['B', 'STRONG', 'I', 'EM', 'U', 'S', 'STRIKE', 'DEL', 'BR', 'DIV', 'P', 'H3', 'UL', 'OL', 'LI', 'SUP', 'SUB', 'IMG', 'SPAN', 'FONT', 'A']);

/** Entfernt alles außer einfacher Formatierung und eingebetteten Bildern. */
export function sanitize(html) {
  const tpl = document.createElement('template');
  tpl.innerHTML = html ?? '';
  const walk = (node) => {
    for (const child of [...node.childNodes]) {
      if (child.nodeType === Node.ELEMENT_NODE) {
        if (!ALLOWED.has(child.tagName)) {
          if (['SCRIPT', 'STYLE', 'IFRAME', 'OBJECT'].includes(child.tagName)) child.remove();
          else child.replaceWith(...child.childNodes);
          continue;
        }
        for (const attr of [...child.attributes]) {
          const keep =
            (child.tagName === 'IMG' && attr.name === 'src' && /^data:image\//.test(attr.value)) ||
            (child.tagName === 'A' && attr.name === 'href' && /^https?:\/\//i.test(attr.value)) ||
            (child.tagName === 'FONT' && attr.name === 'color' && TEXT_COLORS.includes(attr.value.toLowerCase()));
          if (!keep) child.removeAttribute(attr.name);
        }
        if (child.tagName === 'A') {
          child.setAttribute('target', '_blank');
          child.setAttribute('rel', 'noopener noreferrer');
        }
        if (child.tagName === 'IMG' && !child.getAttribute('src')) {
          child.remove();
          continue;
        }
        walk(child);
      } else if (child.nodeType !== Node.TEXT_NODE) {
        child.remove();
      }
    }
  };
  walk(tpl.content);
  return tpl.innerHTML;
}

export function plainText(html) {
  const tpl = document.createElement('template');
  tpl.innerHTML = html ?? '';
  const imgs = tpl.content.querySelectorAll('img').length;
  const text = (tpl.content.textContent ?? '').replace(/\s+/g, ' ').trim();
  return text || (imgs ? '🖼 Bild' : '');
}

export function isEmptyHtml(html) {
  return !plainText(html);
}

// ---------- Bottom-Sheets ----------
export function openSheet(inner) {
  const backdrop = document.createElement('div');
  backdrop.className = 'sheet-backdrop';
  backdrop.innerHTML = `<div class="sheet" role="dialog">${inner}</div>`;
  document.body.appendChild(backdrop);
  requestAnimationFrame(() => backdrop.classList.add('open'));
  const close = () => {
    backdrop.classList.remove('open');
    setTimeout(() => backdrop.remove(), 200);
  };
  return { el: backdrop, sheet: backdrop.firstElementChild, close };
}

/** Aktionsmenü. items: [{ label, value, danger }] → Promise<value|null> */
export function menu(items, title = '') {
  return new Promise((resolve) => {
    const { el, sheet, close } = openSheet(
      (title ? `<div class="sheet-title">${esc(title)}</div>` : '') +
        items.map((it, i) => `<button class="sheet-item${it.danger ? ' danger' : ''}" data-i="${i}">${esc(it.label)}</button>`).join('') +
        `<button class="sheet-item cancel" data-i="-1">Abbrechen</button>`
    );
    const done = (v) => {
      close();
      resolve(v);
    };
    el.addEventListener('click', (e) => {
      if (e.target === el) return done(null);
      const b = e.target.closest('[data-i]');
      if (b) done(b.dataset.i === '-1' ? null : items[+b.dataset.i].value);
    });
    sheet.querySelector('button')?.focus();
  });
}

/** Texteingabe → Promise<string|null> */
export function prompt(title, value = '', confirmLabel = 'Speichern') {
  return new Promise((resolve) => {
    const { el, sheet, close } = openSheet(`
      <div class="sheet-title">${esc(title)}</div>
      <form class="sheet-form">
        <input class="input" name="v" value="${esc(value)}" autocomplete="off" maxlength="120" />
        <div class="sheet-actions">
          <button type="button" class="btn ghost" data-cancel>Abbrechen</button>
          <button type="submit" class="btn primary">${esc(confirmLabel)}</button>
        </div>
      </form>`);
    const input = sheet.querySelector('input');
    const done = (v) => {
      close();
      resolve(v);
    };
    sheet.querySelector('form').addEventListener('submit', (e) => {
      e.preventDefault();
      const v = input.value.trim();
      if (v) done(v);
      else input.focus();
    });
    sheet.querySelector('[data-cancel]').addEventListener('click', () => done(null));
    el.addEventListener('click', (e) => e.target === el && done(null));
    setTimeout(() => {
      input.focus();
      input.select();
    }, 50);
  });
}

export function confirm(title, text, confirmLabel = 'Löschen') {
  return new Promise((resolve) => {
    const { el, sheet, close } = openSheet(`
      <div class="sheet-title">${esc(title)}</div>
      ${text ? `<p class="sheet-text">${esc(text)}</p>` : ''}
      <div class="sheet-actions">
        <button class="btn ghost" data-v="0">Abbrechen</button>
        <button class="btn danger" data-v="1">${esc(confirmLabel)}</button>
      </div>`);
    const done = (v) => {
      close();
      resolve(v);
    };
    sheet.addEventListener('click', (e) => {
      const b = e.target.closest('[data-v]');
      if (b) done(b.dataset.v === '1');
    });
    el.addEventListener('click', (e) => e.target === el && done(false));
  });
}

let toastTimer;
export function toast(text) {
  let t = document.querySelector('.toast');
  if (!t) {
    t = document.createElement('div');
    t.className = 'toast';
    document.body.appendChild(t);
  }
  t.textContent = text;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 1800);
}

/** Bild verkleinern und als data-URL zurückgeben */
export function readImage(file, max = 1000) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, max / Math.max(img.width, img.height));
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(img.width * scale);
      canvas.height = Math.round(img.height * scale);
      canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
      URL.revokeObjectURL(img.src);
      resolve(canvas.toDataURL('image/jpeg', 0.82));
    };
    img.onerror = reject;
    img.src = URL.createObjectURL(file);
  });
}
