import type { WindowAggregate } from './aggregator';

export const INVENTORY_HEADER = ['Name', 'Tag ID', 'UID', 'RSSI', 'Zone', 'Avg Distance (m)', 'Reads', 'Timestamp'];

function cell(v: string | number): string {
  const s = String(v);
  // Neutralise spreadsheet formula injection, then quote if needed.
  const safe = /^[=+\-@\t\r]/.test(s) && !/^-?\d/.test(s) ? `'${s}` : s;
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

/** Distance is reported at the tag's smoothed RSSI over the session. */
export function buildInventoryCsv(rows: WindowAggregate[]): string {
  const lines = [INVENTORY_HEADER.join(',')];
  const sorted = [...rows].sort((a, b) => a.distance - b.distance);
  for (const r of sorted) {
    const avg = r.counter ? Math.round(r.sumRssi / r.counter) : 0;
    lines.push(
      [
        r.tag.name,
        r.tag.key,
        r.tag.uid,
        avg,
        r.zone,
        Number.isFinite(r.distance) ? r.distance.toFixed(2) : '',
        r.counter,
        new Date(r.lastSeen).toISOString(),
      ]
        .map(cell)
        .join(','),
    );
  }
  return lines.join('\r\n') + '\r\n';
}
