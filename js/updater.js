import { APP_VERSION } from './constants.js';

/**
 * Compares two semver strings (e.g. "1.2.0" vs "1.1.9").
 * Returns 1 if a > b, -1 if a < b, 0 if equal.
 */
export function compareVersions(a, b) {
  const pa = String(a || '0.0.0').replace(/^v/, '').split('.').map((n) => parseInt(n, 10) || 0);
  const pb = String(b || '0.0.0').replace(/^v/, '').split('.').map((n) => parseInt(n, 10) || 0);
  const len = Math.max(pa.length, pb.length, 3);
  for (let i = 0; i < len; i++) {
    const na = pa[i] || 0;
    const nb = pb[i] || 0;
    if (na > nb) return 1;
    if (na < nb) return -1;
  }
  return 0;
}

export class AppUpdater {
  constructor() {
    this.registration = null;
  }

  /**
   * Registers the offline-first Service Worker once.
   * Note: updateViaCache:'all' avoids unsolicited network revalidation on normal launches,
   * and the SW never calls skipWaiting() automatically — updates ONLY apply when the user requests them.
   */
  async registerServiceWorker() {
    if (!('serviceWorker' in navigator)) return null;
    try {
      this.registration = await navigator.serviceWorker.register('./sw.js', {
        scope: './',
        updateViaCache: 'all'
      });
      return this.registration;
    } catch (err) {
      console.warn('Service Worker -rekisteröinti epäonnistui:', err);
      return null;
    }
  }

  /**
   * Explicitly checks GitHub Pages / origin for a newer version.json ONLY when user clicks the button.
   */
  async checkForUpdates() {
    if (typeof navigator !== 'undefined' && navigator.onLine === false) {
      return {
        ok: false,
        offline: true,
        message: 'Ei verkkoyhteyttä. Päivityksiä ei voitu tarkistaa — sovellus toimii normaalisti ilman yhteyttä.'
      };
    }

    try {
      const url = `./version.json?arvi_update_check=${Date.now()}`;
      const res = await fetch(url, {
        cache: 'no-store',
        headers: { 'Cache-Control': 'no-cache' }
      });

      if (!res.ok) {
        return {
          ok: false,
          message: `Päivityspalvelimeen ei saatu yhteyttä (HTTP ${res.status}).`
        };
      }

      const remote = await res.json();
      const remoteVersion = String(remote.version || '').trim();
      if (!remoteVersion) {
        return { ok: false, message: 'Versiotietoa ei voitu lukea palvelimelta.' };
      }

      const cmp = compareVersions(remoteVersion, APP_VERSION);
      if (cmp > 0) {
        return {
          ok: true,
          updateAvailable: true,
          currentVersion: APP_VERSION,
          latestVersion: remoteVersion,
          releasedAt: remote.releasedAt || null,
          changelog: Array.isArray(remote.changelog) ? remote.changelog : []
        };
      }

      return {
        ok: true,
        updateAvailable: false,
        currentVersion: APP_VERSION,
        latestVersion: remoteVersion,
        message: `Käytössäsi on jo uusin versio (v${APP_VERSION}).`
      };
    } catch {
      return {
        ok: false,
        offline: true,
        message: 'Yhteyttä päivityspalvelimeen ei saatu. Tarkista verkkoyhteys ja yritä uudelleen.'
      };
    }
  }

  /**
   * Downloads and installs the update ONLY after the user explicitly confirms.
   * Always creates a local safety backup first.
   */
  async installUpdate(currentState, backupManager) {
    if (backupManager) {
      await backupManager.createSafetyBackupBeforeUpdate(currentState);
    }

    if (!('serviceWorker' in navigator)) {
      window.location.reload();
      return;
    }

    const reg = this.registration || (await navigator.serviceWorker.getRegistration('./'));
    if (!reg) {
      window.location.reload();
      return;
    }

    // Listen for controller swap so we reload right after the new SW takes control
    let reloaded = false;
    const triggerReload = () => {
      if (reloaded) return;
      reloaded = true;
      window.location.reload();
    };
    navigator.serviceWorker.addEventListener('controllerchange', triggerReload, { once: true });

    try {
      await reg.update();
    } catch {
      // Continue with fallback refresh if update() fails
    }

    const waiting = reg.waiting;
    if (waiting) {
      waiting.postMessage({ type: 'APPLY_UPDATE' });
      setTimeout(triggerReload, 1500);
      return;
    }

    const installing = reg.installing;
    if (installing) {
      await new Promise((resolve) => {
        const timeout = setTimeout(resolve, 10000);
        installing.addEventListener('statechange', () => {
          if (installing.state === 'installed') {
            clearTimeout(timeout);
            installing.postMessage({ type: 'APPLY_UPDATE' });
            resolve();
          } else if (installing.state === 'redundant') {
            clearTimeout(timeout);
            resolve();
          }
        });
      });
      setTimeout(triggerReload, 1500);
      return;
    }

    // If sw.js itself didn't change, ask active SW to refresh all cached app files from network
    if (reg.active) {
      await new Promise((resolve) => {
        const channel = new MessageChannel();
        const timeout = setTimeout(resolve, 10000);
        channel.port1.onmessage = () => {
          clearTimeout(timeout);
          resolve();
        };
        reg.active.postMessage({ type: 'REFRESH_CACHE' }, [channel.port2]);
      });
    }

    triggerReload();
  }
}
