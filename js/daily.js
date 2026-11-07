// Tagesplan-Agent: stellt jeden Tag im Ordner „Tagesplan“ das Deck „Lernen“ mit den neuen Karten des Tages zusammen.
// Die Karten des Vortags wandern ins Deck „Wiederholen“; nicht gelernte neue Karten gehen zurück in ihr Ursprungsdeck
// (vorne in der Reihe), damit sich nach einem ausgelassenen Tag nichts aufstaut.
// Quelle sind die Themen-Decks („Vorrat“). Jede Karte bekommt beim Verschieben den Tag ihres Ursprungsdecks.
// Decks 00–07 folgen dem festen Vokabelplan (vokabelplan.json, derselbe wie in der Lernplan-App): Er legt für jeden Tag
// fest, welche Karten neu dazukommen. Erkannt werden die Karten am Text ihrer Vorderseite. Andere Decks (z. B. 08 Eigene
// Sätze) liefern eine feste Anzahl pro Tag in der Reihenfolge, in der sie angelegt wurden.
import { S, createNode, cardsOf, createCard, children, settingsChanged, save } from './store.js';
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
// Version des Agenten: Ein Lauf von heute mit älterer Version wird einmal neu zusammengestellt (Fehlerkorrektur 07.11.2026)
const AGENT_VERSION = 2;

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

const isPlanFolder = (n) => n.type === 'folder' && !n.parentId && /^\s*tagesplan\s*$/i.test(n.name);
const isLearnName = (n) => n.type === 'deck' && /^\s*lernen\b/i.test(n.name);
const isReviewName = (n) => n.type === 'deck' && /^\s*wiederholen\b/i.test(n.name);

/**
 * Genau einen Ordner „Tagesplan“ mit je einem Deck „Lernen“ und „Wiederholen“ sicherstellen.
 * Gibt es (z. B. durch einen Lauf vor dem ersten Abgleich auf einem zweiten Gerät) mehrere Tagesplan-Ordner,
 * werden sie zusammengeführt: Karten aus weiteren „Lernen“-/„Wiederholen“-Decks wandern in die Haupt-Decks,
 * andere Decks ziehen in den Hauptordner, die leeren Doppel werden gelöscht. Gibt die Zahl der zusammengeführten Knoten zurück.
 */
function ensureDecks(cfg) {
  const folders = Object.values(S.nodes).filter(isPlanFolder).sort((a, b) => a.createdAt - b.createdAt);
  // Hauptordner: der Ordner, in dem das eingestellte Deck „Lernen“ liegt, sonst der eingestellte, sonst der älteste
  const learnParent = S.nodes[S.nodes[cfg.learnDeckId]?.parentId];
  const main = (learnParent && isPlanFolder(learnParent) ? learnParent : null) ?? (S.nodes[cfg.folderId]?.type === 'folder' ? S.nodes[cfg.folderId] : null) ?? folders[0] ?? createNode('folder', 'Tagesplan', null);
  cfg.folderId = main.id;
  const inPlan = (n) => n && (n.parentId === main.id || folders.some((f) => f.id === n.parentId));
  if (!inPlan(S.nodes[cfg.learnDeckId])) cfg.learnDeckId = (children(main.id).find(isLearnName) ?? folders.flatMap((f) => children(f.id)).find(isLearnName) ?? createNode('deck', 'Lernen', main.id)).id;
  if (!inPlan(S.nodes[cfg.reviewDeckId])) cfg.reviewDeckId = (children(main.id).find(isReviewName) ?? folders.flatMap((f) => children(f.id)).find(isReviewName) ?? createNode('deck', 'Wiederholen', main.id)).id;
  let merged = 0;
  const reparent = (n) => {
    if (n.parentId === main.id) return;
    n.parentId = main.id;
    n.updatedAt = Date.now();
    merged++;
  };
  reparent(S.nodes[cfg.learnDeckId]);
  reparent(S.nodes[cfg.reviewDeckId]);
  for (const f of folders) {
    for (const n of children(f.id)) {
      if (n.id === cfg.learnDeckId || n.id === cfg.reviewDeckId) continue;
      const target = isLearnName(n) ? cfg.learnDeckId : isReviewName(n) ? cfg.reviewDeckId : null;
      if (!target) {
        if (f.id !== main.id) reparent(n);
        continue;
      }
      for (const c of cardsOf(n.id)) move(c, target);
      if (!children(n.id).length) {
        delete S.nodes[n.id];
        merged++;
      } else reparent(n);
    }
    if (f.id !== main.id && !children(f.id).length && !cardsOf(f.id).length) {
      delete S.nodes[f.id];
      merged++;
    }
  }
  if (merged) save();
  return merged;
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
  if (!cfg?.enabled) return null;
  // Daten noch nicht vollständig da (Vokabelplan nicht geladen oder Vorrats-Decks fehlen): nicht umstellen, später erneut versuchen
  if (cfg.sources.some((s) => s.plan) && !plan) return null;
  if (cfg.sources.length && !cfg.sources.some((s) => S.nodes[s.deckId])) return null;
  const merged = ensureDecks(cfg);
  // Heute schon gelaufen: nur neu zusammenstellen, wenn doppelte Ordner zusammengeführt wurden oder der Lauf von einer fehlerhaften Version stammt
  const redo = cfg.lastRun === day && (merged > 0 || (cfg.version ?? 1) < AGENT_VERSION);
  if (cfg.lastRun >= day && !force && !redo) { // >=: auch bei falsch gestellter Uhr nicht rückwärts umstellen
    if (merged) saveCfg(cfg);
    return null;
  }
  const res = { day, toReview: 0, back: 0, added: 0, bySource: {}, merged, redo };

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
  cfg.version = AGENT_VERSION;
  cfg.lastResult = res;
  saveCfg(cfg);
  save();
  return res;
}

/** Noch nicht eingeführte Karten eines Vorrats-Decks */
export const poolLeft = (deckId) => cardsOf(deckId).filter((c) => c.state === 'new' && !c.suspended).length;
