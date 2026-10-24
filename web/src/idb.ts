// Minimal IndexedDB wrapper (no library) for the capture upload queue.
// Database "samaan-capture", object store "pending", keyPath "key".

export const DB_NAME = 'samaan-capture';
export const STORE_PENDING = 'pending';
const DB_VERSION = 1;

let dbPromise: Promise<IDBDatabase> | null = null;

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('IndexedDB request failed'));
  });
}

function done(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error('IndexedDB transaction failed'));
    tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction aborted'));
  });
}

export function idbAvailable(): boolean {
  return typeof indexedDB !== 'undefined';
}

export function open(): Promise<IDBDatabase> {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      if (!idbAvailable()) {
        reject(new Error('IndexedDB unavailable'));
        return;
      }
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE_PENDING)) {
          db.createObjectStore(STORE_PENDING, { keyPath: 'key' });
        }
      };
      req.onsuccess = () => {
        const db = req.result;
        db.onversionchange = () => db.close();
        resolve(db);
      };
      req.onerror = () => reject(req.error ?? new Error('IndexedDB open failed'));
      req.onblocked = () => reject(new Error('IndexedDB open blocked'));
    });
    dbPromise.catch(() => {
      dbPromise = null;
    });
  }
  return dbPromise;
}

export async function put<T extends { key: string }>(store: string, value: T): Promise<void> {
  const db = await open();
  const tx = db.transaction(store, 'readwrite');
  tx.objectStore(store).put(value);
  await done(tx);
}

export async function getAll<T>(store: string): Promise<T[]> {
  const db = await open();
  const tx = db.transaction(store, 'readonly');
  const rows = await request(tx.objectStore(store).getAll() as IDBRequest<T[]>);
  await done(tx);
  return rows;
}

export async function remove(store: string, key: string): Promise<void> {
  const db = await open();
  const tx = db.transaction(store, 'readwrite');
  tx.objectStore(store).delete(key);
  await done(tx);
}
