import ParagonNative from '@modules/paragon-native';
import { AppState } from 'react-native';
import { create } from 'zustand';

import type { WindowAggregate } from '@/core/aggregator';
import { buildGatewayPayload } from '@/core/payload';
import { getConfig } from './configStore';
import { getDb } from './db';
import { getGpsFix } from './location';
import { log } from './logger';
import { ensureMqtt, getMqtt, stopMqtt, tickMqtt } from './mqttService';
import { scanService } from './scanService';

const TICK_MS = 5000;
const OUTBOX_BATCH = 10;
const OUTBOX_MAX_ROWS = 5000;
const OUTBOX_MAX_AGE_MS = 7 * 24 * 3600_000;

interface GatewayState {
  running: boolean;
  lastUploadAt: number | null;
  lastUploadCount: number;
  lastError: string | null;
  outboxSize: number;
  windowSize: number;
}

export const useGateway = create<GatewayState>(() => ({
  running: false,
  lastUploadAt: null,
  lastUploadCount: 0,
  lastError: null,
  outboxSize: 0,
  windowSize: 0,
}));

let subs: { remove(): void }[] = [];
let lastUploadAt = 0;
let busySince: number | null = null;

function uploadIntervalMs(): number {
  const o = getConfig().other;
  return (AppState.currentState === 'active' ? o.foregroundUploadSeconds : o.backgroundUploadSeconds) * 1000;
}

async function persistWindow(rows: WindowAggregate[]) {
  const db = await getDb();
  await db.withExclusiveTransactionAsync(async (txn) => {
    await txn.runAsync('DELETE FROM window_aggregates');
    for (const r of rows) {
      await txn.runAsync('INSERT INTO window_aggregates (key, json) VALUES (?, ?)', r.tag.key, JSON.stringify(r));
    }
  });
}

async function restoreWindow() {
  const db = await getDb();
  const rows = await db.getAllAsync<{ json: string }>('SELECT json FROM window_aggregates');
  if (rows.length) {
    scanService.aggregator.restoreWindow(rows.map((r) => JSON.parse(r.json) as WindowAggregate));
    log.info('gateway', `restored ${rows.length} unsent readings`);
  }
}

async function refreshOutboxSize() {
  const db = await getDb();
  const row = await db.getFirstAsync<{ n: number }>('SELECT COUNT(*) AS n FROM outbox');
  useGateway.setState({ outboxSize: row?.n ?? 0 });
}

async function enqueueUpload(now: number) {
  const rows = scanService.aggregator.takeWindow();
  if (rows.length === 0) return;
  const cfg = getConfig();
  const gps = await getGpsFix();
  const payload = buildGatewayPayload(rows, gps, cfg, now);
  const db = await getDb();
  await db.withExclusiveTransactionAsync(async (txn) => {
    await txn.runAsync(
      'INSERT INTO outbox (topic, payload, created_at) VALUES (?, ?, ?)',
      cfg.mqtt.topic,
      JSON.stringify(payload),
      now,
    );
    await txn.runAsync('DELETE FROM window_aggregates');
  });
  useGateway.setState({ lastUploadCount: payload.beaconReading.length });
}

async function flushOutbox() {
  const client = getMqtt();
  if (!client || client.state !== 'connected') return;
  const db = await getDb();
  await db.runAsync(
    'DELETE FROM outbox WHERE created_at < ? OR id NOT IN (SELECT id FROM outbox ORDER BY id DESC LIMIT ?)',
    Date.now() - OUTBOX_MAX_AGE_MS,
    OUTBOX_MAX_ROWS,
  );
  const rows = await db.getAllAsync<{ id: number; topic: string; payload: string }>(
    'SELECT id, topic, payload FROM outbox ORDER BY id LIMIT ?',
    OUTBOX_BATCH,
  );
  for (const r of rows) {
    try {
      await client.publish(r.topic, r.payload, 1);
      await db.runAsync('DELETE FROM outbox WHERE id = ?', r.id);
      useGateway.setState({ lastUploadAt: Date.now(), lastError: null });
    } catch (e) {
      const msg = (e as Error).message;
      await db.runAsync('UPDATE outbox SET attempts = attempts + 1, last_error = ? WHERE id = ?', msg, r.id);
      useGateway.setState({ lastError: msg });
      log.warn('gateway', `publish failed: ${msg}`);
      break;
    }
  }
}

async function tick() {
  tickMqtt();
  scanService.expireLive();
  const now = Date.now();
  // Guard against a stuck cycle (e.g. a location request that never resolves).
  if (busySince !== null && now - busySince < 60_000) return;
  busySince = now;
  try {
    if (now - lastUploadAt >= uploadIntervalMs()) {
      lastUploadAt = now;
      await enqueueUpload(now);
    } else {
      await persistWindow(scanService.aggregator.windowSnapshot());
    }
    await flushOutbox();
    await refreshOutboxSize();
    useGateway.setState({ windowSize: scanService.aggregator.windowSize() });
  } catch (e) {
    const msg = (e as Error).message;
    useGateway.setState({ lastError: msg });
    log.error('gateway', msg);
  } finally {
    busySince = null;
  }
}

export const gateway = {
  async start() {
    if (useGateway.getState().running) return;
    const cfg = getConfig();
    await restoreWindow();
    scanService.acquire('gateway');
    subs.push(
      ParagonNative.addListener('onGatewayTick', () => void tick()),
      ParagonNative.addListener('onGatewayStopRequested', () => void gateway.stop()),
      ParagonNative.addListener('onGatewayError', ({ message }) => {
        useGateway.setState({ lastError: message });
        log.error('gateway', message);
      }),
    );
    try {
      ParagonNative.startGatewayService({
        title: 'Paragon gateway running',
        text: 'Scanning for tags and uploading every ' + cfg.other.backgroundUploadSeconds + ' s',
        tickIntervalMs: TICK_MS,
      });
    } catch (e) {
      await gateway.stop();
      throw e;
    }
    lastUploadAt = Date.now();
    useGateway.setState({ running: true, lastError: null });
    void ensureMqtt(cfg);
    log.info('gateway', 'started');
  },

  async stop() {
    subs.forEach((s) => s.remove());
    subs = [];
    ParagonNative.stopGatewayService();
    if (scanService.isHeld('gateway')) scanService.release('gateway');
    try {
      // Keep what we have: queue the partial window so it goes out next time.
      await enqueueUpload(Date.now());
      await flushOutbox();
    } catch {
      /* best effort */
    }
    await stopMqtt();
    useGateway.setState({ running: false });
    log.info('gateway', 'stopped');
  },

  /** Force an upload now (Search screen / diagnostics). */
  async uploadNow() {
    lastUploadAt = 0;
    await tick();
  },

  /** Re-apply settings while running. */
  async reconfigure() {
    if (!useGateway.getState().running) return;
    await ensureMqtt(getConfig());
  },

  refreshOutboxSize,
};
