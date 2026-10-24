// Minimal IndexedDB wrapper (no library) for the capture upload queue and the
// ride sample batches. Database "samaan-capture":
//   v1: object store "pending" (keyPath "key")       - photos waiting for upload
//   v2: object store "rideBatches" (keyPath "key")   - accelerometer/GPS batches, key `${rideId}:${seq}`
// Every upgrade step only creates stores that are missing, so a v1 database
// upgrades in place without touching the pending photos.

export const DB_NAME = 'samaan-capture';
export const STORE_PENDING = 'pending';
export const STORE_RIDE_BATCHES = 'rideBatches';
const DB_VERSION = 2;

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
        // Idempotent: each store is created only when missing, whatever the old version was.
        if (!db.objectStoreNames.contains(STORE_PENDING)) {
          db.createObjectStore(STORE_PENDING, { keyPath: 'key' });
        }
        if (!db.objectStoreNames.contains(STORE_RIDE_BATCHES)) {
          db.createObjectStore(STORE_RIDE_BATCHES, { keyPath: 'key' });
        }
      };
      req.onsuccess = () => {
        const db = req.result;
        // Another tab is upgrading: close so it is not blocked; the next call reopens.
        db.onversionchange = () => {
          db.close();
          dbPromise = null;
        };
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
