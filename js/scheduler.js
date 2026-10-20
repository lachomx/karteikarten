// Spaced Repetition mit festen Stufen: Lernschritte in Minuten, danach Intervall-Stufen in Tagen.
// Bewertungen: 1 = Schlecht, 2 = Geht so, 3 = Gut, 4 = Sehr gut

export const MIN = 60 * 1000;
export const DAY = 24 * 60 * MIN;
const MAX_IVL = 36500;

export function startOfDay(t = Date.now()) {
  const d = new Date(t);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

export function endOfDay(t = Date.now()) {
  return startOfDay(t) + DAY - 1;
}

export function dayKey(t = Date.now()) {
  const d = new Date(t);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function newCardFields() {
  return { state: 'new', due: 0, ivl: 0, level: 0, goods: 0, climbed: false, step: 0, reps: 0, lapses: 0 };
}

const PLAN_FIELDS = ['state', 'due', 'ivl', 'level', 'goods', 'climbed', 'step', 'reps', 'lapses'];
export function planOf(card) {
  return Object.fromEntries(PLAN_FIELDS.map((k) => [k, card[k]]));
}

/** Höchste Stufe, deren Intervall nicht größer als ivl ist (für Karten ohne gespeicherte Stufe). */
function levelFor(ivl, levels) {
  let k = 0;
  levels.forEach((d, i) => d <= ivl && (k = i));
  return k;
}

function toReview(c, level, s, now, goods = 0) {
  c.state = 'review';
  c.step = 0;
  c.goods = goods;
  c.level = Math.min(Math.max(level, 0), s.levels.length - 1);
  c.ivl = Math.min(MAX_IVL, s.levels[c.level]);
  c.due = startOfDay(now) + c.ivl * DAY;
  return c;
}

function relearn(c, level, mins, now) {
  c.state = 'relearning';
  c.goods = 0;
  c.level = Math.max(level, 0);
  c.due = now + mins * MIN;
  return c;
}

/**
 * Stufenmodell (Bewertungen: 1 Schlecht · 2 Geht so · 3 Gut · 4 Sehr gut):
 * - Neue Karte:          Schlecht 1 Min · Geht so 8 Min · Gut 15 Min · Sehr gut 1. Stufe (1 Tag)
 * - Nach „Gut“ (15 Min): Schlecht 1 Min · Geht so 15 Min · Gut 1. Stufe · Sehr gut 2. Stufe
 * - Gelernte Karte auf Stufe k:
 *     Schlecht 1 Min (zurück auf Stufe 1) · Geht so 15 Min (eine Stufe runter)
 *     Gut: auf der 1. Stufe erst beim zweiten „Gut“ in Folge eine Stufe höher, ab der 2. Stufe sofort
 *     Sehr gut: immer eine Stufe über „Gut“
 * Liefert die neuen Planungsfelder (verändert die Karte nicht).
 */
export function schedule(card, rating, s, now = Date.now()) {
  const c = rate(card, rating, s, now);
  // Aufgestiegen: aus der Lernphase in die Tages-Stufen gewechselt oder eine Stufe höher gerutscht
  const fromLearning = card.state === 'new' || card.state === 'learning';
  c.climbed = c.state === 'review' && (fromLearning || c.level > (card.level ?? 0));
  return c;
}

function rate(card, rating, s, now) {
  const c = planOf(card);
  c.reps += 1;
  const [againMin, hardMin, goodMin] = s.learnSteps;

  if (c.state === 'new' || c.state === 'learning') {
    const atLastStep = c.state === 'learning' && c.step >= 1;
    c.state = 'learning';
    if (rating === 1) {
      c.step = 0;
      c.due = now + againMin * MIN;
    } else if (rating === 2) {
      c.due = now + (atLastStep ? goodMin : hardMin) * MIN;
    } else if (rating === 3) {
      if (atLastStep) return toReview(c, 0, s, now);
      c.step = 1;
      c.due = now + goodMin * MIN;
    } else {
      return toReview(c, atLastStep ? 1 : 0, s, now);
    }
    return c;
  }

  // Wiederholung (review) oder Wiederlernen (relearning)
  const k = c.level ?? levelFor(c.ivl, s.levels);
  if (rating === 1) {
    if (c.state === 'review') c.lapses += 1;
    return relearn(c, 0, againMin, now);
  }
  if (rating === 2) return relearn(c, c.state === 'review' ? k - 1 : k, goodMin, now);
  if (c.state === 'relearning') return toReview(c, rating === 3 ? k : k + 1, s, now);
  // Auf der ersten Stufe braucht „Gut“ zwei Anläufe, danach steigt die Karte sofort
  const climbs = k > 0 || (c.goods ?? 0) >= 1;
  const goodLevel = climbs ? k + 1 : k;
  if (rating === 3) return toReview(c, goodLevel, s, now, goodLevel === k ? (c.goods ?? 0) + 1 : 0);
  return toReview(c, goodLevel + 1, s, now);
}

/** Kurztext wie bei Noji: 1Min, 8Min, 3Std, 4Tg, 2,5Mo, 1J */
export function formatInterval(plan, now = Date.now()) {
  if (plan.state !== 'review') {
    const mins = Math.max(1, Math.round((plan.due - now) / MIN));
    return mins < 60 ? `${mins}Min` : `${Math.round(mins / 60)}Std`;
  }
  const d = plan.ivl;
  const fmt = (n) => String(Math.round(n * 10) / 10).replace('.', ',');
  if (d < 30) return `${d}Tg`;
  if (d < 365) return `${fmt(d / 30)}Mo`;
  return `${fmt(d / 365)}J`;
}

/** Kategorie für die Deck-Übersicht: „gemeistert“ ist eine Karte, die bei der letzten Abfrage
 *  aufgestiegen ist – bis sie wieder fällig wird. */
export function category(card, now = Date.now()) {
  if (card.state === 'new') return 'new';
  if (card.state === 'review' && card.climbed && card.due > now) return 'mastered';
  return 'learning';
}
