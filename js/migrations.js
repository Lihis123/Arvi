import {
  APP_VERSION,
  DEFAULT_SETTINGS,
  DEFAULT_STATUSES,
  PRIORITY_MAP,
  SCHEMA_VERSION,
  STATUS_COLORS
} from './constants.js';

/**
 * Generates a compact, collision-resistant ID without external dependencies.
 */
export function generateId(prefix = 'id') {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return `${prefix}_${crypto.randomUUID()}`;
  }
  const rand = Math.random().toString(36).slice(2, 10);
  return `${prefix}_${Date.now().toString(36)}_${rand}`;
}

/**
 * Computes a deterministic SHA-256 hex digest for backup integrity checks.
 * Falls back gracefully if Web Crypto Subtle is unavailable (e.g. non-secure HTTP dev).
 */
export async function computeChecksum(dataObj) {
  const canonical = JSON.stringify(dataObj);
  if (typeof crypto !== 'undefined' && crypto.subtle && typeof TextEncoder !== 'undefined') {
    const bytes = new TextEncoder().encode(canonical);
    const hashBuf = await crypto.subtle.digest('SHA-256', bytes);
    const hex = Array.from(new Uint8Array(hashBuf))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
    return `sha256:${hex}`;
  }
  // Lightweight FNV-1a 32-bit fallback for environments without SubtleCrypto
  let hash = 0x811c9dc5;
  for (let i = 0; i < canonical.length; i++) {
    hash ^= canonical.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return `fnv1a:${(hash >>> 0).toString(16).padStart(8, '0')}`;
}

/**
 * Validates and normalizes a date string to YYYY-MM-DD (or empty string if invalid).
 */
export function normalizeDate(val) {
  if (typeof val !== 'string') return '';
  const trimmed = val.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return trimmed;
  const parsed = new Date(trimmed);
  if (!Number.isNaN(parsed.getTime())) {
    const y = parsed.getFullYear();
    const m = String(parsed.getMonth() + 1).padStart(2, '0');
    const d = String(parsed.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }
  return '';
}

/**
 * Validates and normalizes a time string to HH:MM (or empty string).
 */
export function normalizeTime(val) {
  if (typeof val !== 'string') return '';
  const trimmed = val.trim();
  if (/^([01]\d|2[0-3]):[0-5]\d$/.test(trimmed)) return trimmed;
  return '';
}

/**
 * Normalizes a single status item, preserving any unknown extra fields for forward compatibility.
 */
export function normalizeStatus(raw, fallbackIndex = 0) {
  if (!raw || typeof raw !== 'object') return null;
  const name = String(raw.name ?? raw.label ?? '').trim();
  if (!name) return null;
  const id = String(raw.id || generateId('st')).trim();
  const color = typeof raw.color === 'string' && /^#[0-9a-fA-F]{3,8}$/.test(raw.color.trim())
    ? raw.color.trim()
    : STATUS_COLORS[fallbackIndex % STATUS_COLORS.length];

  return {
    ...raw,
    id,
    name: name.slice(0, 40),
    color,
    isDone: Boolean(raw.isDone ?? raw.completed ?? false)
  };
}

/**
 * Normalizes a task item, preserving unknown extra fields so future schema fields aren't lost.
 */
export function normalizeTask(raw, validStatusIds, defaultStatusId) {
  if (!raw || typeof raw !== 'object') return null;
  const title = String(raw.title ?? raw.name ?? '').trim();
  if (!title) return null;

  const now = new Date().toISOString();
  const id = String(raw.id || generateId('task')).trim();
  const statusId = validStatusIds.has(raw.statusId) ? raw.statusId : defaultStatusId;
  const priority = PRIORITY_MAP[raw.priority] ? raw.priority : 'normal';
  const deadline = normalizeDate(raw.deadline ?? raw.dueDate ?? '');
  const deadlineTime = normalizeTime(raw.deadlineTime ?? raw.dueTime ?? '');
  const notes = typeof raw.notes === 'string' ? raw.notes : '';

  return {
    ...raw,
    id,
    title: title.slice(0, 200),
    statusId,
    deadline,
    deadlineTime,
    notes,
    priority,
    createdAt: typeof raw.createdAt === 'string' ? raw.createdAt : now,
    updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : now,
    completedAt: typeof raw.completedAt === 'string' || raw.completedAt === null ? raw.completedAt : null
  };
}

/**
 * Normalizes settings while preserving unknown future keys.
 */
export function normalizeSettings(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const theme = ['system', 'light', 'dark'].includes(src.theme) ? src.theme : DEFAULT_SETTINGS.theme;
  const keepDailyBackups = Number.isInteger(src.keepDailyBackups) && src.keepDailyBackups >= 1 && src.keepDailyBackups <= 365
    ? src.keepDailyBackups
    : DEFAULT_SETTINGS.keepDailyBackups;

  return {
    ...DEFAULT_SETTINGS,
    ...src,
    hideDone: Boolean(src.hideDone ?? DEFAULT_SETTINGS.hideDone),
    theme,
    keepDailyBackups,
    autoBackupEnabled: src.autoBackupEnabled === undefined ? DEFAULT_SETTINGS.autoBackupEnabled : Boolean(src.autoBackupEnabled)
  };
}

/**
 * Schema migration registry.
 * Every future breaking schema change adds a step `MIGRATIONS[fromVersion] = (data) => migratedData`.
 * Backups from version 1 will ALWAYS migrate smoothly through 1 -> 2 -> 3 -> ... -> current.
 */
const MIGRATIONS = {
  // Future migrations go here, e.g.:
  // 1: (data) => ({ ...data, ... })
};

/**
 * Builds a versioned, checksummed backup envelope ready to serialize as JSON.
 */
export async function createBackupEnvelope(state) {
  const data = {
    tasks: Array.isArray(state.tasks) ? state.tasks : [],
    statuses: Array.isArray(state.statuses) && state.statuses.length > 0 ? state.statuses : DEFAULT_STATUSES,
    settings: normalizeSettings(state.settings)
  };
  const checksum = await computeChecksum(data);
  return {
    app: 'arvi',
    schemaVersion: SCHEMA_VERSION,
    appVersion: APP_VERSION,
    exportedAt: new Date().toISOString(),
    checksum,
    data
  };
}

/**
 * Parses, verifies, migrates, and normalizes any Arvi backup JSON (old, current, or newer minor versions).
 * Returns `{ ok: true, state, warnings, meta }` or `{ ok: false, error }`.
 */
export async function parseAndMigrateBackup(input) {
  let parsed;
  if (typeof input === 'string') {
    try {
      parsed = JSON.parse(input);
    } catch {
      return { ok: false, error: 'Tiedosto ei ole kelvollista JSON-muotoa.' };
    }
  } else if (input && typeof input === 'object') {
    parsed = input;
  } else {
    return { ok: false, error: 'Varmuuskopion sisältö on virheellinen.' };
  }

  const warnings = [];
  let sourceVersion = 1;
  let rawData;

  if (parsed.data && typeof parsed.data === 'object') {
    // Standard Arvi backup envelope
    if (parsed.app && parsed.app !== 'arvi') {
      return { ok: false, error: 'Tiedosto ei näytä olevan Arvi-sovelluksen varmuuskopio.' };
    }
    sourceVersion = Number.isInteger(parsed.schemaVersion) && parsed.schemaVersion >= 1
      ? parsed.schemaVersion
      : 1;
    rawData = parsed.data;

    // Verify integrity checksum if present
    if (typeof parsed.checksum === 'string' && parsed.checksum.includes(':')) {
      const algo = parsed.checksum.split(':')[0];
      const expected = await computeChecksum(rawData);
      if (expected.startsWith(`${algo}:`) && expected !== parsed.checksum) {
        warnings.push('Tarkistussumma ei täsmännyt — tiedostoa on saatettu muokata käsin, mutta tiedot luettiin silti.');
      }
    }
  } else if (Array.isArray(parsed.tasks) || Array.isArray(parsed)) {
    // Ultra-defensive support for bare/legacy payloads
    rawData = Array.isArray(parsed) ? { tasks: parsed } : parsed;
    warnings.push('Varmuuskopio oli vanhassa tai pelkistetyssä muodossa ja muunnettiin automaattisesti.');
  } else {
    return { ok: false, error: 'Varmuuskopiosta ei löytynyt Arvi-tietoja.' };
  }

  // Run forward migrations step by step
  let working = structuredCloneSafe(rawData);
  if (sourceVersion > SCHEMA_VERSION) {
    warnings.push(
      `Varmuuskopio on uudemmasta versiosta (skeema v${sourceVersion}). Tuetut tiedot palautettiin ja tuntemattomat kentät säilytettiin.`
    );
  } else {
    for (let v = sourceVersion; v < SCHEMA_VERSION; v++) {
      if (typeof MIGRATIONS[v] === 'function') {
        working = MIGRATIONS[v](working);
      }
    }
  }

  // Normalize statuses (always guarantee at least 1 valid status)
  const rawStatuses = Array.isArray(working.statuses) ? working.statuses : [];
  const seenStatusIds = new Set();
  const statuses = [];
  for (let i = 0; i < rawStatuses.length; i++) {
    const st = normalizeStatus(rawStatuses[i], i);
    if (st && !seenStatusIds.has(st.id)) {
      seenStatusIds.add(st.id);
      statuses.push(st);
    }
  }
  const finalStatuses = statuses.length > 0 ? statuses : DEFAULT_STATUSES.map((s) => ({ ...s }));
  const validStatusIds = new Set(finalStatuses.map((s) => s.id));
  const defaultStatusId = finalStatuses[0].id;

  // Normalize tasks (deduplicate by ID, repair broken status references)
  const rawTasks = Array.isArray(working.tasks) ? working.tasks : [];
  const seenTaskIds = new Set();
  const tasks = [];
  let repairedStatuses = 0;

  for (const item of rawTasks) {
    if (item && typeof item === 'object' && item.statusId && !validStatusIds.has(item.statusId)) {
      repairedStatuses++;
    }
    const normalized = normalizeTask(item, validStatusIds, defaultStatusId);
    if (normalized && !seenTaskIds.has(normalized.id)) {
      seenTaskIds.add(normalized.id);
      tasks.push(normalized);
    }
  }

  if (repairedStatuses > 0) {
    warnings.push(`${repairedStatuses} työn puuttuva tila korjattiin oletustilaan "${finalStatuses[0].name}".`);
  }

  const settings = normalizeSettings(working.settings);

  return {
    ok: true,
    state: { tasks, statuses: finalStatuses, settings },
    warnings,
    meta: {
      sourceVersion,
      exportedAt: parsed.exportedAt || null,
      appVersion: parsed.appVersion || null
    }
  };
}

/**
 * Chronological comparator for tasks:
 * 1. Tasks with deadline come before tasks without deadline
 * 2. Earlier deadline date first
 * 3. Earlier deadline time first (tasks with a specific time on that day come before no-time or sorted naturally)
 * 4. Higher priority first
 * 5. Older createdAt first
 */
export function compareTasksChronologically(a, b) {
  const hasA = Boolean(a.deadline);
  const hasB = Boolean(b.deadline);
  if (hasA !== hasB) return hasA ? -1 : 1;

  if (hasA && hasB && a.deadline !== b.deadline) {
    return a.deadline < b.deadline ? -1 : 1;
  }

  const timeA = a.deadlineTime || '99:99';
  const timeB = b.deadlineTime || '99:99';
  if (timeA !== timeB) {
    return timeA < timeB ? -1 : 1;
  }

  const rankA = PRIORITY_MAP[a.priority]?.rank ?? 2;
  const rankB = PRIORITY_MAP[b.priority]?.rank ?? 2;
  if (rankA !== rankB) {
    return rankB - rankA;
  }

  return String(a.createdAt || '').localeCompare(String(b.createdAt || ''));
}

function structuredCloneSafe(obj) {
  if (typeof structuredClone === 'function') {
    return structuredClone(obj);
  }
  return JSON.parse(JSON.stringify(obj));
}
