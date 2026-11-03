import { Link, router } from 'expo-router';
import { useState } from 'react';
import { KeyboardAvoidingView, Platform, StyleSheet, Text, View } from 'react-native';

import { isApiConfigured } from '@/services/api';
import { auth } from '@/services/auth';
import { useConfig } from '@/services/configStore';
import { Banner, Button, Card, Field } from '@/ui/components';
import { colors, space, type } from '@/ui/theme';

export default function Login() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useConfig((s) => s.config.server.apiBaseUrl); // re-render when the API URL changes
  const demo = auth.canUseDemo();

  async function submit() {
    setError(null);
    setBusy(true);
    try {
      await auth.login(email, password);
      router.replace('/readiness');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <KeyboardAvoidingView style={styles.root} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <View style={styles.hero}>
        <Text style={styles.brand}>Paragon ID</Text>
        <Text style={styles.tagline}>Smart tracking Solutions</Text>
      </View>
      <Card style={styles.card}>
        <Text style={[type.h2, { marginBottom: space(3) }]}>Sign in</Text>
        {demo ? (
          <Banner tone="warn">Demo mode: no backend API is configured, so any email/password is accepted.</Banner>
        ) : null}
        {!demo && !isApiConfigured() ? (
          <Banner tone="error">No authentication server configured. Set the API URL in Server settings.</Banner>
        ) : null}
        <View style={{ height: space(3) }} />
        <Field label="Email" value={email} onChangeText={setEmail} keyboardType="email-address" autoComplete="email" textContentType="username" />
        <Field
          label="Password"
          value={password}
          onChangeText={setPassword}
          secureTextEntry
          autoComplete="password"
          textContentType="password"
          onSubmitEditing={submit}
        />
        {error ? <Text style={styles.error}>{error}</Text> : null}
        <Button title="Sign in" onPress={submit} loading={busy} />
        <Link href={{ pathname: '/settings', params: { tab: 'server' } }} style={styles.link}>
          Server settings
        </Link>
      </Card>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.primary, justifyContent: 'center', padding: space(4) },
  hero: { alignItems: 'center', marginBottom: space(6) },
  brand: { color: '#fff', fontSize: 30, fontWeight: '800' },
  tagline: { color: colors.accent, fontSize: 15, marginTop: 4, fontWeight: '600' },
  card: { gap: 0 },
  error: { color: colors.danger, marginBottom: space(3) },
  link: { color: colors.primary, textAlign: 'center', marginTop: space(4), fontWeight: '600', padding: space(2) },
});
