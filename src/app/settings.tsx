import { router, useLocalSearchParams } from 'expo-router';
import { useEffect, useState } from 'react';
import { Alert, Text, View } from 'react-native';

import { type AppConfig, validateConfig } from '@/core/config';
import { isValidBrokerUri } from '@/core/mqtt/uri';
import { auth, useAuth } from '@/services/auth';
import { useConfig } from '@/services/configStore';
import { gateway } from '@/services/gateway';
import { useLog } from '@/services/logger';
import { pairingService } from '@/services/pairing';
import { scanService } from '@/services/scanService';
import { getSecret, setSecret } from '@/services/secrets';
import { Banner, Button, Card, Field, NumberField, Screen, Segmented, SectionTitle, ToggleRow } from '@/ui/components';
import { colors, space, type } from '@/ui/theme';

type Tab = 'bluetooth' | 'mqtt' | 'server' | 'other';

function formatCalibration(m: Record<string, number>) {
  return Object.entries(m).map(([k, v]) => `${k}=${v}`).join(', ');
}

function parseCalibration(s: string): Record<string, number> | null {
  const out: Record<string, number> = {};
  for (const part of s.split(/[,;\n]/).map((p) => p.trim()).filter(Boolean)) {
    const m = /^([0-9a-fA-F]{4})\s*=\s*(-\d{1,3})$/.exec(part);
    if (!m) return null;
    out[m[1].toUpperCase()] = Number(m[2]);
  }
  return out;
}

