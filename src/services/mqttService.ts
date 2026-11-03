import { create } from 'zustand';

import type { AppConfig } from '@/core/config';
import { MqttClient, type MqttState } from '@/core/mqtt/client';
import { parseBrokerUri } from '@/core/mqtt/uri';
import { log } from './logger';
import { transportFor } from './mqttTransports';
import { getSecret } from './secrets';

interface MqttStatus {
  state: MqttState;
  detail?: string;
  broker: string;
}

export const useMqttStatus = create<MqttStatus>(() => ({ state: 'idle', broker: '' }));

let client: MqttClient | null = null;
let signature = '';

let lock: Promise<unknown> = Promise.resolve();

/** (Re)creates the client when broker settings change. Safe to call repeatedly and concurrently. */
export function ensureMqtt(cfg: AppConfig): Promise<MqttClient | null> {
  const p = lock.then(() => ensureMqttLocked(cfg));
  lock = p.catch(() => {});
  return p;
}

async function ensureMqttLocked(cfg: AppConfig): Promise<MqttClient | null> {
  const password = await getSecret('mqttPassword');
  const sig = JSON.stringify([cfg.mqtt, password, cfg.other.gatewayId]);
  if (client && sig === signature) {
    if (client.state === 'idle' || client.state === 'stopped') client.start();
    return client;
  }
  await stopMqtt();
  const addr = parseBrokerUri(cfg.mqtt.brokerUri);
  if (!addr) {
    useMqttStatus.setState({ state: 'idle', detail: 'Invalid broker URI', broker: cfg.mqtt.brokerUri });
    return null;
  }
  if (!addr.tls) log.warn('mqtt', 'Broker connection is not encrypted (use ssl:// or wss://)');
  signature = sig;
  useMqttStatus.setState({ state: 'idle', detail: undefined, broker: cfg.mqtt.brokerUri });
  client = new MqttClient(
    () => transportFor(addr),
    {
      connect: {
        clientId: cfg.other.gatewayId,
        username: cfg.mqtt.username || undefined,
        password: password || undefined,
        keepAliveSeconds: cfg.mqtt.keepAliveSeconds,
        cleanSession: cfg.mqtt.cleanSession,
      },
      // Original app subscribed to its own topic and only logged incoming messages.
      subscriptions: [cfg.mqtt.topic],
      autoReconnect: true,
    },
    {
      onState: (state, detail) => useMqttStatus.setState({ state, detail }),
      onMessage: (topic, payload) => log.debug('mqtt', `message on ${topic} (${payload.length} bytes)`),
      onLog: (m) => log.info('mqtt', m),
    },
  );
  client.start();
  return client;
}

export function getMqtt() {
  return client;
}

export function tickMqtt() {
  client?.tick();
}

export async function stopMqtt() {
  const c = client;
  client = null;
  signature = '';
  if (c) await c.stop();
  useMqttStatus.setState({ state: 'idle', detail: undefined });
}
