import type { AppConfig } from './config';
import { classifyZone, ema, resolveTxPower, rssiToDistance, type Zone } from './distance';
import { parseAdvertisement, type ParsedTag, type RawAdvertisement } from './tagParser';

/** One native batch entry: the latest advertisement plus every RSSI sample seen since the last batch. */
export interface AdvertisementBatchItem extends RawAdvertisement {
  rssis: number[];
}

export interface LiveTag {
  tag: ParsedTag;
  rssi: number; // latest raw sample
  smoothedRssi: number; // EMA
  txPower: number; // calibrated 1 m RSSI used for distance
  distance: number;
  zone: Zone;
  firstSeen: number;
  lastSeen: number;
}

/** Aggregate for one tag over the current upload window (the original Room row). */
export interface WindowAggregate {
  tag: ParsedTag;
  minRssi: number;
  maxRssi: number;
  sumRssi: number;
  counter: number;
  smoothedRssi: number;
  txPower: number;
  distance: number;
  zone: Zone;
  firstSeen: number;
  lastSeen: number;
}

export type BluetoothConfig = AppConfig['bluetooth'];

export class TagAggregator {
  private live = new Map<string, LiveTag>();
  private window = new Map<string, WindowAggregate>();

  constructor(private cfg: BluetoothConfig) {}

  setConfig(cfg: BluetoothConfig) {
    this.cfg = cfg;
    // Re-derive distances with new calibration/thresholds.
    for (const l of this.live.values()) this.recompute(l);
    for (const w of this.window.values()) this.recompute(w);
  }

  private recompute(e: { tag: ParsedTag; smoothedRssi: number; txPower: number; distance: number; zone: Zone }) {
    e.txPower = resolveTxPower(e.tag.generationCode, e.tag.measuredPower, this.cfg);
    e.distance = rssiToDistance(e.smoothedRssi, e.txPower, this.cfg.pathLossExponent);
    e.zone = classifyZone(e.distance, this.cfg);
  }

  /** Ingests a native batch. Returns number of accepted (tracked) devices. */
  ingest(batch: AdvertisementBatchItem[], now: number): number {
    let accepted = 0;
    for (const item of batch) {
      const samples = item.rssis.filter((r) => Number.isFinite(r) && r < 0 && r > -127);
      if (samples.length === 0) continue;
      const tag = parseAdvertisement(item, this.cfg);
      if (!tag) continue;
      accepted++;
      this.ingestLive(tag, samples, now);
      this.ingestWindow(tag, samples, now);
    }
    return accepted;
  }

  private ingestLive(tag: ParsedTag, samples: number[], now: number) {
    let l = this.live.get(tag.key);
    if (!l) {
      l = {
        tag,
        rssi: samples[0],
        smoothedRssi: samples[0],
        txPower: 0,
        distance: 0,
        zone: 'OUT_OF_RANGE',
        firstSeen: now,
        lastSeen: now,
      };
      this.live.set(tag.key, l);
      samples = samples.slice(1);
    }
    l.tag = tag; // name may arrive later via scan response
    for (const s of samples) l.smoothedRssi = ema(l.smoothedRssi, s, this.cfg.rssiSmoothing);
    if (samples.length) l.rssi = samples[samples.length - 1];
    l.lastSeen = now;
    this.recompute(l);
  }

  private ingestWindow(tag: ParsedTag, samples: number[], now: number) {
    let w = this.window.get(tag.key);
    if (!w) {
      w = {
        tag,
        minRssi: samples[0],
        maxRssi: samples[0],
        sumRssi: 0,
        counter: 0,
        smoothedRssi: samples[0],
        txPower: 0,
        distance: 0,
        zone: 'OUT_OF_RANGE',
        firstSeen: now,
        lastSeen: now,
      };
      this.window.set(tag.key, w);
    }
    w.tag = tag;
    for (const s of samples) {
      if (s < w.minRssi) w.minRssi = s;
      if (s > w.maxRssi) w.maxRssi = s;
      w.sumRssi += s;
      w.counter += 1;
      w.smoothedRssi = ema(w.smoothedRssi, s, this.cfg.rssiSmoothing);
    }
    w.lastSeen = now;
    this.recompute(w);
  }

  /** Drops live entries not seen within ttlMs. Returns true if anything was removed. */
  expire(now: number, ttlMs: number): boolean {
    let changed = false;
    for (const [k, l] of this.live) {
      if (now - l.lastSeen > ttlMs) {
        this.live.delete(k);
        changed = true;
      }
    }
    return changed;
  }

  liveTags(): LiveTag[] {
    return [...this.live.values()];
  }

  windowSize(): number {
    return this.window.size;
  }

  windowSnapshot(): WindowAggregate[] {
    return [...this.window.values()].map((w) => ({ ...w }));
  }

  /** Atomically takes the current window and starts a new one. */
  takeWindow(): WindowAggregate[] {
    const out = [...this.window.values()];
    this.window = new Map();
    return out;
  }

  /** Merges aggregates back (e.g. restored from disk after a restart, or a failed hand-off). */
  restoreWindow(rows: WindowAggregate[]) {
    for (const r of rows) {
      const cur = this.window.get(r.tag.key);
      if (!cur) {
        this.window.set(r.tag.key, { ...r });
        continue;
      }
      cur.minRssi = Math.min(cur.minRssi, r.minRssi);
      cur.maxRssi = Math.max(cur.maxRssi, r.maxRssi);
      cur.sumRssi += r.sumRssi;
      cur.counter += r.counter;
      cur.firstSeen = Math.min(cur.firstSeen, r.firstSeen);
      cur.lastSeen = Math.max(cur.lastSeen, r.lastSeen);
    }
  }

  clearLive() {
    this.live.clear();
  }
}

export interface LiveListFilter {
  nameFilter: string;
  search: string;
  maxDistance: number;
}

/** Live list filter from the original app: FILTER prefix + search text, distance ≤ max. */
export function filterLive(tags: LiveTag[], f: LiveListFilter): LiveTag[] {
  const prefix = f.nameFilter.trim().toLowerCase();
  const q = f.search.trim().toLowerCase();
  return tags
    .filter((t) => {
      if (t.distance > f.maxDistance) return false;
      const name = t.tag.name.toLowerCase();
      if (prefix && !name.startsWith(prefix)) return false;
      if (q && !(name.includes(q) || t.tag.uid.toLowerCase().includes(q) || t.tag.key.toLowerCase().includes(q)))
        return false;
      return true;
    })
    .sort((a, b) => a.distance - b.distance);
}
