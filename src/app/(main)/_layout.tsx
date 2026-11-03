import { Redirect, Stack } from 'expo-router';

import { useAuth } from '@/services/auth';
import { colors } from '@/ui/theme';

export default function MainLayout() {
  const status = useAuth((s) => s.status);
  if (status === 'signedOut') return <Redirect href="/login" />;

  return (
    <Stack
      screenOptions={{
        headerStyle: { backgroundColor: colors.header },
        headerTintColor: '#fff',
        headerTitleStyle: { fontWeight: '700' },
        contentStyle: { backgroundColor: colors.bg },
      }}
    >
      <Stack.Screen name="dashboard" options={{ title: 'Paragon ID' }} />
      <Stack.Screen name="search" options={{ title: 'xGenTag Search' }} />
      <Stack.Screen name="inventory" options={{ title: 'Inventory' }} />
      <Stack.Screen name="pairing" options={{ title: 'Pairing / Unpairing' }} />
      <Stack.Screen name="web" options={{ title: 'Platform Access' }} />
    </Stack>
  );
}
