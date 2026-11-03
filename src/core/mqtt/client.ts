import { utf8Encode } from '../bytes';
import {
  CONNACK_ERRORS,
  type ConnectOptions,
  encodeConnect,
  encodeDisconnect,
  encodePingreq,
  encodePuback,
  encodePublish,
  encodeSubscribe,
  type IncomingPacket,
  PacketDecoder,
  PacketType,
  type QoS,
} from './packets';

/** Byte transport (TCP, TLS or WebSocket). */
export interface MqttTransport {
  open(handlers: { onData: (b: Uint8Array) => void; onClose: (err?: Error) => void }): Promise<void>;
  send(bytes: Uint8Array): Promise<void>;
  close(): void;
}

export type MqttState = 'idle' | 'connecting' | 'connected' | 'waiting' | 'stopped';

export interface MqttClientOptions {
  connect: ConnectOptions;
  subscriptions: string[];
  autoReconnect: boolean;
  connectTimeoutMs?: number;
  ackTimeoutMs?: number;
  minBackoffMs?: number;
  maxBackoffMs?: number;
  now?: () => number;
}

export interface MqttClientEvents {
  onState?: (state: MqttState, detail?: string) => void;
  onMessage?: (topic: string, payload: Uint8Array) => void;
  onLog?: (msg: string) => void;
}

interface Pending {
  resolve: () => void;
  reject: (e: Error) => void;
  sentAt: number;
}

/**
 * MQTT 3.1.1 client with no internal timers: the owner calls tick() periodically (every few
 * seconds). This keeps it working inside an Android foreground service where JS timers are
 * throttled â€” the native gateway service drives the ticks.
 */
export class MqttClient {
  private transport: MqttTransport | null = null;
  private decoder = new PacketDecoder();
  private _state: MqttState = 'idle';
  private pending = new Map<number, Pending>();
  private nextId = 1;
  private lastSend = 0;
  private pingSentAt: number | null = null;
  private connectStartedAt = 0;
  private connack: { resolve: () => void; reject: (e: Error) => void } | null = null;
  private reconnectAt: number | null = null;
  private backoff: number;
  private generation = 0;
  private readonly now: () => number;

  constructor(
    private readonly factory: () => MqttTransport,
    private opts: MqttClientOptions,
    private events: MqttClientEvents = {},
  ) {
    this.now = opts.now ?? Date.now;
    this.backoff = opts.minBackoffMs ?? 2000;
  }

  get state() {
    return this._state;
  }

  private setState(s: MqttState, detail?: string) {
    this._state = s;
    this.events.onState?.(s, detail);
  }

  private log(m: string) {
    this.events.onLog?.(m);
  }

  start() {
    if (this._state === 'connecting' || this._state === 'connected') return;
    this.reconnectAt = null;
    void this.connectOnce();
  }

  async stop() {
    this.generation++;
    this.reconnectAt = null;
    const t = this.transport;
    this.transport = null;
    if (t && this._state === 'connected') {
      try {
        await t.send(encodeDisconnect());
      } catch {
        /* ignore */
      }
    }
    t?.close();
    this.failPending(new Error('client stopped'));
    this.setState('stopped');
  }

  private async connectOnce() {
    const gen = ++this.generation;
    this.setState('connecting');
    this.connectStartedAt = this.now();
    this.decoder.reset();
    this.pingSentAt = null;
    const transport = this.factory();
    this.transport = transport;
    try {
      await transport.open({
        onData: (b) => gen === this.generation && this.onData(b),
        onClose: (err) => gen === this.generation && this.drop(err?.message ?? 'connection closed'),
      });
      if (gen !== this.generation) return;
      const connack = new Promise<void>((resolve, reject) => (this.connack = { resolve, reject }));
      await this.send(encodeConnect(this.opts.connect));
      await connack;
      if (gen !== this.generation) return;
      this.backoff = this.opts.minBackoffMs ?? 2000;
      this.setState('connected');
      if (this.opts.subscriptions.length) {
        await this.send(
          encodeSubscribe(
            this.allocId(),
            this.opts.subscriptions.map((topic) => ({ topic, qos: 1 as QoS })),
          ),
        );
      }
    } catch (e) {
      if (gen === this.generation) this.drop((e as Error).message);
    }
  }

