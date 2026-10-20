import {
  S, load, save, replaceState, resetAll, createNode, renameNode, deleteNode, children, path, descendantDecks,
  cardsOf, createCard, updateCard, deleteCard, newIntroducedToday, recordReview, streak, reviewsToday, goalReached, finishedToday, longestStreak, activeDays, DEFAULT_SETTINGS,
  dayCount, exportState, settingsChanged,
} from './store.js';
import { initSync, onStatus, getStatus, signIn, signUp, signOut, syncNow } from './sync.js';
import { schedule, planOf, newCardFields, formatInterval, category, endOfDay, dayKey } from './scheduler.js';
import { SEPARATORS, parseImport } from './importer.js';
import { icon, esc, sanitize, plainText, isEmptyHtml, menu, prompt, confirm, toast, readImage, openSheet, TEXT_COLORS } from './ui.js';

const app = document.getElementById('app');
const go = (hash) => (location.hash = hash);

// ================= Zählungen =================
function deckCounts(deckId, now = Date.now()) {
  const eod = endOfDay(now);
  const cat = { new: 0, learning: 0, mastered: 0 };
  let newCount = 0, learn = 0, review = 0, total = 0;
  for (const c of cardsOf(deckId)) {
    total++;
    cat[category(c)]++;
    if (c.state === 'new') newCount++;
    else if (c.due <= eod) c.state === 'review' ? review++ : learn++;
  }
  const newAvail = Math.max(0, Math.min(newCount, S.settings.newPerDay - newIntroducedToday(deckId)));
  return { newAvail, learn, review, due: newAvail + learn + review, cat, total };
}

function nodeCounts(id) {
  const sum = { due: 0, total: 0, cat: { new: 0, learning: 0, mastered: 0 } };
  for (const d of descendantDecks(id)) {
    const c = deckCounts(d.id);
    sum.due += c.due;
    sum.total += c.total;
    for (const k in sum.cat) sum.cat[k] += c.cat[k];
  }
  return sum;
}

/** Statuszeile unter Ordnern und Decks (HTML) */
function subLabel(c) {
  if (!c.total) return 'Noch keine Karten hinzugefügt';
  if (!c.due) return `<span class="done-label">Heute abgeschlossen ${icon.checkCircle}</span>`;
  return `${icon.clock}Heute ${c.due} ${c.due === 1 ? 'Karte' : 'Karten'} lernen`;
}

const nodeIcon = (n) =>
  `<span class="node-icon c-${n.color}">${n.type === 'folder' ? icon.folder : icon.deck}</span>`;

// ================= Gemeinsame Aktionen =================
async function newNode(type, parentId) {
  const name = await prompt(type === 'folder' ? 'Neuer Ordner' : 'Neues Deck', '', 'Erstellen');
  if (!name) return;
  const n = createNode(type, name, parentId);
  go(type === 'deck' ? `#/deck/${n.id}` : `#/folder/${n.id}`);
}

async function addMenu(parentId) {
  const v = await menu([
    { label: 'Neues Deck', value: 'deck' },
    { label: 'Neuer Ordner', value: 'folder' },
  ]);
  if (v) newNode(v, parentId);
}

function moveTargets(nodeId) {
  const forbidden = new Set();
  const mark = (id) => {
    forbidden.add(id);
    children(id).forEach((c) => mark(c.id));
  };
  mark(nodeId);
  const out = [{ label: 'Startseite (oberste Ebene)', value: '__root' }];
  const walk = (parentId, depth) => {
    for (const n of children(parentId)) {
      if (n.type !== 'folder' || forbidden.has(n.id)) continue;
      out.push({ label: `${'  '.repeat(depth)}${n.name}`, value: n.id });
      walk(n.id, depth + 1);
    }
  };
  walk(null, 0);
  return out;
}

async function nodeMenu(id) {
  const n = S.nodes[id];
  const items = [];
  if (n.type === 'folder') {
    items.push({ label: 'Neues Deck hier', value: 'newDeck' }, { label: 'Neuer Ordner hier', value: 'newFolder' });
  }
  if (n.type === 'deck') items.push({ label: 'Massenimport', value: 'import' });
  items.push({ label: 'Umbenennen', value: 'rename' }, { label: 'Verschieben', value: 'move' }, { label: 'Löschen', value: 'delete', danger: true });
  const v = await menu(items, n.name);
  if (v === 'newDeck') return newNode('deck', id);
  if (v === 'newFolder') return newNode('folder', id);
  if (v === 'import') return go(`#/import/${id}`);
  if (v === 'rename') {
    const name = await prompt('Umbenennen', n.name);
    if (name) renameNode(id, name), render();
  }
  if (v === 'move') {
    const target = await menu(moveTargets(id), 'Verschieben nach …');
    if (target) {
      n.parentId = target === '__root' ? null : target;
      n.updatedAt = Date.now();
      save();
      render();
    }
  }
  if (v === 'delete') {
    const cards = nodeCounts(id).total;
    const ok = await confirm(`„${n.name}“ löschen?`, cards ? `Dabei werden ${cards} Karten unwiderruflich gelöscht.` : '');
    if (ok) {
      const parent = n.parentId;
      deleteNode(id);
      go(parent ? `#/folder/${parent}` : '#/');
    }
  }
}

function tabbar(active) {
  return `<nav class="tabbar">
    <a href="#/" class="${active === 'home' ? 'active' : ''}">${icon.home}<span>Startseite</span></a>
    <a href="#/settings" class="${active === 'settings' ? 'active' : ''}">${icon.gear}<span>Einstellungen</span></a>
  </nav>`;
}

// ================= Startseite =================
function goalBar() {
  const goal = S.settings.dailyGoal;
  const done = reviewsToday();
  const reached = done >= goal;
  return `<section class="goal ${reached ? 'reached' : ''}">
    <div class="goal-text">${icon.flame}<span>${reached ? 'Tagesziel erreicht – dein Streak ist gesichert!' : `Tagesziel: ${done} von ${goal} Karten`}</span></div>
    <div class="goal-bar"><span style="width:${Math.min(100, (done / goal) * 100)}%"></span></div>
  </section>`;
}

function pickContinueDeck() {
  const last = S.nodes[S.lastDeckId];
  if (last && deckCounts(last.id).due) return last;
  const walk = (parentId) => {
    for (const n of children(parentId)) {
      if (n.type === 'deck' && deckCounts(n.id).due) return n;
      if (n.type === 'folder') {
        const f = walk(n.id);
        if (f) return f;
      }
    }
    return null;
  };
  return walk(null);
}

