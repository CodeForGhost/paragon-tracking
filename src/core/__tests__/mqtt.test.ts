import { utf8Decode, utf8Encode } from '../bytes';
import { MqttClient, type MqttTransport } from '../mqtt/client';
import { encodeConnect, encodePublish, PacketDecoder, PacketType } from '../mqtt/packets';

class FakeTransport implements MqttTransport {
  sent: Uint8Array[] = [];
  handlers!: { onData: (b: Uint8Array) => void; onClose: (err?: Error) => void };
  closed = false;
  async open(h: FakeTransport['handlers']) {
    this.handlers = h;
  }
  async send(b: Uint8Array) {
    this.sent.push(b);
  }
  close() {
    this.closed = true;
  }
  lastType() {
    return this.sent[this.sent.length - 1][0] >> 4;
  }
}

const flush = () => new Promise<void>((r) => setImmediate(() => r()));

describe('mqtt packets', () => {
  it('encodes CONNECT with credentials', () => {
    const p = encodeConnect({ clientId: 'gw', username: 'u', password: 'p', keepAliveSeconds: 60, cleanSession: false });
    expect(p[0]).toBe(0x10);
    expect(p[1]).toBe(p.length - 2);
    // protocol name "MQTT", level 4, flags user+pass
    expect(Array.from(p.subarray(2, 10))).toEqual([0, 4, 77, 81, 84, 84, 4, 0xc0]);
  });

  it('decodes packets split across chunks and with multi-byte lengths', () => {
    const payload = utf8Encode('x'.repeat(300));
    const pub = encodePublish('/t', payload, 1, 42);
    expect(pub[1] & 0x80).toBe(0x80); // remaining length > 127
    const d = new PacketDecoder();
    expect(d.push(pub.subarray(0, 1))).toHaveLength(0);
    expect(d.push(pub.subarray(1, 100))).toHaveLength(0);
    const out = d.push(Uint8Array.from([...pub.subarray(100), 0xd0, 0x00]));
    expect(out).toHaveLength(2);
    const p = out[0];
    if (p.type !== PacketType.PUBLISH) throw new Error('expected publish');
    expect(p.topic).toBe('/t');
    expect(p.packetId).toBe(42);
    expect(utf8Decode(p.payload)).toHaveLength(300);
    expect(out[1].type).toBe(PacketType.PINGRESP);
  });
});

describe('mqtt client', () => {
  function setup(autoReconnect = true) {
    let now = 0;
    const transports: FakeTransport[] = [];
    const states: string[] = [];
    const client = new MqttClient(
      () => {
        const t = new FakeTransport();
        transports.push(t);
        return t;
      },
      {
        connect: { clientId: 'gw', keepAliveSeconds: 60, cleanSession: false },
        subscriptions: ['/in'],
        autoReconnect,
        now: () => now,
      },
      { onState: (s) => states.push(s) },
    );
    return { client, transports, states, advance: (ms: number) => (now += ms) };
  }

  it('connects, subscribes, publishes QoS1 and resolves on PUBACK', async () => {
    const { client, transports } = setup();
    client.start();
    await flush();
    const t = transports[0];
    expect(t.lastType()).toBe(PacketType.CONNECT);
    t.handlers.onData(Uint8Array.of(0x20, 2, 0, 0));
    await flush();
    expect(client.state).toBe('connected');
    expect(t.lastType()).toBe(PacketType.SUBSCRIBE);

    const done = jest.fn();
    client.publish('/inbound/1/xtag', '{"a":1}').then(done);
    await flush();
    const pub = t.sent[t.sent.length - 1];
    expect(pub[0]).toBe(0x32);
    const id = (pub[4 + 15] << 8) | pub[5 + 15]; // after topic length(2) + topic(15)
    t.handlers.onData(Uint8Array.of(0x40, 2, id >> 8, id & 0xff));
    await flush();
    expect(done).toHaveBeenCalled();
  });

  it('rejects pending publishes and reconnects with backoff after a drop', async () => {
    const { client, transports, advance } = setup();
    client.start();
    await flush();
    transports[0].handlers.onData(Uint8Array.of(0x20, 2, 0, 0));
    await flush();
    const p = client.publish('/t', 'x');
    await flush();
    transports[0].handlers.onClose(new Error('socket reset'));
    await expect(p).rejects.toThrow('socket reset');
    expect(client.state).toBe('waiting');
    advance(1000);
    client.tick();
    expect(transports).toHaveLength(1);
    advance(1500);
    client.tick();
    await flush();
    expect(transports).toHaveLength(2);
  });

  it('surfaces refused connections and sends keep-alive pings', async () => {
    const { client, transports, advance, states } = setup();
    client.start();
    await flush();
    transports[0].handlers.onData(Uint8Array.of(0x20, 2, 0, 4));
    await flush();
    expect(states).toContain('waiting');

    advance(5000);
    client.tick();
    await flush();
    transports[1].handlers.onData(Uint8Array.of(0x20, 2, 0, 0));
    await flush();
    advance(46000);
    client.tick();
    await flush();
    expect(transports[1].lastType()).toBe(PacketType.PINGREQ);
    advance(31000);
    client.tick();
    expect(client.state).toBe('waiting'); // no PINGRESP -> dropped
  });

  it('rejects publish when not connected', async () => {
    const { client } = setup(false);
    await expect(client.publish('/t', 'x')).rejects.toThrow('not connected');
  });
});
