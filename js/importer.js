// Massenimport: Text/CSV in Karten zerlegen.
import { esc, sanitize } from './ui.js';

export const SEPARATORS = { auto: 'Automatisch', '\t': 'Tab', ';': 'Semikolon ;', ',': 'Komma ,', ' - ': 'Bindestrich -' };
export const EMPTY_BACK = '<i>(Rückseite war im Export leer – evtl. ein Bild)</i>';

export function detectSeparator(text) {
  const lines = text.split(/\r?\n/).filter((l) => l.trim() && !l.startsWith('#')).slice(0, 30);
  for (const sep of ['\t', ';', ' - ', ',']) {
    if (lines.length && lines.filter((l) => l.includes(sep)).length >= Math.ceil(lines.length * 0.6)) return sep;
  }
  return '\t';
}

/** Zerlegt Text in Zeilen und Spalten; Felder in Anführungszeichen dürfen Trennzeichen und Zeilenumbrüche enthalten. */
export function parseRows(text, sep) {
  if (sep === ' - ') {
    return text.split(/\r?\n/).map((l) => {
      const i = l.indexOf(' - ');
      return i < 0 ? [l] : [l.slice(0, i), l.slice(i + 3)];
    });
  }
  const rows = [];
  let row = [], field = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') (field += '"'), i++;
      else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"' && !field.trim()) {
      quoted = true;
      field = '';
    } else if (ch === sep) {
      row.push(field);
      field = '';
    } else if (ch === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else if (ch !== '\r') {
      field += ch;
    }
  }
  row.push(field);
  rows.push(row);
  return rows;
}

// Wörter mit Großbuchstaben in der Mitte, die nicht getrennt werden dürfen
const CAMEL_WORDS = new Set(['cogniplus', 'rehacom', 'patientinnen', 'ebooks', 'iphone', 'ipad', 'youtube', 'powerpoint', 'whatsapp', 'linkedin', 'mcdonald', 'mcdonalds', 'ecampus', 'olat', 'moodle']);

/**
 * Noji (und andere Apps) entfernen beim CSV-Export die Zeilenumbrüche, sodass Listen zusammenkleben:
 * „HirnschädigungZum Beispiel“, „Therapieerfolges.Heterogene“, „(F00)Vaskuläre“.
 * Wir setzen dort wieder einen Umbruch, wo ein Großbuchstabe ohne Leerzeichen direkt folgt.
 */
export function restoreLineBreaks(text) {
  return text
    // nach Satzzeichen oder schließender Klammer/Anführung
    .replace(/([.!?:)\]“”»])(?=[A-ZÄÖÜ][a-zäöüß])/g, '$1\n')
    // nach schließender Klammer direkt gefolgt von einem Wort: „(…, freshminder)adaptiv“
    .replace(/\)(?=[a-zäöüß]{2})/g, ')\n')
    // Kleinbuchstabe direkt gefolgt von Großbuchstabe (außer bei bekannten Wörtern wie „CogniPlus“)
    .replace(/([a-zäöüß])(?=[A-ZÄÖÜ])/g, (m, ch, offset, str) => {
      const start = str.slice(0, offset + 1).search(/[A-Za-zÄÖÜäöüß]+$/);
      const end = offset + 1 + str.slice(offset + 1).search(/[^A-Za-zÄÖÜäöüß]|$/);
      return CAMEL_WORDS.has(str.slice(start, end).toLowerCase()) ? ch : ch + '\n';
    });
}

export function fieldToHtml(t, restore = false) {
  if (/<[a-z][\s\S]*>/i.test(t)) return sanitize(t);
  return esc(restore ? restoreLineBreaks(t) : t).replace(/\n/g, '<br>');
}

/**
 * Liefert { sep, cards: [[frontHtml, backHtml]], skipped, emptyBack }.
 * Zeilen ohne Trennzeichen werden übersprungen; Karten mit leerer Rückseite bekommen einen Platzhalter.
 */
export function parseImport(text, sepChoice, { restore = false } = {}) {
  const sep = sepChoice === 'auto' ? detectSeparator(text) : sepChoice;
  const cards = [];
  let skipped = 0, emptyBack = 0;
  for (const r of parseRows(text, sep)) {
    const cells = r.map((x) => x.trim());
    if (!cells.join('') || cells[0].startsWith('#')) continue; // Leerzeilen und Anki-Kopfzeilen
    if (cells.length < 2 || !cells[0]) {
      skipped++;
      continue;
    }
    if (!cells[1]) emptyBack++;
    cards.push([fieldToHtml(cells[0], restore), cells[1] ? fieldToHtml(cells[1], restore) : EMPTY_BACK]);
  }
  return { sep, cards, skipped, emptyBack };
}
