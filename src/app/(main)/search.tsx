import { useEffect, useMemo, useState } from 'react';
import { SectionList, StyleSheet, Text, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { filterLive, type LiveTag } from '@/core/aggregator';
import { ZONE_LABEL, type Zone } from '@/core/distance';
import { useConfig } from '@/services/configStore';
import { scanService, useScan } from '@/services/scanService';
import { Banner, Button, Pill, Segmented } from '@/ui/components';
import { formatDistance, zoneColor } from '@/ui/format';
import { colors, radius, space, type } from '@/ui/theme';
import { WebPanel } from '@/ui/WebPanel';

type Tab = 'search' | 'home' | 'map';
const ZONES: Zone[] = ['Immed', 'Near', 'Far'];

function TagRow({ t }: { t: LiveTag }) {
  return (
    <View style={styles.row}>
      <View style={{ flex: 1 }}>
        <Text style={type.body} numberOfLines={1}>{t.tag.name}</Text>
        <Text style={type.mono} numberOfLines={1}>{t.tag.key}</Text>
      </View>
      <View style={{ alignItems: 'flex-end', gap: 4 }}>
        <Text style={styles.distance}>{formatDistance(t.distance)}</Text>
        <Text style={type.small}>{Math.round(t.smoothedRssi)} dBm</Text>
      </View>
    </View>
  );
}

function SearchTab() {
  const live = useScan((s) => s.live);
  const scanning = useScan((s) => s.scanning);
  const error = useScan((s) => s.error);
  const held = useScan((s) => s.holders.includes('search'));
  const gatewayRunning = useScan((s) => s.holders.includes('gateway'));
  const bt = useConfig((s) => s.config.bluetooth);
  const [query, setQuery] = useState('');
  const [startError, setStartError] = useState<string | null>(null);

  // Expire stale entries while the screen is visible.
  useEffect(() => {
    const t = setInterval(() => scanService.expireLive(), 1000);
    return () => clearInterval(t);
  }, []);

  // Stop our scan hold when leaving the screen.
  useEffect(() => () => {
    if (scanService.isHeld('search')) scanService.release('search');
  }, []);

  const sections = useMemo(() => {
    const list = filterLive(live, { nameFilter: bt.nameFilter, search: query, maxDistance: bt.maxDistance });
    return ZONES.map((z) => ({ zone: z, data: list.filter((t) => t.zone === z) }));
  }, [live, bt.nameFilter, bt.maxDistance, query]);
  const total = sections.reduce((n, s) => n + s.data.length, 0);
  const active = held || gatewayRunning;

  function toggle() {
    setStartError(null);
    try {
      if (held) scanService.release('search');
      else scanService.acquire('search');
    } catch (e) {
      setStartError((e as Error).message);
    }
  }

  return (
    <View style={{ flex: 1 }}>
      <View style={styles.controls}>
        <TextInput
          style={styles.search}
          placeholder="Search name or ID"
          placeholderTextColor={colors.textMuted}
          value={query}
          onChangeText={setQuery}
          autoCapitalize="none"
          autoCorrect={false}
          clearButtonMode="while-editing"
        />
        <Button title={held ? '■ Stop' : '▶ Play'} variant={held ? 'danger' : 'primary'} onPress={toggle} style={{ minWidth: 100 }} />
      </View>
      {startError || error ? <View style={{ paddingHorizontal: space(3) }}><Banner tone="error">{startError ?? error}</Banner></View> : null}
      {!held && gatewayRunning ? (
        <View style={{ paddingHorizontal: space(3) }}>
          <Banner tone="info">Background tracking is scanning. The list shows its live results.</Banner>
        </View>
      ) : null}
      <Text style={[type.small, { paddingHorizontal: space(4), paddingVertical: space(2) }]}>
        {active ? (scanning ? `Scanning · ${total} tag${total === 1 ? '' : 's'} in range` : 'Starting scanner…') : 'Press Play to start scanning'}
      </Text>
      <SectionList
        sections={sections}
        keyExtractor={(t) => t.tag.key}
        renderItem={({ item }) => <TagRow t={item} />}
        renderSectionHeader={({ section }) => (
          <View style={styles.sectionHeader}>
            <Pill label={ZONE_LABEL[section.zone]} color={zoneColor(section.zone)} />
            <Text style={type.small}>{section.data.length}</Text>
          </View>
        )}
        renderSectionFooter={({ section }) =>
          section.data.length === 0 ? <Text style={[type.small, styles.emptyZone]}>No tags</Text> : null
        }
        stickySectionHeadersEnabled
        contentContainerStyle={{ paddingBottom: space(6) }}
      />
    </View>
  );
}

export default function Search() {
  const [tab, setTab] = useState<Tab>('search');
  return (
    <SafeAreaView edges={['bottom']} style={{ flex: 1 }}>
      <View style={{ padding: space(3), paddingBottom: 0 }}>
        <Segmented
          options={[
            { value: 'search', label: 'Search' },
            { value: 'home', label: 'Home' },
            { value: 'map', label: 'Map' },
          ]}
          value={tab}
          onChange={setTab}
        />
      </View>
      {/* Keep the scanner tab mounted so scanning continues while viewing Home/Map. */}
      <View style={{ flex: 1, display: tab === 'search' ? 'flex' : 'none' }}>
        <SearchTab />
      </View>
      {tab !== 'search' ? <WebPanel key={tab} page={tab} /> : null}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  controls: { flexDirection: 'row', gap: space(2), padding: space(3), alignItems: 'center' },
  search: {
    flex: 1,
    minHeight: 48,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    paddingHorizontal: space(3),
    backgroundColor: colors.surface,
    color: colors.text,
  },
  sectionHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: space(4),
    paddingVertical: space(2),
    backgroundColor: colors.bg,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.surface,
    marginHorizontal: space(3),
    marginBottom: space(2),
    padding: space(3),
    borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    gap: space(3),
  },
  distance: { fontSize: 17, fontWeight: '700', color: colors.primary },
  emptyZone: { paddingHorizontal: space(4), paddingBottom: space(2) },
});
