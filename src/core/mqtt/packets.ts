// Minimal MQTT 3.1.1 codec: just what a gateway needs (CONNECT, PUBLISH QoS 0/1, SUBSCRIBE, PING, DISCONNECT).
import { concatBytes, utf8Decode, utf8Encode } from '../bytes';

export enum PacketType {
  CONNECT = 1,
  CONNACK = 2,
  PUBLISH = 3,
  PUBACK = 4,
  SUBSCRIBE = 8,
  SUBACK = 9,
  UNSUBSCRIBE = 10,
  UNSUBACK = 11,
  PINGREQ = 12,
  PINGRESP = 13,
  DISCONNECT = 14,
}

export type QoS = 0 | 1;

export interface ConnectOptions {
  clientId: string;
  username?: string;
  password?: string;
  keepAliveSeconds: number;
  cleanSession: boolean;
}

export type IncomingPacket =
  | { type: PacketType.CONNACK; sessionPresent: boolean; returnCode: number }
  | { type: PacketType.PUBLISH; topic: string; payload: Uint8Array; qos: number; packetId?: number; dup: boolean; retain: boolean }
  | { type: PacketType.PUBACK; packetId: number }
  | { type: PacketType.SUBACK; packetId: number; granted: number[] }
  | { type: PacketType.UNSUBACK; packetId: number }
  | { type: PacketType.PINGRESP }
  | { type: 'unknown'; header: number };

export const CONNACK_ERRORS: Record<number, string> = {
  1: 'unacceptable protocol version',
  2: 'identifier rejected',
  3: 'server unavailable',
  4: 'bad user name or password',
  5: 'not authorized',
};

function encodeLength(len: number): number[] {
  if (len > 268_435_455) throw new Error('MQTT packet too large');
  const out: number[] = [];
  do {
    let b = len % 128;
    len = Math.floor(len / 128);
    if (len > 0) b |= 0x80;
    out.push(b);
  } while (len > 0);
  return out;
}

function u16(n: number): Uint8Array {
  return Uint8Array.of((n >> 8) & 0xff, n & 0xff);
}

function str(s: string): Uint8Array {
  const b = utf8Encode(s);
  if (b.length > 0xffff) throw new Error('MQTT string too long');
  return concatBytes([u16(b.length), b]);
}

function packet(header: number, body: Uint8Array[]): Uint8Array {
  const payload = concatBytes(body);
  return concatBytes([Uint8Array.of(header, ...encodeLength(payload.length)), payload]);
}

export function encodeConnect(o: ConnectOptions): Uint8Array {
  let flags = 0;
  if (o.cleanSession) flags |= 0x02;
  if (o.username !== undefined && o.username !== '') flags |= 0x80;
  if (o.password !== undefined && o.password !== '' && flags & 0x80) flags |= 0x40;
  const parts: Uint8Array[] = [str('MQTT'), Uint8Array.of(4, flags), u16(o.keepAliveSeconds), str(o.clientId)];
  if (flags & 0x80) parts.push(str(o.username!));
  if (flags & 0x40) parts.push(str(o.password!));
  return packet(PacketType.CONNECT << 4, parts);
}

export function encodePublish(
  topic: string,
  payload: Uint8Array,
  qos: QoS,
  packetId: number,
  opts: { retain?: boolean; dup?: boolean } = {},
): Uint8Array {
  let header = PacketType.PUBLISH << 4;
  if (opts.dup) header |= 0x08;
  header |= qos << 1;
  if (opts.retain) header |= 0x01;
  const parts = [str(topic)];
  if (qos > 0) parts.push(u16(packetId));
  parts.push(payload);
  return packet(header, parts);
}

export function encodePuback(packetId: number): Uint8Array {
  return packet(PacketType.PUBACK << 4, [u16(packetId)]);
}

export function encodeSubscribe(packetId: number, topics: { topic: string; qos: QoS }[]): Uint8Array {
  const parts: Uint8Array[] = [u16(packetId)];
  for (const t of topics) parts.push(str(t.topic), Uint8Array.of(t.qos));
  return packet((PacketType.SUBSCRIBE << 4) | 0x02, parts);
}

export const encodePingreq = () => Uint8Array.of(PacketType.PINGREQ << 4, 0);
export const encodeDisconnect = () => Uint8Array.of(PacketType.DISCONNECT << 4, 0);

function readU16(b: Uint8Array, o: number) {
  return (b[o] << 8) | b[o + 1];
}

function decodePacket(header: number, body: Uint8Array): IncomingPacket {
  const type = header >> 4;
  switch (type) {
    case PacketType.CONNACK:
      return { type, sessionPresent: (body[0] & 1) === 1, returnCode: body[1] };
    case PacketType.PUBLISH: {
      const qos = (header >> 1) & 3;
      const tlen = readU16(body, 0);
      const topic = utf8Decode(body.subarray(2, 2 + tlen));
      let o = 2 + tlen;
      let packetId: number | undefined;
      if (qos > 0) {
        packetId = readU16(body, o);
        o += 2;
      }
      return {
        type,
        topic,
        payload: body.slice(o),
        qos,
        packetId,
        dup: (header & 0x08) !== 0,
        retain: (header & 0x01) !== 0,
      };
    }
    case PacketType.PUBACK:
      return { type, packetId: readU16(body, 0) };
    case PacketType.SUBACK:
      return { type, packetId: readU16(body, 0), granted: Array.from(body.subarray(2)) };
    case PacketType.UNSUBACK:
      return { type, packetId: readU16(body, 0) };
    case PacketType.PINGRESP:
      return { type };
    default:
      return { type: 'unknown', header };
  }
}

/** Incremental stream decoder: feed arbitrary chunks, get complete packets. */
export class PacketDecoder {
  private buf: Uint8Array = new Uint8Array(0);

  push(chunk: Uint8Array): IncomingPacket[] {
    this.buf = this.buf.length ? concatBytes([this.buf, chunk]) : chunk;
    const out: IncomingPacket[] = [];
    for (;;) {
      if (this.buf.length < 2) break;
      let len = 0;
      let mult = 1;
      let i = 1;
      let complete = false;
      for (; i < this.buf.length && i <= 4; i++) {
        const b = this.buf[i];
        len += (b & 0x7f) * mult;
        mult *= 128;
        if ((b & 0x80) === 0) {
          complete = true;
          break;
        }
      }
      if (!complete) {
        if (i > 4) throw new Error('Malformed MQTT remaining length');
        break;
      }
      const start = i + 1;
      if (this.buf.length < start + len) break;
      out.push(decodePacket(this.buf[0], this.buf.subarray(start, start + len)));
      this.buf = this.buf.slice(start + len);
    }
    return out;
  }

  reset() {
    this.buf = new Uint8Array(0);
  }
}
