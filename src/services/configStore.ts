import { create } from 'zustand';

import { type AppConfig, DEFAULT_CONFIG, mergeConfig } from '@/core/config';
import { getDb } from './db';

const KEY = 'app_config';

function newGatewayId(): string {
  let s = '';
  for (let i = 0; i < 12; i++) s += Math.floor(Math.random() * 16).toString(16);
  return `PGW-${s.toUpperCase()}`;
}

interface ConfigState {
  config: AppConfig;
  loaded: boolean;
  load: () => Promise<AppConfig>;
  save: (next: AppConfig) => Promise<void>;
}

export const useConfig = create<ConfigState>((set, get) => ({
  config: DEFAULT_CONFIG,
  loaded: false,
  async load() {
    if (get().loaded) return get().config;
    const db = await getDb();
    const row = await db.getFirstAsync<{ value: string }>('SELECT value FROM settings WHERE key = ?', KEY);
    let config = mergeConfig(row ? JSON.parse(row.value) : null);
    if (!config.other.gatewayId) {
      // Modern Android/iOS don't expose the IMEI; generate a stable gateway id once.
      config = { ...config, other: { ...config.other, gatewayId: newGatewayId() } };
      await persist(config);
    }
    set({ config, loaded: true });
    return config;
  },
  async save(next) {
    await persist(next);
    set({ config: next });
  },
}));

async function persist(c: AppConfig) {
  const db = await getDb();
  await db.runAsync(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    KEY,
    JSON.stringify(c),
  );
}

export const getConfig = () => useConfig.getState().config;
