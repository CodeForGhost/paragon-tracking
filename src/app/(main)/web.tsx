import { Stack, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { Segmented } from '@/ui/components';
import { space } from '@/ui/theme';
import { PAGE_TITLES, WebPanel, type WebPage } from '@/ui/WebPanel';

const PAGES: WebPage[] = ['platform1', 'platform2'];

export default function WebScreen() {
  const params = useLocalSearchParams<{ page?: string }>();
  const initial = (PAGES as string[]).includes(params.page ?? '') ? (params.page as WebPage) : 'platform1';
  const [page, setPage] = useState<WebPage>(initial);

  return (
    <SafeAreaView edges={['bottom']} style={{ flex: 1 }}>
      <Stack.Screen options={{ title: PAGE_TITLES[page] }} />
      <View style={{ padding: space(3) }}>
        <Segmented
          options={PAGES.map((p) => ({ value: p, label: PAGE_TITLES[p] }))}
          value={page}
          onChange={setPage}
        />
      </View>
      <WebPanel key={page} page={page} />
    </SafeAreaView>
  );
}
