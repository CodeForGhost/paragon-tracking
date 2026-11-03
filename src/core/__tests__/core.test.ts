import { TagAggregator, filterLive, type AdvertisementBatchItem } from '../aggregator';
import { base64ToBytes, bytesToBase64, hexToBytes, utf8Decode, utf8Encode } from '../bytes';
import { DEFAULT_CONFIG, mergeConfig, validateConfig, type AppConfig } from '../config';
import { buildInventoryCsv } from '../csv';
import { classifyZone, rssiToDistance, resolveTxPower } from '../distance';
import { buildGatewayPayload, IFACE_MAC, IFACE_UID } from '../payload';
import { isValidBrokerUri, parseBrokerUri } from '../mqtt/uri';
import { parseAdvertisement, PARAGON_COMPANY_ID } from '../tagParser';

const b64 = (hex: string) => bytesToBase64(hexToBytes(hex));

function paragonAdv(id: string, payloadHex: string, name: string | null = null): AdvertisementBatchItem {
  return { id, name, txPower: null, mfg: { [String(PARAGON_COMPANY_ID)]: b64(payloadHex) }, svc: {}, rssis: [] };
}

const cfg: AppConfig = { ...DEFAULT_CONFIG, other: { ...DEFAULT_CONFIG.other, gatewayId: 'GW-1' } };

describe('bytes', () => {
  it('round-trips base64 and utf8', () => {
    const data = Uint8Array.from([0, 1, 2, 250, 255, 128, 77]);
    expect(Array.from(base64ToBytes(bytesToBase64(data)))).toEqual(Array.from(data));
    expect(utf8Decode(utf8Encode('Zürich ✈ 🧳'))).toBe('Zürich ✈ 🧳');
  });
});

describe('tag parser', () => {
  it('parses Paragon manufacturer data (company 0x0EB8)', () => {
    const t = parseAdvertisement(paragonAdv('EB:12:34:56:78:90', '00A1B2C3D4E5FF'))!;
    expect(t.format).toBe('PARAGON');
    expect(t.generationCode).toBe('00A1');
    expect(t.uid).toBe('B2C3D4E5');
    expect(t.name).toBe('PID_00A1B2C3D4E5');
    expect(t.address).toBe('EB1234567890');
    expect(t.key).toBe('EB1234567890');
  });

  it('uses the UID as key when there is no MAC (iOS)', () => {
    const t = parseAdvertisement(paragonAdv('6F1C2D3E-0000-4000-8000-000000000001', '00A1B2C3D4E5', 'Bag 7'))!;
    expect(t.address).toBeNull();
    expect(t.key).toBe('00A1B2C3D4E5');
    expect(t.name).toBe('Bag 7');
  });

  it('rejects short payloads and foreign devices by default', () => {
    expect(parseAdvertisement(paragonAdv('EB:00:00:00:00:01', '00A1B2'))).toBeNull();
    const ibeacon: AdvertisementBatchItem = {
      id: 'AA:00:00:00:00:01', name: null, txPower: null, svc: {}, rssis: [],
      mfg: { '76': b64('0215' + '11'.repeat(16) + '0001' + '0002' + 'C5') },
    };
    expect(parseAdvertisement(ibeacon)).toBeNull();
    const t = parseAdvertisement(ibeacon, { acceptBeaconFormats: true, legacyMacPrefix: '' })!;
    expect(t.format).toBe('IBEACON');
    expect(t.uid).toBe('00010002');
    expect(t.measuredPower).toBe(-59);
  });

  it('parses Eddystone-UID and legacy EB-prefix unknown devices', () => {
    const eddy: AdvertisementBatchItem = {
      id: 'EB:00:00:00:00:02', name: null, txPower: null, mfg: {}, rssis: [],
      svc: { FEAA: b64('00EE' + 'AB'.repeat(10) + '010203040506') },
    };
    const t = parseAdvertisement(eddy, { acceptBeaconFormats: false, legacyMacPrefix: 'eb' })!;
    expect(t.format).toBe('EDDYSTONE_UID');
    expect(t.measuredPower).toBe(-18 - 41);
    const unk: AdvertisementBatchItem = { id: 'EB:00:00:00:00:03', name: null, txPower: null, svc: {}, rssis: [], mfg: { '89': b64('0102030405060708') } };
    expect(parseAdvertisement(unk, { acceptBeaconFormats: false, legacyMacPrefix: 'EB' })!.uid).toBe('010203040506');
  });
});

describe('distance', () => {
  it('matches the original model at defaults', () => {
    expect(rssiToDistance(-59, -59, 2)).toBeCloseTo(1);
    expect(rssiToDistance(-79, -59, 2)).toBeCloseTo(10);
  });
  it('classifies zones with defaults 5/10/20', () => {
    const b = DEFAULT_CONFIG.bluetooth;
    expect(classifyZone(5, b)).toBe('Immed');
    expect(classifyZone(7, b)).toBe('Near');
    expect(classifyZone(20, b)).toBe('Far');
    expect(classifyZone(20.1, b)).toBe('OUT_OF_RANGE');
  });
  it('prefers per-generation calibration', () => {
    const b = { ...DEFAULT_CONFIG.bluetooth, txPowerByGeneration: { '00A1': -65 } };
    expect(resolveTxPower('00A1', null, b)).toBe(-65);
    expect(resolveTxPower('00B2', -70, b)).toBe(-70);
    expect(resolveTxPower(null, null, b)).toBe(-59);
  });
});