function viewHome() {
  const roots = children(null);
  const deck = pickContinueDeck();
  let hero = '';
  if (deck) {
    const crumbs = path(deck.id).slice(0, -1).map((n) => esc(n.name)).join(' › ');
    const due = deckCounts(deck.id).due;
    const done = finishedToday(deck.id);
    hero = `<section class="hero">
      ${crumbs ? `<div class="crumbs">${crumbs} ›</div>` : ''}
      <h2>${esc(deck.name)}</h2>
      <div class="tip"><span class="tip-badge">TIP</span><span>Kurz und regelmäßig lernen, besser merken</span></div>
      <div class="hero-progress"><span>Gelernt: <b>${done}</b> / ${done + due}</span><div class="goal-bar"><span style="width:${(done / (done + due)) * 100}%"></span></div></div>
      <a class="btn primary big" href="#/study/${deck.id}">Mit ${due} ${due === 1 ? 'Karte' : 'Karten'} starten</a>
    </section>`;
  } else if (Object.values(S.cards).length) {
    hero = `<section class="hero done"><h2>Alles erledigt für heute 🎉</h2><p class="muted">Komm morgen wieder, dann warten neue Wiederholungen auf dich.</p></section>`;
  }

  const list = roots.length
    ? roots.map((n) => `<a class="row-card" href="#/${n.type}/${n.id}">${nodeIcon(n)}<span class="row-main"><span class="row-title">${esc(n.name)}</span><span class="row-sub">${subLabel(nodeCounts(n.id))}</span></span><span class="chev">${icon.chevron}</span></a>`).join('')
    : `<div class="empty"><p>Lege deinen ersten Stapel an – zum Beispiel einen Ordner für dein Studium und darin Decks für jedes Fach.</p>
        <div class="empty-actions"><button class="btn primary" data-new="deck">Neues Deck</button><button class="btn ghost" data-new="folder">Neuer Ordner</button></div></div>`;

  app.innerHTML = `
    <header class="topbar">
      <button class="streak ${goalReached() ? 'on' : ''}" data-activity title="Aktivität anzeigen">${icon.flame}<b>${streak()}</b></button>
      <h1>Startseite</h1>
      <button class="icon-btn" data-new="folder" aria-label="Neuer Ordner">${icon.folderPlus}</button>
    </header>
    <main class="page with-tabbar">
      ${goalBar()}
      ${hero}
      <h3 class="section-label">Meine Stapel</h3>
      <div class="stack">${list}</div>
    </main>
    <button class="fab" aria-label="Hinzufügen">${icon.plus}</button>
    ${tabbar('home')}`;

  app.querySelectorAll('[data-new]').forEach((b) => (b.onclick = () => newNode(b.dataset.new, null)));
  app.querySelector('.fab').onclick = () => addMenu(null);
  app.querySelector('[data-activity]').onclick = activitySheet;
  app.querySelector('.goal').onclick = activitySheet;
}

// ================= Aktivität =================
function activitySheet() {
  const month = new Date();
  month.setDate(1);
  const { el, sheet, close } = openSheet('<div class="activity"></div>');
  const box = sheet.querySelector('.activity');
  const draw = () => {
    const y = month.getFullYear();
    const m = month.getMonth();
    const offset = (new Date(y, m, 1).getDay() + 6) % 7; // Woche beginnt am Montag
    const days = new Date(y, m + 1, 0).getDate();
    const today = dayKey();
    const isCurrentMonth = y === new Date().getFullYear() && m === new Date().getMonth();
    let cells = '<span></span>'.repeat(offset);
    for (let d = 1; d <= days; d++) {
      const k = dayKey(new Date(y, m, d).getTime());
      const n = dayCount(k);
      const cls = [goalReached(k) ? 'hit' : n ? 'some' : '', k === today ? 'today' : ''].join(' ').trim();
      cells += `<span class="${cls}" title="${n} ${n === 1 ? 'Karte' : 'Karten'}">${d}</span>`;
    }
    box.innerHTML = `
      <div class="sheet-title">Aktivität</div>
      <div class="act-stats">
        <div class="act-box streak-box">${icon.flame}<b>${streak()}</b><small>Tage Streak</small></div>
        <div class="act-box trophy-box">${icon.trophy}<b>${longestStreak()}</b><small>Längster Streak</small></div>
      </div>
      <div class="act-days">${icon.checkCircle}<span><b>${activeDays()}</b> ${activeDays() === 1 ? 'Tag' : 'Tage'} mit erreichtem Tagesziel (${S.settings.dailyGoal} Karten)</span></div>
      <div class="cal-head">
        <button class="icon-btn" data-prev aria-label="Vorheriger Monat">${icon.chevLeft}</button>
        <span>${month.toLocaleDateString('de-DE', { month: 'long', year: 'numeric' })}</span>
        <button class="icon-btn" data-next aria-label="Nächster Monat" ${isCurrentMonth ? 'disabled' : ''}>${icon.chevron}</button>
      </div>
      <div class="cal">${['Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa', 'So'].map((d) => `<b>${d}</b>`).join('')}${cells}</div>
      <div class="cal-legend"><span><i class="hit"></i>Tagesziel erreicht</span><span><i class="some"></i>Gelernt</span></div>
      <button class="sheet-item cancel" data-close>Schließen</button>`;
    box.querySelector('[data-prev]').onclick = () => (month.setMonth(month.getMonth() - 1), draw());
    box.querySelector('[data-next]').onclick = () => (month.setMonth(month.getMonth() + 1), draw());
    box.querySelector('[data-close]').onclick = close;
  };
  el.addEventListener('click', (e) => e.target === el && close());
  draw();
}

// ================= Ordner =================
const collapsed = new Set();

function treeRow(n, depth) {
  const kids = children(n.id);
  const c = nodeCounts(n.id);
  const isOpen = !collapsed.has(n.id);
  const toggle = kids.length
    ? `<button class="tree-toggle" data-toggle="${n.id}" aria-label="Ein-/Ausklappen">${isOpen ? icon.minus : icon.plus}</button>`
    : `<span class="tree-spacer"></span>`;
  const progress = depth === 0 && c.total
    ? `<div class="progress"><span class="p-mastered" style="width:${(c.cat.mastered / c.total) * 100}%"></span><span class="p-learning" style="width:${(c.cat.learning / c.total) * 100}%"></span></div>`
    : '';
  return `<div class="tree-node">
      <div class="tree-row">${toggle}
        <a class="tree-link" href="#/${n.type}/${n.id}">
          <span class="row-title">${esc(n.name)}</span>
          <span class="row-sub">${subLabel(c)}</span>
          ${progress}
        </a>
      </div>
      ${kids.length && isOpen ? `<div class="tree-children">${kids.map((k) => treeRow(k, depth + 1)).join('')}</div>` : ''}
    </div>`;
}

