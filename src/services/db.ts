import * as SQLite from 'expo-sqlite';

let dbPromise: Promise<SQLite.SQLiteDatabase> | null = null;

const MIGRATIONS: string[] = [
  `
  CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL);
  -- Current upload window, persisted every tick so a crash/restart doesn't lose readings.
  CREATE TABLE IF NOT EXISTS window_aggregates (key TEXT PRIMARY KEY NOT NULL, json TEXT NOT NULL);
  -- Offline queue: payloads are only deleted after the broker acknowledges them (QoS 1).
  CREATE TABLE IF NOT EXISTS outbox (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    topic TEXT NOT NULL,
    payload TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0,
    last_error TEXT
  );
  CREATE TABLE IF NOT EXISTS pairings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    barcode TEXT NOT NULL,
    barcode_type TEXT NOT NULL,
    tag_key TEXT NOT NULL,
    tag_uid TEXT NOT NULL,
    tag_name TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    sync_state TEXT NOT NULL,
    remote_id TEXT,
    last_error TEXT
  );
  CREATE UNIQUE INDEX IF NOT EXISTS pairings_tag ON pairings(tag_key) WHERE sync_state != 'pendingDelete';
  `,
];

async function migrate(db: SQLite.SQLiteDatabase) {
  await db.execAsync('PRAGMA journal_mode = WAL;');
  const row = await db.getFirstAsync<{ user_version: number }>('PRAGMA user_version');
  let version = row?.user_version ?? 0;
  while (version < MIGRATIONS.length) {
    await db.withExclusiveTransactionAsync(async (txn) => {
      await txn.execAsync(MIGRATIONS[version]);
      await txn.execAsync(`PRAGMA user_version = ${version + 1}`);
    });
    version++;
  }
}

export function getDb(): Promise<SQLite.SQLiteDatabase> {
  if (!dbPromise) {
    dbPromise = (async () => {
      const db = await SQLite.openDatabaseAsync('paragon.db');
      await migrate(db);
      return db;
    })();
    dbPromise.catch(() => (dbPromise = null));
  }
  return dbPromise;
}
