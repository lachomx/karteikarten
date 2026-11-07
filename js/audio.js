// Audio: eigene Aufnahmen pro Karte, fertige Aussprache-Dateien und Sprachausgabe über die Web Speech API (ko-KR).
// Reihenfolge: eigene Aufnahme → Aussprache-Datei (für alle Karten des Vokabelplans, Stimme „Yuna“) → Sprachausgabe.
// Die Dateien laufen als normales Audio und funktionieren daher auch auf dem iPhone zuverlässig.
import { getAudio } from './store.js';
import { planKey } from './daily.js';

// ---------- Aussprache-Dateien (erzeugt mit Koreanisch/tools/audio.mjs, liegen bei der Lernplan-App) ----------
const AUDIO_BASE = 'https://lachomx.github.io/lernplan/audio/';
let audioIndex = new Set();
fetch(AUDIO_BASE + 'index.json')
  .then((r) => (r.ok ? r.json() : []))
  .then((keys) => (audioIndex = new Set(keys)))
  .catch(() => {});
export const audioFileCount = () => audioIndex.size;

/** Schlüssel einer Karte: 64-Bit-FNV-1a über die Vorderseite ohne HTML (wie audioKey in tools/audio.mjs) */
function audioKey(text) {
  let a = 0x811c9dc5, b = 0x050c5d1f;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    a = Math.imul(a ^ c, 0x01000193) >>> 0;
    b = Math.imul(b ^ c, 0x01000193) >>> 0;
  }
  return a.toString(16).padStart(8, '0') + b.toString(16).padStart(8, '0');
}
const fileUrl = (card) => {
  // Umgedrehte Karten (Deutsch → Koreanisch): die Datei gehört zur ursprünglichen Vorderseite, jetzt die Rückseite
  const k = [card.front, card.back].map((side) => audioKey(planKey(side))).find((key) => audioIndex.has(key));
  return k ? AUDIO_BASE + k + '.m4a' : null;
};

const HANGUL = /[ᄀ-ᇿ㄰-㆏가-힯]/;
export const ttsSupported = typeof speechSynthesis !== 'undefined';
export const recordSupported = typeof MediaRecorder !== 'undefined' && !!navigator.mediaDevices?.getUserMedia;

// ---------- Einstellungen (pro Gerät, z. B. unterwegs stumm) ----------
const pref = (k, fallback) => {
  try {
    return localStorage.getItem(k) ?? fallback;
  } catch {
    return fallback;
  }
};
export const audioPrefs = {
  get autoSpeak() { return pref('autoSpeak', '0') === '1'; },
  set autoSpeak(v) { localStorage.setItem('autoSpeak', v ? '1' : '0'); },
  get rate() { return Number(pref('ttsRate', '0.9')) || 0.9; },
  set rate(v) { localStorage.setItem('ttsRate', String(v)); },
};

// ---------- Stimmen ----------
let voices = [];
const loadVoices = () => (voices = speechSynthesis.getVoices());
if (ttsSupported) {
  loadVoices();
  speechSynthesis.addEventListener?.('voiceschanged', loadVoices);
}
// Apples Spaß- und Effektstimmen klingen für Vokabeln unpassend; Standard- und hochwertige Stimmen bevorzugen
const NOVELTY = /eddy|flo|grandma|grandpa|reed|rocko|sandy|shelley|bad news|bells|boing|bubbles|cellos|jester|organ|trinoids|whisper|zarvox/i;
const voiceScore = (v) =>
  (/premium|enhanced|erweitert|siri|neural/i.test(v.name) ? 4 : 0) + (/yuna|google/i.test(v.name) ? 2 : 0) + (v.localService ? 1 : 0) - (NOVELTY.test(v.name) ? 5 : 0);

/** Koreanische Stimme des Systems (Chrome lädt die Liste erst nach kurzer Zeit) */
export function koreanVoice() {
  if (ttsSupported && !voices.length) loadVoices();
  const ko = voices.filter((v) => /^ko([-_]|$)/i.test(v.lang));
  return ko.sort((a, b) => voiceScore(b) - voiceScore(a))[0] ?? null;
}

// ---------- Freischalten (iPhone) ----------
// iOS spielt Sprachausgabe erst nach einer Berührung ab und schaltet sie im Lautlos-Modus stumm.
// Beim ersten Tippen: Audio-Sitzung auf „Wiedergabe“ stellen, ein stummes Mini-Audio abspielen
// (schaltet die Seite auf Wiedergabe) und eine leere Ansage starten (gibt die Sprachausgabe frei).
const SILENT_WAV = 'data:audio/wav;base64,UklGRrQBAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YZABAACAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICA';
let unlocked = false;
function unlockAudio() {
  if (unlocked) return;
  unlocked = true;
  try {
    if (navigator.audioSession) navigator.audioSession.type = 'playback';
  } catch {}
  try {
    new Audio(SILENT_WAV).play().catch(() => {});
  } catch {}
  if (ttsSupported && !speechSynthesis.speaking) {
    const u = new SpeechSynthesisUtterance(' ');
    u.volume = 0;
    speechSynthesis.speak(u);
  }
}
if (typeof window !== 'undefined') for (const t of ['touchend', 'click', 'keydown']) window.addEventListener(t, unlockAudio, { capture: true, once: true });