function viewFolder(id) {
  const f = S.nodes[id];
  if (!f) return go('#/');
  const kids = children(id);
  app.innerHTML = `
    <header class="topbar">
      <a class="icon-btn" href="${f.parentId ? `#/folder/${f.parentId}` : '#/'}" aria-label="Zurück">${icon.back}</a>
      <h1>${esc(f.name)}</h1>
      <button class="icon-btn" data-menu aria-label="Menü">${icon.more}</button>
    </header>
    <main class="page">
      ${kids.length
        ? kids.map((k) => `<section class="tree-block">${treeRow(k, 0)}</section>`).join('')
        : `<div class="empty"><p>Dieser Ordner ist noch leer.</p><div class="empty-actions"><button class="btn primary" data-new="deck">Neues Deck</button><button class="btn ghost" data-new="folder">Neuer Ordner</button></div></div>`}
    </main>
    <button class="fab" aria-label="Hinzufügen">${icon.plus}</button>`;

  app.querySelector('[data-menu]').onclick = () => nodeMenu(id);
  app.querySelector('.fab').onclick = () => addMenu(id);
  app.querySelectorAll('[data-new]').forEach((b) => (b.onclick = () => newNode(b.dataset.new, id)));
  app.querySelectorAll('[data-toggle]').forEach((b) => (b.onclick = () => {
    const t = b.dataset.toggle;
    collapsed.has(t) ? collapsed.delete(t) : collapsed.add(t);
    render();
  }));
}

// ================= Deck =================
const deckUi = { sort: 'newest', filter: 'all', search: '' };
const SORTS = { newest: 'Neueste', oldest: 'Älteste', az: 'A–Z' };
const FILTERS = { all: 'Alle', new: 'Nicht gelernt', learning: 'In Bearbeitung', mastered: 'Gemeistert' };

function viewDeck(id) {
  const d = S.nodes[id];
  if (!d || d.type !== 'deck') return go('#/');
  const c = deckCounts(id);
  const q = deckUi.search.toLowerCase();
  let cards = cardsOf(id).filter((card) => deckUi.filter === 'all' || category(card) === deckUi.filter);
  if (q) cards = cards.filter((card) => (plainText(card.front) + ' ' + plainText(card.back)).toLowerCase().includes(q));
  cards.sort((a, b) =>
    deckUi.sort === 'newest' ? b.createdAt - a.createdAt
      : deckUi.sort === 'oldest' ? a.createdAt - b.createdAt
        : plainText(a.front).localeCompare(plainText(b.front), 'de'));
  const pct = (n) => (c.total ? (n / c.total) * 100 : 0);
  const eod = endOfDay();

  app.innerHTML = `
    <header class="topbar">
      <a class="icon-btn" href="${d.parentId ? `#/folder/${d.parentId}` : '#/'}" aria-label="Zurück">${icon.back}</a>
      <h1></h1>
      <button class="icon-btn" data-menu aria-label="Menü">${icon.more}</button>
    </header>
    <main class="page with-pill">
      <h2 class="page-title">${esc(d.name)}</h2>
      <p class="page-sub">Neue Karten pro Tag: <a href="#/settings">${S.settings.newPerDay}</a></p>

      <section class="today">
        <div class="today-num">${c.due}</div>
        <div class="today-label">${c.due === 1 ? 'Karte' : 'Karten'} für heute</div>
        <div class="today-split">
          <div><span class="ic c-gray">${icon.newCard}</span><b>${c.newAvail}</b><small>Nicht gelernte</small></div>
          <div><span class="ic c-sky">${icon.clock}</span><b>${c.learn + c.review}</b><small>Wiederholen</small></div>
          <div><span class="ic c-blue">${icon.mastered}</span><b>${c.cat.mastered}</b><small>Gemeisterte</small></div>
        </div>
        ${c.due
          ? `<a class="btn primary big" href="#/study/${id}">Karten lernen</a>`
          : `<button class="btn ghost big" disabled>${c.total ? 'Für heute erledigt 🎉' : 'Füge zuerst Karten hinzu'}</button>`}
      </section>

      <div class="deck-head">
        <h3>Karten im Deck (${c.total})</h3>
      </div>
      <div class="progress big"><span class="p-mastered" style="width:${pct(c.cat.mastered)}%"></span><span class="p-learning" style="width:${pct(c.cat.learning)}%"></span></div>
      <div class="legend">
        <span><i class="dot p-mastered"></i>${c.cat.mastered} Gemeisterte</span>
        <span><i class="dot p-learning"></i>${c.cat.learning} In Bearbeitung</span>
        <span><i class="dot p-new"></i>${c.cat.new} Nicht gelernte</span>
      </div>

      <label class="search-wrap">${icon.search}<input class="input search" type="search" placeholder="Karten durchsuchen" value="${esc(deckUi.search)}" /></label>
      <div class="chips">
        <button class="chip" data-sort>${icon.sort}${SORTS[deckUi.sort]}</button>
        <button class="chip" data-filter>${FILTERS[deckUi.filter]}</button>
      </div>

      <div class="card-list">
        ${cards.map((card) => `
          <div class="card-item" data-card="${card.id}">
            <div class="card-text">
              <div class="card-front">${esc(plainText(card.front))}${card.state !== 'new' && card.due <= eod ? '<span class="tag-today">Heute</span>' : ''}</div>
              <div class="card-back">${esc(plainText(card.back))}</div>
            </div>
            <button class="icon-btn small" data-card-menu="${card.id}" aria-label="Kartenmenü">${icon.more}</button>
          </div>`).join('') || (c.total ? '<p class="muted center">Keine Karten gefunden.</p>' : '')}
      </div>
    </main>
    <a class="pill" href="#/add/${id}">Karten hinzufügen</a>`;

  app.querySelector('[data-menu]').onclick = () => nodeMenu(id);
  const search = app.querySelector('.search');
  if (search) search.oninput = () => {
    deckUi.search = search.value;
    const pos = search.selectionStart;
    render();
    const s = app.querySelector('.search');
    s.focus();
    s.setSelectionRange(pos, pos);
  };
  app.querySelector('[data-sort]').onclick = () => {
    const keys = Object.keys(SORTS);
    deckUi.sort = keys[(keys.indexOf(deckUi.sort) + 1) % keys.length];
    render();
  };
  app.querySelector('[data-filter]').onclick = async () => {
    const v = await menu(Object.entries(FILTERS).map(([value, label]) => ({ label, value })), 'Filtern');
    if (v) (deckUi.filter = v), render();
  };
  app.querySelectorAll('[data-card]').forEach((el) => (el.onclick = (e) => {
    if (e.target.closest('[data-card-menu]')) return;
    go(`#/edit/${el.dataset.card}`);
  }));
  app.querySelectorAll('[data-card-menu]').forEach((b) => (b.onclick = () => cardMenu(b.dataset.cardMenu)));
}

