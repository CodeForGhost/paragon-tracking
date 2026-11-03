import { base64ToBytes, bytesToHex } from './bytes';

/** Paragon / xGenTag Bluetooth SIG company identifier. */
export const PARAGON_COMPANY_ID = 0x0eb8; // 3768
export const APPLE_COMPANY_ID = 0x004c;
export const EDDYSTONE_SERVICE = 'FEAA';

/** Advertisement as delivered by the native scanner (one per device per batch). */
export interface RawAdvertisement {
  /** Android: MAC address "EB:12:..". iOS: CoreBluetooth peripheral UUID. */
  id: string;
  name: string | null;
  /** TX power level advertised in the AD structure, if any. */
  txPower: number | null;
  /** Manufacturer specific data keyed by decimal company id; value is base64 of the payload AFTER the 2-byte company id. */
  mfg: Record<string, string>;
  /** Service data keyed by upper-case UUID (16-bit as 4 hex chars); base64 value. */
  svc: Record<string, string>;
}

export type TagFormat = 'PARAGON' | 'IBEACON' | 'EDDYSTONE_UID' | 'UNKNOWN';

export interface ParsedTag {
  /** Stable key used for aggregation and as payload id. */
  key: string;
  /** MAC address without colons (Android only), else null. */
  address: string | null;
  uid: string;
  generationCode: string | null;
  name: string;
  format: TagFormat;
  /** Calibrated 1 m RSSI if the frame carries one (iBeacon / Eddystone). */
  measuredPower: number | null;
}

export interface ParseOptions {
  /** Also accept iBeacon / Eddystone-UID frames (from any device). */
  acceptBeaconFormats: boolean;
  /**
   * Legacy behaviour from the original app: accept any device whose MAC starts with this prefix
   * and fall back to the first 12 hex chars of its manufacturer data. Android only. Empty = off.
   */
  legacyMacPrefix: string;
}

export const DEFAULT_PARSE_OPTIONS: ParseOptions = {
  acceptBeaconFormats: false,
  legacyMacPrefix: '',
};

const MAC_RE = /^([0-9A-F]{2}:){5}[0-9A-F]{2}$/i;

function int8(b: number): number {
  return b > 127 ? b - 256 : b;
}

function decode(b64: string | undefined): Uint8Array | null {
  if (!b64) return null;
  try {
    return base64ToBytes(b64);
  } catch {
    return null;
  }
}

function makeTag(
  adv: RawAdvertisement,
  format: TagFormat,
  uid: string,
  generationCode: string | null,
  measuredPower: number | null,
): ParsedTag {
  const address = MAC_RE.test(adv.id) ? adv.id.replace(/:/g, '').toUpperCase() : null;
  const fallbackName =
    format === 'PARAGON' ? `PID_${generationCode ?? ''}${uid}` : `${format}_${uid}`;
  // Key: MAC where we have one (matches the platform's BLE_AdvAddr contract), otherwise the decoded UID.
  const key = address ?? `${generationCode ?? ''}${uid}`;
  return {
    key,
    address,
    uid,
    generationCode,
    name: adv.name && adv.name.trim().length > 0 ? adv.name.trim() : fallbackName,
    format,
    measuredPower,
  };
}

export function parseParagon(adv: RawAdvertisement): ParsedTag | null {
  const data = decode(adv.mfg[String(PARAGON_COMPANY_ID)]);
  if (!data || data.length < 6) return null;
  const generationCode = bytesToHex(data.subarray(0, 2));
  const uid = bytesToHex(data.subarray(2, 6));
  return makeTag(adv, 'PARAGON', uid, generationCode, null);
}

export function parseIBeacon(adv: RawAdvertisement): ParsedTag | null {
  const data = decode(adv.mfg[String(APPLE_COMPANY_ID)]);
  // 02 15 | uuid(16) | major(2) | minor(2) | txPower(1)  => 23 bytes
  if (!data || data.length < 23 || data[0] !== 0x02 || data[1] !== 0x15) return null;
  const uid = bytesToHex(data.subarray(18, 22));
  return makeTag(adv, 'IBEACON', uid, null, int8(data[22]));
}

export function parseEddystoneUid(adv: RawAdvertisement): ParsedTag | null {
  const data = decode(adv.svc[EDDYSTONE_SERVICE]);
  // frame 0x00 | txPower@0m | namespace(10) | instance(6)
  if (!data || data.length < 18 || data[0] !== 0x00) return null;
  const uid = bytesToHex(data.subarray(2, 18));
  // Eddystone ranging data is calibrated at 0 m; ~41 dB loss to 1 m.
  return makeTag(adv, 'EDDYSTONE_UID', uid, null, int8(data[1]) - 41);
}

function parseUnknown(adv: RawAdvertisement): ParsedTag | null {
  const first = Object.values(adv.mfg)[0];
  const data = decode(first);
  if (!data || data.length === 0) return null;
  return makeTag(adv, 'UNKNOWN', bytesToHex(data).slice(0, 12), null, null);
}

/** Returns a ParsedTag if the advertisement belongs to a device we track, else null. */
export function parseAdvertisement(
  adv: RawAdvertisement,
  opts: ParseOptions = DEFAULT_PARSE_OPTIONS,
): ParsedTag | null {
  const paragon = parseParagon(adv);
  if (paragon) return paragon;

  const legacy =
    opts.legacyMacPrefix.length > 0 &&
    MAC_RE.test(adv.id) &&
    adv.id.toUpperCase().startsWith(opts.legacyMacPrefix.toUpperCase());

  if (opts.acceptBeaconFormats || legacy) {
    const beacon = parseIBeacon(adv) ?? parseEddystoneUid(adv);
    if (beacon) return beacon;
  }
  if (legacy) return parseUnknown(adv);
  return null;
}
