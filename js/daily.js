// Tagesplan-Agent: stellt jeden Tag im Ordner „Tagesplan“ das Deck „Lernen“ mit den neuen Karten des Tages zusammen.
// Die Karten des Vortags wandern ins Deck „Wiederholen“; nicht gelernte neue Karten gehen zurück in ihr Ursprungsdeck
// (vorne in der Reihe), damit sich nach einem ausgelassenen Tag nichts aufstaut.
// Quelle sind die Themen-Decks („Vorrat“). Jede Karte bekommt beim Verschieben den Tag ihres Ursprungsdecks.
// Decks 00–07 folgen dem festen Vokabelplan (vokabelplan.json, derselbe wie in der Lernplan-App): Er legt für jeden Tag
// fest, welche Karten neu dazukommen. Erkannt werden die Karten am Text ihrer Vorderseite. Andere Decks (z. B. 08 Eigene
// Sätze) liefern eine feste Anzahl pro Tag in der Reihenfolge, in der sie angelegt wurden.
import { S, createNode, cardsOf, createCard, settingsChanged, save } from './store.js';
import { dayKey } from './scheduler.js';

// Mengen für Decks ohne Vokabelplan (Anzeige und Vorgabe), erkannt an der Nummer am Anfang des Decknamens
const PLAN_RATES = {
  '01': [['2026-11-02', 35], ['2026-11-16', 20]],
  '02': [['2026-11-02', 2]],
  '03': [['2026-11-02', 4]],
  '04': [['2026-11-16', 3]],
  '05': [['2026-12-07', 3]],
  '06': [['2026-12-14', 3]],
  '07': [['2026-11-16', 10]],
  '08': [['2026-11-21', 8]],
};

