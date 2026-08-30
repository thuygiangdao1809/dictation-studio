// Storage layer for running outside the Claude artifact sandbox.
// Mirrors the shape of the `window.storage` API the app was originally built
// against (get/set/delete, throwing on missing keys) but persists to the
// browser's IndexedDB instead of localStorage. IndexedDB has a much higher
// quota (typically hundreds of MB up to several GB, vs. localStorage's
// ~5-10MB total), which lets the app store much larger/more audio files.
//
// On first run, any data previously saved under the old localStorage-based
// storage layer is automatically migrated over so existing lessons/history
// aren't lost when upgrading.

const DB_NAME = "dictation-studio-db";
const DB_VERSION = 1;
const STORE_NAME = "kv";
const OLD_LS_PREFIX = "dictation-app:"; // prefix used by the old localStorage layer
const MIGRATION_FLAG = "dictation-studio:idb-migrated";

function fullKey(key, shared) {
  return `${shared ? "shared" : "local"}:${key}`;
}

let dbPromise = null;

function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = window.indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: "fullKey" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error("Failed to open IndexedDB"));
  });
  return dbPromise;
}

function reqToPromise(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error("IndexedDB request failed"));
  });
}

// One-time migration from the old localStorage-based storage layer, so
// upgrading the app doesn't wipe out lessons/history people already saved.
let migratePromise = null;
function migrateFromLocalStorageOnce() {
  if (migratePromise) return migratePromise;
  migratePromise = (async () => {
    try {
      if (window.localStorage.getItem(MIGRATION_FLAG)) return;

      const oldEntries = [];
      for (let i = 0; i < window.localStorage.length; i++) {
        const lsKey = window.localStorage.key(i);
        if (!lsKey || !lsKey.startsWith(OLD_LS_PREFIX)) continue;
        const value = window.localStorage.getItem(lsKey);
        if (value === null) continue;
        // Old format: "dictation-app:local:<key>" or "dictation-app:shared:<key>"
        const rest = lsKey.slice(OLD_LS_PREFIX.length); // "local:<key>" / "shared:<key>"
        const isShared = rest.startsWith("shared:");
        const key = rest.slice(isShared ? "shared:".length : "local:".length);
        oldEntries.push({ key, value, shared: isShared });
      }

      if (oldEntries.length > 0) {
        const db = await openDb();
        const store = db.transaction(STORE_NAME, "readwrite").objectStore(STORE_NAME);
        for (const { key, value, shared } of oldEntries) {
          store.put({ fullKey: fullKey(key, shared), key, value, shared });
        }
        console.info(`[storage] Migrated ${oldEntries.length} item(s) from localStorage to IndexedDB.`);
      }

      window.localStorage.setItem(MIGRATION_FLAG, "1");
    } catch (e) {
      console.warn("[storage] Migration from localStorage skipped/failed:", e);
    }
  })();
  return migratePromise;
}

export const storage = {
  async get(key, shared = false) {
    await migrateFromLocalStorageOnce();
    const db = await openDb();
    const store = db.transaction(STORE_NAME, "readonly").objectStore(STORE_NAME);
    const row = await reqToPromise(store.get(fullKey(key, shared)));
    if (!row) throw new Error(`Key not found: ${key}`);
    return { key, value: row.value, shared };
  },

  async set(key, value, shared = false) {
    await migrateFromLocalStorageOnce();
    const db = await openDb();
    const store = db.transaction(STORE_NAME, "readwrite").objectStore(STORE_NAME);
    await reqToPromise(store.put({ fullKey: fullKey(key, shared), key, value, shared }));
    return { key, value, shared };
  },

  async delete(key, shared = false) {
    await migrateFromLocalStorageOnce();
    const db = await openDb();
    const store = db.transaction(STORE_NAME, "readwrite").objectStore(STORE_NAME);
    await reqToPromise(store.delete(fullKey(key, shared)));
    return { key, deleted: true, shared };
  },

  async list(prefix = "", shared = false) {
    await migrateFromLocalStorageOnce();
    const db = await openDb();
    const store = db.transaction(STORE_NAME, "readonly").objectStore(STORE_NAME);
    const all = await reqToPromise(store.getAll());
    const keys = all
      .filter((row) => row.shared === shared && row.key.startsWith(prefix))
      .map((row) => row.key);
    return { keys, prefix, shared };
  },
};
