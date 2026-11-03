# Paragon ID — React Native (Expo SDK 58)

Rebuild of the `com.airport.paragonid` Android app (see `../paragonid-app-teardown.md`). The phone acts as a
mobile BLE **gateway**: it scans Paragon xGenTag tags, estimates distance/zone, aggregates readings and
publishes batches (tags + phone GPS) over MQTT.

## Run

Needs a development build (Expo Go cannot load the native BLE module).

```sh
npm install
npm run android          # = npx expo run:android  (device with BLE; emulators have no Bluetooth)
npm run ios              # macOS only
npm test                 # core logic unit tests
npm run typecheck && npm run lint
```

In development builds, sign-in falls back to a **demo mode** (any email/password) while no backend API is
configured. Release builds require an API URL (Configuration → Server) unless `EXPO_PUBLIC_DEMO_AUTH=1`.

## Layout

| Path | What |
|---|---|
| `src/core/` | Pure TypeScript, unit-tested: tag parser (0x0EB8 / iBeacon / Eddystone), distance + zones + EMA, window aggregation, gateway payload, CSV, MQTT 3.1.1 codec + client |
| `src/services/` | SQLite (settings, persisted window, outbox, pairings), SecureStore secrets, scanner, MQTT transports, gateway loop, auth, pairing sync, permissions |
| `src/app/` | Expo Router screens: splash, login, readiness gate, dashboard, search (+Home/Map), inventory, pairing, web dashboards, configuration |
| `modules/paragon-native/` | Local Expo module (Kotlin + Swift): BLE scanner with hardware filters, Android foreground service + tick, TCP/TLS sockets |

## Workflows → implementation

| # | Original | Here |
|---|---|---|
| 1 | Splash → mocked login | Splash → login against `POST {api}/auth/login` (token in SecureStore). Demo mode in dev only |
| 2 | Readiness gate | Bluetooth/location/notification/camera permissions, Bluetooth on, location services on |
| 3 | Dashboard (5 tiles, back twice exits) | Same, plus a background-tracking card (broker state, queue, last upload) |
| 4 | Search (Immediate/Near/Far, Play/Stop, Home/Map tabs) | Same; 3 s live TTL |
| 5 | Foreground service + MQTT upload | Native foreground service (`connectedDevice\|location`) drives a 5 s tick; window persisted to SQLite; payloads go through an outbox and are deleted only after PUBACK (QoS 1) |
| 6 | Inventory (timer, CSV, email) | Same; CSV escaped against formula injection; mail composer or share sheet |
| 7 | Pairing (display only) | Barcode → pick nearest tag → stored locally → synced to `POST/DELETE {api}/pairings`; unpair |
| 8 | Platform Access / Home / Map WebViews | Same, HTTP basic auth via `basicAuthCredential`; **TLS errors are not ignored** |
| 9 | Configuration (Bluetooth/MQTT/Server/Other) | Same keys + calibration, path-loss, smoothing, TLS; passwords in SecureStore |
| 10 | Logout | Confirmation, stops tracking, clears token |

## Changes from the original (per the teardown)

- Tags are identified by **manufacturer data 0x0EB8**, with a hardware `ScanFilter` on Android, not by the `EB` MAC
  prefix. The legacy prefix mode is available as an option.
- Payload `id` is the MAC on Android (`BLE_AdvAddr`, matching the platform contract) and the decoded
  `generationCode+UID` on iOS (`BLE_PID_UID`). **The platform must accept the iOS form.**
- `rssi` is the **average** by default. `avgRssi`, `sumRssi`, `minRssi`, `maxRssi` and `counter` are always sent. A
  "Legacy RSSI field" toggle restores `rssi = sum`.
- Distance uses EMA-smoothed RSSI, a per-generation txPower calibration map and a configurable path-loss
  exponent.
- The default broker is `ssl://demo.tracktio.com:8883` with no credentials. Set real per-device credentials. `tcp://` still works but shows a warning.
- The IMEI can't be read on modern phones, so a stable `PGW-…` gateway id is generated (editable).

## Backend contract (assumed — adjust to the real API)

```
POST   /auth/login   { email, password }                                  -> { token, user?: { email, name } }
POST   /pairings     { barcode, barcodeType, tagId, tagUid, tagName, gatewayId, pairedAt } -> { id }
DELETE /pairings/:id
```

## Known limits

- **iOS**: no background gateway. CoreBluetooth can't scan manufacturer-data-only tags in the background, and it hides
  iBeacon frames. The pipeline runs while the app is in the foreground.
- **Android**: if the user swipes the app away, the JS runtime can be torn down while the service keeps running.
  The notification's **Stop** action and restarting tracking recover from this. A fully native upload path would remove
  this limit.
- The partial wake lock keeps ticks running in Doze. It costs battery, which is the trade-off for a dedicated gateway phone.
- RSSI distance stays approximate. Calibrate `txPower` per generation code at 1 m.