async function cardMenu(cardId) {
  const v = await menu([
    { label: 'Bearbeiten', value: 'edit' },
    { label: 'Lernfortschritt zurücksetzen', value: 'reset' },
    { label: 'Löschen', value: 'delete', danger: true },
  ]);
  if (v === 'edit') go(`#/edit/${cardId}`);
  if (v === 'reset') {
    updateCard(cardId, newCardFields());
    toast('Karte zurückgesetzt');
    render();
  }
  if (v === 'delete' && (await confirm('Karte löschen?', ''))) {
    deleteCard(cardId);
    render();
  }
}

// ================= Karten-Editor =================
// Zeichenfolgen, die beim Tippen automatisch zu Pfeilen werden (längere zuerst prüfen)
const ARROWS = [
  ['<-->', '↔'], ['<->', '↔'], ['<==>', '⇔'], ['<=>', '⇔'],
  ['-->', '→'], ['->', '→'], ['==>', '⇒'], ['=>', '⇒'],
  ['<--', '←'], ['←>', '↔'], ['<==', '⇐'],
];

/** Ersetzt eine gerade getippte Pfeil-Zeichenfolge vor dem Cursor. */
function replaceArrow() {
  const sel = getSelection();
  if (!sel.rangeCount || !sel.isCollapsed) return;
  const node = sel.anchorNode;
  const off = sel.anchorOffset;
  if (!node || node.nodeType !== Node.TEXT_NODE) return;
  const before = node.data.slice(0, off);
  const hit = ARROWS.find(([seq]) => before.endsWith(seq));
  if (!hit) return;
  // Direkt im Textknoten ersetzen – execCommand ist innerhalb eines input-Ereignisses gesperrt
  const start = off - hit[0].length;
  node.replaceData(start, hit[0].length, hit[1]);
  sel.collapse(node, start + hit[1].length);
}
function viewEditor({ deckId, cardId, from }) {
  const card = cardId ? S.cards[cardId] : null;
  if (cardId && !card) return go('#/');
  deckId ??= card.deckId;
  if (!S.nodes[deckId]) return go('#/');
  const backHref = from === 'study' ? `#/study/${deckId}` : `#/deck/${deckId}`;

  app.innerHTML = `
    <header class="topbar">
      <a class="icon-btn" href="${backHref}" aria-label="Zurück">${icon.back}</a>
      <h1>${card ? 'Karte bearbeiten' : 'Karten hinzufügen'}</h1>
      <button class="save-btn" data-save disabled aria-label="Speichern">${icon.check}</button>
    </header>
    <main class="page editor">
      <label class="field-label">Vorderseite</label>
      <div class="field" contenteditable="true" data-field="front" data-placeholder="Hier Text eingeben"></div>
      <label class="field-label">Rückseite</label>
      <div class="field" contenteditable="true" data-field="back" data-placeholder="Hier Text eingeben"></div>
      ${card ? '' : `
      <label class="toggle-row">
        <span class="ic">${icon.swap}</span><span class="grow">Umkehrkarten<small>Legt zusätzlich eine Karte mit vertauschten Seiten an</small></span>
        <input type="checkbox" class="switch" data-reverse ${localStorage.getItem('reverse') === '1' ? 'checked' : ''} />
      </label>`}
      <p class="hint">Tipp: <b>--&gt;</b> wird zu →, <b>=&gt;</b> zu ⇒, <b>&lt;--</b> zu ← und <b>&lt;-&gt;</b> zu ↔. Mit ⌘/Strg + Enter speichern.${card ? '' : ` Viele Karten auf einmal? <a href="#/import/${deckId}">Massenimport</a>`}</p>
    </main>
    <div class="color-pop" hidden>${TEXT_COLORS.map((c) => `<button data-color="${c}" style="background:${c}" aria-label="Farbe ${c}"></button>`).join('')}</div>
    <div class="format-bar">
      <button data-cmd="image" aria-label="Bild einfügen" title="Bild">${icon.image}</button>
      <button data-cmd="bold" aria-label="Fett" title="Fett">${icon.bold}</button>
      <button data-cmd="italic" aria-label="Kursiv" title="Kursiv">${icon.italic}</button>
      <button data-cmd="underline" aria-label="Unterstrichen" title="Unterstrichen">${icon.underline}</button>
      <button data-cmd="strikeThrough" aria-label="Durchgestrichen" title="Durchgestrichen">${icon.strike}</button>
      <button data-cmd="color" aria-label="Textfarbe" title="Textfarbe">${icon.color}</button>
      <button data-cmd="heading" aria-label="Überschrift" title="Überschrift">${icon.heading}</button>
      <button data-cmd="insertUnorderedList" aria-label="Aufzählung" title="Aufzählung">${icon.list}</button>
      <button data-cmd="insertOrderedList" aria-label="Nummerierte Liste" title="Nummerierte Liste">${icon.olist}</button>
      <button data-cmd="superscript" aria-label="Hochgestellt" title="Hochgestellt">${icon.sup}</button>
      <button data-cmd="subscript" aria-label="Tiefgestellt" title="Tiefgestellt">${icon.sub}</button>
      <button data-cmd="link" aria-label="Link" title="Link">${icon.link}</button>
      <input type="file" accept="image/*" hidden />
    </div>`;

  const front = app.querySelector('[data-field=front]');
  const back = app.querySelector('[data-field=back]');
  const saveBtn = app.querySelector('[data-save]');
  const fileInput = app.querySelector('input[type=file]');
  let lastField = front;
  if (card) {
    front.innerHTML = sanitize(card.front);
    back.innerHTML = sanitize(card.back);
  }

  const update = () => {
    for (const f of [front, back]) if (isEmptyHtml(f.innerHTML) && !f.querySelector('img')) f.innerHTML = '';
    saveBtn.disabled = !(front.innerHTML && back.innerHTML);
  };
  [front, back].forEach((f) => {
    f.addEventListener('input', (e) => {
      if (e.inputType === 'insertText') replaceArrow();
      update();
    });
    f.addEventListener('focus', () => (lastField = f));
    f.addEventListener('paste', (e) => {
      // Nur Text einfügen, damit keine fremden Formatierungen in die Karte gelangen
      const text = e.clipboardData?.getData('text/plain');
      if (text != null && !e.clipboardData.files.length) {
        e.preventDefault();
        document.execCommand('insertText', false, text);
      }
    });
  });
  update();

  // Auswahl merken, damit Farbe und Link nach einem Dialog auf den markierten Text wirken
  let savedRange = null;
  const rememberSelection = () => {
    const sel = getSelection();
    // Das Feld mit der Textauswahl ist das aktive Feld (zuverlässiger als das focus-Ereignis)
    const active = [front, back].find((f) => f.contains(sel.anchorNode));
    if (active) lastField = active;
    if (sel.rangeCount && lastField.contains(sel.anchorNode)) savedRange = sel.getRangeAt(0).cloneRange();
  };
  const restoreSelection = () => {
    lastField.focus();
    if (savedRange) {
      const sel = getSelection();
      sel.removeAllRanges();
      sel.addRange(savedRange);
    }
  };
  const colorPop = app.querySelector('.color-pop');
  app.querySelectorAll('[data-cmd], [data-color]').forEach((b) => b.addEventListener('mousedown', (e) => e.preventDefault())); // Fokus im Feld behalten
  app.querySelectorAll('[data-cmd]').forEach((b) => {
    b.onclick = async () => {
      const cmd = b.dataset.cmd;
      if (cmd === 'image') return fileInput.click();
      rememberSelection();
      if (cmd === 'color') return (colorPop.hidden = !colorPop.hidden);
      if (cmd === 'link') {
        if (!savedRange || savedRange.collapsed) return toast('Markiere zuerst den Text für den Link');
        const url = await prompt('Link einfügen', 'https://', 'Einfügen');
        if (!url) return;
        restoreSelection();
        document.execCommand('createLink', false, /^https?:\/\//i.test(url) ? url : `https://${url}`);
        return update();
      }
      lastField.focus();
      if (cmd === 'heading') {
        const isHeading = String(document.queryCommandValue('formatBlock')).toLowerCase() === 'h3';
        document.execCommand('formatBlock', false, isHeading ? 'div' : 'h3');
      } else {
        document.execCommand(cmd);
      }
      update();
    };
  });
  app.querySelectorAll('[data-color]').forEach((b) => (b.onclick = () => {
    restoreSelection();
    document.execCommand('styleWithCSS', false, false);
    document.execCommand('foreColor', false, b.dataset.color);
    colorPop.hidden = true;
    update();
  }));
  fileInput.onchange = async () => {
    const file = fileInput.files[0];
    fileInput.value = '';
    if (!file) return;
    const src = await readImage(file);
    lastField.focus();
    document.execCommand('insertHTML', false, `<img src="${src}">`);
    update();
  };

  const doSave = () => {
    if (saveBtn.disabled) return;
    const f = sanitize(front.innerHTML);
    const b = sanitize(back.innerHTML);
    if (card) {
      updateCard(card.id, { front: f, back: b });
      toast('Gespeichert');
      go(backHref);
      return;
    }
    createCard(deckId, f, b);
    const reverse = app.querySelector('[data-reverse]')?.checked;
    if (reverse) createCard(deckId, b, f);
    toast(reverse ? '2 Karten hinzugefügt' : 'Karte hinzugefügt');
    front.innerHTML = back.innerHTML = '';
    update();
    front.focus();
  };
  saveBtn.onclick = doSave;
  app.querySelector('[data-reverse]')?.addEventListener('change', (e) => localStorage.setItem('reverse', e.target.checked ? '1' : '0'));
  app.querySelector('.editor').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      doSave();
    }
  });
  if (!card) front.focus();
}