/** Text einer Seite ohne HTML; Zeilen (Umbrüche, Blöcke) bleiben getrennt */
function linesOf(root) {
  root.querySelectorAll('br').forEach((br) => br.replaceWith('\n'));
  root.querySelectorAll('div, p, li, h3').forEach((el) => el.append('\n'));
  return (root.textContent ?? '').split('\n');
}

export const hasKorean = (html) => HANGUL.test(String(html ?? '').replace(/<[^>]*>/g, ''));

/**
 * Was vorgelesen wird: HTML-Tags und {{ }} entfernt. Bei gemischten Seiten nur das Koreanische –
 * Anmerkungen (graue Schrift, kursive Übersetzungen) und lateinische Wörter fallen weg.
 */
export function speechText(html) {
  const tpl = document.createElement('template');
  tpl.innerHTML = String(html ?? '').replace(/\{\{|\}\}/g, '');
  const root = tpl.content;
  for (const el of root.querySelectorAll('font, i, em, sup, sub')) {
    const next = el.nextSibling, parent = el.parentNode;
    el.remove();
    if (!HANGUL.test(root.textContent)) parent.insertBefore(el, next); // ohne sie bliebe nichts Koreanisches übrig
  }
  return linesOf(root)
    .filter((l) => HANGUL.test(l))
    .map((l) => l.replace(/[A-Za-zÄÖÜäöüß]+\.?/g, ' ').replace(/[/·|=()[\]]+/g, ', ').replace(/\s*,[\s,]*/g, ', ').replace(/([!?.]),/g, '$1').replace(/\s+/g, ' ').replace(/^[\s,.:;-]+|[\s,:;-]+$/g, ''))
    .filter(Boolean)
    .join('. ');
}

export function stop() {
  if (ttsSupported) speechSynthesis.cancel();
  if (player) player.pause();
}

let current = null; // Referenz halten: Safari und Chrome verwerfen sonst laufende Ansagen
/** Liest koreanischen Text vor. Gibt false zurück, wenn es keine Sprachausgabe gibt. */
export function speak(text) {
  if (!ttsSupported || !text) return false;
  unlockAudio();
  if (player) player.pause();
  const u = new SpeechSynthesisUtterance(text);
  u.lang = 'ko-KR';
  const v = koreanVoice();
  if (v) u.voice = v;
  u.rate = audioPrefs.rate;
  u.onerror = (e) => {
    if (!['interrupted', 'canceled'].includes(e.error)) window.dispatchEvent(new CustomEvent('tts-error', { detail: e.error }));
  };
  current = u;
  // Safari verschluckt eine Ansage, die direkt nach cancel() startet: nur abbrechen, wenn nötig, dann kurz warten
  const busy = speechSynthesis.speaking || speechSynthesis.pending;
  if (busy) speechSynthesis.cancel();
  speechSynthesis.resume(); // iOS bleibt sonst manchmal im Pausenzustand hängen
  if (busy) setTimeout(() => current === u && speechSynthesis.speak(u), 120);
  else speechSynthesis.speak(u);
  return true;
}

// ---------- Eigene Aufnahmen ----------
// Die Blob-URLs werden beim Anzeigen der Karte vorbereitet, damit das Abspielen direkt im Tipp passiert
// (iOS spielt Audio sonst nicht ab).
const urls = new Map();
let player = null;

export async function prepareAudio(card) {
  const id = card?.audio?.id;
  if (!id || urls.has(id)) return;
  const blob = await getAudio(id).catch(() => null);
  if (blob) urls.set(id, URL.createObjectURL(blob));
}

export function playUrl(url, onFail) {
  stop();
  player = new Audio(url);
  if (onFail) player.onerror = onFail;
  return player.play().catch((e) => e?.name !== 'AbortError' && onFail?.());
}

/** Seite mit Koreanisch: 'front', 'back' oder null */
export function koreanSide(card) {
  return hasKorean(card.front) ? 'front' : hasKorean(card.back) ? 'back' : card.audio ? 'front' : null;
}

/** Spielt die eigene Aufnahme, die Aussprache-Datei oder liest die koreanische Seite vor. Rückgabe: 'audio' | 'file' | 'tts' | false */
export function playCard(card) {
  const url = card.audio && urls.get(card.audio.id);
  if (url) {
    playUrl(url);
    return 'audio';
  }
  const side = koreanSide(card);
  const file = side && fileUrl(card);
  if (file) {
    playUrl(file, () => speak(speechText(card[side]))); // ohne Netz: Sprachausgabe als Ersatz
    return 'file';
  }
  return side && speak(speechText(card[side])) ? 'tts' : false;
}

/** Aufnahme mit dem Mikrofon. Rückgabe: { stop: () => Promise<Blob> } */
export async function startRecording() {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  // mp4/AAC spielen Safari und Chrome ab; sonst das Standardformat des Browsers (meist webm)
  const type = ['audio/mp4', 'audio/webm;codecs=opus', 'audio/webm'].find((t) => MediaRecorder.isTypeSupported?.(t));
  const rec = new MediaRecorder(stream, type ? { mimeType: type } : undefined);
  const chunks = [];
  rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
  rec.start();
  return {
    stop: () => new Promise((resolve) => {
      rec.onstop = () => {
        stream.getTracks().forEach((t) => t.stop());
        resolve(new Blob(chunks, { type: rec.mimeType || type || 'audio/webm' }));
      };
      rec.stop();
    }),
  };
}
