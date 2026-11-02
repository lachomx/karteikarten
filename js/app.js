import {
  S, load, save, replaceState, resetAll, createNode, renameNode, deleteNode, children, path, descendantDecks,
  cardsOf, createCard, updateCard, deleteCard, newIntroducedToday, recordReview, streak, reviewsToday, goalReached, finishedToday, longestStreak, activeDays, DEFAULT_SETTINGS,
  dayCount, exportState, settingsChanged, isTestDb, ratingsOn, uid, putAudio, deleteAudio,
} from './store.js';
import { audioPrefs, ttsSupported, recordSupported, koreanVoice, koreanSide, speechText, speak, stop as stopAudio, prepareAudio, playCard, playUrl, startRecording } from './audio.js';
import { initSync, onStatus, getStatus, signIn, signUp, signOut, syncNow } from './sync.js';
import { schedule, planOf, newCardFields, formatInterval, category, endOfDay, startOfDay, dayKey, statusFields, STATUSES, DAY } from './scheduler.js';
import { SEPARATORS, parseImport, parseTags, fieldToHtml } from './importer.js';
import { dailyCfg, defaultCfg, saveCfg, runDaily, rateFor, tagFor, planRatesFor, poolLeft, isPoolDeck, isLearnDeck, isPlanDeck, loadPlan, plannedOn, planNoFor } from './daily.js';
import { icon, esc, sanitize, plainText, isEmptyHtml, menu, prompt, confirm, toast, readImage, openSheet, TEXT_COLORS } from './ui.js';

const app = document.getElementById('app');
const go = (hash) => (location.hash = hash);

// ================= Zählungen =================
const ALL = '__all'; // Lernen über alle Decks (z. B. nach Tag)
const hasTag = (card, tag) => !tag || (card.tags ?? []).includes(tag);

/** Zählung nur der Karten, die direkt in diesem Deck liegen (ohne Unterdecks); bekannte (ausgesetzte) Karten sind nie fällig.
 *  Mit tag zählen nur Karten mit diesem Tag. */
function ownCounts(deckId, tag = null, now = Date.now()) {
  const eod = endOfDay(now);
  const cat = { new: 0, learning: 0, mastered: 0, known: 0 };
  let newCount = 0, learn = 0, review = 0, total = 0;
  for (const c of cardsOf(deckId)) {
    if (!hasTag(c, tag)) continue;
    total++;
    cat[category(c)]++;
    if (c.suspended) continue;
    if (c.state === 'new') newCount++;
    else if (c.due <= eod) c.state === 'review' ? review++ : learn++;
  }
  // Tagesplan: Vorrats-Decks geben keine neuen Karten direkt aus, im Deck „Lernen“ gilt kein Tageslimit
  const limit = isPoolDeck(deckId) ? 0 : isLearnDeck(deckId) ? Infinity : S.settings.newPerDay - newIntroducedToday(deckId);
  const newAvail = Math.max(0, Math.min(newCount, limit));
  return { newAvail, learn, review, due: newAvail + learn + review, cat, total };
}

/** Zählung über alle Decks unterhalb eines Ordners bzw. über ein Deck samt Unterdecks */
function nodeCounts(id, tag = null) {
  const sum = { newAvail: 0, learn: 0, review: 0, due: 0, total: 0, cat: { new: 0, learning: 0, mastered: 0, known: 0 } };
  for (const d of decksIn(id)) {
    const c = ownCounts(d.id, tag);
    for (const k of ['newAvail', 'learn', 'review', 'due', 'total']) sum[k] += c[k];
    for (const k in sum.cat) sum.cat[k] += c.cat[k];
  }
  return sum;
}
const deckCounts = nodeCounts;

/** Href eines Knotens (Ordner oder Deck) bzw. der Startseite */
const nodeHref = (id) => (S.nodes[id] ? `#/${S.nodes[id].type}/${id}` : '#/');

/** Decks unterhalb eines Knotens bzw. alle Decks */
const decksIn = (id) => (id === ALL ? allDecksInOrder() : descendantDecks(id));

/** Karten eines Decks samt Unterdecks */
const cardsWithin = (deckId) => decksIn(deckId).flatMap((d) => cardsOf(d.id));

/** Tags der Karten mit Anzahl, häufigste zuerst */
function tagCounts(cards) {
  const m = new Map();
  for (const c of cards) for (const t of c.tags ?? []) m.set(t, (m.get(t) ?? 0) + 1);
  return [...m].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'de'));
}

const studyHref = (deckId, tag) => `#/study/${deckId}${tag ? `/${encodeURIComponent(tag)}` : ''}`;
const tagChips = (tags) => (tags?.length ? `<div class="card-tags">${tags.map((t) => `<span>#${esc(t)}</span>`).join('')}</div>` : '');

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
  const sub = type === 'deck' && S.nodes[parentId]?.type === 'deck';
  const name = await prompt(type === 'folder' ? 'Neuer Ordner' : sub ? 'Neues Unterdeck' : 'Neues Deck', '', 'Erstellen');
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
  // Decks lassen sich auch in andere Decks verschieben (als Unterdeck), Ordner nur in Ordner
  const isDeck = S.nodes[nodeId].type === 'deck';
  const out = [{ label: 'Startseite (oberste Ebene)', value: '__root' }];
  const walk = (parentId, depth) => {
    for (const n of children(parentId)) {
      if (forbidden.has(n.id) || (n.type === 'deck' && !isDeck)) continue;
      out.push({ label: `${'  '.repeat(depth)}${n.type === 'deck' ? '▸ ' : ''}${n.name}`, value: n.id });
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
  if (n.type === 'deck') items.push({ label: 'Neues Unterdeck', value: 'newDeck' }, { label: 'Massenimport', value: 'import' }, { label: 'Neue Karten sortieren', value: 'sort' });
  items.push({ label: 'Umbenennen', value: 'rename' }, { label: 'Verschieben', value: 'move' }, { label: 'Löschen', value: 'delete', danger: true });
  const v = await menu(items, n.name);
  if (v === 'newDeck') return newNode('deck', id);
  if (v === 'newFolder') return newNode('folder', id);
  if (v === 'import') return go(`#/import/${id}`);
  if (v === 'sort') return go(`#/sort/${id}`);
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
      go(nodeHref(parent));
    }
  }
}

const NODE_SORTS = { created: 'Erstellt', asc: 'A–Z', desc: 'Z–A' };

/** Knopf zum Sortieren von Ordnern und Decks (gilt überall, auch auf anderen Geräten) */
const sortChip = () => `<button class="chip small-chip" data-node-sort>${icon.sort}${NODE_SORTS[S.settings.nodeSort] ?? NODE_SORTS.created}</button>`;

function bindSortChip() {
  app.querySelectorAll('[data-node-sort]').forEach((b) => (b.onclick = async () => {
    const v = await menu([
      { label: 'Nach Erstellung', value: 'created' },
      { label: 'Name aufsteigend (A–Z, 1–9)', value: 'asc' },
      { label: 'Name absteigend (Z–A, 9–1)', value: 'desc' },
    ], 'Sortieren');
    if (!v) return;
    S.settings.nodeSort = v;
    settingsChanged();
    render();
  }));
}

