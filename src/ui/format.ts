import type { Zone } from '@/core/distance';
import type { MqttState } from '@/core/mqtt/client';
import { colors } from './theme';

export function timeAgo(t: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 5) return 'just now';
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  return new Date(t).toLocaleTimeString();
}

export function formatDistance(d: number): string {
  if (!Number.isFinite(d)) return '—';
  return d < 10 ? `${d.toFixed(1)} m` : `${Math.round(d)} m`;
}

export const zoneColor = (z: Zone) =>
  z === 'Immed' ? colors.zoneImmed : z === 'Near' ? colors.zoneNear : colors.zoneFar;

export const mqttStateLabel = (s: MqttState) =>
  ({ idle: 'Not connected', connecting: 'Connecting…', connected: 'Connected', waiting: 'Reconnecting…', stopped: 'Stopped' })[s];

export const mqttStateColor = (s: MqttState) =>
  s === 'connected' ? colors.success : s === 'connecting' || s === 'waiting' ? colors.warning : colors.textMuted;
