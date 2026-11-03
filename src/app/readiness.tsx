import { router, useFocusEffect } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState, Text, View } from 'react-native';

import {
  checkReadiness,
  enableBluetooth,
  enableLocationServices,
  isReady,
  type Readiness,
  requestPermissions,
} from '@/services/readiness';
import { Button, Card, Pill, Screen } from '@/ui/components';
import { colors, space, type } from '@/ui/theme';

function Row({ label, ok, optional, action }: { label: string; ok: boolean; optional?: boolean; action?: { title: string; run: () => void } }) {
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', paddingVertical: space(2), gap: space(3) }}>
      <View style={{ flex: 1 }}>
        <Text style={type.body}>{label}</Text>
        {optional ? <Text style={type.small}>Optional</Text> : null}
      </View>
      {ok ? (
        <Pill label="OK" color={colors.success} />
      ) : action ? (
        <Button title={action.title} variant="secondary" onPress={action.run} style={{ minHeight: 36 }} />
      ) : (
        <Pill label="Missing" color={optional ? colors.warning : colors.danger} />
      )}
    </View>
  );
}

export default function ReadinessScreen() {
  const [r, setR] = useState<Readiness | null>(null);
  const asked = useRef(false);
  const navigated = useRef(false);

  const refresh = useCallback(async () => {
    const next = await checkReadiness();
    setR(next);
    if (isReady(next) && !navigated.current) {
      navigated.current = true;
      router.replace('/dashboard');
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      (async () => {
        if (!asked.current) {
          asked.current = true;
          await requestPermissions().catch(() => {});
        }
        await refresh();
      })();
    }, [refresh]),
  );

  // Re-check after returning from system dialogs / settings.
  useEffect(() => {
    const sub = AppState.addEventListener('change', (s) => s === 'active' && void refresh());
    const t = setInterval(() => void refresh(), 2000);
    return () => {
      sub.remove();
      clearInterval(t);
    };
  }, [refresh]);

  if (!r) return <Screen><Text style={type.body}>Checking device…</Text></Screen>;

  const grant = { title: 'Grant', run: () => void requestPermissions().then(refresh) };
  return (
    <Screen>
      <Text style={type.small}>
        The phone acts as a tag reader. Bluetooth and location must be on before continuing.
      </Text>
      <Card>
        <Row label="Bluetooth permission" ok={r.bluetoothPermission} action={grant} />
        <Row label="Location permission" ok={r.location} action={grant} />
        <Row label="Notifications (background status)" ok={r.notifications} optional action={grant} />
        <Row label="Camera (barcode pairing)" ok={r.camera} optional action={grant} />
        <Row
          label="Bluetooth turned on"
          ok={r.bluetoothState === 'on'}
          action={r.bluetoothPermission && r.bluetoothState === 'off' ? { title: 'Turn on', run: () => void enableBluetooth() } : undefined}
        />
        <Row
          label="Location services on"
          ok={r.locationServices}
          action={{ title: 'Turn on', run: () => void enableLocationServices().then(refresh) }}
        />
      </Card>
      {r.bluetoothState === 'unsupported' ? (
        <Text style={{ color: colors.danger }}>This device does not support Bluetooth Low Energy.</Text>
      ) : null}
      <Button title="Continue" disabled={!isReady(r)} onPress={() => router.replace('/dashboard')} />
    </Screen>
  );
}
