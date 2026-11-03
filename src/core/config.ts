/**
 * App configuration. Mirrors the original SharedPreferences keys (noted per field) but with
 * secrets split out: passwords and tokens live in SecureStore, never in this object.
 */
export interface AppConfig {
  bluetooth: {
    /** FILTER: name prefix filter for the live list. */
    nameFilter: string;
    /** MAX_DISTANCE_KEY (m): beyond this a tag is OUT_OF_RANGE and hidden. */
    maxDistance: number;
    /** IMMEDIATE_COUNTER_KEY (m). */
    immediateDistance: number;
    /** INTERMEDIATE_COUNTER_KEY (m). */
    nearDistance: number;
    /** SEARCH_SCAN_INTERVAL (min): scan window before the scanner is restarted, and upload override. */
    scanIntervalMinutes: number;
    /** Default calibrated RSSI at 1 m. */
    defaultTxPower: number;
    /** Per generationCode calibration, e.g. { "00A1": -62 }. */
    txPowerByGeneration: Record<string, number>;
    /** Path-loss exponent n. 2 = free space; 2.5-3.5 indoors. */
    pathLossExponent: number;
    /** EMA smoothing factor for live RSSI (0..1, higher = more reactive). */
    rssiSmoothing: number;
    /** Accept iBeacon / Eddystone-UID frames in addition to Paragon manufacturer data. */
    acceptBeaconFormats: boolean;
    /** Legacy: accept MACs starting with this prefix (Android only). Empty disables. */
    legacyMacPrefix: string;
    /** Use balanced instead of low-latency scanning (saves battery). */
    lowPowerScan: boolean;
  };
  mqtt: {
    /** MQTT_SERVER_KEY: tcp://, ssl://, ws:// or wss:// */
    brokerUri: string;
    /** MQTT_SERVER_USER_NAME */
    username: string;
    /** MQTT_SERVER_TOPIC */
    topic: string;
    keepAliveSeconds: number;
    cleanSession: boolean;
    /** 'average' (recommended) or 'legacySum' (original app: rssi = sum of samples). */
    rssiMode: 'average' | 'legacySum';
  };
  server: {
    /** HTTP_SERVER_ADDRESS: dashboard web app base URL (Platform Access / Home / Map). */
    dashboardUrl: string;
    /** HTTP_SERVER_USER_NAME (HTTP basic auth for the dashboards). */
    username: string;
    /** Paths appended to dashboardUrl for each web page. */
    pages: { home: string; map: string; platform1: string; platform2: string };
    /** Backend API for auth and pairing. Empty = not configured. */
    apiBaseUrl: string;
  };
  other: {
    /** IMEI_NUMBER: gateway identity sent as mainUniqueId. */
    gatewayId: string;
    /** interfaceTypeId for the gateway. */
    gatewayInterfaceType: string;
    /** Upload interval (s) while app is in foreground. */
    foregroundUploadSeconds: number;
    /** Upload interval (s) while app is in background. */
    backgroundUploadSeconds: number;
    /** Inventory timer (min). */
    inventoryMinutes: number;
    /** Recipient for the inventory CSV email. */
    inventoryEmail: string;
  };
}

export const DEFAULT_CONFIG: AppConfig = {
  bluetooth: {
    nameFilter: '',
    maxDistance: 20,
    immediateDistance: 5,
    nearDistance: 10,
    scanIntervalMinutes: 1,
    defaultTxPower: -59,
    txPowerByGeneration: {},
    pathLossExponent: 2,
    rssiSmoothing: 0.3,
    acceptBeaconFormats: false,
    legacyMacPrefix: '',
    lowPowerScan: false,
  },
  mqtt: {
    brokerUri: 'ssl://demo.tracktio.com:8883',
    username: '',
    topic: '/inbound/1/xtag',
    keepAliveSeconds: 60,
    cleanSession: false,
    rssiMode: 'average',
  },
  server: {
    dashboardUrl: '',
    username: '',
    pages: { home: '', map: '/map', platform1: '', platform2: '' },
    apiBaseUrl: '',
  },
  other: {
    gatewayId: '',
    gatewayInterfaceType: '3G_IMEI',
    foregroundUploadSeconds: 20,
    backgroundUploadSeconds: 60,
    inventoryMinutes: 1,
    inventoryEmail: '',
  },
};