// ================= Massenimport =================
const importUi = { text: '', sep: 'auto' };

function viewImport(deckId) {
  const d = S.nodes[deckId];
  if (!d || d.type !== 'deck') return go('#/');
  const restoreOn = localStorage.getItem('importRestore') !== '0';
  app.innerHTML = `
    <header class="topbar">
      <a class="icon-btn" href="#/deck/${deckId}" aria-label="Zurück">${icon.back}</a>
      <h1>Massenimport</h1>
      <span class="icon-btn"></span>
    </header>
    <main class="page import">
      <p class="muted">Füge viele Karten auf einmal in <b>${esc(d.name)}</b> ein: eine Karte pro Zeile, Vorder- und Rückseite durch ein Trennzeichen getrennt. CSV-Exporte aus Noji, Quizlet (Tab) oder Anki (Notizen als Text) funktionieren direkt.</p>
      <div class="chips wrap" data-seps>
        ${Object.entries(SEPARATORS).map(([v, l]) => `<button class="chip ${importUi.sep === v ? 'active' : ''}" data-sep="${esc(v)}">${l}</button>`).join('')}
      </div>
      <textarea class="input area" spellcheck="false" placeholder="Hund ; dog&#10;Katze ; cat&#10;Haus ; house">${esc(importUi.text)}</textarea>
      <button class="btn ghost file-btn" data-file>${icon.upload}Datei wählen (.txt, .csv)</button>
      <input type="file" accept=".txt,.csv,.tsv,text/plain,text/csv" hidden />
      <label class="toggle-row">
        <span class="ic">${icon.list}</span><span class="grow">Zeilenumbrüche wiederherstellen<small>Für Noji-Exporte: trennt zusammengeklebte Listen wie „…HirnschädigungZum Beispiel…“</small></span>
        <input type="checkbox" class="switch" data-restore ${restoreOn ? 'checked' : ''} />
      </label>
      <label class="toggle-row">
        <span class="ic">${icon.swap}</span><span class="grow">Umkehrkarten<small>Legt zusätzlich je eine Karte mit vertauschten Seiten an</small></span>
        <input type="checkbox" class="switch" data-reverse />
      </label>
      <div class="import-preview"></div>
      <button class="btn primary big" data-import disabled>Importieren</button>
    </main>`;

  const area = app.querySelector('textarea');
  const preview = app.querySelector('.import-preview');
  const btn = app.querySelector('[data-import]');
  const reverse = app.querySelector('[data-reverse]');
  const restore = app.querySelector('[data-restore]');
  let parsed = { cards: [], skipped: 0, emptyBack: 0, sep: '\t' };

  const refresh = () => {
    importUi.text = area.value;
    parsed = parseImport(area.value, importUi.sep, { restore: restore.checked });
    const n = parsed.cards.length * (reverse.checked ? 2 : 1);
    btn.disabled = !n;
    btn.textContent = n ? `${n} ${n === 1 ? 'Karte' : 'Karten'} importieren` : 'Importieren';
    if (!area.value.trim()) return (preview.innerHTML = '');
    const notes = [];
    if (importUi.sep === 'auto') notes.push(`Trennzeichen: ${SEPARATORS[parsed.sep]}`);
    if (parsed.emptyBack) notes.push(`<span class="warn">${parsed.emptyBack} ohne Rückseite (Platzhalter eingefügt)</span>`);
    if (parsed.skipped) notes.push(`<span class="warn">${parsed.skipped} ${parsed.skipped === 1 ? 'Zeile' : 'Zeilen'} ohne Trennzeichen übersprungen</span>`);
    preview.innerHTML = `
      <div class="preview-head">${parsed.cards.length} ${parsed.cards.length === 1 ? 'Karte' : 'Karten'} erkannt${notes.map((x) => ` · ${x}`).join('')}</div>
      ${parsed.cards.slice(0, 5).map(([f, b]) => `<div class="preview-row"><div>${f}</div><div>${b}</div></div>`).join('')}
      ${parsed.cards.length > 5 ? `<div class="muted small">… und ${parsed.cards.length - 5} weitere</div>` : ''}`;
  };
  area.addEventListener('input', refresh);
  reverse.addEventListener('change', refresh);
  restore.addEventListener('change', () => {
    localStorage.setItem('importRestore', restore.checked ? '1' : '0');
    refresh();
  });
  app.querySelectorAll('[data-sep]').forEach((b) => (b.onclick = () => {
    importUi.sep = b.dataset.sep;
    app.querySelectorAll('[data-sep]').forEach((x) => x.classList.toggle('active', x === b));
    refresh();
  }));
  const file = app.querySelector('input[type=file]');
  app.querySelector('[data-file]').onclick = () => file.click();
  file.onchange = async () => {
    const f = file.files[0];
    file.value = '';
    if (!f) return;
    area.value = await f.text();
    refresh();
  };
  btn.onclick = () => {
    const base = Date.now();
    let i = 0;
    for (const [front, back] of parsed.cards) {
      createCard(deckId, front, back).createdAt = base + i++;
      if (reverse.checked) createCard(deckId, back, front).createdAt = base + i++;
    }
    save();
    importUi.text = '';
    toast(`${i} ${i === 1 ? 'Karte' : 'Karten'} importiert`);
    go(`#/deck/${deckId}`);
  };
  refresh();
}

