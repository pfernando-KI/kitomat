// AP10 — Public WebUI Data Bridge
//
// Liest Bibliotheksdaten bevorzugt aus der oeffentlichen Sites Content API (AP9),
// faellt aber ohne API sauber zurueck. Fallback-Reihenfolge:
//
//   1. Sites Content API  (VITE_KITOMAT_CONTENT_API_URL gesetzt)
//   2. Browser Cache      (localStorage, TTL)
//   3. Mockdaten          (web/src/data/library.js)
//
// Status-Werte fuer die Datenquellenanzeige: 'live' | 'cache' | 'stale' | 'fallback'.
// Vertrag und Feld-Mapping stammen aus AP9 (sites-content-api). AP10 dupliziert den
// Vertrag nicht, sondern konsumiert ihn nur.

import { useEffect, useState } from 'react';
import { LIBRARY } from './library.js';
import { contentArtifactUrl } from '../lib/links.js';

const CACHE_KEY = 'kitomat_public_content_cache_v1';
// TTL fuer den Browser-Cache. Bewusst konservativ; die API setzt zusaetzlich
// eigene Cache-Control-Header serverseitig.
const CACHE_TTL_MS = 30 * 60 * 1000;
// Nur diese API-Status gelten als verwertbare Datenquelle. Alles andere
// (z. B. 'error' oder der AP8-Foundation-Stub 'foundation') faellt auf Cache/Mock.
const LIVE_STATUSES = ['live', 'cache', 'stale'];

// In-Memory-Snapshot der letzten erfolgreichen Live-Antwort. Vermeidet beim
// Wechsel zwischen Views (Library -> Detail -> Library) ein Flackern auf Mock.
let memorySnapshot = null;

// VITE_KITOMAT_CONTENT_API_URL wird beim Build ins Bundle geschrieben. Ohne die
// Variable ist Mockdaten-Modus gewollt und kein Fehler.
export function getContentApiBase() {
  const raw = import.meta.env && import.meta.env.VITE_KITOMAT_CONTENT_API_URL;
  // trailing-slash-sicher zusammensetzen
  return raw ? String(raw).trim().replace(/\/$/, '') : '';
}

function contentEndpoint(base) {
  return base + '/api/content';
}

// GitHub-Link bevorzugt aus den API-Daten (githubUrl), sonst aus der Mock-Konvention.
export function artifactGithubUrl(a) {
  if (a && a.githubUrl) return a.githubUrl;
  return contentArtifactUrl(a ? a.id : '');
}

// Normalisiert ein API-Artefakt auf die Form, die die Views erwarten. Pflichtfelder
// aus dem AP9-Vertrag werden durchgereicht; UI-optionale Felder bekommen Defaults,
// damit Karten/Tabellen nicht an undefined zerbrechen. Quelllose Detailfelder
// (pos/nb/neg/sampleIn/sampleOut/failure) bleiben absichtlich leer und werden in
// der Detailansicht ausgeblendet statt leer gerendert.
function normalizeArtifact(raw) {
  return {
    ...raw,
    _source: 'api',
    title: raw.title || raw.id,
    short: raw.short || 'Keine Kurzbeschreibung vorhanden.',
    version: raw.version || '—',
    released: raw.released || '—',
    license: raw.license || '—',
    sources: raw.sources || '—',
    risk: raw.risk || 'yellow',
  };
}

function readCache() {
  try {
    const rec = JSON.parse(localStorage.getItem(CACHE_KEY));
    if (!rec || !Array.isArray(rec.artifacts) || typeof rec.savedAt !== 'number') return null;
    return { ...rec, expired: Date.now() - rec.savedAt > CACHE_TTL_MS };
  } catch (e) {
    return null;
  }
}

function writeCache(artifacts) {
  try {
    localStorage.setItem(
      CACHE_KEY,
      JSON.stringify({ artifacts, savedAt: Date.now() }),
    );
  } catch (e) {
    /* localStorage nicht verfuegbar/voll — kein Fehler, Cache ist optional */
  }
}

function mockResult() {
  return { artifacts: LIBRARY, status: 'fallback', loadedAt: null, cacheUpdatedAt: null };
}

// Bestmoegliche Daten ohne (frische) API-Antwort: gueltiger Cache, sonst Mock.
function offlineResult() {
  if (memorySnapshot && Date.now() - memorySnapshot.savedAt <= CACHE_TTL_MS) {
    return {
      artifacts: memorySnapshot.artifacts,
      status: 'cache',
      loadedAt: memorySnapshot.loadedAt,
      cacheUpdatedAt: memorySnapshot.cacheUpdatedAt,
    };
  }
  const cached = readCache();
  if (cached && !cached.expired && cached.artifacts.length) {
    return {
      artifacts: cached.artifacts,
      status: 'cache',
      loadedAt: null,
      cacheUpdatedAt: cached.savedAt,
    };
  }
  return mockResult();
}

// React-Hook: liefert die anzuzeigende Artefaktliste samt Datenquellenstatus.
// Library, Detail und Dashboard konsumieren ausschliesslich diesen Hook.
export function useLibraryData() {
  const base = getContentApiBase();
  const [state, setState] = useState(() => ({ ...offlineResult(), loading: !!base }));

  useEffect(() => {
    if (!base) return; // Mock-Modus: kein Fetch, keine Fehlermeldung fuer Nutzer
    let cancelled = false;

    (async () => {
      try {
        const res = await fetch(contentEndpoint(base), {
          headers: { Accept: 'application/json' },
        });
        const data = await res.json();
        if (cancelled) return;

        const apiStatus = data && data.status;
        const rawArtifacts = data && Array.isArray(data.artifacts) ? data.artifacts : [];

        // status 'error', unbekannter Status oder leere Liste => unsicherer Zustand.
        // Leere/Fehlerantworten nicht cachen; auf Cache bzw. Mock zurueckfallen.
        if (!LIVE_STATUSES.includes(apiStatus) || rawArtifacts.length === 0) {
          setState({ ...offlineResult(), loading: false });
          return;
        }

        const artifacts = rawArtifacts.map(normalizeArtifact);
        writeCache(artifacts);
        memorySnapshot = {
          artifacts,
          loadedAt: (data && data.loadedAt) || null,
          cacheUpdatedAt: (data && data.cacheUpdatedAt) || null,
          savedAt: Date.now(),
        };
        setState({
          artifacts,
          status: apiStatus,
          loadedAt: memorySnapshot.loadedAt,
          cacheUpdatedAt: memorySnapshot.cacheUpdatedAt,
          loading: false,
        });
      } catch (e) {
        if (cancelled) return;
        // API nicht erreichbar: Cache (falls vorhanden) als 'cache' bzw. Mock als 'fallback'.
        setState({ ...offlineResult(), loading: false });
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [base]);

  return state;
}

// Anzeigetext fuer die Datenquelle (kleine Anzeige in der Library).
export const DATA_SOURCE_LABEL = {
  live: 'Live-Daten aus der Content-API',
  cache: 'Aus Browser-Cache',
  stale: 'Cache (API nicht erreichbar)',
  fallback: 'Beispieldaten (keine API verbunden)',
};
