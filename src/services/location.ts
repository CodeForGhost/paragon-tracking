import * as Location from 'expo-location';

import type { GpsFix } from '@/core/payload';

function toFix(l: Location.LocationObject): GpsFix {
  return {
    latitude: l.coords.latitude,
    longitude: l.coords.longitude,
    altitude: l.coords.altitude ?? null,
    accuracy: l.coords.accuracy ?? null,
    timestamp: l.timestamp,
  };
}

function timeout<T>(ms: number): Promise<T> {
  return new Promise((_, reject) => setTimeout(() => reject(new Error('location timeout')), ms));
}

let lastFix: GpsFix | null = null;

/** Best-effort phone position for an upload. Never throws; returns null if unavailable. */
export async function getGpsFix(): Promise<GpsFix | null> {
  try {
    const perm = await Location.getForegroundPermissionsAsync();
    if (!perm.granted) return null;
    try {
      const cur = await Promise.race([
        Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced }),
        timeout<Location.LocationObject>(10000),
      ]);
      lastFix = toFix(cur);
      return lastFix;
    } catch {
      const last = await Location.getLastKnownPositionAsync({ maxAge: 5 * 60_000 });
      if (last) lastFix = toFix(last);
      // Fall back to our own last fix if it's recent enough.
      if (lastFix && Date.now() - lastFix.timestamp < 10 * 60_000) return lastFix;
      return null;
    }
  } catch {
    return null;
  }
}
