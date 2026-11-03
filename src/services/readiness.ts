import ParagonNative, { type BluetoothState } from '@modules/paragon-native';
import { Camera } from 'expo-camera';
import * as Location from 'expo-location';
import { Linking, PermissionsAndroid, Platform } from 'react-native';

export interface Readiness {
  bluetoothPermission: boolean;
  location: boolean;
  notifications: boolean; // Android 13+: needed to show the gateway notification
  camera: boolean;
  bluetoothState: BluetoothState;
  locationServices: boolean;
}

/** Required before the dashboard. Camera & notifications are requested but not required. */
export const isReady = (r: Readiness) =>
  r.bluetoothPermission && r.location && r.bluetoothState === 'on' && r.locationServices;

const P = PermissionsAndroid.PERMISSIONS;
const apiLevel = () => (Platform.OS === 'android' ? (Platform.Version as number) : 0);

type AndroidPermission = (typeof P)[keyof typeof P];

function androidBtPermissions(): AndroidPermission[] {
  return apiLevel() >= 31 ? [P.BLUETOOTH_SCAN, P.BLUETOOTH_CONNECT] : [];
}

export async function checkReadiness(): Promise<Readiness> {
  const [loc, cam, svc] = await Promise.all([
    Location.getForegroundPermissionsAsync(),
    Camera.getCameraPermissionsAsync(),
    Location.hasServicesEnabledAsync().catch(() => false),
  ]);
  let bluetoothPermission = true;
  let notifications = true;
  if (Platform.OS === 'android') {
    for (const p of androidBtPermissions()) bluetoothPermission &&= await PermissionsAndroid.check(p);
    if (apiLevel() >= 33) notifications = await PermissionsAndroid.check(P.POST_NOTIFICATIONS);
  }
  const bluetoothState = ParagonNative.getBluetoothState();
  if (Platform.OS === 'ios') bluetoothPermission = bluetoothState !== 'unauthorized';
  return {
    bluetoothPermission,
    location: loc.granted,
    notifications,
    camera: cam.granted,
    bluetoothState,
    locationServices: svc,
  };
}

export async function requestPermissions(): Promise<void> {
  await Location.requestForegroundPermissionsAsync();
  if (Platform.OS === 'android') {
    const perms = [...androidBtPermissions()];
    if (apiLevel() >= 33) perms.push(P.POST_NOTIFICATIONS);
    if (perms.length) await PermissionsAndroid.requestMultiple(perms);
  } else {
    // Touching the central manager triggers the iOS Bluetooth prompt.
    ParagonNative.getBluetoothState();
  }
  await Camera.requestCameraPermissionsAsync();
}

export async function enableBluetooth(): Promise<void> {
  if (Platform.OS === 'android') {
    await ParagonNative.requestEnableBluetooth();
  } else {
    await Linking.openSettings();
  }
}

export async function enableLocationServices(): Promise<void> {
  if (Platform.OS === 'android') {
    try {
      await Location.enableNetworkProviderAsync();
      return;
    } catch {
      /* user declined; fall back to settings */
    }
  }
  await Linking.openSettings();
}