function tabbar(active) {
  return `<nav class="tabbar">
    <a href="#/" class="${active === 'home' ? 'active' : ''}">${icon.home}<span>Startseite</span></a>
    <a href="#/stats" class="${active === 'stats' ? 'active' : ''}">${icon.chart}<span>Statistik</span></a>
    <a href="#/quick" class="${active === 'quick' ? 'active' : ''}">${icon.pencil}<span>Neuer Satz</span></a>
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
    const done = descendantDecks(deck.id).reduce((n, d) => n + finishedToday(d.id), 0);
    hero = `<section class="hero">
      ${crumbs ? `<div class="crumbs">${crumbs} ›</div>` : ''}
      <h2>${esc(deck.name)}</h2>
      <div class="tip"><span class="tip-badge">TIP</span><span>Kurz und regelmäßig lernen, besser merken</span></div>
      <div class="hero-progress"><span>Gelernt: <b>${done}</b> / ${done + due}</span><div class="goal-bar"><span style="width:${(done / (done + due)) * 100}%"></span></div></div>
      <a class="btn primary big" href="#/study/${deck.id}">Mit ${due} ${due === 1 ? 'Karte' : 'Karten'} starten</a>
    </section>`;
  } else if (Object.values(S.cards).length) {
    const n = recapCards().length;
    hero = `<section class="hero done"><h2>Alles erledigt für heute 🎉</h2><p class="muted">${n ? 'Am Abend festigt eine kurze Runde die heute gelernten Karten.' : 'Komm morgen wieder, dann warten neue Wiederholungen auf dich.'}</p>${n ? `<a class="btn primary big" href="#/recap">Abendrunde: ${n} Karten</a>` : ''}</section>`;
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
      <div class="label-row"><h3 class="section-label">Meine Stapel</h3>${roots.length > 1 ? sortChip() : ''}</div>
      <div class="stack">${list}</div>
    </main>
    <button class="fab" aria-label="Hinzufügen">${icon.plus}</button>
    ${tabbar('home')}`;

  app.querySelectorAll('[data-new]').forEach((b) => (b.onclick = () => newNode(b.dataset.new, null)));
  bindSortChip();
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
      <a class="icon-btn" href="${nodeHref(f.parentId)}" aria-label="Zurück">${icon.back}</a>
      <h1>${esc(f.name)}</h1>
      <button class="icon-btn" data-menu aria-label="Menü">${icon.more}</button>
    </header>
    <main class="page">
      ${kids.length > 1 ? `<div class="label-row end">${sortChip()}</div>` : ''}
      ${kids.length
        ? kids.map((k) => `<section class="tree-block">${treeRow(k, 0)}</section>`).join('')
        : `<div class="empty"><p>Dieser Ordner ist noch leer.</p><div class="empty-actions"><button class="btn primary" data-new="deck">Neues Deck</button><button class="btn ghost" data-new="folder">Neuer Ordner</button></div></div>`}
    </main>
    <button class="fab" aria-label="Hinzufügen">${icon.plus}</button>`;

  app.querySelector('[data-menu]').onclick = () => nodeMenu(id);
  app.querySelector('.fab').onclick = () => addMenu(id);
  app.querySelectorAll('[data-new]').forEach((b) => (b.onclick = () => newNode(b.dataset.new, id)));
  bindSortChip();
  app.querySelectorAll('[data-toggle]').forEach((b) => (b.onclick = () => {
    const t = b.dataset.toggle;
    collapsed.has(t) ? collapsed.delete(t) : collapsed.add(t);
    render();
  }));
}

// ================= Deck =================
const deckUi = { sort: 'newest', filter: 'all', search: '', tag: null, deckId: null };
const SORTS = { newest: 'Neueste', oldest: 'Älteste', az: 'A–Z' };
const FILTERS = { all: 'Alle', new: 'Nicht gelernt', learning: 'In Bearbeitung', mastered: 'Gemeistert', known: 'Bekannt (ausgesetzt)' };

function viewDeck(id) {
  const d = S.nodes[id];
  if (!d || d.type !== 'deck') return go('#/');
  if (deckUi.deckId !== id) Object.assign(deckUi, { deckId: id, tag: null });
  const allCards = cardsWithin(id);
  const tags = tagCounts(allCards);
  if (deckUi.tag && !tags.some(([t]) => t === deckUi.tag)) deckUi.tag = null;
  const tag = deckUi.tag;
  const c = deckCounts(id, tag);
  const subs = children(id);
  const q = deckUi.search.toLowerCase();
  let cards = allCards.filter((card) => (deckUi.filter === 'all' || category(card) === deckUi.filter) && hasTag(card, tag));
  if (q) cards = cards.filter((card) => (plainText(card.front) + ' ' + plainText(card.back) + ' ' + (card.tags ?? []).map((t) => '#' + t).join(' ')).toLowerCase().includes(q));
  cards.sort((a, b) =>
    deckUi.sort === 'newest' ? b.createdAt - a.createdAt
      : deckUi.sort === 'oldest' ? a.createdAt - b.createdAt
        : plainText(a.front).localeCompare(plainText(b.front), 'de'));
  const pct = (n) => (c.total ? (n / c.total) * 100 : 0);
  const eod = endOfDay();
  const unsorted = sortable(id).length;

  app.innerHTML = `
    <header class="topbar">
      <a class="icon-btn" href="${nodeHref(d.parentId)}" aria-label="Zurück">${icon.back}</a>
      <h1></h1>
      <button class="icon-btn" data-menu aria-label="Menü">${icon.more}</button>
    </header>
    <main class="page with-pill">
      <h2 class="page-title">${esc(d.name)}</h2>
      <p class="page-sub">${isLearnDeck(id) ? 'Neue Karten von heute, <a href="#/daily">Tagesplan</a>' : isPoolDeck(id) ? `Vorrat für den <a href="#/daily">Tagesplan</a>: ${srcToday(dailyCfg().sources.find((x) => x.deckId === id))} neue heute` : `Neue Karten pro Tag: <a href="#/settings">${S.settings.newPerDay}</a>`}</p>

      <section class="today">
        <div class="today-num">${c.due}</div>
        <div class="today-label">${c.due === 1 ? 'Karte' : 'Karten'} für heute${tag ? ` mit <span class="tag-inline">#${esc(tag)}</span>` : ''}</div>
        <div class="today-split">
          <div><span class="ic c-gray">${icon.newCard}</span><b>${c.newAvail}</b><small>Nicht gelernte</small></div>
          <div><span class="ic c-sky">${icon.clock}</span><b>${c.learn + c.review}</b><small>Wiederholen</small></div>
          <div><span class="ic c-blue">${icon.mastered}</span><b>${c.cat.mastered}</b><small>Gemeisterte</small></div>
        </div>
        ${c.due
          ? `<a class="btn primary big" href="${studyHref(id, tag)}">${tag ? `#${esc(tag)} lernen` : 'Karten lernen'}</a>`
          : `<button class="btn ghost big" disabled>${c.total ? 'Für heute erledigt 🎉' : 'Füge zuerst Karten hinzu'}</button>`}
        ${unsorted ? `<a class="sort-link" href="#/sort/${id}">${icon.sort}${unsorted} neue ${unsorted === 1 ? 'Karte' : 'Karten'} sortieren: bekannt · eingeschlafen · neu</a>` : ''}
      </section>

      <div class="deck-head">
        <h3>Unterdecks${subs.length ? ` (${subs.length})` : ''}</h3>
        <span class="head-actions">${subs.length > 1 ? sortChip() : ''}<button class="chip" data-new-sub>${icon.plus}Unterdeck</button></span>
      </div>
      ${subs.length
        ? `<div class="stack sub-decks">${subs.map((n) => `<a class="row-card" href="#/deck/${n.id}">${nodeIcon(n)}<span class="row-main"><span class="row-title">${esc(n.name)}</span><span class="row-sub">${subLabel(nodeCounts(n.id))}</span></span><span class="chev">${icon.chevron}</span></a>`).join('')}</div>`
        : '<p class="muted small sub-hint">Teile das Deck auf, z. B. in ein Unterdeck pro Vorlesung. Hier lernst du dann alle Karten zusammen.</p>'}

      <div class="deck-head">
        <h3>${tag ? `Karten mit #${esc(tag)}` : 'Karten im Deck'} (${c.total})</h3>
      </div>
      <div class="progress big"><span class="p-mastered" style="width:${pct(c.cat.mastered)}%"></span><span class="p-learning" style="width:${pct(c.cat.learning)}%"></span><span class="p-known" style="width:${pct(c.cat.known)}%"></span></div>
      <div class="legend">
        <span><i class="dot p-mastered"></i>${c.cat.mastered} Gemeisterte</span>
        <span><i class="dot p-learning"></i>${c.cat.learning} In Bearbeitung</span>
        <span><i class="dot p-new"></i>${c.cat.new} Nicht gelernte</span>
        ${c.cat.known ? `<span><i class="dot p-known"></i>${c.cat.known} Bekannt</span>` : ''}
      </div>

      <label class="search-wrap">${icon.search}<input class="input search" type="search" placeholder="Karten durchsuchen" value="${esc(deckUi.search)}" /></label>
      <div class="chips">
        <button class="chip" data-sort>${icon.sort}${SORTS[deckUi.sort]}</button>
        <span class="head-actions">
          ${tags.length ? `<button class="chip ${tag ? 'active' : ''}" data-tag>#${tag ? esc(tag) : 'Tags'}</button>` : ''}
          <button class="chip" data-filter>${FILTERS[deckUi.filter]}</button>
        </span>
      </div>

      <div class="card-list">
        ${cards.map((card) => `
          <div class="card-item" data-card="${card.id}">
            <div class="card-text">
              <div class="card-front">${esc(plainText(card.front))}${card.suspended ? '<span class="tag-known">Bekannt</span>' : card.state !== 'new' && card.due <= eod ? '<span class="tag-today">Heute</span>' : ''}${card.deckId !== id && S.nodes[card.deckId] ? `<span class="tag-deck">${esc(S.nodes[card.deckId].name)}</span>` : ''}</div>
              <div class="card-back">${esc(plainText(card.back))}</div>
              ${tagChips(card.tags)}
            </div>
            <button class="icon-btn small" data-card-menu="${card.id}" aria-label="Kartenmenü">${icon.more}</button>
          </div>`).join('') || (c.total ? '<p class="muted center">Keine Karten gefunden.</p>' : '')}
      </div>
    </main>
    <a class="pill" href="#/add/${id}">Karten hinzufügen</a>`;

  app.querySelector('[data-menu]').onclick = () => nodeMenu(id);
  app.querySelector('[data-new-sub]').onclick = () => newNode('deck', id);
  bindSortChip();
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
  const tagBtn = app.querySelector('[data-tag]');
  if (tagBtn) tagBtn.onclick = async () => {
    const v = await menu([{ label: 'Alle Karten', value: '__none' }, ...tags.map(([t, n]) => ({ label: `#${t} (${n})`, value: t }))], 'Nach Tag filtern');
    if (v) (deckUi.tag = v === '__none' ? null : v), render();
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
  const known = S.cards[cardId].suspended;
  const v = await menu([
    { label: 'Bearbeiten', value: 'edit' },
    known ? { label: 'Wieder aktivieren (abfragen)', value: 'activate' } : { label: 'Als bekannt aussetzen', value: 'suspend' },
    { label: 'Lernfortschritt zurücksetzen', value: 'reset' },
    { label: 'Löschen', value: 'delete', danger: true },
  ]);
  if (v === 'edit') go(`#/edit/${cardId}`);
  if (v === 'activate' || v === 'suspend') {
    updateCard(cardId, { suspended: v === 'suspend' });
    toast(v === 'suspend' ? 'Karte ausgesetzt – wird nicht mehr abgefragt' : 'Karte wird wieder abgefragt');
    session = null;
    render();
  }
  if (v === 'reset') {
    updateCard(cardId, { ...newCardFields(), suspended: false });
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
  const backHref = from === 'study' ? (session ? studyHref(session.deckId, session.tag) : studyHref(deckId)) : `#/deck/${deckId}`;

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
      <label class="field-label">Audio <small>– eigene Aufnahme, wird statt der Computerstimme abgespielt</small></label>
      <div class="audio-row">
        ${recordSupported ? `<button type="button" class="chip" data-rec>${icon.mic}<span>Aufnehmen</span></button>` : ''}
        <button type="button" class="chip" data-audio-file>${icon.upload}Datei</button>
        <button type="button" class="chip" data-listen>${icon.speaker}Anhören</button>
        <button type="button" class="chip" data-audio-del aria-label="Aufnahme entfernen" hidden>${icon.trash}</button>
        <input type="file" accept="audio/*" hidden data-audio-input />
      </div>
      <p class="hint" data-audio-status></p>
      <label class="field-label" for="e-tags">Tags <small>– mit Leerzeichen getrennt, z. B. klettern alltag</small></label>
      <input class="input" id="e-tags" data-tags autocomplete="off" autocapitalize="none" value="${esc((card?.tags ?? []).join(' '))}" />
      ${card ? '' : `
      <label class="toggle-row">
        <span class="ic">${icon.swap}</span><span class="grow">Umkehrkarten<small>Legt zusätzlich eine Karte mit vertauschten Seiten an</small></span>
        <input type="checkbox" class="switch" data-reverse ${localStorage.getItem('reverse') === '1' ? 'checked' : ''} />
      </label>`}
      <p class="hint">Tipp: <b>--&gt;</b> wird zu →, <b>=&gt;</b> zu ⇒, <b>&lt;--</b> zu ← und <b>&lt;-&gt;</b> zu ↔. <b>{{Wort}}</b> hebt das Zielwort hervor. Mit ⌘/Strg + Enter speichern.${card ? '' : ` Viele Karten auf einmal? <a href="#/import/${deckId}">Massenimport</a>`}</p>
    </main>
    <div class="color-pop" hidden>${TEXT_COLORS.map((c) => `<button data-color="${c}" style="background:${c}" aria-label="Farbe ${c}"></button>`).join('')}</div>
    <div class="format-bar">
      <button data-cmd="image" aria-label="Bild einfügen" title="Bild">${icon.image}</button>
      <button data-cmd="bold" aria-label="Fett" title="Fett">${icon.bold}</button>
      <button data-cmd="italic" aria-label="Kursiv" title="Kursiv">${icon.italic}</button>
      <button data-cmd="underline" aria-label="Unterstrichen" title="Unterstrichen">${icon.underline}</button>
      <button data-cmd="strikeThrough" aria-label="Durchgestrichen" title="Durchgestrichen">${icon.strike}</button>
      <button data-cmd="color" aria-label="Textfarbe" title="Textfarbe">${icon.color}</button>
      <button data-cmd="mark" aria-label="Zielwort markieren" title="Zielwort markieren">${icon.highlight}</button>
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
  const fileInput = app.querySelector('.format-bar input[type=file]');
  let lastField = front;
  if (card) {
    front.innerHTML = sanitize(card.front);
    back.innerHTML = sanitize(card.back);
  }

  const update = () => {
    for (const f of [front, back]) if (isEmptyHtml(f.innerHTML) && !f.querySelector('img')) f.innerHTML = '';
    saveBtn.disabled = !front.innerHTML; // Rückseite ist optional (z. B. Übersetzung später ergänzen)
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
  // Zielwort: Auswahl in <mark> setzen bzw. eine vorhandene Markierung aufheben
  const toggleMark = () => {
    const sel = getSelection();
    const existing = sel.anchorNode && (sel.anchorNode.nodeType === 1 ? sel.anchorNode : sel.anchorNode.parentElement)?.closest('mark');
    if (existing && lastField.contains(existing)) existing.replaceWith(...existing.childNodes);
    else if (!savedRange || savedRange.collapsed) return toast('Markiere zuerst das Zielwort');
    else {
      const m = document.createElement('mark');
      m.append(savedRange.extractContents());
      savedRange.insertNode(m);
    }
    update();
  };
  const colorPop = app.querySelector('.color-pop');
  app.querySelectorAll('[data-cmd], [data-color]').forEach((b) => b.addEventListener('mousedown', (e) => e.preventDefault())); // Fokus im Feld behalten
  app.querySelectorAll('[data-cmd]').forEach((b) => {
    b.onclick = async () => {
      const cmd = b.dataset.cmd;
      if (cmd === 'image') return fileInput.click();
      rememberSelection();
      if (cmd === 'color') return (colorPop.hidden = !colorPop.hidden);
      if (cmd === 'mark') return toggleMark();
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

  // ----- Audio: Aufnahme oder Datei, gespeichert erst beim Speichern der Karte -----
  let audio = card?.audio ?? null;   // { id, type } der gespeicherten Aufnahme
  let audioBlob = null;              // neue, noch nicht gespeicherte Aufnahme
  let audioUrl = null;
  let recorder = null;
  const audioStatus = app.querySelector('[data-audio-status]');
  const recBtn = app.querySelector('[data-rec]');
  const delBtn = app.querySelector('[data-audio-del]');
  const audioInput = app.querySelector('[data-audio-input]');
  const showAudio = (text) => {
    delBtn.hidden = !(audio || audioBlob);
    audioStatus.textContent = text ?? (audioBlob ? 'Neue Aufnahme – wird beim Speichern übernommen.' : audio ? 'Eigene Aufnahme vorhanden.' : '');
  };
  const setBlob = (blob) => {
    if (audioUrl) URL.revokeObjectURL(audioUrl);
    audioBlob = blob;
    audioUrl = blob ? URL.createObjectURL(blob) : null;
    showAudio();
  };
  if (audio) prepareAudio(card);
  showAudio();
  recBtn?.addEventListener('click', async () => {
    if (recorder) {
      const blob = await recorder.stop();
      recorder = null;
      recBtn.classList.remove('recording');
      recBtn.innerHTML = `${icon.mic}<span>Aufnehmen</span>`;
      if (blob.size) setBlob(blob);
      return;
    }
    try {
      recorder = await startRecording();
      recBtn.classList.add('recording');
      recBtn.innerHTML = `${icon.stop}<span>Stopp</span>`;
      showAudio('Aufnahme läuft …');
    } catch {
      showAudio('Kein Zugriff aufs Mikrofon – bitte im Browser erlauben.');
    }
  });
  app.querySelector('[data-audio-file]').onclick = () => audioInput.click();
  audioInput.onchange = () => {
    const f = audioInput.files[0];
    audioInput.value = '';
    if (!f) return;
    if (f.size > 5 * 1024 * 1024) return toast('Die Datei ist größer als 5 MB');
    setBlob(f);
  };
  app.querySelector('[data-listen]').onclick = () => {
    if (audioUrl) return playUrl(audioUrl);
    const preview = { front: front.innerHTML, back: back.innerHTML, audio: audioBlob ? null : audio };
    if (!playCard(preview)) toast(koreanSide(preview) ? 'Keine Sprachausgabe verfügbar' : 'Kein koreanischer Text zum Vorlesen');
  };
  delBtn.onclick = () => {
    audio = null;
    setBlob(null);
  };

  /** Speichert eine neue Aufnahme und liefert das audio-Feld der Karte */
  const commitAudio = async () => {
    if (!audioBlob) return audio;
    const id = uid();
    await putAudio(id, audioBlob);
    return { id, type: audioBlob.type || 'audio/webm' };
  };

  const doSave = async () => {
    if (saveBtn.disabled) return;
    if (recorder) recBtn.click();
    const f = sanitize(front.innerHTML);
    const b = sanitize(back.innerHTML);
    const tags = parseTags(app.querySelector('[data-tags]').value);
    if (card) {
      const newAudio = await commitAudio();
      if (card.audio && card.audio.id !== newAudio?.id) deleteAudio(card.audio.id).catch(() => {});
      updateCard(card.id, { front: f, back: b, audio: newAudio, tags });
      toast('Gespeichert');
      go(backHref);
      return;
    }
    createCard(deckId, f, b, { audio: await commitAudio(), tags });
    const reverse = app.querySelector('[data-reverse]')?.checked;
    if (reverse) createCard(deckId, b, f, { audio: await commitAudio(), tags }); // eigene Kopie der Aufnahme
    toast(reverse ? '2 Karten hinzugefügt' : 'Karte hinzugefügt');
    front.innerHTML = back.innerHTML = '';
    audio = null;
    setBlob(null);
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
const importUi = { text: '', sep: 'auto', status: 'file' };
const IMPORT_STATUS = { file: 'Aus der Datei', ...STATUSES };

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
      <div class="import-option">
        <span>Status der Karten<small>„Aus der Datei“ nutzt die Spalte <i>status</i>, sonst Neu. Eingeschlafen: erste Wiederholung in 3–4 Tagen · Bekannt: wird nicht abgefragt</small></span>
        <div class="chips wrap" data-statuses>
          ${Object.entries(IMPORT_STATUS).map(([v, l]) => `<button class="chip ${importUi.status === v ? 'active' : ''}" data-status="${v}">${l}</button>`).join('')}
        </div>
      </div>
      <div class="import-option">
        <span>Tags für alle Karten<small>Optional, mit Leerzeichen getrennt – zusätzlich zur Spalte <i>tags</i> in der Datei</small></span>
        <input class="input" data-import-tags autocomplete="off" autocapitalize="none" placeholder="z. B. yonsei kapitel3" />
      </div>
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
    const byStatus = {};
    for (const card of parsed.cards) {
      const st = statusOf(card);
      byStatus[st] = (byStatus[st] ?? 0) + 1;
    }
    const tagged = parsed.cards.filter((card) => card[2]?.tags.length).length;
    if (tagged) notes.push(`${tagged} mit Tags`);
    if (byStatus.eingeschlafen || byStatus.bekannt) notes.push(Object.entries(byStatus).map(([k, n]) => `${n} ${STATUSES[k].toLowerCase()}`).join(', '));
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
  const statusOf = (card) => (importUi.status === 'file' ? card[2]?.status ?? 'neu' : importUi.status);
  app.querySelectorAll('[data-status]').forEach((b) => (b.onclick = () => {
    importUi.status = b.dataset.status;
    app.querySelectorAll('[data-status]').forEach((x) => x.classList.toggle('active', x === b));
    refresh();
  }));
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
    for (const card of parsed.cards) {
      const [front, back] = card;
      const tags = [...new Set([...(card[2]?.tags ?? []), ...parseTags(app.querySelector('[data-import-tags]').value)])];
      const extra = () => ({ ...statusFields(statusOf(card), S.settings), ...(tags.length ? { tags } : {}) });
      createCard(deckId, front, back, extra()).createdAt = base + i++;
      if (reverse.checked) createCard(deckId, back, front, extra()).createdAt = base + i++;
    }
    session = null;
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

function startSession(deckId, tag = null) {
  const eod = endOfDay();
  const cards = cardsWithin(deckId).filter((c) => !c.suspended && hasTag(c, tag));
  const learn = cards.filter((c) => isLearning(c) && c.due <= eod).sort((a, b) => a.due - b.due);
  const review = cards.filter((c) => c.state === 'review' && c.due <= eod).sort((a, b) => a.due - b.due);
  // Neue Karten: je Deck bis zu dessen Tageslimit, in Reihenfolge der Decks (Hauptdeck, dann Unterdecks)
  const news = decksIn(deckId).flatMap((d) =>
    cardsOf(d.id).filter((c) => c.state === 'new' && !c.suspended && hasTag(c, tag)).sort((a, b) => a.createdAt - b.createdAt).slice(0, ownCounts(d.id, tag).newAvail));
  const ids = [...learn, ...review, ...news].map((c) => c.id);
  session = { deckId, tag, ids, total: ids.length, done: 0, current: null, revealed: false, history: [], startedDay: dayKey(), turn: 0, spoken: null };
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
  recordReview(card, wasNew, plan.state === 'review', rating);
  if (plan.state === 'review') {
    session.ids = session.ids.filter((i) => i !== card.id);
    session.done++;
  }
  session.current = null;
  session.revealed = false;
  session.turn++;
  stopAudio();
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
  session.turn++;
  render();
}

function viewStudy(deckId, tag = null) {
  if (!S.nodes[deckId] && deckId !== ALL) return go('#/');
  if (!session || session.deckId !== deckId || session.tag !== tag || session.startedDay !== dayKey()) startSession(deckId, tag);
  const exitHref = deckId === ALL ? '#/stats' : `#/deck/${deckId}`;
  if (session.current && !S.cards[session.current.id]) session.current = null; // währenddessen gelöscht
  if (!session.current) session.current = nextCard();
  const card = session.current ? S.cards[session.current.id] : null;
  session.current = card;

  const pct = session.total ? (session.done / session.total) * 100 : 100;
  const top = `
    <header class="topbar study-top">
      <a class="icon-btn" href="${exitHref}" data-exit aria-label="Beenden">${icon.close}</a>
      <span class="counter">${tag ? `<span class="tag-inline">#${esc(tag)}</span>` : ''}<b>${session.done}</b>/${session.total}</span>
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
        <a class="btn primary big" href="${exitHref}" data-exit>${deckId === ALL ? 'Zurück zur Statistik' : 'Zurück zum Deck'}</a>
        ${isPlanFolderOrDeck(deckId) && recapCards().length ? `<a class="btn ghost big" href="#/recap" data-exit>Abendrunde: heutige Karten noch einmal</a>` : ''}
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
  const side = koreanSide(card);
  const canSpeak = side && (side === 'front' || session.revealed);
  app.innerHTML = `${top}
    <main class="study">
      <article class="study-card">
        ${canSpeak ? `<button class="speak-btn" data-speak aria-label="Vorlesen" title="Vorlesen (V)">${icon.speaker}</button>` : ''}
        <div class="card-content ${isLong(card.front) ? 'long' : ''}">${sanitize(card.front)}</div>
        ${session.revealed ? `<hr />${isEmptyHtml(card.back) && !/<img/i.test(card.back ?? '') ? '<p class="muted small">Noch keine Rückseite – über ⋯ › Karte bearbeiten ergänzen</p>' : `<div class="card-content ${isLong(card.back) ? 'long' : ''}">${sanitize(card.back)}</div>`}` : ''}
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

  app.querySelector('[data-exit]').addEventListener('click', () => {
    stopAudio();
    session = null;
  });
  app.querySelector('[data-speak]')?.addEventListener('click', (e) => {
    e.stopPropagation();
    speakCard(card);
  });
  // Automatisch vorlesen, sobald die koreanische Seite zu sehen ist (einmal pro Karte)
  prepareAudio(card).then(() => {
    if (!audioPrefs.autoSpeak || !canSpeak || session?.current !== card || session.spoken === session.turn) return;
    session.spoken = session.turn;
    playCard(card);
  });
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

let voiceHintShown = false;
function speakCard(card) {
  const r = playCard(card);
  if (!r) toast('Keine Sprachausgabe verfügbar');
  else if (r === 'tts' && !koreanVoice() && !voiceHintShown) {
    voiceHintShown = true;
    toast('Keine koreanische Stimme gefunden – siehe Einstellungen › Audio');
  }
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
  } else if (e.key === 'v' && app.querySelector('[data-speak]')) {
    speakCard(session.current);
  }
});

// Abendrunde per Tastatur: Leertaste zeigt die Antwort, 1 = nicht gewusst, 2 oder Leertaste = gewusst
document.addEventListener('keydown', (e) => {
  if (location.hash !== '#/recap' || !recap?.queue.length || e.metaKey || e.ctrlKey || e.altKey) return;
  const btn = (v) => app.querySelector(`[data-recap="${v}"]`);
  if (!recap.revealed && (e.key === ' ' || e.key === 'Enter')) {
    e.preventDefault();
    app.querySelector('[data-reveal]')?.click();
  } else if (recap.revealed && e.key === '1') btn(0)?.click();
  else if (recap.revealed && (e.key === '2' || e.key === ' ' || e.key === 'Enter')) {
    e.preventDefault();
    btn(1)?.click();
  }
});

// ================= Statistik =================
const MATURE_DAYS = 21; // ab diesem Intervall gilt eine Karte als reif
const WEEKDAYS = ['So', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa'];
const pctText = (x) => (x == null ? '–' : `${Math.round(x * 100)} %`);

/** Trefferquote = Anteil der Antworten, die nicht „Schlecht“ waren */
function hitRate(days) {
  let all = 0, hit = 0;
  for (const k of days) {
    const r = ratingsOn(k);
    all += r[1] + r[2] + r[3] + r[4];
    hit += r[2] + r[3] + r[4];
  }
  return all ? hit / all : null;
}

/** Tagesschlüssel der letzten n Tage (ältester zuerst) bzw. der nächsten n Tage */
function dayKeys(n, dir = -1) {
  const base = startOfDay() + DAY / 2; // Tagesmitte, damit Zeitumstellungen nicht stören
  return Array.from({ length: n }, (_, i) => dayKey(base + (dir < 0 ? i - n + 1 : i) * DAY));
}

/** Säulendiagramm: items = [{ label, value, sub, today }] */
function bars(items, cls = '') {
  const max = Math.max(1, ...items.map((x) => x.value));
  return `<div class="bars ${cls}">${items.map((x) => `
    <div class="bar ${x.today ? 'is-today' : ''}" title="${x.value}">
      <b>${x.value || ''}</b>
      <span class="bar-col"><span style="height:${(x.value / max) * 100}%"></span></span>
      <small>${x.label}</small>${x.sub != null ? `<small class="bar-sub">${x.sub}</small>` : ''}
    </div>`).join('')}</div>`;
}

/** Alle Decks in Baum-Reihenfolge */
function allDecksInOrder() {
  const out = [];
  const walk = (parentId) => children(parentId).forEach((n) => (n.type === 'deck' && out.push(n), walk(n.id)));
  walk(null);
  return out;
}

function viewStats() {
  const now = Date.now();
  const eod = endOfDay(now);
  const active = Object.values(S.cards).filter((c) => !c.suspended);
  const stock = { new: 0, learning: 0, young: 0, mature: 0, known: Object.keys(S.cards).length - active.length };
  for (const c of active) {
    if (c.state === 'new') stock.new++;
    else if (c.state !== 'review') stock.learning++;
    else if (c.ivl >= MATURE_DAYS) stock.mature++;
    else stock.young++;
  }
  const decks = allDecksInOrder().map((d) => ({ d, c: ownCounts(d.id) })).filter((x) => x.c.total);
  const dueToday = decks.reduce((n, x) => n + x.c.due, 0);
  const reviewsDue = decks.reduce((n, x) => n + x.c.learn + x.c.review, 0);

  // Woche: Wiederholungen und Trefferquote je Tag
  const week = dayKeys(7);
  const weekReviews = week.reduce((n, k) => n + dayCount(k), 0);
  const weekActive = week.filter((k) => dayCount(k)).length;
  const weekBars = week.map((k) => {
    const rate = hitRate([k]);
    return { label: WEEKDAYS[new Date(k + 'T12:00:00').getDay()], value: dayCount(k), sub: rate == null ? '' : `${Math.round(rate * 100)}%`, today: k === dayKey(now) };
  });
  const prevWeek = dayKeys(14).slice(0, 7);
  const rate7 = hitRate(week);
  const ratePrev = hitRate(prevWeek);

  // Vorschau: fällige Wiederholungen der nächsten 7 Tage (Überfälliges zählt zu heute)
  const next = dayKeys(7, 1);
  const forecast = Object.fromEntries(next.map((k) => [k, 0]));
  for (const c of active) {
    if (c.state === 'new') continue;
    const k = c.due <= eod ? next[0] : dayKey(c.due);
    if (k in forecast) forecast[k]++;
  }
  const tagRows = tagCounts(Object.values(S.cards)).map(([t, n]) => [t, n, nodeCounts(ALL, t).due]);
  const total = Object.keys(S.cards).length;
  const seg = (n, cls) => (total ? `<span class="${cls}" style="width:${(n / total) * 100}%"></span>` : '');

  app.innerHTML = `
    <header class="topbar"><span></span><h1>Statistik</h1><span></span></header>
    <main class="page with-tabbar stats">
      <section class="stats-row">
        <div><b>${dueToday}</b><small>Heute fällig</small></div>
        <div><b>${pctText(rate7)}</b><small>Treffer 7 Tage</small></div>
        <div><b>${stock.mature}</b><small>Reife Karten</small></div>
      </section>

      <h3 class="section-label">Letzte 7 Tage</h3>
      <section class="stat-box">
        <div class="stat-line">
          <span><b>${weekReviews}</b> Wiederholungen</span>
          <span><b>${weekActive}</b>/7 Tage gelernt</span>
          <span><b>${Math.round(weekReviews / 7)}</b> pro Tag</span>
        </div>
        ${bars(weekBars)}
        <p class="muted small">Unter den Säulen: Trefferquote (nicht „Schlecht“). ${ratePrev != null && rate7 != null ? `Vorwoche: ${pctText(ratePrev)}.` : ''}</p>
      </section>

      <h3 class="section-label">Fällig in den nächsten 7 Tagen</h3>
      <section class="stat-box">
        ${bars(next.map((k, i) => ({ label: i === 0 ? 'Heute' : WEEKDAYS[new Date(k + 'T12:00:00').getDay()], value: forecast[k], today: i === 0 })), 'forecast')}
        <p class="muted small">Nur Wiederholungen, ohne neue Karten. Heute inklusive Überfälliges.</p>
      </section>

      <h3 class="section-label">Fällig heute je Deck</h3>
      <section class="stat-box deck-due">
        ${decks.length ? decks.map(({ d, c }) => `
          <a class="due-row" href="#/deck/${d.id}">
            <span class="grow">${path(d.id).map((n) => esc(n.name)).join(' › ')}</span>
            <span class="due-split" title="Wiederholen · Neu"><span class="c-sky">${c.learn + c.review}</span> · <span class="muted">${c.newAvail} neu</span></span>
            <b>${c.due}</b>
          </a>`).join('') + `<div class="due-row total"><span class="grow">Gesamt</span><span class="due-split"><span class="c-sky">${reviewsDue}</span> · <span class="muted">${dueToday - reviewsDue} neu</span></span><b>${dueToday}</b></div>`
          : '<p class="muted">Noch keine Karten.</p>'}
      </section>

      ${tagRows.length ? `<h3 class="section-label">Tags</h3>
      <section class="stat-box deck-due">
        ${tagRows.map(([t, n, due]) => `
          <${due ? `a href="${studyHref(ALL, t)}"` : 'div'} class="due-row">
            <span class="grow">#${esc(t)} <span class="muted small">${n} ${n === 1 ? 'Karte' : 'Karten'}</span></span>
            ${due ? `<span class="due-split c-sky">lernen</span>` : ''}<b>${due}</b>
          </${due ? 'a' : 'div'}>`).join('')}
        <p class="muted small">Tippe auf einen Tag, um seine fälligen Karten aus allen Decks zu lernen.</p>
      </section>` : ''}

      <h3 class="section-label">Kartenbestand (${total})</h3>
      <section class="stat-box">
        <div class="progress big">${seg(stock.mature, 'p-mastered')}${seg(stock.young, 'p-young')}${seg(stock.learning, 'p-learning')}${seg(stock.new, 'p-new')}${seg(stock.known, 'p-known')}</div>
        <div class="legend">
          <span><i class="dot p-mastered"></i>${stock.mature} reif (≥ ${MATURE_DAYS} Tage)</span>
          <span><i class="dot p-young"></i>${stock.young} jung</span>
          <span><i class="dot p-learning"></i>${stock.learning} in der Lernphase</span>
          <span><i class="dot p-new"></i>${stock.new} neu</span>
          ${stock.known ? `<span><i class="dot p-known"></i>${stock.known} bekannt</span>` : ''}
        </div>
      </section>
    </main>
    ${tabbar('stats')}`;
}

// ================= Sortiermodus =================
// Noch nie gelernte Karten schnell einordnen – wirkt wie der Status beim Import.
let sorting = null;
const SORT_CHOICES = [
  { key: '1', status: 'bekannt', label: 'Bekannt', sub: 'nicht abfragen', cls: 'good' },
  { key: '2', status: 'eingeschlafen', label: 'Eingeschlafen', sub: 'in 3–4 Tagen', cls: 'hard' },
  { key: '3', status: 'neu', label: 'Neu', sub: 'normal lernen', cls: 'easy' },
];

/** Karten, die noch nie gelernt und noch nicht einsortiert wurden (withSorted: auch die als „Neu“ einsortierten) */
function sortable(deckId, withSorted = false) {
  return cardsWithin(deckId)
    .filter((c) => c.state === 'new' && !c.reps && !c.suspended && (withSorted || !c.sorted))
    .sort((a, b) => a.createdAt - b.createdAt);
}

function startSorting(deckId, withSorted = false) {
  sorting = { deckId, ids: sortable(deckId, withSorted).map((c) => c.id), index: 0, history: [], counts: { bekannt: 0, eingeschlafen: 0, neu: 0 }, withSorted };
}

function sortAnswer(status) {
  const card = S.cards[sorting.ids[sorting.index]];
  if (!card) return;
  sorting.history.push({ id: card.id, before: { ...planOf(card), suspended: !!card.suspended, sorted: !!card.sorted }, status });
  updateCard(card.id, { ...(status === 'neu' ? {} : statusFields(status, S.settings)), sorted: true });
  sorting.counts[status]++;
  sorting.index++;
  session = null; // Lernsitzung neu aufbauen, weil sich Fälligkeiten geändert haben
  stopAudio();
  render();
}

function sortUndo() {
  const h = sorting?.history.pop();
  if (!h) return;
  updateCard(h.id, h.before);
  sorting.counts[h.status]--;
  sorting.index--;
  session = null;
  render();
}

function viewSort(deckId) {
  const d = S.nodes[deckId];
  if (!d) return go('#/');
  if (sorting?.deckId !== deckId) startSorting(deckId);
  // Karten überspringen, die inzwischen gelöscht oder woanders gelernt wurden
  while (sorting.index < sorting.ids.length && S.cards[sorting.ids[sorting.index]]?.state !== 'new') sorting.ids.splice(sorting.index, 1);
  const card = S.cards[sorting.ids[sorting.index]];
  const n = sorting.ids.length;
  const top = `
    <header class="topbar study-top">
      <a class="icon-btn" href="#/deck/${deckId}" data-exit aria-label="Beenden">${icon.close}</a>
      <span class="counter"><b>${Math.min(sorting.index + 1, n)}</b>/${n}</span>
      <button class="icon-btn" data-sort-undo aria-label="Rückgängig" title="Rückgängig (Z)" ${sorting.history.length ? '' : 'disabled'}>${icon.undo}</button>
    </header>
    <div class="study-progress"><span style="width:${n ? (sorting.index / n) * 100 : 100}%"></span></div>`;

  if (!card) {
    const c = sorting.counts;
    const again = !sorting.withSorted && sortable(deckId, true).length;
    app.innerHTML = `${top}
      <main class="page study-done">
        <div class="done-emoji">🗂️</div>
        <h2>${n ? 'Alles sortiert!' : 'Nichts zu sortieren'}</h2>
        <p class="muted">${n ? `${c.bekannt} bekannt · ${c.eingeschlafen} eingeschlafen · ${c.neu} neu` : 'In diesem Deck gibt es keine neuen Karten, die noch nicht einsortiert sind.'}</p>
        ${again ? `<button class="btn ghost" data-again>Auch die als „Neu“ einsortierten (${again}) nochmal durchgehen</button>` : ''}
        <a class="btn primary big" href="#/deck/${deckId}" data-exit>Zurück zum Deck</a>
      </main>`;
    app.querySelectorAll('[data-exit]').forEach((a) => a.addEventListener('click', () => (sorting = null)));
    app.querySelector('[data-sort-undo]').onclick = sortUndo;
    const b = app.querySelector('[data-again]');
    if (b) b.onclick = () => (startSorting(deckId, true), render());
    return;
  }

  const canSpeak = !!koreanSide(card);
  app.innerHTML = `${top}
    <main class="study sort-view">
      <article class="study-card">
        ${canSpeak ? `<button class="speak-btn" data-speak aria-label="Vorlesen" title="Vorlesen (V)">${icon.speaker}</button>` : ''}
        <div class="card-content ${isLong(card.front) ? 'long' : ''}">${sanitize(card.front)}</div>
        <hr />
        <div class="card-content sort-back ${isLong(card.back) ? 'long' : ''}">${sanitize(card.back)}</div>
      </article>
    </main>
    <footer class="study-actions">
      <div class="sort-row">${SORT_CHOICES.map((x) => `<button class="rate ${x.cls}" data-choice="${x.status}">${x.label}<small>${x.sub}</small><kbd>${x.key}</kbd></button>`).join('')}</div>
    </footer>`;
  app.querySelector('[data-exit]').addEventListener('click', () => (sorting = null));
  app.querySelector('[data-sort-undo]').onclick = sortUndo;
  app.querySelectorAll('[data-choice]').forEach((b) => (b.onclick = () => sortAnswer(b.dataset.choice)));
  app.querySelector('[data-speak]')?.addEventListener('click', () => speakCard(card));
  prepareAudio(card);
}

document.addEventListener('keydown', (e) => {
  if (!location.hash.startsWith('#/sort/') || !sorting) return;
  if (document.querySelector('.sheet-backdrop') || e.metaKey || e.ctrlKey || e.altKey) return;
  const choice = SORT_CHOICES.find((x) => x.key === e.key);
  if (choice && sorting.index < sorting.ids.length) sortAnswer(choice.status);
  else if (e.key === 'z' || e.key === 'Backspace') sortUndo();
  else if (e.key === 'v' && app.querySelector('[data-speak]')) speakCard(S.cards[sorting.ids[sorting.index]]);
});

// ================= Abendrunde =================
// Die heute im Tagesplan gelernten Karten noch einmal durchgehen. Die Planung der Karten bleibt unverändert;
// nicht gewusste Karten kommen am Ende der Runde noch einmal.
const isPlanFolderOrDeck = (id) => !!dailyCfg()?.enabled && [dailyCfg().folderId, dailyCfg().learnDeckId].includes(id);
const recapCards = () => (dailyCfg()?.enabled && S.nodes[dailyCfg().learnDeckId] ? cardsOf(dailyCfg().learnDeckId).filter((c) => c.state !== 'new' && !c.suspended) : []);
let recap = null;

function viewRecap() {
  if (!recap || recap.day !== dayKey()) {
    const ids = recapCards().map((c) => c.id).sort(() => Math.random() - 0.5);
    recap = { day: dayKey(), queue: ids, total: ids.length, known: 0, missed: new Set(), revealed: false };
  }
  const card = S.cards[recap.queue[0]];
  const pct = recap.total ? (recap.known / recap.total) * 100 : 100;
  const top = `
    <header class="topbar study-top">
      <a class="icon-btn" href="#/" data-exit aria-label="Beenden">${icon.close}</a>
      <span class="counter">Abendrunde · <b>${recap.known}</b>/${recap.total}</span>
      <span class="icon-btn"></span>
    </header>
    <div class="study-progress"><span style="width:${pct}%"></span></div>`;
  if (!card) {
    const missed = recap.missed.size;
    app.innerHTML = `${top}
      <main class="page study-done">
        <div class="done-emoji">🌙</div>
        <h2>Abendrunde geschafft</h2>
        <p class="muted">${recap.total ? `${recap.total - missed} von ${recap.total} Karten auf Anhieb gewusst.` : 'Heute hast du im Tagesplan noch keine Karten gelernt.'}</p>
        ${missed ? `<p class="muted">${missed} ${missed === 1 ? 'Karte kam' : 'Karten kamen'} noch einmal dran. Morgen fragt der Tagesplan sie wie geplant ab.</p>` : ''}
        <a class="btn primary big" href="#/" data-exit>Zur Startseite</a>
      </main>`;
    app.querySelectorAll('[data-exit]').forEach((a) => a.addEventListener('click', () => (recap = null)));
    return;
  }
  app.innerHTML = `${top}
    <main class="study">
      <article class="study-card">
        <div class="card-content ${isLong(card.front) ? 'long' : ''}">${sanitize(card.front)}</div>
        ${recap.revealed ? `<hr /><div class="card-content ${isLong(card.back) ? 'long' : ''}">${sanitize(card.back)}</div>` : ''}
      </article>
    </main>
    <footer class="study-actions">
      ${recap.revealed
        ? `<div class="rate-row recap-row"><button class="rate again" data-recap="0">Nicht gewusst</button><button class="rate good" data-recap="1">Gewusst</button></div>`
        : `<div class="reveal-row"><span class="kbd-hint">Leertaste</span><button class="reveal" data-reveal>Die Antwort anzeigen</button><span></span></div>`}
    </footer>`;
  app.querySelector('[data-exit]').addEventListener('click', () => (recap = null));
  const show = () => {
    recap.revealed = true;
    viewRecap();
  };
  app.querySelector('[data-reveal]')?.addEventListener('click', show);
  app.querySelector('.study-card').addEventListener('click', () => !recap.revealed && show());
  app.querySelectorAll('[data-recap]').forEach((b) => (b.onclick = () => {
    const id = recap.queue.shift();
    if (b.dataset.recap === '1') recap.known++;
    else {
      recap.missed.add(id);
      recap.queue.push(id); // am Ende noch einmal
    }
    recap.revealed = false;
    viewRecap();
  }));
}

// ================= Tagesplan-Agent =================
/** Neue Karten einer Quelle heute: laut Vokabelplan oder feste Anzahl */
const srcToday = (src, day = dayKey()) => (src.plan ? plannedOn(src.plan, day) : rateFor(src, day));

function viewDaily() {
  const cfg = dailyCfg() ?? defaultCfg();
  const today = dayKey();
  const decks = allDecksInOrder().filter((d) => !isPlanDeck(d.id));
  const srcOf = (id) => cfg.sources.find((s) => s.deckId === id);
  const planText = (rates) => rates.map(([from, n], i) => (i ? `ab ${from.slice(8, 10)}.${from.slice(5, 7)}.: ${n}` : `${n}${from > today ? ` ab ${from.slice(8, 10)}.${from.slice(5, 7)}.` : ''}`)).join(', ');
  const todayTotal = cfg.sources.reduce((n, s) => n + (S.nodes[s.deckId] ? srcToday(s, today) : 0), 0);
  const r = cfg.lastResult;
  const learn = S.nodes[cfg.learnDeckId];

  app.innerHTML = `
    <header class="topbar"><a class="icon-btn" href="#/settings" aria-label="Zurück">${icon.back}</a><h1>Tagesplan</h1><span class="icon-btn"></span></header>
    <main class="page with-tabbar">
      <div class="settings">
        <label class="set-row"><span>Tagesplan-Agent<small>Stellt jeden Tag beim ersten Öffnen das Deck „Lernen“ zusammen</small></span><input type="checkbox" class="switch" data-enabled ${cfg.enabled ? 'checked' : ''} /></label>
      </div>
      <p class="daily-help">Jeden Morgen schiebt der Agent die Karten vom Vortag ins Deck <b>Wiederholen</b> und holt die neuen Karten des Tages aus deinen Vorrats-Decks ins Deck <b>Lernen</b>. Jede Karte bekommt den Tag ihres Ursprungsdecks, z. B. <span class="tag-inline">#yonsei-wortschatz</span>, damit du nach Bereich filtern kannst. Neue Karten, die du nicht geschafft hast, gehen zurück in ihr Deck und kommen am nächsten Tag zuerst dran. So staut sich nichts auf.</p>

      ${cfg.enabled && learn ? `
      <section class="hero daily-hero">
        <h2>${esc(learn.name)}</h2>
        <p>${cardsOf(cfg.learnDeckId).length} Karten in „Lernen“ · ${deckCounts(cfg.reviewDeckId).due} Wiederholungen fällig</p>
        ${r ? `<p class="muted small">Letzter Lauf ${r.day.slice(8, 10)}.${r.day.slice(5, 7)}.: ${r.added} neu${r.fromPlan != null ? ` (${r.fromPlan} laut Plan, ${r.catchUp} nachgeholt)` : ''}, ${r.toReview} ins Wiederholen, ${r.back} zurück in den Vorrat${r.backlog ? ` · ${r.backlog} noch im Rückstand` : ''}${r.unmatched ? ` · ${r.unmatched} Plan-Karten nicht gefunden` : ''}</p>` : ''}
        <div class="empty-actions"><a class="btn primary" href="#/study/${cfg.folderId}">Tagesplan lernen</a><button class="btn ghost" data-rerun>Heute neu zusammenstellen</button>${recapCards().length ? `<a class="btn ghost" href="#/recap">Abendrunde (${recapCards().length})</a>` : ''}</div>
      </section>` : ''}

      <div class="label-row"><h3 class="section-label">Vorrats-Decks und neue Karten pro Tag</h3><span class="muted small">heute ${todayTotal}</span></div>
      <div class="settings">
        ${decks.length ? decks.map((d) => {
          const src = srcOf(d.id);
          const plan = planRatesFor(d.name);
          const crumbs = path(d.id).slice(0, -1).map((n) => n.name).join(' › ');
          return `<div class="set-row daily-src">
            <label class="daily-check"><input type="checkbox" data-src="${d.id}" ${src ? 'checked' : ''} />
              <span><b>${esc(d.name)}</b><small>${crumbs ? esc(crumbs) + ' · ' : ''}noch ${poolLeft(d.id)} neue${src ? ` · #${esc(src.tag)}` : ''}${src?.plan ? ' · nach Vokabelplan' : plan ? ` · Plan: ${planText(plan)}` : ''}</small></span></label>
            ${src?.plan
              ? `<span class="plan-badge" title="laut Vokabelplan heute">${plannedOn(src.plan, today)}</span>`
              : `<input class="input num" type="number" min="0" max="500" data-rate="${d.id}" value="${src ? rateFor(src, today) : ''}" placeholder="–" ${src ? '' : 'disabled'} aria-label="Neue Karten pro Tag" />`}
          </div>`;
        }).join('') : '<p class="muted">Noch keine Decks vorhanden.</p>'}
      </div>
      <button class="link-btn" data-plan>Vokabelplan für die Decks 00–07 verwenden</button>
      <p class="muted small">Decks 00–07 folgen dem Vokabelplan aus deiner Lernplan-App: Er legt für jeden Tag bis zur Korea-Reise fest, welche Karten neu dazukommen, auch an Feiertagen. Andere Decks liefern die eingetragene Anzahl pro Tag.</p>
      <div class="settings">
        <label class="set-row"><span>Höchstens neue Karten pro Tag<small>Gilt nur, wenn verpasste Tage nachgeholt werden. Der Rest kommt an den Folgetagen.</small></span><input class="input num" type="number" min="10" max="300" data-max value="${cfg.maxNew ?? 60}" /></label>
      </div>
    </main>
    ${tabbar('settings')}`;

  const store = () => {
    saveCfg(cfg);
    session = null;
  };
  app.querySelectorAll('[data-src]').forEach((cb) => (cb.onchange = () => {
    const d = S.nodes[cb.dataset.src];
    const no = planNoFor(d.name);
    if (cb.checked) cfg.sources.push({ deckId: d.id, tag: tagFor(d.name), plan: no, rates: planRatesFor(d.name) ?? [[today, 10]] });
    else cfg.sources = cfg.sources.filter((s) => s.deckId !== d.id);
    store();
    viewDaily();
  }));
  app.querySelectorAll('[data-rate]').forEach((inp) => (inp.onchange = () => {
    const src = srcOf(inp.dataset.rate);
    const n = Math.max(0, parseInt(inp.value, 10) || 0);
    if (!src || n === rateFor(src, today)) return;
    src.rates = [...src.rates.filter(([from]) => from < today), [today, n]];
    store();
    toast('Gespeichert – gilt ab heute');
    viewDaily();
  }));
  app.querySelector('[data-plan]').onclick = () => {
    let n = 0;
    for (const s of cfg.sources) {
      const no = planNoFor(S.nodes[s.deckId]?.name ?? '');
      if (no) (s.plan = no), n++;
    }
    store();
    toast(n ? `Vokabelplan für ${n} Decks aktiv` : 'Kein ausgewähltes Deck mit Nummer 00–07');
    viewDaily();
  };
  app.querySelector('[data-max]').onchange = (e) => {
    cfg.maxNew = Math.max(10, parseInt(e.target.value, 10) || 60);
    store();
    toast('Gespeichert');
  };
  app.querySelector('[data-enabled]').onchange = async (e) => {
    if (!e.target.checked) {
      cfg.enabled = false;
      store();
      return viewDaily();
    }
    if (!cfg.sources.length) {
      e.target.checked = false;
      return toast('Wähle zuerst mindestens ein Vorrats-Deck aus');
    }
    const start = await menu([
      { label: 'Heute starten', value: 'today' },
      { label: 'Ab morgen (heute schon gelernt)', value: 'tomorrow' },
    ], 'Schon gelernte Karten dieser Decks kommen ins Deck „Wiederholen“.');
    if (!start || start === -1) {
      e.target.checked = false;
      return;
    }
    cfg.enabled = true;
    saveCfg(cfg);
    // „Ab morgen“: heute nur aufräumen, keine neuen Karten
    if (start === 'tomorrow') cfg.pause = [...(cfg.pause ?? []), today];
    const res = runDaily({ force: true });
    if (start === 'tomorrow') cfg.pause = cfg.pause.filter((d) => d !== today);
    saveCfg(cfg);
    session = null;
    toast(`Tagesplan aktiv: ${res.added} neue Karten, ${res.toReview} ins Wiederholen`);
    viewDaily();
  };
  app.querySelector('[data-rerun]')?.addEventListener('click', async () => {
    if (!(await confirm('Heute neu zusammenstellen?', 'Nicht angefangene Karten gehen zurück in ihr Deck, dann werden die neuen Karten mit den aktuellen Mengen neu geholt. Schon gelernte bleiben erhalten (im Deck „Wiederholen“).', 'Neu zusammenstellen'))) return;
    const res = runDaily({ force: true });
    session = null;
    toast(`${res.added} neue Karten in „Lernen“`);
    viewDaily();
  });
}

// ================= Schnelleingabe =================
// Am Handy schnell einen Satz anlegen: Ziel-Deck vorausgewählt, Rückseite und Tags optional.
const QUICK_DECK_NAME = '08 Eigene Sätze';
const quickUi = { added: [], tags: '' };

function quickDefaultDeck() {
  try {
    const saved = localStorage.getItem('quickDeck');
    if (S.nodes[saved]?.type === 'deck') return saved;
  } catch {}
  return allDecksInOrder().find((d) => /eigene sätze/i.test(d.name))?.id ?? '__new';
}

/** „08 Eigene Sätze“ neben die anderen nummerierten Decks (01 …, 02 …) legen, sonst auf die Startseite */
function createQuickDeck() {
  const sibling = allDecksInOrder().find((d) => /^0\d\b/.test(d.name));
  return createNode('deck', QUICK_DECK_NAME, sibling?.parentId ?? null);
}

function viewQuick() {
  const decks = allDecksInOrder();
  const selected = quickDefaultDeck();
  const hasOwn = decks.some((d) => /eigene sätze/i.test(d.name));
  app.innerHTML = `
    <header class="topbar"><span></span><h1>Neuer Satz</h1><span></span></header>
    <main class="page with-tabbar quick">
      <label class="field-label" for="q-deck">Deck</label>
      <select class="input" id="q-deck" data-deck>
        ${hasOwn ? '' : `<option value="__new" ${selected === '__new' ? 'selected' : ''}>＋ Neues Deck „${QUICK_DECK_NAME}“</option>`}
        ${decks.map((d) => `<option value="${d.id}" ${d.id === selected ? 'selected' : ''}>${path(d.id).map((n) => esc(n.name)).join(' › ')}</option>`).join('')}
      </select>
      <label class="field-label" for="q-front">Vorderseite</label>
      <textarea class="input quick-field" id="q-front" rows="2" enterkeyhint="next" placeholder="z. B. 저는 {{클라이밍}}을 좋아해요." data-front></textarea>
      <label class="field-label" for="q-back">Rückseite <small>(optional)</small></label>
      <textarea class="input quick-field" id="q-back" rows="2" enterkeyhint="next" placeholder="z. B. Ich mag Klettern." data-back></textarea>
      <label class="field-label" for="q-tags">Tags <small>(optional, mit Leerzeichen getrennt)</small></label>
      <input class="input" id="q-tags" enterkeyhint="done" autocomplete="off" autocapitalize="none" placeholder="z. B. klettern alltag" value="${esc(quickUi.tags)}" data-tags />
      <button class="btn primary big" data-quick-save disabled>Speichern</button>
      <p class="hint">Enter springt ins nächste Feld und speichert am Ende, Umschalt + Enter macht einen Zeilenumbruch. <b>{{Wort}}</b> hebt das Zielwort hervor. Die Tags bleiben für die nächste Karte stehen.</p>
      ${quickUi.added.length ? `<h3 class="section-label">Gerade hinzugefügt (${quickUi.added.length})</h3>
        <div class="card-list">${quickUi.added.slice(-5).reverse().filter((id) => S.cards[id]).map((id) => `
          <a class="card-item" href="#/edit/${id}"><div class="card-text"><div class="card-front">${esc(plainText(S.cards[id].front))}</div><div class="card-back">${esc(plainText(S.cards[id].back)) || '–'}</div></div></a>`).join('')}</div>` : ''}
    </main>
    ${tabbar('quick')}`;

  const deckSel = app.querySelector('[data-deck]');
  const front = app.querySelector('[data-front]');
  const back = app.querySelector('[data-back]');
  const tags = app.querySelector('[data-tags]');
  const btn = app.querySelector('[data-quick-save]');
  const fields = [front, back, tags];
  front.addEventListener('input', () => (btn.disabled = !front.value.trim()));
  tags.addEventListener('input', () => (quickUi.tags = tags.value));
  const save = () => {
    const text = front.value.trim();
    if (!text) return front.focus();
    let deckId = deckSel.value;
    if (deckId === '__new') deckId = createQuickDeck().id;
    try {
      localStorage.setItem('quickDeck', deckId);
    } catch {}
    const card = createCard(deckId, fieldToHtml(text), back.value.trim() ? fieldToHtml(back.value.trim()) : '', { tags: parseTags(tags.value) });
    quickUi.added.push(card.id);
    session = null;
    toast('Gespeichert');
    render(); // Felder leeren, Liste aktualisieren
    app.querySelector('[data-front]').focus();
  };
  btn.onclick = save;
  fields.forEach((f, i) => f.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' || e.shiftKey || e.isComposing) return;
    e.preventDefault();
    if (e.metaKey || e.ctrlKey || i === fields.length - 1) save();
    else fields[i + 1].focus();
  }));
  front.focus();
}

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

      <h3 class="section-label">Tagesplan</h3>
      <div class="settings">
        <a class="set-row action" href="#/daily"><span>Tagesplan-Agent<small>${dailyCfg()?.enabled ? `Aktiv · zuletzt ${dailyCfg().lastRun ?? '–'}` : 'Aus · stellt jeden Tag ein Deck „Lernen“ zusammen'}</small></span>${icon.chevron}</a>
      </div>

      <h3 class="section-label">Audio</h3>
      <div class="settings">
        <label class="set-row"><span>Koreanisch automatisch vorlesen<small>Nur auf diesem Gerät · sobald die koreanische Seite zu sehen ist (Taste V liest jederzeit vor)</small></span><input type="checkbox" class="switch" data-autospeak ${audioPrefs.autoSpeak ? 'checked' : ''} /></label>
        <label class="set-row"><span>Sprechtempo<small>Nur auf diesem Gerät</small></span>
          <select class="input num wide" data-rate>${[[0.7, 'Langsam'], [0.9, 'Normal'], [1.1, 'Schnell']].map(([v, l]) => `<option value="${v}" ${audioPrefs.rate === v ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
        <div class="set-row"><span>Koreanische Stimme<small data-voice></small></span><button type="button" class="chip small-chip" data-tts-test>${icon.speaker}Testen</button></div>
      </div>

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
    S.settings = { ...DEFAULT_SETTINGS, nodeSort: S.settings.nodeSort, daily: S.settings.daily };
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
  const voiceInfo = () => {
    const v = koreanVoice();
    const el = app.querySelector('[data-voice]');
    if (!el) return;
    el.textContent = !ttsSupported ? 'Dieser Browser hat keine Sprachausgabe.'
      : v ? v.name
        : 'Nicht gefunden. iPhone: Einstellungen › Bedienungshilfen › Gesprochene Inhalte › Stimmen › Koreanisch. Mac: Systemeinstellungen › Bedienungshilfen › Gesprochene Inhalte › Systemstimme › Stimmen verwalten.';
  };
  voiceInfo();
  setTimeout(voiceInfo, 800); // Chrome liefert die Stimmen erst verzögert
  app.querySelector('[data-autospeak]').onchange = (e) => (audioPrefs.autoSpeak = e.target.checked);
  app.querySelector('[data-rate]').onchange = (e) => (audioPrefs.rate = Number(e.target.value));
  app.querySelector('[data-tts-test]').onclick = () => speak('안녕하세요. 만나서 반가워요.') || toast('Keine Sprachausgabe verfügbar');
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
  else if (view === 'study') viewStudy(id, extra ? decodeURIComponent(extra) : null);
  else if (view === 'import') viewImport(id);
  else if (view === 'settings') viewSettings();
  else if (view === 'stats') viewStats();
  else if (view === 'sort') viewSort(id);
  else if (view === 'quick') viewQuick();
  else if (view === 'daily') viewDaily();
  else if (view === 'recap') viewRecap();
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
const planReady = loadPlan();
const ready = isTestDb ? planReady : initSync(() => {
  if (!/^#\/(add|edit|import|quick)\b/.test(location.hash) && !document.querySelector('.sheet-backdrop')) render();
}).then(() => (getStatus().email ? syncNow() : null)).finally(() => planReady);

// Tagesplan: erst nach dem ersten Abgleich, damit zwei Geräte nicht unabhängig voneinander umstellen
function dailyTick() {
  if (/^#\/(add|edit|import|quick|sort|study)\b/.test(location.hash)) return;
  const res = runDaily();
  if (res) {
    session = null;
    toast(`Tagesplan: ${res.added} neue Karten in „Lernen“`);
    render();
  }
}
ready.catch(() => {}).finally(dailyTick);
document.addEventListener('visibilitychange', () => document.visibilityState === 'visible' && ready.finally(dailyTick));
window.addEventListener('hashchange', () => ready.finally(dailyTick));

if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
