import ParagonNative from '@modules/paragon-native';

import { base64ToBytes, bytesToBase64 } from '@/core/bytes';
import type { MqttTransport } from '@/core/mqtt/client';
import type { BrokerAddress } from '@/core/mqtt/uri';

let socketSeq = 0;

/** tcp:// and ssl:// via the native socket module (platform trust store, host-name verification). */
export class NativeSocketTransport implements MqttTransport {
  private readonly id = `mqtt-${++socketSeq}`;
  private subs: { remove(): void }[] = [];
  private writeChain: Promise<void> = Promise.resolve();
  private closed = false;

  constructor(private readonly addr: BrokerAddress) {}

  async open(h: { onData: (b: Uint8Array) => void; onClose: (err?: Error) => void }) {
    this.subs.push(
      ParagonNative.addListener('onSocketData', (e) => {
        if (e.id === this.id) h.onData(base64ToBytes(e.data));
      }),
      ParagonNative.addListener('onSocketClose', (e) => {
        if (e.id !== this.id) return;
        this.cleanup();
        h.onClose(e.error ? new Error(e.error) : undefined);
      }),
    );
    try {
      await ParagonNative.socketConnect(this.id, this.addr.host, this.addr.port, this.addr.tls, 15000);
    } catch (e) {
      this.cleanup();
      throw e;
    }
  }

  send(bytes: Uint8Array): Promise<void> {
    // Serialise writes so MQTT packets never interleave.
    const b64 = bytesToBase64(bytes);
    const p = this.writeChain.then(() => ParagonNative.socketWrite(this.id, b64));
    this.writeChain = p.catch(() => {});
    return p;
  }

  close() {
    if (this.closed) return;
    ParagonNative.socketClose(this.id);
    this.cleanup();
  }

  private cleanup() {
    this.closed = true;
    this.subs.forEach((s) => s.remove());
    this.subs = [];
  }
}

/** ws:// and wss:// using React Native's built-in WebSocket. */
export class WebSocketTransport implements MqttTransport {
  private ws: WebSocket | null = null;

  constructor(private readonly addr: BrokerAddress) {}

  open(h: { onData: (b: Uint8Array) => void; onClose: (err?: Error) => void }): Promise<void> {
    const url = `${this.addr.tls ? 'wss' : 'ws'}://${this.addr.host}:${this.addr.port}${this.addr.path}`;
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url, ['mqtt']);
      ws.binaryType = 'arraybuffer';
      this.ws = ws;
      let opened = false;
      ws.onopen = () => {
        opened = true;
        resolve();
      };
      ws.onmessage = (ev) => {
        if (ev.data instanceof ArrayBuffer) h.onData(new Uint8Array(ev.data));
      };
      ws.onerror = (ev) => {
        const msg = (ev as unknown as { message?: string }).message ?? 'WebSocket error';
        if (!opened) reject(new Error(msg));
      };
      ws.onclose = (ev) => {
        this.ws = null;
        if (opened) h.onClose(ev.code === 1000 ? undefined : new Error(`WebSocket closed (${ev.code})`));
        else reject(new Error(`WebSocket closed (${ev.code})`));
      };
    });
  }

  async send(bytes: Uint8Array) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) throw new Error('WebSocket not open');
    this.ws.send(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer);
  }

  close() {
    this.ws?.close();
    this.ws = null;
  }
}

export function transportFor(addr: BrokerAddress): MqttTransport {
  return addr.websocket ? new WebSocketTransport(addr) : new NativeSocketTransport(addr);
}