  private drop(reason: string) {
    this.generation++;
    const t = this.transport;
    this.transport = null;
    t?.close();
    this.connack?.reject(new Error(reason));
    this.connack = null;
    this.failPending(new Error(reason));
    this.log(`disconnected: ${reason}`);
    if (this.opts.autoReconnect && this._state !== 'stopped') {
      this.reconnectAt = this.now() + this.backoff;
      this.backoff = Math.min(this.backoff * 2, this.opts.maxBackoffMs ?? 60000);
      this.setState('waiting', reason);
    } else {
      this.setState('idle', reason);
    }
  }

  private failPending(err: Error) {
    for (const p of this.pending.values()) p.reject(err);
    this.pending.clear();
  }

  private async send(bytes: Uint8Array) {
    if (!this.transport) throw new Error('not connected');
    this.lastSend = this.now();
    await this.transport.send(bytes);
  }

  private allocId(): number {
    for (let i = 0; i < 65535; i++) {
      const id = this.nextId;
      this.nextId = this.nextId >= 65535 ? 1 : this.nextId + 1;
      if (!this.pending.has(id)) return id;
    }
    throw new Error('no free packet ids');
  }

  private onData(b: Uint8Array) {
    let packets: IncomingPacket[];
    try {
      packets = this.decoder.push(b);
    } catch (e) {
      this.drop((e as Error).message);
      return;
    }
    for (const p of packets) this.handle(p);
  }

  private handle(p: IncomingPacket) {
    switch (p.type) {
      case PacketType.CONNACK:
        if (p.returnCode === 0) {
          this.connack?.resolve();
          this.connack = null;
        } else {
          this.drop(`connection refused: ${CONNACK_ERRORS[p.returnCode] ?? p.returnCode}`);
        }
        break;
      case PacketType.PUBACK: {
        const pend = this.pending.get(p.packetId);
        if (pend) {
          this.pending.delete(p.packetId);
          pend.resolve();
        }
        break;
      }
      case PacketType.PUBLISH:
        if (p.qos === 1 && p.packetId !== undefined) void this.send(encodePuback(p.packetId)).catch(() => {});
        this.events.onMessage?.(p.topic, p.payload);
        break;
      case PacketType.PINGRESP:
        this.pingSentAt = null;
        break;
      case PacketType.SUBACK:
        if (p.granted.some((g) => g === 0x80)) this.log('subscription rejected by broker');
        break;
      default:
        break;
    }
  }

  /** Publishes; for QoS 1 resolves when the broker acknowledges (PUBACK). */
  publish(topic: string, payload: string | Uint8Array, qos: QoS = 1): Promise<void> {
    if (this._state !== 'connected') return Promise.reject(new Error(`MQTT not connected (${this._state})`));
    const bytes = typeof payload === 'string' ? utf8Encode(payload) : payload;
    if (qos === 0) return this.send(encodePublish(topic, bytes, 0, 0));
    const id = this.allocId();
    return new Promise<void>((resolve, reject) => {
      this.pending.set(id, { resolve, reject, sentAt: this.now() });
      this.send(encodePublish(topic, bytes, 1, id)).catch((e) => {
        this.pending.delete(id);
        reject(e);
      });
    });
  }

  /** Drive timeouts, keep-alive and reconnects. Call every 1â€“5 s. */
  tick() {
    const now = this.now();
    const ka = this.opts.connect.keepAliveSeconds * 1000;
    if (this._state === 'connecting' && now - this.connectStartedAt > (this.opts.connectTimeoutMs ?? 15000)) {
      this.drop('connect timeout');
      return;
    }
    if (this._state === 'waiting' && this.reconnectAt !== null && now >= this.reconnectAt) {
      this.reconnectAt = null;
      void this.connectOnce();
      return;
    }
    if (this._state !== 'connected') return;
    const ackTimeout = this.opts.ackTimeoutMs ?? 30000;
    for (const [id, p] of this.pending) {
      if (now - p.sentAt > ackTimeout) {
        this.pending.delete(id);
        p.reject(new Error('PUBACK timeout'));
      }
    }
    if (this.pingSentAt !== null && now - this.pingSentAt > Math.max(ka / 2, 10000)) {
      this.drop('keep-alive timeout');
      return;
    }
    if (ka > 0 && this.pingSentAt === null && now - this.lastSend >= ka * 0.75) {
      this.pingSentAt = now;
      void this.send(encodePingreq()).catch(() => {});
    }
  }
}
