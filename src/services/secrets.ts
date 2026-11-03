import * as SecureStore from 'expo-secure-store';

export type SecretKey = 'mqttPassword' | 'serverPassword' | 'authToken' | 'authUser';

const OPTS: SecureStore.SecureStoreOptions = {
  keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK, // readable by the background gateway
};

export async function getSecret(key: SecretKey): Promise<string> {
  try {
    return (await SecureStore.getItemAsync(key, OPTS)) ?? '';
  } catch {
    return '';
  }
}

export async function setSecret(key: SecretKey, value: string): Promise<void> {
  if (value) await SecureStore.setItemAsync(key, value, OPTS);
  else await SecureStore.deleteItemAsync(key, OPTS);
}
