import type { AppConfig } from './config';

export type Zone = 'Immed' | 'Near' | 'Far' | 'OUT_OF_RANGE';

export const ZONE_LABEL: Record<Zone, string> = {
  Immed: 'Immediate',
  Near: 'Near',
  Far: 'Far',
  OUT_OF_RANGE: 'Out of range',
};

/** Log-distance path-loss model: d = 10 ^ ((txPower - rssi) / (10 n)). */
export function rssiToDistance(rssi: number, txPower: number, n: number): number {
  if (!Number.isFinite(rssi) || rssi === 0) return Number.POSITIVE_INFINITY;
  return Math.pow(10, (txPower - rssi) / (10 * n));
}

export function classifyZone(
  distance: number,
  t: Pick<AppConfig['bluetooth'], 'immediateDistance' | 'nearDistance' | 'maxDistance'>,
): Zone {
  if (distance <= t.immediateDistance) return 'Immed';
  if (distance <= t.nearDistance) return 'Near';
  if (distance <= t.maxDistance) return 'Far';
  return 'OUT_OF_RANGE';
}

/** Exponential moving average. Returns the sample itself when there is no previous value. */
export function ema(prev: number | null, sample: number, alpha: number): number {
  return prev === null ? sample : prev + alpha * (sample - prev);
}

/**
 * Calibrated 1 m RSSI for a tag: per-generation calibration wins, then the frame's own
 * measured power (iBeacon/Eddystone), then the configured default.
 */
export function resolveTxPower(
  generationCode: string | null,
  measuredPower: number | null,
  bt: Pick<AppConfig['bluetooth'], 'txPowerByGeneration' | 'defaultTxPower'>,
): number {
  if (generationCode && bt.txPowerByGeneration[generationCode] !== undefined) {
    return bt.txPowerByGeneration[generationCode];
  }
  if (measuredPower !== null && measuredPower < 0) return measuredPower;
  return bt.defaultTxPower;
}
