// Audio: Sprachausgabe über die Web Speech API (ko-KR) und eigene Aufnahmen pro Karte.
// Hat eine Karte eine eigene Aufnahme, wird diese statt der Computerstimme abgespielt.
import { getAudio } from './store.js';

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
/** Koreanische Stimme des Systems (Chrome lädt die Liste erst nach kurzer Zeit) */
export function koreanVoice() {
  if (ttsSupported && !voices.length) loadVoices();
  return voices.find((v) => /^ko[-_]KR$/i.test(v.lang) && v.localService) ?? voices.find((v) => /^ko\b/i.test(v.lang)) ?? null;
}

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

/** Liest koreanischen Text vor. Gibt false zurück, wenn es keine Sprachausgabe gibt. */
export function speak(text) {
  if (!ttsSupported || !text) return false;
  stop();
  const u = new SpeechSynthesisUtterance(text);
  u.lang = 'ko-KR';
  const v = koreanVoice();
  if (v) u.voice = v;
  u.rate = audioPrefs.rate;
  speechSynthesis.speak(u);
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

export function playUrl(url) {
  stop();
  player = new Audio(url);
  return player.play().catch(() => {});
}

/** Seite mit Koreanisch: 'front', 'back' oder null */
export function koreanSide(card) {
  return hasKorean(card.front) ? 'front' : hasKorean(card.back) ? 'back' : card.audio ? 'front' : null;
}

/** Spielt die eigene Aufnahme oder liest die koreanische Seite vor. Rückgabe: 'audio' | 'tts' | false */
export function playCard(card) {
  const url = card.audio && urls.get(card.audio.id);
  if (url) {
    playUrl(url);
    return 'audio';
  }
  const side = koreanSide(card);
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
