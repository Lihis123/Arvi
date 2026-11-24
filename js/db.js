import { DEFAULT_SETTINGS, DEFAULT_STATUSES, SCHEMA_VERSION } from './constants.js';
import { createBackupEnvelope, normalizeSettings, normalizeStatus, normalizeTask } from './migrations.js';

const DB_NAME = 'arvi-db';
const DB_VERSION = 1;
const STORE_STATE = 'state';
const STORE_HANDLES = 'handles';
const STORE_SNAPSHOTS = 'snapshots';

const MIRROR_KEY = 'arvi_state_mirror_v1';
const MAX_INTERNAL_SNAPSHOTS = 15;

let dbPromise = null;

function openDB() {
  if (typeof indexedDB === 'undefined') {
    return Promise.reject(new Error('IndexedDB ei ole käytettävissä'));
  }
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        dbPromise = null;
        reject(new Error('IndexedDB-yhteys aikakatkaistiin'));
      }
    }, 2500);

    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_STATE)) {
        db.createObjectStore(STORE_STATE);
      }
      if (!db.objectStoreNames.contains(STORE_HANDLES)) {
        db.createObjectStore(STORE_HANDLES);
      }
      if (!db.objectStoreNames.contains(STORE_SNAPSHOTS)) {
        db.createObjectStore(STORE_SNAPSHOTS, { keyPath: 'id', autoIncrement: true });
      }
    };
    req.onsuccess = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(req.result);
    };
    req.onerror = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      dbPromise = null;
      reject(req.error);
    };
    req.onblocked = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      dbPromise = null;
      reject(new Error('IndexedDB on lukittu toisessa välilehdessä'));
    };
  });
  return dbPromise;
}

function txRequest(storeName, mode, operation) {
  return openDB().then(
    (db) =>
      new Promise((resolve, reject) => {
        const tx = db.transaction(storeName, mode);
        const store = tx.objectStore(storeName);
        const req = operation(store);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      })
  );
}

/**
 * Requests persistent browser storage so Android Chrome does not evict IndexedDB under storage pressure.
 */
export async function requestPersistentStorage() {
  try {
    if (navigator.storage && typeof navigator.storage.persist === 'function') {
      return await navigator.storage.persist();
    }
  } catch {
    // Ignore unsupported environments
  }
  return false;
}

export async function isStoragePersisted() {
  try {
    if (navigator.storage && typeof navigator.storage.persisted === 'function') {
      return await navigator.storage.persisted();
    }
  } catch {
    // Ignore
  }
  return false;
}

/**
 * Loads application state from IndexedDB, falling back to localStorage mirror or clean defaults.
 */
export async function loadAppState() {
  let stored = null;
  try {
    stored = await txRequest(STORE_STATE, 'readonly', (s) => s.get('app'));
  } catch (err) {
    console.warn('IndexedDB luku epäonnistui, kokeillaan varakopiota:', err);
  }

  if (!stored) {
    try {
      const mirrorRaw = localStorage.getItem(MIRROR_KEY);
      if (mirrorRaw) {
        stored = JSON.parse(mirrorRaw);
      }
    } catch {
      // Ignore corrupt mirror
    }
  }

  if (!stored || typeof stored !== 'object') {
    return {
      schemaVersion: SCHEMA_VERSION,
      tasks: [],
      statuses: DEFAULT_STATUSES.map((s) => ({ ...s })),
      settings: { ...DEFAULT_SETTINGS }
    };
  }

  const rawStatuses = Array.isArray(stored.statuses) ? stored.statuses : DEFAULT_STATUSES;
  const statuses = rawStatuses.map((s, idx) => normalizeStatus(s, idx)).filter(Boolean);
  const finalStatuses = statuses.length > 0 ? statuses : DEFAULT_STATUSES.map((s) => ({ ...s }));
  const validIds = new Set(finalStatuses.map((s) => s.id));
  const defaultId = finalStatuses[0].id;

  const tasks = (Array.isArray(stored.tasks) ? stored.tasks : [])
    .map((t) => normalizeTask(t, validIds, defaultId))
    .filter(Boolean);

  return {
    schemaVersion: SCHEMA_VERSION,
    tasks,
    statuses: finalStatuses,
    settings: normalizeSettings(stored.settings)
  };
}

/**
 * Saves application state to both IndexedDB and localStorage mirror for maximum durability.
 */
export async function saveAppState(state) {
  const payload = {
    schemaVersion: SCHEMA_VERSION,
    tasks: state.tasks,
    statuses: state.statuses,
    settings: state.settings,
    savedAt: new Date().toISOString()
  };

  try {
    await txRequest(STORE_STATE, 'readwrite', (s) => s.put(payload, 'app'));
  } catch (err) {
    console.warn('IndexedDB tallennus epäonnistui, käytetään localStorage-varakopiota:', err);
  }

  try {
    localStorage.setItem(MIRROR_KEY, JSON.stringify(payload));
  } catch {
    // localStorage might be full if user has thousands of huge notes; IndexedDB is authoritative
  }

  return payload;
}

/**
 * Saves a rolling internal recovery snapshot inside IndexedDB.
 */
export async function saveInternalSnapshot(state, reason = 'auto') {
  try {
    const envelope = await createBackupEnvelope(state);
    const db = await openDB();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_SNAPSHOTS, 'readwrite');
      const store = tx.objectStore(STORE_SNAPSHOTS);
      store.add({
        createdAt: envelope.exportedAt,
        reason,
        taskCount: state.tasks.length,
        envelope
      });

      const getAllKeysReq = store.getAllKeys();
      getAllKeysReq.onsuccess = () => {
        const keys = getAllKeysReq.result;
        if (keys.length > MAX_INTERNAL_SNAPSHOTS) {
          const toDelete = keys.slice(0, keys.length - MAX_INTERNAL_SNAPSHOTS);
          for (const k of toDelete) {
            store.delete(k);
          }
        }
      };

      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch (err) {
    console.warn('Sisäisen palautuspisteen tallennus epäonnistui:', err);
  }
}

export async function listInternalSnapshots() {
  try {
    const rows = await txRequest(STORE_SNAPSHOTS, 'readonly', (s) => s.getAll());
    return rows.sort((a, b) => (b.id || 0) - (a.id || 0));
  } catch {
    return [];
  }
}

/**
 * Persists FileSystemDirectoryHandle in IndexedDB (structured-cloneable).
 */
export async function saveBackupDirectoryHandle(handle) {
  if (!handle) {
    return txRequest(STORE_HANDLES, 'readwrite', (s) => s.delete('backupDir'));
  }
  return txRequest(STORE_HANDLES, 'readwrite', (s) => s.put(handle, 'backupDir'));
}

export async function loadBackupDirectoryHandle() {
  try {
    return (await txRequest(STORE_HANDLES, 'readonly', (s) => s.get('backupDir'))) || null;
  } catch {
    return null;
  }
}

export async function saveBackupMeta(meta) {
  return txRequest(STORE_STATE, 'readwrite', (s) => s.put(meta, 'backupMeta'));
}

export async function loadBackupMeta() {
  try {
    return (await txRequest(STORE_STATE, 'readonly', (s) => s.get('backupMeta'))) || {};
  } catch {
    return {};
  }
}
