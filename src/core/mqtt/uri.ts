export type MqttScheme = 'tcp' | 'ssl' | 'ws' | 'wss';

export interface BrokerAddress {
  scheme: MqttScheme;
  host: string;
  port: number;
  /** WebSocket path (ws/wss only). */
  path: string;
  tls: boolean;
  websocket: boolean;
}

const URI_RE = /^(tcp|ssl|mqtt|mqtts|ws|wss):\/\/(\[[0-9a-fA-F:]+\]|[A-Za-z0-9.-]+)(?::(\d{1,5}))?(\/[^\s?#]*)?$/;

const DEFAULT_PORT: Record<MqttScheme, number> = { tcp: 1883, ssl: 8883, ws: 80, wss: 443 };

export function parseBrokerUri(uri: string): BrokerAddress | null {
  const m = URI_RE.exec(uri.trim());
  if (!m) return null;
  const raw = m[1];
  const scheme: MqttScheme = raw === 'mqtt' ? 'tcp' : raw === 'mqtts' ? 'ssl' : (raw as MqttScheme);
  const websocket = scheme === 'ws' || scheme === 'wss';
  if (!websocket && m[4] && m[4] !== '/') return null; // paths only make sense for WebSockets
  const port = m[3] ? Number(m[3]) : DEFAULT_PORT[scheme];
  if (!(port > 0 && port < 65536)) return null;
  return {
    scheme,
    host: m[2].replace(/^\[|\]$/g, ''),
    port,
    path: websocket ? m[4] || '/mqtt' : '',
    tls: scheme === 'ssl' || scheme === 'wss',
    websocket,
  };
}

export const isValidBrokerUri = (uri: string) => parseBrokerUri(uri) !== null;
