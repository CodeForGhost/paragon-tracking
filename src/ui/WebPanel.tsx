import { useEffect, useState } from 'react';
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';
import { WebView } from 'react-native-webview';

import type { AppConfig } from '@/core/config';
import { useConfig } from '@/services/configStore';
import { getSecret } from '@/services/secrets';
import { Banner, Button } from './components';
import { colors, space, type } from './theme';

export type WebPage = keyof AppConfig['server']['pages'];

export const PAGE_TITLES: Record<WebPage, string> = {
  home: 'Home',
  map: 'Map',
  platform1: 'Platform Access 1',
  platform2: 'Platform Access 2',
};

export function pageUrl(cfg: AppConfig, page: WebPage): string | null {
  const base = cfg.server.dashboardUrl.trim().replace(/\/+$/, '');
  if (!base) return null;
  const path = cfg.server.pages[page]?.trim() ?? '';
  if (/^https?:\/\//i.test(path)) return path;
  return base + (path ? (path.startsWith('/') ? path : `/${path}`) : '');
}

/**
 * Platform dashboards in a WebView. Uses HTTP basic auth from Server settings. TLS errors are NOT
 * ignored (the original app called handler.proceed() on every SSL error).
 */
export function WebPanel({ page }: { page: WebPage }) {
  const cfg = useConfig((s) => s.config);
  const url = pageUrl(cfg, page);
  const [password, setPassword] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    void getSecret('serverPassword').then(setPassword);
  }, []);

  if (!url) {
    return (
      <View style={styles.empty}>
        <Text style={type.h2}>{PAGE_TITLES[page]}</Text>
        <Text style={[type.small, { textAlign: 'center' }]}>
          Additional operational information, KPIs and alerts appear here when connected to a data platform.
          Set the dashboard URL under Configuration → Server.
        </Text>
      </View>
    );
  }
  if (password === null) return <ActivityIndicator style={{ marginTop: space(8) }} color={colors.primary} />;

  const insecure = url.startsWith('http://');
  const creds = cfg.server.username && !insecure ? { username: cfg.server.username, password } : undefined;

  return (
    <View style={{ flex: 1 }}>
      {insecure ? <Banner tone="warn">This dashboard is served over plain HTTP; credentials are not sent.</Banner> : null}
      {error ? (
        <View style={styles.empty}>
          <Text style={{ color: colors.danger, textAlign: 'center' }}>{error}</Text>
          <Button title="Retry" variant="secondary" onPress={() => { setError(null); setReloadKey((k) => k + 1); }} />
        </View>
      ) : (
        <WebView
          key={reloadKey}
          source={{ uri: url }}
          basicAuthCredential={creds}
          javaScriptEnabled
          domStorageEnabled
          startInLoadingState
          originWhitelist={['https://*', 'http://*']}
          setSupportMultipleWindows={false}
          onError={(e) => setError(`Could not load page: ${e.nativeEvent.description}`)}
          onHttpError={(e) =>
            e.nativeEvent.statusCode >= 400 && setError(`Server returned HTTP ${e.nativeEvent.statusCode}`)
          }
          style={{ flex: 1 }}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  empty: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: space(6), gap: space(3) },
});
