import ParagonNative, { type NativeAdvertisement, type ScanOptions } from '@modules/paragon-native';
import { create } from 'zustand';

import { TagAggregator, type LiveTag } from '@/core/aggregator';
import type { AppConfig } from '@/core/config';
import { EDDYSTONE_SERVICE, PARAGON_COMPANY_ID } from '@/core/tagParser';
import { getConfig } from './configStore';
import { log } from './logger';

/** Live entries not seen for this long are dropped from the list. */
export const LIVE_TTL_MS = 3000;

export type ScanHolder = 'search' | 'inventory' | 'gateway' | 'pairing';

interface ScanState {
  scanning: boolean;
  error: string | null;
  live: LiveTag[];
  holders: ScanHolder[];
}

export const useScan = create<ScanState>(() => ({ scanning: false, error: null, live: [], holders: [] }));

type Sink = (batch: NativeAdvertisement[], now: number) => void;

const aggregator = new TagAggregator(getConfig().bluetooth);
const holders = new Set<ScanHolder>();
const sinks = new Set<Sink>();
let subscribed = false;
let currentOptionsKey = '';

function scanOptions(cfg: AppConfig): ScanOptions {
  const bt = cfg.bluetooth;
  return {
    manufacturerIds: [PARAGON_COMPANY_ID],
    serviceUuids: bt.acceptBeaconFormats ? [EDDYSTONE_SERVICE] : [],
    iBeacon: bt.acceptBeaconFormats,
    // Legacy MAC-prefix mode needs unfiltered scanning (tags without Paragon manufacturer data).
    unfiltered: bt.legacyMacPrefix.length > 0,
    lowPower: bt.lowPowerScan,
    batchIntervalMs: 500,
    restartIntervalMs: Math.max(30, Math.round(bt.scanIntervalMinutes * 60)) * 1000,
  };
}

function publishLive() {
  useScan.setState({ live: aggregator.liveTags() });
}

function ensureSubscribed() {
  if (subscribed) return;
  subscribed = true;
  ParagonNative.addListener('onAdvertisements', ({ items, timestamp }) => {
    const now = timestamp || Date.now();
    aggregator.ingest(items, now);
    aggregator.expire(now, LIVE_TTL_MS);
    for (const s of sinks) {
      try {
        s(items, now);
      } catch (e) {
        log.error('scan', `sink failed: ${(e as Error).message}`);
      }
    }
    publishLive();
  });
  ParagonNative.addListener('onScanState', ({ scanning, error }) => {
    useScan.setState({ scanning, error: error ?? null });
    if (error) log.warn('scan', error);
  });
}

function startNative() {
  const opts = scanOptions(getConfig());
  const key = JSON.stringify(opts);
  if (ParagonNative.isScanning() && key === currentOptionsKey) return;
  currentOptionsKey = key;
  try {
    ParagonNative.startScan(opts);
    useScan.setState({ error: null });
  } catch (e) {
    const msg = (e as Error).message;
    useScan.setState({ scanning: false, error: msg });
    throw e;
  }
}

export const scanService = {
  aggregator,

  /** Starts scanning on behalf of `holder`; scanning continues while any holder remains. */
  acquire(holder: ScanHolder) {
    ensureSubscribed();
    holders.add(holder);
    useScan.setState({ holders: [...holders] });
    startNative();
  },

  release(holder: ScanHolder) {
    holders.delete(holder);
    useScan.setState({ holders: [...holders] });
    if (holders.size === 0) {
      currentOptionsKey = '';
      ParagonNative.stopScan();
      aggregator.clearLive();
      publishLive();
    }
  },

  isHeld(holder: ScanHolder) {
    return holders.has(holder);
  },

  addSink(s: Sink): () => void {
    sinks.add(s);
    return () => sinks.delete(s);
  },

  /** Apply new thresholds/calibration and restart the native scan if its filters changed. */
  applyConfig(cfg: AppConfig) {
    aggregator.setConfig(cfg.bluetooth);
    publishLive();
    if (holders.size > 0) {
      try {
        startNative();
      } catch {
        /* surfaced via store */
      }
    }
  },

  expireLive(now = Date.now()) {
    if (aggregator.expire(now, LIVE_TTL_MS)) publishLive();
  },
};