const WD = ['So', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa'];
const ACTIVE_PER_DAY = 5; // neue Karten Deutsch → Koreanisch pro Tag
const ACTIVE_MIN_IVL = 7; // erst ab dieser Intervall-Stufe (Tage) kommt eine Karte in die Gegenrichtung
const MAX_NEW = 60; // höchstens so viele neue Karten pro Tag, wenn verpasste Tage nachgeholt werden

// ---------- Vokabelplan ----------
let plan = null; // { '01': Map(Schlüssel → { date, nr }) }, ... }
let planToday = {}; // Datum → { '01': Anzahl }
export async function loadPlan() {
  try {
    const data = await (await fetch('vokabelplan.json')).json();
    plan = {};
    planToday = {};
    for (const [date, list] of Object.entries(data.days)) {
      for (const [deck, nr, key] of list) {
        (plan[deck] ??= new Map()).set(key, { date, nr });
        (planToday[date] ??= {})[deck] = (planToday[date][deck] ?? 0) + 1;
      }
    }
  } catch (e) {
    console.warn('Vokabelplan nicht geladen', e);
  }
}
export const planLoaded = () => !!plan;
/** Laut Vokabelplan neue Karten eines Decks an einem Tag */
export const plannedOn = (deckNo, day = dayKey()) => planToday[day]?.[deckNo] ?? 0;
export const planNoFor = (name) => (plan && plan[deckNo(name)] ? deckNo(name) : null);

const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'", apos: "'", nbsp: ' ' };
/** Schlüssel einer Karte: Text der Vorderseite ohne HTML und ohne Leerraum (wie in der Lernplan-App) */
export function planKey(html) {
  return String(html ?? '')
    .replace(/<[^>]*>/g, '')
    .replace(/&(#\d+|#x[0-9a-f]+|\w+);/gi, (m, e) => ENT[e.toLowerCase()] ?? (e[0] === '#' ? String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : Number(e.slice(1))) : m))
    .replace(/\s+/g, '');
}

export const dailyCfg = () => S.settings.daily ?? null;
const active = () => !!dailyCfg()?.enabled;
export const isPoolDeck = (id) => active() && dailyCfg().sources.some((s) => s.deckId === id);
export const isLearnDeck = (id) => active() && dailyCfg().learnDeckId === id;
export const isPlanDeck = (id) => !!dailyCfg() && [dailyCfg().learnDeckId, dailyCfg().reviewDeckId].includes(id);

/** „01 Yonsei-Wortschatz“ → „yonsei-wortschatz“ */
export function tagFor(name) {
  return name.replace(/^\s*\d+[\s._-]*/, '').trim().toLowerCase().replace(/[\s,#:;.]+/g, '-').replace(/^-+|-+$/g, '') || 'karten';
}
/** Deck-Nummer am Namensanfang als zweistellige Zeichenkette: „01 Yonsei“ und „1. Yonsei“ → „01“ */
const deckNo = (name) => name.trim().match(/^(\d{1,2})(?!\d)/)?.[1].padStart(2, '0') ?? null;
export const planRatesFor = (name) => PLAN_RATES[deckNo(name)] ?? null;

/** Neue Karten pro Tag für eine Quelle an einem Tag */
export function rateFor(src, day = dayKey()) {
  let n = 0;
  for (const [from, k] of src.rates ?? []) if (day >= from) n = k;
  return n;
}

export function saveCfg(cfg) {
  S.settings.daily = cfg;
  settingsChanged();
}

export function defaultCfg() {
  return { enabled: false, maxNew: MAX_NEW, activePerDay: ACTIVE_PER_DAY, folderId: null, learnDeckId: null, reviewDeckId: null, sources: [], pause: [], lastRun: null, lastResult: null };
}

/** Ordner „Tagesplan“ mit den Decks „Lernen“ und „Wiederholen“ anlegen, falls sie fehlen */
function ensureDecks(cfg) {
  if (!S.nodes[cfg.folderId]) cfg.folderId = createNode('folder', 'Tagesplan', null).id;
  if (!S.nodes[cfg.learnDeckId]) cfg.learnDeckId = createNode('deck', 'Lernen', cfg.folderId).id;
  if (!S.nodes[cfg.reviewDeckId]) cfg.reviewDeckId = createNode('deck', 'Wiederholen', cfg.folderId).id;
}

function move(card, deckId, extra = {}) {
  Object.assign(card, { deckId, ...extra, updatedAt: Date.now() });
}
const withTag = (card, tag) => (tag && !(card.tags ?? []).includes(tag) ? [...(card.tags ?? []), tag] : card.tags ?? []);

/** Deutsche Seite als Frage: Hinweise in Klammern mit koreanischem Text würden die Antwort verraten */
const withoutKoreanHints = (html) => html.replace(/\s*\([^()]*[가-힯ㄱ-ㅎㅏ-ㅣ][^()]*\)/g, '');

/** Legt für sichere Karten aus Deck 00 die Gegenrichtung an. Die feste id verhindert Doppelte, wenn zwei Geräte umstellen. */
function addActiveCards(cfg) {
  const src = cfg.sources.find((s) => s.plan === '00');
  if (!src) return 0;
  const waiting = cardsOf(cfg.learnDeckId).filter((c) => c.activeOf && c.state === 'new').length;
  const room = Math.max(0, (cfg.activePerDay ?? ACTIVE_PER_DAY) - waiting);
  const ready = Object.values(S.cards)
    .filter((c) => c.origin === src.deckId && !c.activeOf && !c.activeDone && !c.suspended && c.state === 'review' && c.ivl >= ACTIVE_MIN_IVL && !S.cards[`aktiv-${c.id}`])
    .sort((a, b) => a.createdAt - b.createdAt)
    .slice(0, room);
  for (const c of ready) {
    createCard(cfg.learnDeckId, withoutKoreanHints(c.back), c.front, { id: `aktiv-${c.id}`, activeOf: c.id, tags: withTag(c, 'aktiv') });
    c.activeDone = true;
    c.updatedAt = Date.now();
  }
  return ready.length;
}

/**
 * Tageswechsel ausführen. Läuft einmal pro Tag; mit force wird der heutige Tag neu zusammengestellt
 * (schon gelernte Karten bleiben dabei erhalten und kommen ins Wiederholen-Deck).
 * Gibt das Ergebnis zurück oder null, wenn nichts zu tun war.
 */
export function runDaily({ force = false, day = dayKey() } = {}) {
  const cfg = dailyCfg();
  if (!cfg?.enabled || (cfg.lastRun >= day && !force)) return null; // >=: auch bei falsch gestellter Uhr nicht rückwärts umstellen
  ensureDecks(cfg);
  const res = { day, toReview: 0, back: 0, added: 0, bySource: {} };

  // 1. Karten aus „Lernen“: gelernte → Wiederholen, nicht angefangene → zurück ins Ursprungsdeck
  for (const c of cardsOf(cfg.learnDeckId)) {
    if (c.activeOf && c.state === 'new') continue; // Gegenrichtung: wartet im Deck „Lernen“, zählt aufs Tagesmaß
    if (c.state === 'new' && S.nodes[c.origin]) {
      move(c, c.origin);
      res.back++;
    } else {
      move(c, cfg.reviewDeckId);
      res.toReview++;
    }
  }

  // 2. Schon gelernte Karten im Vorrat (z. B. vor dem Start des Agenten gelernt) → Wiederholen
  for (const src of cfg.sources) {
    if (!S.nodes[src.deckId]) continue;
    for (const c of cardsOf(src.deckId)) {
      if (c.state !== 'new' && !c.suspended) {
        move(c, cfg.reviewDeckId, { origin: src.deckId, tags: withTag(c, src.tag) });
        res.toReview++;
      }
    }
  }

  // 3a. Decks mit Vokabelplan: die Karten von heute, dazu verpasste Tage (älteste zuerst) bis zur Höchstzahl
  const paused = (cfg.pause ?? []).includes(day);
  const planSrc = plan ? cfg.sources.filter((s) => s.plan && plan[s.plan] && S.nodes[s.deckId]) : [];
  if (!paused && planSrc.length) {
    const due = [];
    let today = 0;
    for (const src of planSrc) {
      const known = new Set();
      for (const c of Object.values(S.cards)) {
        if (c.deckId !== src.deckId && c.origin !== src.deckId) continue;
        const key = planKey(c.front);
        known.add(key);
        const p = plan[src.plan].get(key);
        if (c.deckId === src.deckId && c.state === 'new' && !c.suspended && p && p.date <= day) due.push({ c, src, ...p });
      }
      for (const [key, p] of plan[src.plan]) {
        if (p.date !== day) continue;
        today++;
        if (!known.has(key)) res.unmatched = (res.unmatched ?? 0) + 1;
      }
    }
    due.sort((a, b) => a.date.localeCompare(b.date) || a.src.plan.localeCompare(b.src.plan) || a.nr - b.nr);
    const take = due.slice(0, Math.max(today, cfg.maxNew ?? MAX_NEW));
    for (const { c, src } of take) {
      move(c, cfg.learnDeckId, { origin: src.deckId, tags: withTag(c, src.tag) });
      res.bySource[src.deckId] = (res.bySource[src.deckId] ?? 0) + 1;
    }
    res.added += take.length;
    res.fromPlan = take.filter((x) => x.date === day).length;
    res.catchUp = take.length - res.fromPlan;
    res.backlog = due.length - take.length;
  }

  // 3b. Übrige Vorrats-Decks: feste Anzahl pro Tag
  if (!paused) {
    for (const src of cfg.sources) {
      if (!S.nodes[src.deckId] || planSrc.includes(src)) continue;
      const n = rateFor(src, day);
      const fresh = cardsOf(src.deckId).filter((c) => c.state === 'new' && !c.suspended).sort((a, b) => a.createdAt - b.createdAt).slice(0, n);
      for (const c of fresh) move(c, cfg.learnDeckId, { origin: src.deckId, tags: withTag(c, src.tag) });
      if (fresh.length) res.bySource[src.deckId] = fresh.length;
      res.added += fresh.length;
    }
  }

  // 4. Aktiver Abruf: sicher erkannte häufige Wörter zusätzlich von Deutsch nach Koreanisch (häufigste zuerst)
  if (!paused) res.active = addActiveCards(cfg);

  const d = new Date(day + 'T12:00:00');
  const learn = S.nodes[cfg.learnDeckId];
  learn.name = `Lernen · ${WD[d.getDay()]} ${day.slice(8, 10)}.${day.slice(5, 7)}.`;
  learn.updatedAt = Date.now();
  cfg.lastRun = day;
  cfg.lastResult = res;
  saveCfg(cfg);
  save();
  return res;
}

/** Noch nicht eingeführte Karten eines Vorrats-Decks */
export const poolLeft = (deckId) => cardsOf(deckId).filter((c) => c.state === 'new' && !c.suspended).length;