// ================= Lernmodus =================
let session = null;
const isLearning = (c) => c.state === 'learning' || c.state === 'relearning';

function startSession(deckId) {
  const eod = endOfDay();
  const cards = cardsOf(deckId);
  const learn = cards.filter((c) => isLearning(c) && c.due <= eod).sort((a, b) => a.due - b.due);
  const review = cards.filter((c) => c.state === 'review' && c.due <= eod).sort((a, b) => a.due - b.due);
  const news = cards.filter((c) => c.state === 'new').sort((a, b) => a.createdAt - b.createdAt).slice(0, deckCounts(deckId).newAvail);
  const ids = [...learn, ...review, ...news].map((c) => c.id);
  session = { deckId, ids, total: ids.length, done: 0, current: null, revealed: false, history: [], startedDay: dayKey() };
}

function nextCard() {
  const now = Date.now();
  const cards = session.ids.map((id) => S.cards[id]).filter(Boolean);
  const learnDue = cards.filter((c) => isLearning(c) && c.due <= now).sort((a, b) => a.due - b.due);
  if (learnDue.length) return learnDue[0];
  const review = cards.find((c) => c.state === 'review');
  if (review) return review;
  const fresh = cards.find((c) => c.state === 'new');
  if (fresh) return fresh;
  // Nur noch Lernkarten, die erst in ein paar Minuten fällig wären: vorziehen
  return cards.filter(isLearning).sort((a, b) => a.due - b.due)[0] ?? null;
}

function answer(rating) {
  const card = session.current;
  if (!card || !session.revealed) return;
  const wasNew = card.state === 'new';
  session.history.push({ id: card.id, before: planOf(card), ids: [...session.ids], done: session.done, log: JSON.stringify(S.log), lastDeckId: S.lastDeckId });
  const plan = schedule(card, rating, S.settings);
  updateCard(card.id, plan);
  recordReview(card, wasNew, plan.state === 'review');
  if (plan.state === 'review') {
    session.ids = session.ids.filter((i) => i !== card.id);
    session.done++;
  }
  session.current = null;
  session.revealed = false;
  render();
}

function undo() {
  const h = session?.history.pop();
  if (!h) return;
  updateCard(h.id, h.before);
  S.log = JSON.parse(h.log);
  S.lastDeckId = h.lastDeckId;
  save();
  session.ids = h.ids;
  session.done = h.done;
  session.current = S.cards[h.id];
  session.revealed = false;
  render();
}

