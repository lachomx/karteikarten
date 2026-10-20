// Datenhaltung: der gesamte Zustand liegt als ein Objekt in IndexedDB.
// Jeder Eintrag hat id + updatedAt, damit später eine Cloud-Synchronisierung andocken kann.
import { newCardFields, dayKey } from './scheduler.js';

const DB_NAME = 'karteikarten';
const STORE = 'state';
const KEY = 'main';

export const DEFAULT_SETTINGS = {
  newPerDay: 20,
  dailyGoal: 20,           // Wiederholungen pro Tag, damit der Streak zählt
  learnSteps: [1, 8, 15],  // Minuten für Schlecht · Geht so · Gut
  levels: [1, 2, 4, 7, 14, 30, 60, 120, 240, 365], // Intervall-Stufen in Tagen
};

function mergeSettings(saved = {}) {
  const st = { ...DEFAULT_SETTINGS, ...saved };
  if (!Array.isArray(st.learnSteps) || st.learnSteps.length !== 3) st.learnSteps = [...DEFAULT_SETTINGS.learnSteps];
  if (!Array.isArray(st.levels) || !st.levels.length) st.levels = [...DEFAULT_SETTINGS.levels];
  for (const k of ['relearnSteps', 'graduatingIvl', 'easyIvl']) delete st[k]; // Felder der alten Version
  return st;
}

function emptyState() {
  return {
    version: 1,
    nodes: {},   // Ordner und Decks: { id, type: 'folder'|'deck', name, parentId, color, createdAt, updatedAt }
    cards: {},   // { id, deckId, front, back, createdAt, updatedAt, ...Planungsfelder }
    settings: mergeSettings(),
    log: { days: {}, newIntroduced: {} }, // days[YYYY-MM-DD] = Anzahl Wiederholungen; newIntroduced[YYYY-MM-DD][deckId] = n
    lastDeckId: null,
  };
}

export let S = emptyState();

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

let dbPromise = null;
function db() {
  if (!dbPromise) dbPromise = openDb();
  return dbPromise;
}

export async function load() {
  try {
    const d = await db();
    const data = await new Promise((resolve, reject) => {
      const req = d.transaction(STORE).objectStore(STORE).get(KEY);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    if (data) S = { ...emptyState(), ...data, settings: mergeSettings(data.settings) };
    // Karten aus älteren Versionen: bereits in die Tages-Stufen gewechselte Karten gelten als aufgestiegen
    for (const c of Object.values(S.cards)) if (c.climbed === undefined) c.climbed = c.state === 'review';
  } catch (e) {
    console.error('Laden fehlgeschlagen', e);
  }
  return S;
}

let saveTimer = null;
export function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    try {
      const d = await db();
      d.transaction(STORE, 'readwrite').objectStore(STORE).put(S, KEY);
    } catch (e) {
      console.error('Speichern fehlgeschlagen', e);
    }
  }, 150);
}

export function replaceState(data) {
  S = { ...emptyState(), ...data, settings: mergeSettings(data.settings) };
  save();
}

export function resetAll() {
  S = emptyState();
  save();
}

const uid = () => (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random().toString(16).slice(2));

// ---------- Ordner & Decks ----------
const COLORS = ['blue', 'green', 'orange', 'purple', 'red'];

export function createNode(type, name, parentId = null) {
  const now = Date.now();
  const siblings = children(parentId).length;
  const node = { id: uid(), type, name, parentId, color: COLORS[siblings % COLORS.length], createdAt: now, updatedAt: now };
  S.nodes[node.id] = node;
  save();
  return node;
}

export function renameNode(id, name) {
  S.nodes[id].name = name;
  S.nodes[id].updatedAt = Date.now();
  save();
}

export function deleteNode(id) {
  for (const c of children(id)) deleteNode(c.id);
  for (const card of cardsOf(id)) delete S.cards[card.id];
  delete S.nodes[id];
  if (S.lastDeckId === id) S.lastDeckId = null;
  save();
}

export function children(parentId) {
  return Object.values(S.nodes)
    .filter((n) => (n.parentId ?? null) === (parentId ?? null))
    .sort((a, b) => (a.type === b.type ? a.createdAt - b.createdAt : a.type === 'folder' ? -1 : 1));
}

export function path(id) {
  const out = [];
  let n = S.nodes[id];
  while (n) {
    out.unshift(n);
    n = S.nodes[n.parentId];
  }
  return out;
}

export function descendantDecks(id) {
  const n = S.nodes[id];
  if (!n) return [];
  if (n.type === 'deck') return [n];
  return children(id).flatMap((c) => descendantDecks(c.id));
}

// ---------- Karten ----------
export function cardsOf(deckId) {
  return Object.values(S.cards).filter((c) => c.deckId === deckId);
}

export function createCard(deckId, front, back) {
  const now = Date.now();
  const card = { id: uid(), deckId, front, back, createdAt: now, updatedAt: now, ...newCardFields() };
  S.cards[card.id] = card;
  save();
  return card;
}

export function updateCard(id, patch) {
  Object.assign(S.cards[id], patch, { updatedAt: Date.now() });
  save();
}

export function deleteCard(id) {
  delete S.cards[id];
  save();
}

// ---------- Lernprotokoll ----------
export function newIntroducedToday(deckId) {
  return S.log.newIntroduced[dayKey()]?.[deckId] ?? 0;
}

export function finishedToday(deckId) {
  return S.log.finished?.[dayKey()]?.[deckId] ?? 0;
}

/** finished = Karte ist für heute fertig (in eine Tages-Stufe gewechselt) */
export function recordReview(card, wasNew, finished = false) {
  const k = dayKey();
  S.log.days[k] = (S.log.days[k] ?? 0) + 1;
  if (finished) {
    S.log.finished ??= {};
    S.log.finished[k] ??= {};
    S.log.finished[k][card.deckId] = (S.log.finished[k][card.deckId] ?? 0) + 1;
  }
  if (wasNew) {
    S.log.newIntroduced[k] ??= {};
    S.log.newIntroduced[k][card.deckId] = (S.log.newIntroduced[k][card.deckId] ?? 0) + 1;
  }
  S.lastDeckId = card.deckId;
  save();
}

export function reviewsToday() {
  return S.log.days[dayKey()] ?? 0;
}

export function goalReached(key = dayKey()) {
  return (S.log.days[key] ?? 0) >= S.settings.dailyGoal;
}

/** Tage in Folge, an denen das Tagesziel erreicht wurde (heute zählt, sobald es erreicht ist). */
export function streak() {
  let count = 0;
  const d = new Date();
  if (!goalReached(dayKey(d.getTime()))) d.setDate(d.getDate() - 1);
  while (goalReached(dayKey(d.getTime()))) {
    count++;
    d.setDate(d.getDate() - 1);
  }
  return count;
}

/** Längste Serie von Tagen mit erreichtem Tagesziel */
export function longestStreak() {
  const days = Object.keys(S.log.days).filter((k) => goalReached(k)).sort();
  let best = 0, run = 0, prev = null;
  for (const k of days) {
    const t = new Date(k + 'T12:00:00').getTime();
    run = prev != null && Math.round((t - prev) / 86400000) === 1 ? run + 1 : 1;
    best = Math.max(best, run);
    prev = t;
  }
  return best;
}

/** Anzahl Tage mit erreichtem Tagesziel */
export function activeDays() {
  return Object.keys(S.log.days).filter((k) => goalReached(k)).length;
}
