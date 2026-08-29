// Lightweight storage layer for running outside the Claude artifact sandbox.
// Mirrors the shape of the `window.storage` API the app was originally built
// against (get/set/delete, throwing on missing keys) but persists to the
// browser's localStorage instead, so the app works as a normal static site.

const PREFIX = "dictation-app:";

function fullKey(key, shared) {
  return `${PREFIX}${shared ? "shared" : "local"}:${key}`;
}

export const storage = {
  async get(key, shared = false) {
    const raw = window.localStorage.getItem(fullKey(key, shared));
    if (raw === null) throw new Error(`Key not found: ${key}`);
    return { key, value: raw, shared };
  },

  async set(key, value, shared = false) {
    window.localStorage.setItem(fullKey(key, shared), value);
    return { key, value, shared };
  },

  async delete(key, shared = false) {
    window.localStorage.removeItem(fullKey(key, shared));
    return { key, deleted: true, shared };
  },

  async list(prefix = "", shared = false) {
    const searchPrefix = fullKey(prefix, shared);
    const base = fullKey("", shared);
    const keys = [];
    for (let i = 0; i < window.localStorage.length; i++) {
      const k = window.localStorage.key(i);
      if (k && k.startsWith(searchPrefix)) keys.push(k.slice(base.length));
    }
    return { keys, prefix, shared };
  },
};
