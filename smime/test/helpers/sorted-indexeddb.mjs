// An IndexedDB stand-in that keeps the property some tests depend on: getAll() and
// getAllKeys() return records in ascending key order, as the IndexedDB spec requires
// and browsers do (fake-indexeddb.mjs keeps insertion order). Values go through
// structuredClone both ways, as in a browser.
//
// Supports what src/key-storage.js uses: open + onupgradeneeded, createObjectStore
// ({ keyPath }), createIndex (ignored), transaction(...).objectStore(...),
// put/get/getAll/getAllKeys/delete/clear, request.onsuccess with event.target.result.

const compare = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

export function sortedIndexedDB() {
  const databases = new Map();

  function transaction(db) {
    const request = (fn) => {
      const req = { result: undefined, error: null, onsuccess: null, onerror: null };
      queueMicrotask(() => {
        try {
          req.result = fn();
          req.onsuccess?.({ target: req });
        } catch (err) {
          req.error = err;
          req.onerror?.({ target: req });
        }
      });
      return req;
    };
    return {
      objectStore(name) {
        const store = db.stores.get(name);
        if (!store) throw new Error(`no object store ${name}`);
        const keyOf = (value) => value[store.keyPath];
        const sortedKeys = () => [...store.rows.keys()].sort(compare);
        return {
          put: (value) => request(() => { store.rows.set(keyOf(value), structuredClone(value)); return keyOf(value); }),
          get: (key) => request(() => (store.rows.has(key) ? structuredClone(store.rows.get(key)) : undefined)),
          getAll: () => request(() => sortedKeys().map((k) => structuredClone(store.rows.get(k)))),
          getAllKeys: () => request(() => sortedKeys()),
          delete: (key) => request(() => { store.rows.delete(key); }),
          clear: () => request(() => { store.rows.clear(); }),
          createIndex: () => {},
        };
      },
    };
  }

  return {
    /** The stored rows of one store, in key order, for tests that look inside. */
    rows(dbName, storeName) {
      const store = databases.get(dbName)?.stores.get(storeName);
      if (!store) return [];
      return [...store.rows.keys()].sort(compare).map((k) => structuredClone(store.rows.get(k)));
    },
    /** Writes a row straight into a store, creating database and store if needed (as an older version left them). */
    put(dbName, storeName, keyPath, row) {
      let db = databases.get(dbName);
      if (!db) databases.set(dbName, (db = { stores: new Map(), seeded: true }));
      let store = db.stores.get(storeName);
      if (!store) db.stores.set(storeName, (store = { keyPath, rows: new Map() }));
      store.rows.set(row[keyPath], structuredClone(row));
    },
    open(name) {
      const req = { result: undefined, error: null, onsuccess: null, onerror: null, onupgradeneeded: null, onblocked: null };
      queueMicrotask(() => {
        let db = databases.get(name);
        const fresh = !db;
        if (fresh) {
          db = { stores: new Map() };
          databases.set(name, db);
        }
        req.result = {
          objectStoreNames: { contains: (s) => db.stores.has(s) },
          createObjectStore(s, { keyPath }) {
            const store = { keyPath, rows: new Map() };
            db.stores.set(s, store);
            return { createIndex: () => {} };
          },
          transaction: () => transaction(db),
          close() {},
        };
        // A database seeded with put() stands for one an older version created: the first
        // open runs the upgrade, which adds the stores it lacks.
        if (fresh || db.seeded) {
          db.seeded = false;
          req.onupgradeneeded?.({ target: req });
        }
        req.onsuccess?.({ target: req });
      });
      return req;
    },
  };
}
