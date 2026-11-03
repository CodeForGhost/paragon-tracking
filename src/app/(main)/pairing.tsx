import { CameraView, useCameraPermissions, type BarcodeType } from 'expo-camera';
import { useFocusEffect } from 'expo-router';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Alert, Pressable, StyleSheet, Text, View } from 'react-native';

import { filterLive, type LiveTag } from '@/core/aggregator';
import { isApiConfigured } from '@/services/api';
import { useConfig } from '@/services/configStore';
import { type Pairing, pairingService, usePairings } from '@/services/pairing';
import { scanService, useScan } from '@/services/scanService';
import { Banner, Button, Card, Pill, Screen, SectionTitle } from '@/ui/components';
import { formatDistance, zoneColor } from '@/ui/format';
import { colors, radius, space, type } from '@/ui/theme';

// Code 128 / EAN-13 / UPC-A as in the original; QR covers the URL / email / phone payloads.
const BARCODE_TYPES: BarcodeType[] = ['code128', 'ean13', 'upc_a', 'qr'];

function syncLabel(p: Pairing): { label: string; color: string } {
  if (p.syncState === 'synced') return { label: 'Synced', color: colors.success };
  if (p.syncState === 'error') return { label: 'Sync failed', color: colors.danger };
  return { label: isApiConfigured() ? 'Syncing' : 'Local only', color: colors.warning };
}

export default function PairingScreen() {
  const [permission, requestPermission] = useCameraPermissions();
  const [scanned, setScanned] = useState<{ data: string; type: string } | null>(null);
  const [cameraOn, setCameraOn] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const live = useScan((s) => s.live);
  const bt = useConfig((s) => s.config.bluetooth);
  const pairings = usePairings((s) => s.items);

  function onScanned(data: string, barcodeType: string) {
    setCameraOn(false);
    setScanned({ data, type: barcodeType });
    // Scan for nearby tags only while choosing one; released by the effect below.
    try {
      scanService.acquire('pairing');
    } catch (e) {
      setError((e as Error).message);
    }
  }

  useEffect(() => {
    if (!scanned) return;
    const t = setInterval(() => scanService.expireLive(), 1000);
    return () => {
      clearInterval(t);
      if (scanService.isHeld('pairing')) scanService.release('pairing');
    };
  }, [scanned]);

  useFocusEffect(
    useCallback(() => {
      void pairingService.reload();
      void pairingService.sync();
    }, []),
  );

  const nearby = useMemo(
    () => filterLive(live, { nameFilter: '', search: '', maxDistance: bt.maxDistance }).slice(0, 10),
    [live, bt.maxDistance],
  );
  const pairedByTag = useMemo(() => new Map(pairings.map((p) => [p.tagKey, p])), [pairings]);

  async function pair(t: LiveTag) {
    if (!scanned) return;
    setBusyKey(t.tag.key);
    setError(null);
    try {
      await pairingService.pair(scanned.data, scanned.type, t.tag);
      setScanned(null);
      setCameraOn(true);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusyKey(null);
    }
  }

  function confirmUnpair(p: Pairing) {
    Alert.alert('Unpair', `Remove the link between ${p.barcode} and ${p.tagName}?`, [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Unpair', style: 'destructive', onPress: () => void pairingService.unpair(p.id) },
    ]);
  }

  return (
    <Screen>
      <SectionTitle>1 · Scan barcode</SectionTitle>
      {!permission ? null : !permission.granted ? (
        <Card>
          <Text style={[type.body, { marginBottom: space(3) }]}>Camera access is needed to scan bag tag / asset barcodes.</Text>
          <Button title="Allow camera" onPress={() => void requestPermission()} />
        </Card>
      ) : scanned ? (
        <Card>
          <Text style={type.small}>Scanned ({scanned.type})</Text>
          <Text style={[type.title, { marginVertical: space(1) }]} selectable>{scanned.data}</Text>
          <Button title="Scan again" variant="secondary" onPress={() => { setScanned(null); setCameraOn(true); }} />
        </Card>
      ) : (
        <View style={styles.cameraWrap}>
          {cameraOn ? (
            <CameraView
              style={StyleSheet.absoluteFill}
              facing="back"
              barcodeScannerSettings={{ barcodeTypes: BARCODE_TYPES }}
              onBarcodeScanned={(r) => {
                if (r.data) onScanned(r.data.trim(), r.type);
              }}
            />
          ) : null}
          <View style={styles.reticle} pointerEvents="none" />
        </View>
      )}

      {scanned ? (
        <>
          <SectionTitle>2 · Hold the tag next to the phone and pick it</SectionTitle>
          {nearby.length === 0 ? <Text style={type.small}>Looking for tags…</Text> : null}
          {nearby.map((t, i) => {
            const existing = pairedByTag.get(t.tag.key);
            return (
              <Pressable
                key={t.tag.key}
                disabled={!!existing || busyKey !== null}
                onPress={() => void pair(t)}
                style={({ pressed }) => [styles.tagRow, i === 0 && styles.closest, pressed && { opacity: 0.8 }, existing && { opacity: 0.5 }]}
              >
                <View style={{ flex: 1 }}>
                  <Text style={type.body}>{t.tag.name}</Text>
                  <Text style={type.mono}>{t.tag.key}</Text>
                  {existing ? <Text style={type.small}>Already paired with {existing.barcode}</Text> : null}
                </View>
                <View style={{ alignItems: 'flex-end', gap: 4 }}>
                  <Pill label={formatDistance(t.distance)} color={zoneColor(t.zone)} />
                  {i === 0 && !existing ? <Text style={[type.small, { color: colors.primary, fontWeight: '700' }]}>Tap to pair</Text> : null}
                </View>
              </Pressable>
            );
          })}
        </>
      ) : null}

      {error ? <Banner tone="error">{error}</Banner> : null}

      <SectionTitle>Paired tags ({pairings.length})</SectionTitle>
      {!isApiConfigured() ? (
        <Banner tone="info">No backend API configured: pairings are stored on this phone only and will sync once an API URL is set.</Banner>
      ) : null}
      {pairings.map((p) => {
        const s = syncLabel(p);
        return (
          <Card key={p.id} style={styles.pairCard}>
            <View style={{ flex: 1 }}>
              <Text style={type.h2} selectable>{p.barcode}</Text>
              <Text style={type.small}>⇄ {p.tagName} · {p.tagKey}</Text>
              <View style={{ marginTop: space(1) }}><Pill label={s.label} color={s.color} /></View>
              {p.lastError ? <Text style={[type.small, { color: colors.danger }]}>{p.lastError}</Text> : null}
            </View>
            <Button title="Unpair" variant="ghost" onPress={() => confirmUnpair(p)} />
          </Card>
        );
      })}
    </Screen>
  );
}

const styles = StyleSheet.create({
  cameraWrap: { height: 260, borderRadius: radius.lg, overflow: 'hidden', backgroundColor: '#000', alignItems: 'center', justifyContent: 'center' },
  reticle: { width: '75%', height: 110, borderWidth: 2, borderColor: colors.accent, borderRadius: radius.md },
  tagRow: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.surface,
    padding: space(3),
    borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    gap: space(3),
  },
  closest: { borderWidth: 2, borderColor: colors.primary },
  pairCard: { flexDirection: 'row', alignItems: 'center', gap: space(2) },
});
