// Synchronisierung mit Supabase.
// Prinzip: Jeder Ordner, jedes Deck und jede Karte ist eine Zeile in der Tabelle „items“.
// Hochgeladen wird, was sich seit dem letzten Abgleich lokal geändert hat (Vergleich über updatedAt);
// heruntergeladen wird, was der Server seit dem letzten Abruf neu hat. Bei Konflikten gewinnt die neuere Änderung.
import { S, save, onSave, deviceId } from './store.js';

const SUPABASE_URL = 'https://pjearscszkvvbxipgrkm.supabase.co';
const SUPABASE_KEY = 'sb_publishable_KcXfeuzOgTd4HpSuHsF5EA_QgDJMV8H';
const SUPABASE_LIB = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/+esm';
const PAGE = 1000;
const OVERLAP_MS = 60 * 1000; // beim Abruf etwas überlappen, damit keine gleichzeitigen Änderungen verloren gehen

let client = null;
let user = null;
let running = null;
let again = false;
let applyingRemote = false;
let timer = null;
const status = { state: 'signedOut', lastSync: null, error: null };
const listeners = new Set();

export function onStatus(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
function setStatus(patch) {
  Object.assign(status, patch);
  listeners.forEach((fn) => fn(status));
}
export const getStatus = () => ({ ...status, email: user?.email ?? null });

async function getClient() {
  if (client) return client;
  const { createClient } = await import(SUPABASE_LIB);
  client = createClient(SUPABASE_URL, SUPABASE_KEY, {
    auth: { persistSession: true, autoRefreshToken: true, storageKey: 'karteikarten-auth' },
  });
  return client;
}

// ---------- Anmeldung ----------
export async function initSync(onRemoteChange) {
  remoteChanged = onRemoteChange;
  onSave(() => {
    if (!applyingRemote && user) schedule(4000);
  });
  window.addEventListener('online', () => user && schedule(500));
  document.addEventListener('visibilitychange', () => document.visibilityState === 'visible' && user && schedule(500));
  // Nur laden, wenn schon einmal angemeldet wurde – sonst bleibt die App komplett offline-fähig
  if (!localStorage.getItem('karteikarten-auth')) return;
  try {
    const sb = await getClient();
    const { data } = await sb.auth.getSession();
    user = data.session?.user ?? null;
    setStatus({ state: user ? 'idle' : 'signedOut' });
    if (user) schedule(0);
  } catch (e) {
    setStatus({ state: 'offline', error: 'Keine Verbindung zum Sync-Server' });
  }
}
let remoteChanged = () => {};

export async function signIn(email, password) {
  const sb = await getClient();
  const { data, error } = await sb.auth.signInWithPassword({ email, password });
  if (error) throw new Error(translate(error.message));
  user = data.user;
  setStatus({ state: 'idle', error: null });
  await syncNow();
}

export async function signUp(email, password) {
  const sb = await getClient();
  const { data, error } = await sb.auth.signUp({
    email,
    password,
    options: { emailRedirectTo: location.origin + location.pathname },
  });
  if (error) throw new Error(translate(error.message));
  if (data.session) {
    user = data.user;
    setStatus({ state: 'idle', error: null });
    await syncNow();
    return 'signedIn';
  }
  return 'confirmEmail';
}

export async function signOut() {
  const sb = await getClient();
  await sb.auth.signOut();
  user = null;
  setStatus({ state: 'signedOut', error: null });
}

function translate(msg) {
  if (/invalid login credentials/i.test(msg)) return 'E-Mail oder Passwort ist falsch.';
  if (/email not confirmed/i.test(msg)) return 'Bitte bestätige zuerst deine E-Mail-Adresse (Link in der Bestätigungsmail).';
  if (/already registered/i.test(msg)) return 'Für diese E-Mail gibt es schon ein Konto – bitte anmelden.';
  if (/password should be at least/i.test(msg)) return 'Das Passwort muss mindestens 6 Zeichen lang sein.';
  if (/rate limit/i.test(msg)) return 'Zu viele Versuche – bitte kurz warten.';
  if (/fetch|network/i.test(msg)) return 'Keine Internetverbindung.';
  return msg;
}

// ---------- Abgleich ----------
function schedule(ms) {
  clearTimeout(timer);
  timer = setTimeout(() => syncNow().catch(() => {}), ms);
}

export async function syncNow() {
  if (!user) return;
  if (running) {
    again = true;
    return running;
  }
  running = (async () => {
    setStatus({ state: 'syncing', error: null });
    try {
      const sb = await getClient();
      const changed = await pull(sb);
      await push(sb);
      setStatus({ state: 'idle', lastSync: Date.now() });
      if (changed) remoteChanged();
    } catch (e) {
      console.error('Synchronisierung fehlgeschlagen', e);
      setStatus({ state: navigator.onLine ? 'error' : 'offline', error: translate(String(e?.message ?? e)) });
    } finally {
      running = null;
      if (again) {
        again = false;
        schedule(1000);
      }
    }
  })();
  return running;
}

const key = (kind, id) => `${kind}:${id}`;
const logId = (day) => `${day}|${deviceId}`;

function ownLogDay(day) {
  return {
    reviews: S.log.days[day] ?? 0,
    newIntroduced: S.log.newIntroduced[day] ?? {},
    finished: S.log.finished?.[day] ?? {},
  };
}

/** Änderungen vom Server holen und einarbeiten. Gibt zurück, ob sich lokal etwas geändert hat. */
async function pull(sb) {
  const sync = S.sync;
  const since = sync.lastPulled ? new Date(new Date(sync.lastPulled).getTime() - OVERLAP_MS).toISOString() : null;
  let changed = false;
  let maxSeen = sync.lastPulled;
  applyingRemote = true;
  try {
    for (let from = 0; ; from += PAGE) {
      let q = sb.from('items').select('kind,id,data,deleted,updated_at,server_updated_at').order('server_updated_at').range(from, from + PAGE - 1);
      if (since) q = q.gte('server_updated_at', since);
      const { data, error } = await q;
      if (error) throw error;
      for (const row of data) {
        if (applyRow(row)) changed = true;
        if (!maxSeen || row.server_updated_at > maxSeen) maxSeen = row.server_updated_at;
      }
      if (data.length < PAGE) break;
    }
    sync.lastPulled = maxSeen;
    save();
  } finally {
    applyingRemote = false;
  }
  return changed;
}

function applyRow(row) {
  const k = key(row.kind, row.id);
  const pushed = S.sync.pushed;
  const remoteTime = Number(row.updated_at);

  if (row.kind === 'node' || row.kind === 'card') {
    const coll = row.kind === 'node' ? S.nodes : S.cards;
    const local = coll[row.id];
    if (row.deleted) {
      if (local && (local.updatedAt ?? 0) > remoteTime) return false; // lokal neuer bearbeitet
      delete pushed[k];
      if (!local) return false;
      delete coll[row.id];
      return true;
    }
    if (local) {
      if ((local.updatedAt ?? 0) >= remoteTime) return false; // lokale Version ist aktuell oder neuer
    } else if (pushed[k] != null && pushed[k] >= remoteTime) {
      return false; // lokal gelöscht, nachdem diese Version hochgeladen wurde
    }
    coll[row.id] = row.data;
    pushed[k] = remoteTime;
    return true;
  }

  if (row.kind === 'log') {
    const [day, dev] = row.id.split('|');
    if (dev === deviceId) return false;
    S.remoteLog[dev] ??= {};
    S.remoteLog[dev][day] = row.data;
    // Ein per Backup kopiertes Protokoll desselben Tages nicht doppelt zählen
    if (JSON.stringify(ownLogDay(day)) === JSON.stringify(row.data)) {
      delete S.log.days[day];
      delete S.log.newIntroduced[day];
      delete S.log.finished?.[day];
      delete pushed[key('log', logId(day))];
    }
    return true;
  }

  if (row.kind === 'meta' && row.id === 'settings') {
    if ((S.settingsUpdatedAt ?? 0) >= remoteTime) return false;
    S.settings = { ...S.settings, ...row.data };
    S.settingsUpdatedAt = remoteTime;
    pushed[k] = remoteTime;
    return true;
  }
  return false;
}

/** Lokale Änderungen ermitteln und hochladen */
async function push(sb) {
  const pushed = S.sync.pushed;
  const rows = [];
  const marks = [];

  for (const [kind, coll] of [['node', S.nodes], ['card', S.cards]]) {
    for (const item of Object.values(coll)) {
      const k = key(kind, item.id);
      const t = item.updatedAt ?? item.createdAt ?? 0;
      if (pushed[k] == null || t > pushed[k]) {
        rows.push({ kind, id: item.id, data: item, deleted: false, updated_at: t });
        marks.push([k, t]);
      }
    }
  }
  // Gelöschtes: war schon online, existiert lokal aber nicht mehr
  for (const k of Object.keys(pushed)) {
    const [kind, id] = k.split(/:(.*)/s);
    if ((kind === 'node' && !S.nodes[id]) || (kind === 'card' && !S.cards[id])) {
      rows.push({ kind, id, data: null, deleted: true, updated_at: Date.now() });
      marks.push([k, null]);
    }
  }
  // Lernprotokoll dieses Geräts (pro Tag)
  for (const day of Object.keys(S.log.days)) {
    const k = key('log', logId(day));
    const data = ownLogDay(day);
    const sig = JSON.stringify(data);
    if (pushed[k] !== sig) {
      rows.push({ kind: 'log', id: logId(day), data, deleted: false, updated_at: Date.now() });
      marks.push([k, sig]);
    }
  }
  // Einstellungen
  const st = S.settingsUpdatedAt ?? 0;
  if (st && (pushed['meta:settings'] == null || st > pushed['meta:settings'])) {
    rows.push({ kind: 'meta', id: 'settings', data: S.settings, deleted: false, updated_at: st });
    marks.push(['meta:settings', st]);
  }

  if (!rows.length) return;
  for (let i = 0; i < rows.length; i += 500) {
    const chunk = rows.slice(i, i + 500).map((r) => ({ ...r, user_id: user.id }));
    const { error } = await sb.from('items').upsert(chunk, { onConflict: 'user_id,kind,id' });
    if (error) throw error;
    for (const [k, v] of marks.slice(i, i + 500)) {
      if (v === null) delete pushed[k];
      else pushed[k] = v;
    }
  }
  applyingRemote = true; // Speichern des Sync-Stands soll keinen neuen Abgleich auslösen
  save();
  applyingRemote = false;
}
