import {
  listInternalSnapshots,
  loadBackupDirectoryHandle,
  loadBackupMeta,
  saveBackupDirectoryHandle,
  saveBackupMeta,
  saveInternalSnapshot
} from './db.js';
import { createBackupEnvelope, parseAndMigrateBackup } from './migrations.js';
import {
  BACKUP_SUBFOLDER_NAME,
  DAILY_PREFIX,
  DAILY_REGEX,
  DEFAULT_RETENTION,
  LATEST_FILENAME,
  planBackupRetention
} from './retention.js';

function getLocalDateKey(date = new Date()) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export class BackupManager {
  constructor(onStatusChange) {
    this.onStatusChange = onStatusChange || (() => {});
    this.dirHandle = null;
    this.meta = {
      folderName: null,
      lastBackupAt: null,
      lastBackupStatus: 'idle', // 'idle' | 'ok' | 'needs_permission' | 'error' | 'unsupported'
      lastError: null,
      pendingSync: false
    };
    this.debounceTimer = null;
    this.writeInFlight = false;
    this.queuedState = null;
  }

  get supportsFolderPicker() {
    return typeof window !== 'undefined' && typeof window.showDirectoryPicker === 'function';
  }

  getDisplayFolderPath(handle) {
    if (!handle) return null;
    const name = String(handle.name || 'Valittu kansio').trim();
    if (name.toLowerCase() === BACKUP_SUBFOLDER_NAME.toLowerCase()) {
      return name;
    }
    return `${name} / ${BACKUP_SUBFOLDER_NAME}`;
  }

  async resolveTargetDirectory(create = true) {
    if (!this.dirHandle) return null;
    const name = String(this.dirHandle.name || '').trim();
    if (name.toLowerCase() === BACKUP_SUBFOLDER_NAME.toLowerCase()) {
      return this.dirHandle;
    }
    try {
      return await this.dirHandle.getDirectoryHandle(BACKUP_SUBFOLDER_NAME, { create });
    } catch (err) {
      if (!create && err && err.name === 'NotFoundError') {
        return null;
      }
      throw err;
    }
  }

  async init() {
    this.meta = { ...this.meta, ...(await loadBackupMeta()) };
    this.dirHandle = await loadBackupDirectoryHandle();

    if (!this.supportsFolderPicker) {
      this.meta.lastBackupStatus = 'unsupported';
    } else if (this.dirHandle) {
      this.meta.folderName = this.getDisplayFolderPath(this.dirHandle) || this.meta.folderName;
      const perm = await this.queryFolderPermission();
      if (perm === 'granted') {
        this.meta.lastBackupStatus = this.meta.lastBackupAt ? 'ok' : 'idle';
      } else {
        this.meta.lastBackupStatus = 'needs_permission';
      }
    } else {
      this.meta.folderName = null;
      this.meta.lastBackupStatus = 'idle';
    }
    this.emitStatus();
  }

  emitStatus() {
    this.onStatusChange({
      ...this.meta,
      hasFolder: Boolean(this.dirHandle),
      supportsFolderPicker: this.supportsFolderPicker
    });
  }

  async queryFolderPermission() {
    if (!this.dirHandle || typeof this.dirHandle.queryPermission !== 'function') {
      return 'denied';
    }
    try {
      return await this.dirHandle.queryPermission({ mode: 'readwrite' });
    } catch {
      return 'denied';
    }
  }

  /**
   * Prompts user to pick a local backup folder and immediately writes a full backup.
   */
  async chooseBackupFolder(currentState) {
    if (!this.supportsFolderPicker) {
      return {
        ok: false,
        error: 'Selaimesi ei tue paikallisen kansion suoraa valintaa. Suosittelemme Chrome-selainta (Android 132+) tai manuaalista varmuuskopion latausta.'
      };
    }

    try {
      const handle = await window.showDirectoryPicker({
        id: 'arvi-backups',
        mode: 'readwrite',
        startIn: 'documents'
      });

      const perm = await handle.requestPermission({ mode: 'readwrite' });
      if (perm !== 'granted') {
        return { ok: false, error: 'Kansiolle ei annettu kirjoitusoikeutta.' };
      }

      this.dirHandle = handle;
      await saveBackupDirectoryHandle(handle);
      this.meta.folderName = this.getDisplayFolderPath(handle);
      this.meta.lastError = null;
      this.meta.pendingSync = false;
      await saveBackupMeta(this.meta);

      const writeRes = await this.writeFolderBackupNow(currentState, 'folder-selected');
      return writeRes;
    } catch (err) {
      if (err && err.name === 'AbortError') {
        return { ok: false, cancelled: true };
      }
      return { ok: false, error: `Kansion valinta epäonnistui: ${err?.message || err}` };
    }
  }

  /**
   * Re-requests permission for an already chosen folder (required by browsers after session restart).
   * Must be called inside a user click gesture.
   */
  async reauthorizeFolder(currentState) {
    if (!this.dirHandle) {
      return this.chooseBackupFolder(currentState);
    }
    try {
      const perm = await this.dirHandle.requestPermission({ mode: 'readwrite' });
      if (perm !== 'granted') {
        this.meta.lastBackupStatus = 'needs_permission';
        this.emitStatus();
        return { ok: false, error: 'Kansion kirjoitusoikeutta ei vahvistettu.' };
      }
      return await this.writeFolderBackupNow(currentState, 'reauthorized');
    } catch (err) {
      return { ok: false, error: `Oikeuden vahvistus epäonnistui: ${err?.message || err}` };
    }
  }

  async disconnectFolder() {
    this.dirHandle = null;
    await saveBackupDirectoryHandle(null);
    this.meta.folderName = null;
    this.meta.lastBackupStatus = this.supportsFolderPicker ? 'idle' : 'unsupported';
    this.meta.pendingSync = false;
    this.meta.lastError = null;
    await saveBackupMeta(this.meta);
    this.emitStatus();
  }

  /**
   * Schedules an automatic backup after every state mutation (debounced slightly to coalesce rapid edits).
   */
  scheduleAutoBackup(state, reason = 'auto') {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }
    this.queuedState = state;
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      const latest = this.queuedState;
      this.queuedState = null;
      if (latest) {
        this.performAutoBackup(latest, reason);
      }
    }, 450);
  }

  async performAutoBackup(state, reason = 'auto') {
    // Always keep internal IndexedDB snapshots up to date as a second local safety layer
    await saveInternalSnapshot(state, reason);

    if (!state.settings?.autoBackupEnabled) return;
    if (!this.dirHandle) return;

    const perm = await this.queryFolderPermission();
    if (perm !== 'granted') {
      this.meta.lastBackupStatus = 'needs_permission';
      this.meta.pendingSync = true;
      await saveBackupMeta(this.meta);
      this.emitStatus();
      return;
    }

    await this.writeFolderBackupNow(state, reason);
  }

  /**
   * Writes both the latest backup file and a daily dated backup atomically into the chosen local folder.
   */
  async writeFolderBackupNow(state, reason = 'manual') {
    if (!this.dirHandle) {
      return { ok: false, error: 'Varmuuskopiokansiota ei ole valittu.' };
    }
    if (this.writeInFlight) {
      this.queuedState = state;
      return { ok: true, queued: true };
    }

    this.writeInFlight = true;
    try {
      const perm = await this.queryFolderPermission();
      if (perm !== 'granted') {
        this.meta.lastBackupStatus = 'needs_permission';
        this.meta.pendingSync = true;
        await saveBackupMeta(this.meta);
        this.emitStatus();
        return { ok: false, needsPermission: true, error: 'Kansion kirjoitusoikeus vaatii vahvistuksen.' };
      }

      const targetDir = await this.resolveTargetDirectory(true);
      const envelope = await createBackupEnvelope(state);
      const serialized = JSON.stringify(envelope, null, 2);

      // 1. Atomic write to latest backup file inside dedicated Arvi-varmuuskopiot subfolder
      await this.writeTextFile(targetDir, LATEST_FILENAME, serialized);

      // 2. Atomic write to today's dated snapshot
      const todayFilename = `${DAILY_PREFIX}${getLocalDateKey()}.json`;
      await this.writeTextFile(targetDir, todayFilename, serialized);

      // 3. Tiered GFS retention pruning (7 daily + 4 weekly + 6 monthly)
      await this.pruneBackupsWithRetention(targetDir);

      this.meta.lastBackupAt = envelope.exportedAt;
      this.meta.lastBackupStatus = 'ok';
      this.meta.lastError = null;
      this.meta.pendingSync = false;
      this.meta.lastReason = reason;
      await saveBackupMeta(this.meta);
      this.emitStatus();

      return { ok: true, exportedAt: envelope.exportedAt, filename: LATEST_FILENAME };
    } catch (err) {
      console.error('Paikallinen varmuuskopiointi epäonnistui:', err);
      this.meta.lastBackupStatus = 'error';
      this.meta.lastError = err?.message || 'Tuntematon tallennusvirhe';
      this.meta.pendingSync = true;
      await saveBackupMeta(this.meta);
      this.emitStatus();
      return { ok: false, error: this.meta.lastError };
    } finally {
      this.writeInFlight = false;
      if (this.queuedState) {
        const next = this.queuedState;
        this.queuedState = null;
        this.writeFolderBackupNow(next, 'queued');
      }
    }
  }

  async writeTextFile(dirHandle, filename, content) {
    const fileHandle = await dirHandle.getFileHandle(filename, { create: true });
    const writable = await fileHandle.createWritable();
    await writable.write(content);
    await writable.close();
  }

  async pruneBackupsWithRetention(targetDir) {
    if (!targetDir || typeof targetDir.values !== 'function') return;
    try {
      const filenames = [];
      for await (const entry of targetDir.values()) {
        if (entry.kind === 'file' && DAILY_REGEX.test(entry.name)) {
          filenames.push(entry.name);
        }
      }
      const plan = planBackupRetention(filenames, DEFAULT_RETENTION);
      for (const name of plan.delete) {
        try {
          await targetDir.removeEntry(name);
        } catch {
          // Non-critical if deletion fails
        }
      }
    } catch {
      // Directory iteration may not be allowed in some restricted contexts
    }
  }

  /**
   * Lists Arvi backup JSON files currently stored in the dedicated subfolder
   * (plus any legacy backups in the parent folder for backward compatibility).
   */
  async listFolderBackups() {
    if (!this.dirHandle) return [];
    const perm = await this.queryFolderPermission();
    if (perm !== 'granted') return [];

    const files = [];
    const seenNames = new Set();

    const collectFromDir = async (dir, isLegacyParent = false) => {
      if (!dir || typeof dir.values !== 'function') return;
      try {
        for await (const entry of dir.values()) {
          if (entry.kind === 'file' && entry.name.startsWith('arvi-varmuuskopio') && entry.name.endsWith('.json')) {
            if (isLegacyParent && seenNames.has(entry.name)) continue;
            try {
              const file = await entry.getFile();
              seenNames.add(entry.name);
              files.push({
                name: isLegacyParent ? `${entry.name} (juurikansio)` : entry.name,
                lastModified: file.lastModified,
                size: file.size,
                handle: entry,
                isLatest: !isLegacyParent && entry.name === LATEST_FILENAME
              });
            } catch {
              // Skip unreadable entry
            }
          }
        }
      } catch {
        // Ignore unreadable dir
      }
    };

    const targetDir = await this.resolveTargetDirectory(false);
    if (targetDir) {
      await collectFromDir(targetDir, false);
    }
    if (targetDir !== this.dirHandle) {
      await collectFromDir(this.dirHandle, true);
    }

    return files.sort((a, b) => {
      if (a.isLatest) return -1;
      if (b.isLatest) return 1;
      return b.lastModified - a.lastModified;
    });
  }

  async readFolderBackupFile(fileHandle) {
    const file = await fileHandle.getFile();
    const text = await file.text();
    return parseAndMigrateBackup(text);
  }

  /**
   * Triggers a classic browser download of the full JSON backup (works on every browser & OS).
   */
  async downloadManualBackup(state) {
    const envelope = await createBackupEnvelope(state);
    const json = JSON.stringify(envelope, null, 2);
    const blob = new Blob([json], { type: 'application/json;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const filename = `arvi-varmuuskopio-${getLocalDateKey()}.json`;

    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);

    return { ok: true, filename };
  }

  async importFromFile(file) {
    const text = await file.text();
    return parseAndMigrateBackup(text);
  }

  async getInternalSnapshots() {
    return listInternalSnapshots();
  }

  /**
   * Creates a guaranteed pre-update safety backup (internal snapshot + local folder if granted).
   */
  async createSafetyBackupBeforeUpdate(state) {
    await saveInternalSnapshot(state, 'pre-update');
    if (this.dirHandle) {
      const perm = await this.queryFolderPermission();
      if (perm === 'granted') {
        await this.writeFolderBackupNow(state, 'pre-update');
      }
    }
  }
}
