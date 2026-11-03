import { type Href, router, useFocusEffect } from 'expo-router';
import { useCallback, useRef, useState } from 'react';
import { BackHandler, Platform, Pressable, StyleSheet, Text, ToastAndroid, View } from 'react-native';

import { useAuth } from '@/services/auth';
import { gateway, useGateway } from '@/services/gateway';
import { useMqttStatus } from '@/services/mqttService';
import { Banner, Button, Card, KeyValue, Pill, Screen } from '@/ui/components';
import { mqttStateColor, mqttStateLabel, timeAgo } from '@/ui/format';
import { colors, radius, space, type } from '@/ui/theme';

const TILES: { title: string; subtitle: string; href: Href; glyph: string }[] = [
  { title: 'Search', subtitle: 'Live tags by distance', href: '/search', glyph: '⌕' },
  { title: 'Inventory', subtitle: 'Timed count & CSV', href: '/inventory', glyph: '☰' },
  { title: 'Pairing / Unpairing', subtitle: 'Barcode ↔ tag', href: '/pairing', glyph: '⇄' },
  { title: 'Platform Access', subtitle: 'Dashboards & KPIs', href: { pathname: '/web', params: { page: 'platform1' } }, glyph: '◫' },
  { title: 'Configuration', subtitle: 'Bluetooth, MQTT, server', href: '/settings', glyph: '⚙' },
];

export default function Dashboard() {
  const g = useGateway();
  const mqtt = useMqttStatus();
  const user = useAuth((s) => s.user);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const lastBack = useRef(0);

  // Press back twice to exit (original behaviour).
  useFocusEffect(
    useCallback(() => {
      if (Platform.OS !== 'android') return;
      const sub = BackHandler.addEventListener('hardwareBackPress', () => {
        const now = Date.now();
        if (now - lastBack.current < 2000) return false;
        lastBack.current = now;
        ToastAndroid.show('Press back again to exit', ToastAndroid.SHORT);
        return true;
      });
      return () => sub.remove();
    }, []),
  );

  async function toggleGateway() {
    setErr(null);
    setBusy(true);
    try {
      if (g.running) await gateway.stop();
      else await gateway.start();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Screen>
      {user?.demo ? <Banner tone="warn">Signed in with demo authentication ({user.email}).</Banner> : null}

      <Card>
        <View style={styles.gwHeader}>
          <View style={{ flex: 1 }}>
            <Text style={type.h2}>Background tracking</Text>
            <Text style={type.small}>Scan tags and upload them to the platform over MQTT</Text>
          </View>
          <Pill label={g.running ? 'Running' : 'Stopped'} color={g.running ? colors.success : colors.zoneFar} />
        </View>
        {g.running ? (
          <View style={{ marginTop: space(2) }}>
            <KeyValue k="Broker" v={<Text style={{ color: mqttStateColor(mqtt.state) }}>{mqttStateLabel(mqtt.state)}</Text>} />
            {mqtt.detail && mqtt.state !== 'connected' ? <KeyValue k="Reason" v={mqtt.detail} /> : null}
            <KeyValue k="Tags in current window" v={String(g.windowSize)} />
            <KeyValue k="Queued uploads" v={String(g.outboxSize)} />
            <KeyValue k="Last upload" v={g.lastUploadAt ? `${timeAgo(g.lastUploadAt)} (${g.lastUploadCount} tags)` : '—'} />
            {g.lastError ? <Text style={{ color: colors.danger, marginTop: space(1) }}>{g.lastError}</Text> : null}
          </View>
        ) : null}
        {err ? <Text style={{ color: colors.danger, marginTop: space(2) }}>{err}</Text> : null}
        <Button
          title={g.running ? 'Stop tracking' : 'Start tracking'}
          variant={g.running ? 'danger' : 'primary'}
          onPress={toggleGateway}
          loading={busy}
          style={{ marginTop: space(3) }}
        />
        {Platform.OS === 'ios' ? (
          <Text style={[type.small, { marginTop: space(2) }]}>
            iOS: tracking pauses while the app is in the background.
          </Text>
        ) : null}
      </Card>

      <View style={styles.grid}>
        {TILES.map((t) => (
          <Pressable
            key={t.title}
            accessibilityRole="button"
            onPress={() => router.push(t.href)}
            style={({ pressed }) => [styles.tile, pressed && { opacity: 0.85 }]}
          >
            <Text style={styles.glyph}>{t.glyph}</Text>
            <Text style={styles.tileTitle}>{t.title}</Text>
            <Text style={type.small}>{t.subtitle}</Text>
          </Pressable>
        ))}
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  gwHeader: { flexDirection: 'row', alignItems: 'center', gap: space(3) },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: space(3) },
  tile: {
    flexGrow: 1,
    flexBasis: '45%',
    minHeight: 118,
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    padding: space(4),
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    borderTopWidth: 4,
    borderTopColor: colors.accent,
  },
  glyph: { fontSize: 24, color: colors.primary, marginBottom: space(2) },
  tileTitle: { ...type.h2, marginBottom: 2 },
});
