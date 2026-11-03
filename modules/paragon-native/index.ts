import { NativeModule, requireNativeModule } from 'expo';

export type BluetoothState = 'on' | 'off' | 'unauthorized' | 'unsupported' | 'unknown';

export interface ScanOptions {
  /** Manufacturer company ids to match (hardware filter on Android). */
  manufacturerIds: number[];
  /** 16-bit ("FEAA") or 128-bit service UUIDs to match. */
  serviceUuids?: string[];
  /** Android: also match Apple iBeacon frames. (iOS never exposes iBeacon frames to CoreBluetooth.) */
  iBeacon?: boolean;
  /** No filters at all (debug; Android stops delivering results with the screen off). */
  unfiltered?: boolean;
  lowPower?: boolean;
  batchIntervalMs?: number;
  /** Android: stop/2 s pause/start cycle period. 0 disables. */
  restartIntervalMs?: number;
}

export interface NativeAdvertisement {
  id: string;
  name: string | null;
  txPower: number | null;
  mfg: Record<string, string>;
  svc: Record<string, string>;
  rssis: number[];
}

export interface GatewayOptions {
  title: string;
  text: string;
  tickIntervalMs: number;
}

type Events = {
  onAdvertisements(e: { items: NativeAdvertisement[]; timestamp: number }): void;
  onScanState(e: { scanning: boolean; error?: string | null }): void;
  onGatewayTick(e: { timestamp: number }): void;
  onGatewayStopRequested(e: Record<string, never>): void;
  onGatewayError(e: { message: string }): void;
  onSocketData(e: { id: string; data: string }): void;
  onSocketClose(e: { id: string; error?: string | null }): void;
};

declare class ParagonNativeModule extends NativeModule<Events> {
  getBluetoothState(): BluetoothState;
  requestEnableBluetooth(): Promise<boolean>;
  startScan(options: ScanOptions): void;
  stopScan(): void;
  isScanning(): boolean;
  startGatewayService(options: GatewayOptions): void;
  stopGatewayService(): void;
  isGatewayServiceRunning(): boolean;
  socketConnect(id: string, host: string, port: number, tls: boolean, timeoutMs: number): Promise<void>;
  socketWrite(id: string, base64: string): Promise<void>;
  socketClose(id: string): void;
}

export default requireNativeModule<ParagonNativeModule>('ParagonNative');