describe('aggregator + payload', () => {
  it('aggregates min/max/sum/count and builds the gateway payload', () => {
    const agg = new TagAggregator(cfg.bluetooth);
    agg.ingest([{ ...paragonAdv('EB:12:34:56:78:90', '00A1B2C3D4E5'), rssis: [-60, -70] }], 1000);
    agg.ingest([{ ...paragonAdv('EB:12:34:56:78:90', '00A1B2C3D4E5'), rssis: [-80] }], 2000);
    agg.ingest([{ ...paragonAdv('AA:00:00:00:00:00', ''), rssis: [-50] }], 2000); // ignored

    const rows = agg.takeWindow();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ minRssi: -80, maxRssi: -60, sumRssi: -210, counter: 3, firstSeen: 1000, lastSeen: 2000 });
    expect(agg.windowSize()).toBe(0);

    const p = buildGatewayPayload(rows, { latitude: 52.3, longitude: 4.76, altitude: null, accuracy: 8, timestamp: 0 }, cfg, 5000);
    expect(p.mainUniqueId).toBe('GW-1');
    expect(p.locationGPSLatLonCoordinates).toEqual({ x: 4.76, y: 52.3, alt: null });
    expect(p.beaconReading[0]).toMatchObject({
      id: 'EB1234567890', interfaceTypeId: IFACE_MAC, rssi: -70, avgRssi: -70, sumRssi: -210, counter: 3,
      generationCode: '00A1', format: 'PID_00A1B2C3D4E5',
    });
    const legacy = buildGatewayPayload(rows, null, { ...cfg, mqtt: { ...cfg.mqtt, rssiMode: 'legacySum' } }, 5000);
    expect(legacy.beaconReading[0].rssi).toBe(-210);
    expect(legacy.locationGPSLatLonCoordinates).toBeNull();
  });

  it('marks UID-keyed readings and expires live entries', () => {
    const agg = new TagAggregator(cfg.bluetooth);
    agg.ingest([{ ...paragonAdv('peripheral-uuid', '00A1B2C3D4E5'), rssis: [-59] }], 0);
    expect(buildGatewayPayload(agg.windowSnapshot(), null, cfg, 0).beaconReading[0].interfaceTypeId).toBe(IFACE_UID);
    expect(agg.liveTags()).toHaveLength(1);
    expect(agg.expire(500, 1000)).toBe(false);
    expect(agg.expire(1501, 1000)).toBe(true);
    expect(agg.liveTags()).toHaveLength(0);
  });

  it('restores a window by merging stats', () => {
    const agg = new TagAggregator(cfg.bluetooth);
    agg.ingest([{ ...paragonAdv('EB:00:00:00:00:01', '00A1B2C3D4E5'), rssis: [-60] }], 10);
    const saved = agg.takeWindow();
    agg.ingest([{ ...paragonAdv('EB:00:00:00:00:01', '00A1B2C3D4E5'), rssis: [-70] }], 20);
    agg.restoreWindow(saved);
    expect(agg.windowSnapshot()[0]).toMatchObject({ sumRssi: -130, counter: 2, firstSeen: 10, minRssi: -70, maxRssi: -60 });
  });

  it('filters and sorts the live list', () => {
    const agg = new TagAggregator(cfg.bluetooth);
    agg.ingest(
      [
        { ...paragonAdv('EB:00:00:00:00:01', '00A100000001', 'PID_near'), rssis: [-75] },
        { ...paragonAdv('EB:00:00:00:00:02', '00A100000002', 'PID_close'), rssis: [-55] },
        { ...paragonAdv('EB:00:00:00:00:03', '00A100000003', 'PID_far'), rssis: [-95] },
      ],
      0,
    );
    const list = filterLive(agg.liveTags(), { nameFilter: 'pid', search: '', maxDistance: 20 });
    expect(list.map((t) => t.tag.name)).toEqual(['PID_close', 'PID_near']);
    expect(filterLive(agg.liveTags(), { nameFilter: '', search: '0002', maxDistance: 20 })).toHaveLength(1);
  });
});

describe('csv', () => {
  it('escapes and neutralises formulas', () => {
    const agg = new TagAggregator(cfg.bluetooth);
    agg.ingest([{ ...paragonAdv('EB:00:00:00:00:01', '00A1B2C3D4E5', '=HYPERLINK("x")'), rssis: [-60] }], 0);
    const csv = buildInventoryCsv(agg.windowSnapshot());
    const line = csv.split('\r\n')[1];
    expect(line.startsWith(`"'=HYPERLINK(""x"")"`)).toBe(true);
    expect(line).toContain('EB0000000001');
  });
});

describe('config + broker uri', () => {
  it('parses broker URIs', () => {
    expect(parseBrokerUri('tcp://demo.tracktio.com:1883')).toMatchObject({ host: 'demo.tracktio.com', port: 1883, tls: false, websocket: false });
    expect(parseBrokerUri('ssl://broker')).toMatchObject({ port: 8883, tls: true });
    expect(parseBrokerUri('wss://b.example.com/mqtt')).toMatchObject({ port: 443, path: '/mqtt', websocket: true });
    expect(isValidBrokerUri('http://x')).toBe(false);
    expect(isValidBrokerUri('tcp://x:99999')).toBe(false);
    expect(isValidBrokerUri('tcp://x/path')).toBe(false);
  });
  it('merges stored config over defaults and validates', () => {
    const c = mergeConfig({ bluetooth: { maxDistance: 30 }, server: { pages: { map: '/m' } } });
    expect(c.bluetooth.maxDistance).toBe(30);
    expect(c.bluetooth.nearDistance).toBe(10);
    expect(c.server.pages).toEqual({ ...DEFAULT_CONFIG.server.pages, map: '/m' });
    const errs = validateConfig({ ...c, other: { ...c.other, gatewayId: '' } }, isValidBrokerUri);
    expect(Object.keys(errs)).toEqual(['other.gatewayId']);
  });
});
