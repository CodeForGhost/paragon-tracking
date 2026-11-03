import type { WindowAggregate } from './aggregator';
import type { AppConfig } from './config';

export interface GpsFix {
  latitude: number;
  longitude: number;
  altitude: number | null;
  accuracy: number | null;
  timestamp: number;
}

export interface BeaconReading {
  id: string;
  interfaceTypeId: string;
  technologyId: 'BLE';
  name: string;
  uid: string;
  /** Average RSSI (mode 'average') or the sum of samples (mode 'legacySum', original app). */
  rssi: number;
  avgRssi: number;
  sumRssi: number;
  maxRssi: number;
  minRssi: number;
  counter: number;
  generationCode: string | null;
  txPower: number;
  format: string;
  zone: string;
  distance: number;
  firstSeen: number;
  lastSeen: number;
}

export interface GatewayDataRequest {
  mainUniqueId: string;
  interfaceTypeId: string;
  timestamp: number;
  locationGPSLatLonCoordinates: { x: number; y: number; alt: number | null } | null;
  locationAccuracy: number | null;
  beaconReading: BeaconReading[];
}

/** interfaceTypeId when the key is a MAC address (platform contract) vs. a decoded tag UID (iOS). */
export const IFACE_MAC = 'BLE_AdvAddr';
export const IFACE_UID = 'BLE_PID_UID';

function round(n: number, digits: number) {
  const f = Math.pow(10, digits);
  return Math.round(n * f) / f;
}

export function buildGatewayPayload(
  rows: WindowAggregate[],
  gps: GpsFix | null,
  cfg: AppConfig,
  now: number,
): GatewayDataRequest {
  return {
    mainUniqueId: cfg.other.gatewayId,
    interfaceTypeId: cfg.other.gatewayInterfaceType,
    timestamp: now,
    locationGPSLatLonCoordinates: gps ? { x: gps.longitude, y: gps.latitude, alt: gps.altitude } : null,
    locationAccuracy: gps?.accuracy ?? null,
    beaconReading: rows
      .filter((r) => r.counter > 0)
      .map((r) => {
        const avg = r.sumRssi / r.counter;
        const format =
          r.tag.format === 'PARAGON' ? `PID_${r.tag.generationCode ?? ''}${r.tag.uid}` : r.tag.format;
        return {
          id: r.tag.key,
          interfaceTypeId: r.tag.address ? IFACE_MAC : IFACE_UID,
          technologyId: 'BLE' as const,
          name: r.tag.name,
          uid: r.tag.uid,
          rssi: cfg.mqtt.rssiMode === 'legacySum' ? r.sumRssi : Math.round(avg),
          avgRssi: round(avg, 1),
          sumRssi: r.sumRssi,
          maxRssi: r.maxRssi,
          minRssi: r.minRssi,
          counter: r.counter,
          generationCode: r.tag.generationCode,
          txPower: r.txPower,
          format,
          zone: r.zone,
          distance: Number.isFinite(r.distance) ? round(r.distance, 2) : -1,
          firstSeen: r.firstSeen,
          lastSeen: r.lastSeen,
        };
      }),
  };
}
