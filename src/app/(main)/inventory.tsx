import { File, Paths } from 'expo-file-system';
import * as MailComposer from 'expo-mail-composer';
import * as Sharing from 'expo-sharing';
import { useEffect, useRef, useState } from 'react';
import { FlatList, StyleSheet, Text, View } from 'react-native';

import { TagAggregator, type WindowAggregate } from '@/core/aggregator';
import { buildInventoryCsv } from '@/core/csv';
import { useConfig } from '@/services/configStore';
import { scanService } from '@/services/scanService';
import { Banner, Button, Card, NumberField, Pill } from '@/ui/components';
import { formatDistance, zoneColor } from '@/ui/format';
import { colors, radius, space, type } from '@/ui/theme';
import { SafeAreaView } from 'react-native-safe-area-context';

type Phase = 'idle' | 'running' | 'done';

function mmss(ms: number) {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

export default function Inventory() {
  const { config, save } = useConfig();
  const [minutes, setMinutes] = useState(config.other.inventoryMinutes);
  const [phase, setPhase] = useState<Phase>('idle');
  const [endsAt, setEndsAt] = useState(0);
  const [now, setNow] = useState(0);
  const [rows, setRows] = useState<WindowAggregate[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const agg = useRef<TagAggregator | null>(null);
  const unsink = useRef<(() => void) | null>(null);

  const stopScan = () => {
    unsink.current?.();
    unsink.current = null;
    if (scanService.isHeld('inventory')) scanService.release('inventory');
  };

  useEffect(() => stopScan, []);

  useEffect(() => {
    if (phase !== 'running') return;
    const t = setInterval(() => {
      const n = Date.now();
      setNow(n);
      if (agg.current) setRows(agg.current.windowSnapshot());
      if (n >= endsAt) {
        stopScan();
        setPhase('done');
      }
    }, 500);
    return () => clearInterval(t);
  }, [phase, endsAt]);

  async function start() {
    setError(null);
    if (!(minutes > 0)) {
      setError('Enter a duration greater than 0');
      return;
    }
    if (minutes !== config.other.inventoryMinutes) {
      await save({ ...config, other: { ...config.other, inventoryMinutes: minutes } });
    }
    const a = new TagAggregator(config.bluetooth);
    agg.current = a;
    setRows([]);
    unsink.current = scanService.addSink((batch, t) => a.ingest(batch, t));
    try {
      scanService.acquire('inventory');
    } catch (e) {
      stopScan();
      setError((e as Error).message);
      return;
    }
    setEndsAt(Date.now() + minutes * 60_000);
    setNow(Date.now());
    setPhase('running');
  }

  function stopEarly() {
    stopScan();
    if (agg.current) setRows(agg.current.windowSnapshot());
    setPhase('done');
  }

  async function send() {
    setSending(true);
    setError(null);
    try {
      const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      const file = new File(Paths.cache, `inventory-${stamp}.csv`);
      file.create({ overwrite: true });
      await file.write(buildInventoryCsv(rows));
      const subject = `Inventory ${new Date().toLocaleString()} – ${rows.length} tags`;
      if (await MailComposer.isAvailableAsync()) {
        await MailComposer.composeAsync({
          recipients: config.other.inventoryEmail ? [config.other.inventoryEmail] : [],
          subject,
          body: `Inventory from gateway ${config.other.gatewayId}: ${rows.length} tags scanned in ${minutes} min.`,
          attachments: [file.uri],
        });
      } else if (await Sharing.isAvailableAsync()) {
        await Sharing.shareAsync(file.uri, { mimeType: 'text/csv', dialogTitle: 'Send Inventory', UTI: 'public.comma-separated-values-text' });
      } else {
        throw new Error('No email or share target available on this device');
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSending(false);
    }
  }

  const sorted = [...rows].sort((a, b) => a.distance - b.distance);
  const remaining = phase === 'running' ? endsAt - now : phase === 'done' ? 0 : minutes * 60_000;

  return (
    <SafeAreaView edges={['bottom']} style={{ flex: 1 }}>
      <FlatList
        data={sorted}
        keyExtractor={(r) => r.tag.key}
        contentContainerStyle={{ padding: space(4), gap: space(2) }}
        ListHeaderComponent={
          <View style={{ gap: space(3), marginBottom: space(2) }}>
            <Card>
              <View style={styles.stats}>
                <View style={styles.stat}>
                  <Text style={styles.statValue}>{rows.length}</Text>
                  <Text style={type.small}>Scanned Count</Text>
                </View>
                <View style={styles.stat}>
                  <Text style={[styles.statValue, phase === 'running' && { color: colors.accent }]}>{mmss(remaining)}</Text>
                  <Text style={type.small}>Remaining</Text>
                </View>
              </View>
              {phase === 'idle' || phase === 'done' ? (
                <NumberField label="Duration (minutes)" value={minutes} onChange={setMinutes} />
              ) : null}
              {phase === 'running' ? (
                <Button title="Stop now" variant="danger" onPress={stopEarly} />
              ) : (
                <Button title={phase === 'done' ? 'Start new inventory' : 'Start inventory'} onPress={start} />
              )}
              {phase === 'done' ? (
                <Button
                  title="Send Inventory"
                  variant="secondary"
                  onPress={send}
                  loading={sending}
                  disabled={rows.length === 0}
                  style={{ marginTop: space(2) }}
                />
              ) : null}
            </Card>
            {error ? <Banner tone="error">{error}</Banner> : null}
          </View>
        }
        renderItem={({ item }) => (
          <View style={styles.row}>
            <View style={{ flex: 1 }}>
              <Text style={type.body} numberOfLines={1}>{item.tag.name}</Text>
              <Text style={type.mono}>{item.tag.key}</Text>
            </View>
            <View style={{ alignItems: 'flex-end', gap: 4 }}>
              <Pill label={item.zone} color={zoneColor(item.zone)} />
              <Text style={type.small}>{formatDistance(item.distance)} · {item.counter} reads</Text>
            </View>
          </View>
        )}
        ListEmptyComponent={
          phase !== 'idle' ? <Text style={[type.small, { textAlign: 'center' }]}>No tags yet</Text> : undefined
        }
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  stats: { flexDirection: 'row', marginBottom: space(3) },
  stat: { flex: 1, alignItems: 'center' },
  statValue: { fontSize: 34, fontWeight: '800', color: colors.primary, fontVariant: ['tabular-nums'] },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.surface,
    padding: space(3),
    borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    gap: space(3),
  },
});
