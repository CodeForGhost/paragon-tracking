import { Stack } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { StatusBar } from 'expo-status-bar';
import { useEffect } from 'react';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { auth } from '@/services/auth';
import { useConfig } from '@/services/configStore';
import { log } from '@/services/logger';
import { pairingService } from '@/services/pairing';
import { scanService } from '@/services/scanService';
import { colors } from '@/ui/theme';

void SplashScreen.preventAutoHideAsync().catch(() => {});

export default function RootLayout() {
  useEffect(() => {
    (async () => {
      try {
        const cfg = await useConfig.getState().load();
        scanService.applyConfig(cfg);
        await auth.restore();
        void pairingService.reload();
      } catch (e) {
        log.error('boot', (e as Error).message);
        await auth.restore().catch(() => {});
      } finally {
        await SplashScreen.hideAsync().catch(() => {});
      }
    })();
  }, []);

  return (
    <SafeAreaProvider>
      <StatusBar style="light" />
      <Stack
        screenOptions={{
          headerStyle: { backgroundColor: colors.header },
          headerTintColor: '#fff',
          headerTitleStyle: { fontWeight: '700' },
          contentStyle: { backgroundColor: colors.bg },
        }}
      >
        <Stack.Screen name="index" options={{ headerShown: false }} />
        <Stack.Screen name="login" options={{ headerShown: false }} />
        <Stack.Screen name="readiness" options={{ title: 'Getting ready', headerBackVisible: false }} />
        <Stack.Screen name="settings" options={{ title: 'Configuration' }} />
        <Stack.Screen name="(main)" options={{ headerShown: false }} />
      </Stack>
    </SafeAreaProvider>
  );
}