export default function Settings() {
  const params = useLocalSearchParams<{ tab?: Tab }>();
  const [tab, setTab] = useState<Tab>(params.tab ?? 'bluetooth');
  const stored = useConfig((s) => s.config);
  const signedIn = useAuth((s) => s.status === 'signedIn');
  const logEntries = useLog((s) => s.entries);
  const [draft, setDraft] = useState<AppConfig>(stored);
  const [mqttPassword, setMqttPassword] = useState('');
  const [serverPassword, setServerPassword] = useState('');
  const [calibration, setCalibration] = useState(formatCalibration(stored.bluetooth.txPowerByGeneration));
  const [errors, setErrors] = useState<Record<string, string | undefined>>({});
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    void getSecret('mqttPassword').then(setMqttPassword);
    void getSecret('serverPassword').then(setServerPassword);
  }, []);

  function set<K extends keyof AppConfig>(group: K, patch: Partial<AppConfig[K]>) {
    setSaved(false);
    setDraft((d) => ({ ...d, [group]: { ...d[group], ...patch } }));
  }

  async function save() {
    const cal = parseCalibration(calibration);
    const next: AppConfig = cal ? { ...draft, bluetooth: { ...draft.bluetooth, txPowerByGeneration: cal } } : draft;
    const errs: Record<string, string | undefined> = validateConfig(next, isValidBrokerUri);
    if (!cal) errs['bluetooth.txPowerByGeneration'] = 'Format: 00A1=-62, 00B2=-65';
    setErrors(errs);
    if (Object.keys(errs).length) {
      const first = Object.keys(errs)[0].split('.')[0] as Tab;
      setTab(first);
      return;
    }
    setSaving(true);
    try {
      await useConfig.getState().save(next);
      await setSecret('mqttPassword', mqttPassword);
      await setSecret('serverPassword', serverPassword);
      scanService.applyConfig(next);
      await gateway.reconfigure();
      void pairingService.sync();
      setSaved(true);
    } catch (e) {
      Alert.alert('Could not save', (e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  function logout() {
    Alert.alert('Logout', 'Do you want to log out? Background tracking will stop.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Logout',
        style: 'destructive',
        onPress: async () => {
          await gateway.stop().catch(() => {});
          await auth.logout();
          router.replace('/login');
        },
      },
    ]);
  }

  const e = (k: string) => errors[k];
  const b = draft.bluetooth;
  const m = draft.mqtt;
  const s = draft.server;
  const o = draft.other;
  const key = tab; // remount fields per tab so defaultValue-based inputs refresh

  return (
    <Screen>
      <Segmented
        options={[
          { value: 'bluetooth', label: 'Bluetooth' },
          { value: 'mqtt', label: 'MQTT' },
          { value: 'server', label: 'Server' },
          { value: 'other', label: 'Other' },
        ]}
        value={tab}
        onChange={setTab}
      />

      <Card key={key}>
        {tab === 'bluetooth' ? (
          <>
            <Field label="Name filter (prefix)" value={b.nameFilter} onChangeText={(v) => set('bluetooth', { nameFilter: v })} hint="Only show tags whose name starts with this" />
            <NumberField label="Immediate zone up to (m)" value={b.immediateDistance} onChange={(v) => set('bluetooth', { immediateDistance: v })} error={e('bluetooth.immediateDistance')} />
            <NumberField label="Near zone up to (m)" value={b.nearDistance} onChange={(v) => set('bluetooth', { nearDistance: v })} error={e('bluetooth.nearDistance')} />
            <NumberField label="Max distance / Far zone up to (m)" value={b.maxDistance} onChange={(v) => set('bluetooth', { maxDistance: v })} error={e('bluetooth.maxDistance')} />
            <NumberField label="Scan cycle (minutes)" value={b.scanIntervalMinutes} onChange={(v) => set('bluetooth', { scanIntervalMinutes: v })} error={e('bluetooth.scanIntervalMinutes')} hint="Scanner is restarted after each cycle" />
            <SectionTitle>Distance model</SectionTitle>
            <NumberField label="Default RSSI at 1 m (dBm)" value={b.defaultTxPower} onChange={(v) => set('bluetooth', { defaultTxPower: v })} error={e('bluetooth.defaultTxPower')} />
            <Field label="Calibration per generation code" value={calibration} onChangeText={(v) => { setSaved(false); setCalibration(v); }} placeholder="00A1=-62, 00B2=-65" error={e('bluetooth.txPowerByGeneration')} hint="Measured RSSI at 1 m for each tag generation" />
            <NumberField label="Path-loss exponent" value={b.pathLossExponent} onChange={(v) => set('bluetooth', { pathLossExponent: v })} error={e('bluetooth.pathLossExponent')} hint="2 = open space, 2.5–3.5 typical indoors" />
            <NumberField label="RSSI smoothing (0–1)" value={b.rssiSmoothing} onChange={(v) => set('bluetooth', { rssiSmoothing: v })} error={e('bluetooth.rssiSmoothing')} hint="Lower = steadier, higher = more responsive" />
            <SectionTitle>Scanning</SectionTitle>
            <ToggleRow label="Battery saver scanning" value={b.lowPowerScan} onChange={(v) => set('bluetooth', { lowPowerScan: v })} hint="Balanced instead of low-latency mode" />
            <ToggleRow label="Accept iBeacon / Eddystone" value={b.acceptBeaconFormats} onChange={(v) => set('bluetooth', { acceptBeaconFormats: v })} hint="iBeacon frames are Android only" />
            <Field label="Legacy MAC prefix (Android)" value={b.legacyMacPrefix} onChangeText={(v) => set('bluetooth', { legacyMacPrefix: v.toUpperCase() })} placeholder="e.g. EB (leave empty)" hint="Original app behaviour. Requires unfiltered scanning, which drains battery." />
          </>
        ) : null}

        {tab === 'mqtt' ? (
          <>
            <Field label="Broker URI" value={m.brokerUri} onChangeText={(v) => set('mqtt', { brokerUri: v.trim() })} placeholder="ssl://broker.example.com:8883" error={e('mqtt.brokerUri')} hint="tcp://, ssl://, ws:// or wss://" />
            {m.brokerUri.startsWith('tcp://') || m.brokerUri.startsWith('ws://') ? (
              <Banner tone="warn">Unencrypted connection: credentials and tag data are sent in plain text.</Banner>
            ) : null}
            <View style={{ height: space(2) }} />
            <Field label="Username" value={m.username} onChangeText={(v) => set('mqtt', { username: v })} />
            <Field label="Password" value={mqttPassword} onChangeText={(v) => { setSaved(false); setMqttPassword(v); }} secureTextEntry hint="Stored in the device keychain" />
            <Field label="Topic" value={m.topic} onChangeText={(v) => set('mqtt', { topic: v.trim() })} error={e('mqtt.topic')} />
            <NumberField label="Keep-alive (s)" value={m.keepAliveSeconds} onChange={(v) => set('mqtt', { keepAliveSeconds: v })} error={e('mqtt.keepAliveSeconds')} decimal={false} />
            <ToggleRow label="Clean session" value={m.cleanSession} onChange={(v) => set('mqtt', { cleanSession: v })} />
            <ToggleRow
              label="Legacy RSSI field (sum)"
              value={m.rssiMode === 'legacySum'}
              onChange={(v) => set('mqtt', { rssiMode: v ? 'legacySum' : 'average' })}
              hint="Send rssi as the sum of samples like the original app. avgRssi/sumRssi are always included."
            />
          </>
        ) : null}

        {tab === 'server' ? (
          <>
            <Field label="Backend API URL" value={s.apiBaseUrl} onChangeText={(v) => set('server', { apiBaseUrl: v.trim() })} placeholder="https://api.example.com/v1" error={e('server.apiBaseUrl')} hint="Used for sign-in and tag pairing" />
            <SectionTitle>Dashboards</SectionTitle>
            <Field label="Dashboard URL" value={s.dashboardUrl} onChangeText={(v) => set('server', { dashboardUrl: v.trim() })} placeholder="https://platform.example.com" error={e('server.dashboardUrl')} />
            <Field label="Username" value={s.username} onChangeText={(v) => set('server', { username: v })} />
            <Field label="Password" value={serverPassword} onChangeText={(v) => { setSaved(false); setServerPassword(v); }} secureTextEntry />
            <Field label="Home page path" value={s.pages.home} onChangeText={(v) => set('server', { pages: { ...s.pages, home: v.trim() } })} placeholder="/" />
            <Field label="Map page path" value={s.pages.map} onChangeText={(v) => set('server', { pages: { ...s.pages, map: v.trim() } })} placeholder="/map" />
            <Field label="Platform Access 1 path" value={s.pages.platform1} onChangeText={(v) => set('server', { pages: { ...s.pages, platform1: v.trim() } })} />
            <Field label="Platform Access 2 path" value={s.pages.platform2} onChangeText={(v) => set('server', { pages: { ...s.pages, platform2: v.trim() } })} />
          </>
        ) : null}

        {tab === 'other' ? (
          <>
            <Field label="Gateway ID (mainUniqueId)" value={o.gatewayId} onChangeText={(v) => set('other', { gatewayId: v.trim() })} error={e('other.gatewayId')} hint="Replaces the IMEI, which modern phones don't expose" />
            <Field label="Gateway interface type" value={o.gatewayInterfaceType} onChangeText={(v) => set('other', { gatewayInterfaceType: v.trim() })} />
            <NumberField label="Upload interval, foreground (s)" value={o.foregroundUploadSeconds} onChange={(v) => set('other', { foregroundUploadSeconds: v })} error={e('other.foregroundUploadSeconds')} decimal={false} />
            <NumberField label="Upload interval, background (s)" value={o.backgroundUploadSeconds} onChange={(v) => set('other', { backgroundUploadSeconds: v })} error={e('other.backgroundUploadSeconds')} decimal={false} />
            <NumberField label="Inventory duration (min)" value={o.inventoryMinutes} onChange={(v) => set('other', { inventoryMinutes: v })} error={e('other.inventoryMinutes')} />
            <Field label="Inventory email recipient" value={o.inventoryEmail} onChangeText={(v) => set('other', { inventoryEmail: v.trim() })} keyboardType="email-address" />
          </>
        ) : null}
      </Card>

      {saved ? <Banner tone="info">Settings saved.</Banner> : null}
      <Button title="Save" onPress={save} loading={saving} />

      {tab === 'other' ? (
        <>
          <SectionTitle>Recent activity</SectionTitle>
          <Card>
            {logEntries.length === 0 ? <Text style={type.small}>Nothing logged yet.</Text> : null}
            {logEntries.slice(0, 30).map((l, i) => (
              <Text key={i} style={[type.small, l.level === 'error' && { color: colors.danger }, l.level === 'warn' && { color: colors.warning }]}>
                {new Date(l.t).toLocaleTimeString()} [{l.tag}] {l.msg}
              </Text>
            ))}
          </Card>
        </>
      ) : null}

      {signedIn ? <Button title="Logout" variant="danger" onPress={logout} style={{ marginTop: space(4) }} /> : null}
    </Screen>
  );
}