function viewStudy(deckId) {
  const d = S.nodes[deckId];
  if (!d) return go('#/');
  if (!session || session.deckId !== deckId || session.startedDay !== dayKey()) startSession(deckId);
  if (session.current && !S.cards[session.current.id]) session.current = null; // währenddessen gelöscht
  if (!session.current) session.current = nextCard();
  const card = session.current ? S.cards[session.current.id] : null;
  session.current = card;

  const pct = session.total ? (session.done / session.total) * 100 : 100;
  const top = `
    <header class="topbar study-top">
      <a class="icon-btn" href="#/deck/${deckId}" data-exit aria-label="Beenden">${icon.close}</a>
      <span class="counter"><b>${session.done}</b>/${session.total}</span>
      <button class="icon-btn" data-menu aria-label="Menü" ${card ? '' : 'disabled'}>${icon.more}</button>
    </header>
    <div class="study-progress"><span style="width:${pct}%"></span></div>`;

  if (!card) {
    const s = streak();
    const left = S.settings.dailyGoal - reviewsToday();
    app.innerHTML = `${top}
      <main class="page study-done">
        <div class="done-emoji">🎉</div>
        <h2>Geschafft!</h2>
        <p class="muted">${session.total ? `Du hast ${session.total} ${session.total === 1 ? 'Karte' : 'Karten'} gelernt.` : 'Für dieses Deck ist heute nichts mehr fällig.'}</p>
        ${left > 0
          ? `<p class="muted">Noch ${left} ${left === 1 ? 'Karte' : 'Karten'} bis zum Tagesziel.</p>`
          : `<p class="streak-line">${icon.flame} Tagesziel erreicht · ${s} ${s === 1 ? 'Tag' : 'Tage'} in Folge</p>`}
        <a class="btn primary big" href="#/deck/${deckId}" data-exit>Zurück zum Deck</a>
      </main>`;
    app.querySelectorAll('[data-exit]').forEach((a) => a.addEventListener('click', () => (session = null)));
    return;
  }

  const ratings = [
    { r: 1, label: 'Schlecht', cls: 'again' },
    { r: 2, label: 'Geht so', cls: 'hard' },
    { r: 3, label: 'Gut', cls: 'good' },
    { r: 4, label: 'Sehr gut', cls: 'easy' },
  ];
  app.innerHTML = `${top}
    <main class="study">
      <article class="study-card">
        <div class="card-content ${isLong(card.front) ? 'long' : ''}">${sanitize(card.front)}</div>
        ${session.revealed ? `<hr /><div class="card-content ${isLong(card.back) ? 'long' : ''}">${sanitize(card.back)}</div>` : ''}
      </article>
    </main>
    <footer class="study-actions">
      ${session.revealed
        ? `<div class="rate-row">${ratings.map((x) => `<button class="rate ${x.cls}" data-rate="${x.r}">${x.label}<small>${formatInterval(schedule(card, x.r, S.settings))}</small></button>`).join('')}</div>`
        : `<div class="reveal-row">
            <span class="kbd-hint">Leertaste</span>
            <button class="reveal" data-reveal>Die Antwort anzeigen</button>
            <button class="icon-btn round" data-undo aria-label="Rückgängig" ${session.history.length ? '' : 'disabled'}>${icon.undo}</button>
          </div>`}
    </footer>`;

  app.querySelector('[data-exit]').addEventListener('click', () => (session = null));
  app.querySelector('[data-reveal]')?.addEventListener('click', reveal);
  app.querySelector('.study-card').addEventListener('click', () => !session.revealed && reveal());
  app.querySelector('[data-undo]')?.addEventListener('click', undo);
  app.querySelectorAll('[data-rate]').forEach((b) => (b.onclick = () => answer(+b.dataset.rate)));
  app.querySelector('[data-menu]').onclick = async () => {
    const v = await menu([
      { label: 'Karte bearbeiten', value: 'edit' },
      { label: 'Letzte Bewertung rückgängig', value: 'undo' },
      { label: 'Karte löschen', value: 'delete', danger: true },
    ]);
    if (v === 'edit') go(`#/edit/${card.id}/study`);
    if (v === 'undo') undo();
    if (v === 'delete' && (await confirm('Karte löschen?', ''))) {
      deleteCard(card.id);
      session.ids = session.ids.filter((i) => i !== card.id);
      session.total = Math.max(session.done, session.total - 1);
      session.current = null;
      session.revealed = false;
      render();
    }
  };
}

/** Lange Texte und Listen werden linksbündig und etwas kleiner dargestellt */
function isLong(html) {
  return plainText(html).length > 140 || /<(br|li|div|h3)\b/i.test(html ?? '');
}

function reveal() {
  if (!session?.current) return;
  session.revealed = true;
  render();
}

document.addEventListener('keydown', (e) => {
  if (!location.hash.startsWith('#/study/') || !session?.current) return;
  if (document.querySelector('.sheet-backdrop') || e.metaKey || e.ctrlKey || e.altKey) return;
  if (!session.revealed && (e.key === ' ' || e.key === 'Enter')) {
    e.preventDefault();
    reveal();
  } else if (session.revealed && ['1', '2', '3', '4'].includes(e.key)) {
    answer(+e.key);
  } else if (session.revealed && (e.key === ' ' || e.key === 'Enter')) {
    e.preventDefault();
    answer(3);
  } else if (e.key === 'z' || e.key === 'Backspace') {
    undo();
  }
});