/** Deep-merge stored config over defaults so new fields get default values after upgrades. */
export function mergeConfig(stored: unknown): AppConfig {
  const s = (stored ?? {}) as Partial<Record<keyof AppConfig, Record<string, unknown>>>;
  return {
    bluetooth: { ...DEFAULT_CONFIG.bluetooth, ...(s.bluetooth ?? {}) } as AppConfig['bluetooth'],
    mqtt: { ...DEFAULT_CONFIG.mqtt, ...(s.mqtt ?? {}) } as AppConfig['mqtt'],
    server: {
      ...DEFAULT_CONFIG.server,
      ...(s.server ?? {}),
      pages: {
        ...DEFAULT_CONFIG.server.pages,
        ...((s.server?.pages as object | undefined) ?? {}),
      },
    } as AppConfig['server'],
    other: { ...DEFAULT_CONFIG.other, ...(s.other ?? {}) } as AppConfig['other'],
  };
}

export type ConfigErrors = Partial<Record<string, string>>;

export function validateConfig(c: AppConfig, mqttUriValid: (u: string) => boolean): ConfigErrors {
  const e: ConfigErrors = {};
  const b = c.bluetooth;
  if (!(b.immediateDistance > 0)) e['bluetooth.immediateDistance'] = 'Must be > 0';
  if (!(b.nearDistance > b.immediateDistance))
    e['bluetooth.nearDistance'] = 'Must be greater than Immediate';
  if (!(b.maxDistance >= b.nearDistance))
    e['bluetooth.maxDistance'] = 'Must be at least the Near distance';
  if (!(b.scanIntervalMinutes >= 0.5)) e['bluetooth.scanIntervalMinutes'] = 'Minimum 0.5 min';
  if (!(b.pathLossExponent >= 1 && b.pathLossExponent <= 6))
    e['bluetooth.pathLossExponent'] = 'Between 1 and 6';
  if (!(b.rssiSmoothing > 0 && b.rssiSmoothing <= 1)) e['bluetooth.rssiSmoothing'] = '0 < x ≤ 1';
  if (!(b.defaultTxPower < 0 && b.defaultTxPower > -120))
    e['bluetooth.defaultTxPower'] = 'Between -120 and 0 dBm';
  if (!mqttUriValid(c.mqtt.brokerUri))
    e['mqtt.brokerUri'] = 'Use tcp://, ssl://, ws:// or wss://host[:port][/path]';
  if (!c.mqtt.topic.trim()) e['mqtt.topic'] = 'Required';
  if (!(c.mqtt.keepAliveSeconds >= 10 && c.mqtt.keepAliveSeconds <= 600))
    e['mqtt.keepAliveSeconds'] = 'Between 10 and 600 s';
  if (c.server.dashboardUrl && !/^https?:\/\//i.test(c.server.dashboardUrl))
    e['server.dashboardUrl'] = 'Must start with http:// or https://';
  if (c.server.apiBaseUrl && !/^https?:\/\//i.test(c.server.apiBaseUrl))
    e['server.apiBaseUrl'] = 'Must start with http:// or https://';
  if (!c.other.gatewayId.trim()) e['other.gatewayId'] = 'Required';
  if (!(c.other.foregroundUploadSeconds >= 5)) e['other.foregroundUploadSeconds'] = 'Minimum 5 s';
  if (!(c.other.backgroundUploadSeconds >= 15)) e['other.backgroundUploadSeconds'] = 'Minimum 15 s';
  if (!(c.other.inventoryMinutes > 0)) e['other.inventoryMinutes'] = 'Must be > 0';
  return e;
}
