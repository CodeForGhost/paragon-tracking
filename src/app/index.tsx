import { Redirect } from 'expo-router';
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';

import { useAuth } from '@/services/auth';
import { useConfig } from '@/services/configStore';
import { colors } from '@/ui/theme';

export default function Splash() {
  const status = useAuth((s) => s.status);
  const loaded = useConfig((s) => s.loaded);

  if (status === 'signedIn' && loaded) return <Redirect href="/readiness" />;
  if (status === 'signedOut') return <Redirect href="/login" />;

  return (
    <View style={styles.root}>
      <Text style={styles.brand}>Paragon ID</Text>
      <Text style={styles.tagline}>Smart tracking Solutions</Text>
      <ActivityIndicator color={colors.accent} style={{ marginTop: 32 }} />
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.primary, alignItems: 'center', justifyContent: 'center' },
  brand: { color: '#fff', fontSize: 34, fontWeight: '800', letterSpacing: 1 },
  tagline: { color: colors.accent, fontSize: 16, marginTop: 8, fontWeight: '600' },
});