// ================= Einstellungen =================
function viewSettings() {
  const st = S.settings;
  const cardCount = Object.keys(S.cards).length;
  const today = reviewsToday();
  app.innerHTML = `
    <header class="topbar"><span></span><h1>Einstellungen</h1><span></span></header>
    <main class="page with-tabbar">
      <section class="stats-row">
        <div><b>${cardCount}</b><small>Karten</small></div>
        <div><b>${today}</b><small>Heute gelernt</small></div>
        <div><b>${streak()}</b><small>Tage in Folge</small></div>
      </section>

      <h3 class="section-label">Lernalgorithmus</h3>
      <form class="settings" data-settings>
        <label class="set-row"><span>Tagesziel<small>Karten pro Tag, damit der Streak zählt</small></span><input class="input num" type="number" min="1" max="999" name="dailyGoal" value="${st.dailyGoal}" /></label>
        <label class="set-row"><span>Neue Karten pro Tag<small>pro Deck</small></span><input class="input num" type="number" min="0" max="999" name="newPerDay" value="${st.newPerDay}" /></label>
        <label class="set-row"><span>Lernschritte neuer Karten<small>Minuten für Schlecht · Geht so · Gut</small></span><input class="input num wide" name="learnSteps" value="${st.learnSteps.join(' ')}" /></label>
        <label class="set-row"><span>Stufen in Tagen<small>„Gut“ steigt eine Stufe auf (auf der 1. Stufe erst beim zweiten Mal), „Sehr gut“ zwei</small></span><input class="input num stages" name="levels" value="${st.levels.join(' ')}" /></label>
        <button type="button" class="link-btn" data-defaults>Standardwerte wiederherstellen</button>
      </form>

      <h3 class="section-label">Synchronisierung</h3>
      <div data-sync></div>

      <h3 class="section-label">Daten</h3>
      <div class="settings">
        <button class="set-row action" data-export><span>Backup exportieren<small>Alle Decks und Karten als Datei sichern</small></span>${icon.chevron}</button>
        <button class="set-row action" data-import><span>Backup importieren<small>Ersetzt alle aktuellen Daten${getStatus().email ? ' – auch auf deinen anderen Geräten' : ''}</small></span>${icon.chevron}</button>
        <button class="set-row action danger" data-reset><span>Alle Daten löschen</span>${icon.chevron}</button>
        <input type="file" accept="application/json,.json" hidden data-file />
      </div>
    </main>
    ${tabbar('settings')}`;

  const form = app.querySelector('[data-settings]');
  const parseSteps = (v, fallback) => {
    const arr = v.split(/[\s,;]+/).map(Number).filter((n) => n > 0);
    return arr.length ? arr : fallback;
  };
  form.addEventListener('change', () => {
    const f = new FormData(form);
    st.newPerDay = Math.max(0, parseInt(f.get('newPerDay'), 10) || 0);
    st.dailyGoal = Math.max(1, parseInt(f.get('dailyGoal'), 10) || DEFAULT_SETTINGS.dailyGoal);
    const steps = parseSteps(f.get('learnSteps'), DEFAULT_SETTINGS.learnSteps);
    st.learnSteps = steps.length === 3 ? steps : [...DEFAULT_SETTINGS.learnSteps];
    st.levels = parseSteps(f.get('levels'), DEFAULT_SETTINGS.levels).map(Math.round).sort((a, b) => a - b);
    settingsChanged();
    render();
    session = null;
    toast('Gespeichert');
  });
  app.querySelector('[data-defaults]').onclick = () => {
    S.settings = { ...DEFAULT_SETTINGS };
    settingsChanged();
    render();
    toast('Standardwerte wiederhergestellt');
  };
  app.querySelector('[data-export]').onclick = () => {
    const blob = new Blob([JSON.stringify(exportState())], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `karteikarten-backup-${dayKey()}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  };
  const file = app.querySelector('[data-file]');
  app.querySelector('[data-import]').onclick = () => file.click();
  file.onchange = async () => {
    const f = file.files[0];
    file.value = '';
    if (!f) return;
    try {
      const data = JSON.parse(await f.text());
      if (!data.nodes || !data.cards) throw new Error('kein Backup');
      const where = getStatus().email ? ' Durch die Synchronisierung gilt das auch für deine anderen Geräte.' : '';
      if (!(await confirm('Backup importieren?', 'Alle aktuellen Decks und Karten werden ersetzt.' + where, 'Importieren'))) return;
      replaceState(data);
      session = null;
      toast('Backup importiert');
      render();
    } catch {
      toast('Die Datei ist kein gültiges Backup');
    }
  };
  renderSync();
  app.querySelector('[data-reset]').onclick = async () => {
    const where = getStatus().email ? ' Durch die Synchronisierung auch auf deinen anderen Geräten.' : '';
    if (await confirm('Alle Daten löschen?', 'Alle Ordner, Decks, Karten und der Lernfortschritt werden unwiderruflich gelöscht.' + where)) {
      resetAll();
      session = null;
      go('#/');
    }
  };
}

// ================= Synchronisierung (Einstellungen) =================
const SYNC_STATE = {
  idle: ['ok', 'Synchronisiert'],
  syncing: ['busy', 'Gleiche ab …'],
  error: ['err', 'Fehler'],
  offline: ['off', 'Offline'],
};

function renderSync() {
  const box = app.querySelector('[data-sync]');
  if (!box) return;
  const st = getStatus();
  if (!st.email) {
    box.innerHTML = `
      <form class="settings auth-form" data-auth>
        <p class="auth-intro">Melde dich auf Mac und iPhone mit demselben Konto an – dann werden Karten, Lernstand und Streak automatisch abgeglichen.</p>
        <input class="input" type="email" name="email" placeholder="E-Mail-Adresse" autocomplete="username" required />
        <input class="input" type="password" name="password" placeholder="Passwort (mind. 6 Zeichen)" autocomplete="current-password" minlength="6" required />
        <div class="sheet-actions">
          <button type="submit" class="btn primary" data-mode="in">Anmelden</button>
          <button type="submit" class="btn ghost" data-mode="up">Konto erstellen</button>
        </div>
        <p class="auth-msg" role="status"></p>
      </form>`;
    const form = box.querySelector('form');
    const msg = box.querySelector('.auth-msg');
    let mode = 'in';
    box.querySelectorAll('[data-mode]').forEach((b) => b.addEventListener('click', () => (mode = b.dataset.mode)));
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const f = new FormData(form);
      const email = String(f.get('email')).trim();
      const password = String(f.get('password'));
      msg.className = 'auth-msg';
      msg.textContent = mode === 'up' ? 'Konto wird erstellt …' : 'Anmelden …';
      form.querySelectorAll('button').forEach((b) => (b.disabled = true));
      try {
        if (mode === 'up') {
          const r = await signUp(email, password);
          if (r === 'confirmEmail') {
            msg.className = 'auth-msg ok';
            msg.textContent = 'Fast geschafft: Wir haben dir eine E-Mail geschickt. Klicke auf den Bestätigungslink und melde dich danach hier an.';
            form.querySelectorAll('button').forEach((b) => (b.disabled = false));
            return;
          }
        } else {
          await signIn(email, password);
        }
        toast('Angemeldet – Synchronisierung aktiv');
        render();
      } catch (err) {
        msg.className = 'auth-msg err';
        msg.textContent = err.message;
        form.querySelectorAll('button').forEach((b) => (b.disabled = false));
      }
    });
    return;
  }
  const [cls, label] = SYNC_STATE[st.state] ?? SYNC_STATE.idle;
  const last = st.lastSync ? new Date(st.lastSync).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' }) : '–';
  box.innerHTML = `
    <div class="settings">
      <div class="set-row"><span>Angemeldet als<small>${esc(st.email)}</small></span><span class="sync-badge ${cls}">${label}</span></div>
      ${st.error ? `<p class="auth-msg err">${esc(st.error)}</p>` : ''}
      <button class="set-row action" data-syncnow><span>Jetzt synchronisieren<small>Zuletzt abgeglichen: ${last} Uhr</small></span>${icon.chevron}</button>
      <button class="set-row action danger" data-signout><span>Abmelden<small>Deine Karten bleiben auf diesem Gerät erhalten</small></span>${icon.chevron}</button>
    </div>`;
  box.querySelector('[data-syncnow]').onclick = () => syncNow();
  box.querySelector('[data-signout]').onclick = async () => {
    if (await confirm('Abmelden?', 'Die Karten bleiben auf diesem Gerät, werden aber nicht mehr abgeglichen.', 'Abmelden')) {
      await signOut();
      render();
    }
  };
}

onStatus(() => {
  if (location.hash.startsWith('#/settings') && !app.querySelector('[data-auth]')) renderSync();
});

// ================= Router =================
let lastRoute = null;
function render() {
  const parts = location.hash.replace(/^#\/?/, '').split('/').filter(Boolean);
  const [view, id, extra] = parts;
  const route = location.hash;
  if (view === 'folder') viewFolder(id);
  else if (view === 'deck') viewDeck(id);
  else if (view === 'add') viewEditor({ deckId: id });
  else if (view === 'edit') viewEditor({ cardId: id, from: extra });
  else if (view === 'study') viewStudy(id);
  else if (view === 'import') viewImport(id);
  else if (view === 'settings') viewSettings();
  else viewHome();
  if (route !== lastRoute) {
    window.scrollTo(0, 0);
    if (view !== 'deck') Object.assign(deckUi, { search: '', filter: 'all' });
    lastRoute = route;
  }
}

window.addEventListener('hashchange', render);

await load();
render();
// Änderungen von anderen Geräten anzeigen – aber keine offenen Eingaben (Editor, Import) überschreiben
initSync(() => {
  if (!/^#\/(add|edit|import)\//.test(location.hash) && !document.querySelector('.sheet-backdrop')) render();
});

if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
