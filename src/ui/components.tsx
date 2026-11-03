import type { ReactNode } from 'react';
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  type TextInputProps,
  View,
  type ViewStyle,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { colors, radius, space, type } from './theme';

export function Screen({ children, scroll = true, style }: { children: ReactNode; scroll?: boolean; style?: ViewStyle }) {
  return (
    <SafeAreaView edges={['bottom', 'left', 'right']} style={styles.screen}>
      {scroll ? (
        <ScrollView contentContainerStyle={[styles.screenContent, style]} keyboardShouldPersistTaps="handled">
          {children}
        </ScrollView>
      ) : (
        <View style={[styles.screenContent, { flex: 1 }, style]}>{children}</View>
      )}
    </SafeAreaView>
  );
}

type ButtonVariant = 'primary' | 'secondary' | 'danger' | 'ghost';

export function Button({
  title,
  onPress,
  variant = 'primary',
  disabled,
  loading,
  style,
}: {
  title: string;
  onPress: () => void;
  variant?: ButtonVariant;
  disabled?: boolean;
  loading?: boolean;
  style?: ViewStyle;
}) {
  const v = buttonVariants[variant];
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled: !!disabled || !!loading }}
      onPress={onPress}
      disabled={disabled || loading}
      style={({ pressed }) => [
        styles.button,
        { backgroundColor: v.bg, borderColor: v.border },
        (disabled || loading) && { opacity: 0.5 },
        pressed && { opacity: 0.8 },
        style,
      ]}
    >
      {loading ? <ActivityIndicator color={v.fg} /> : <Text style={[styles.buttonText, { color: v.fg }]}>{title}</Text>}
    </Pressable>
  );
}

const buttonVariants: Record<ButtonVariant, { bg: string; fg: string; border: string }> = {
  primary: { bg: colors.primary, fg: colors.primaryText, border: colors.primary },
  secondary: { bg: colors.surface, fg: colors.primary, border: colors.primary },
  danger: { bg: colors.danger, fg: '#fff', border: colors.danger },
  ghost: { bg: 'transparent', fg: colors.primary, border: 'transparent' },
};

export function Card({ children, style }: { children: ReactNode; style?: ViewStyle }) {
  return <View style={[styles.card, style]}>{children}</View>;
}

export function SectionTitle({ children }: { children: ReactNode }) {
  return <Text style={styles.sectionTitle}>{children}</Text>;
}

export function Field({
  label,
  error,
  hint,
  ...input
}: TextInputProps & { label: string; error?: string; hint?: string }) {
  return (
    <View style={{ marginBottom: space(3) }}>
      <Text style={styles.label}>{label}</Text>
      <TextInput
        placeholderTextColor={colors.textMuted}
        autoCapitalize="none"
        autoCorrect={false}
        {...input}
        style={[styles.input, error ? { borderColor: colors.danger } : null, input.style]}
      />
      {error ? <Text style={styles.error}>{error}</Text> : hint ? <Text style={type.small}>{hint}</Text> : null}
    </View>
  );
}

export function NumberField({
  label,
  value,
  onChange,
  error,
  hint,
  decimal = true,
}: {
  label: string;
  value: number;
  onChange: (n: number) => void;
  error?: string;
  hint?: string;
  decimal?: boolean;
}) {
  return (
    <Field
      label={label}
      defaultValue={Number.isFinite(value) ? String(value) : ''}
      keyboardType={decimal ? 'numbers-and-punctuation' : 'number-pad'}
      onChangeText={(t) => onChange(t.trim() === '' ? NaN : Number(t.replace(',', '.')))}
      error={error}
      hint={hint}
    />
  );
}

export function ToggleRow({ label, value, onChange, hint }: { label: string; value: boolean; onChange: (v: boolean) => void; hint?: string }) {
  return (
    <View style={styles.toggleRow}>
      <View style={{ flex: 1, paddingRight: space(3) }}>
        <Text style={type.body}>{label}</Text>
        {hint ? <Text style={type.small}>{hint}</Text> : null}
      </View>
      <Switch value={value} onValueChange={onChange} trackColor={{ true: colors.primary }} />
    </View>
  );
}

export function Segmented<T extends string>({
  options,
  value,
  onChange,
}: {
  options: { value: T; label: string }[];
  value: T;
  onChange: (v: T) => void;
}) {
  return (
    <View style={styles.segmented} accessibilityRole="tablist">
      {options.map((o) => {
        const active = o.value === value;
        return (
          <Pressable
            key={o.value}
            accessibilityRole="tab"
            accessibilityState={{ selected: active }}
            onPress={() => onChange(o.value)}
            style={[styles.segment, active && styles.segmentActive]}
          >
            <Text style={[styles.segmentText, active && { color: colors.primaryText }]} numberOfLines={1}>
              {o.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

export function Pill({ label, color }: { label: string; color: string }) {
  return (
    <View style={[styles.pill, { backgroundColor: color + '22', borderColor: color }]}>
      <View style={[styles.dot, { backgroundColor: color }]} />
      <Text style={[styles.pillText, { color }]}>{label}</Text>
    </View>
  );
}

export function KeyValue({ k, v, mono }: { k: string; v: ReactNode; mono?: boolean }) {
  return (
    <View style={styles.kv}>
      <Text style={type.small}>{k}</Text>
      <Text style={[mono ? type.mono : type.body, { flexShrink: 1, textAlign: 'right' }]}>{v}</Text>
    </View>
  );
}

export function Banner({ tone, children }: { tone: 'info' | 'warn' | 'error'; children: ReactNode }) {
  const c = tone === 'error' ? colors.danger : tone === 'warn' ? colors.warning : colors.primary;
  return (
    <View style={[styles.banner, { borderLeftColor: c, backgroundColor: c + '14' }]}>
      <Text style={[type.small, { color: colors.text }]}>{children}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  screenContent: { padding: space(4), gap: space(3) },
  button: {
    minHeight: 48,
    paddingHorizontal: space(4),
    borderRadius: radius.md,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1.5,
  },
  buttonText: { fontSize: 16, fontWeight: '600' },
  card: {
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    padding: space(4),
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
  },
  sectionTitle: { ...type.small, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 0.8, marginTop: space(2) },
  label: { ...type.small, fontWeight: '600', marginBottom: space(1), color: colors.text },
  input: {
    minHeight: 46,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    paddingHorizontal: space(3),
    backgroundColor: colors.surface,
    fontSize: 15,
    color: colors.text,
  },
  error: { color: colors.danger, fontSize: 13, marginTop: 2 },
  toggleRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: space(2) },
  segmented: {
    flexDirection: 'row',
    backgroundColor: colors.surfaceAlt,
    borderRadius: radius.md,
    padding: 3,
  },
  segment: { flex: 1, paddingVertical: space(2), alignItems: 'center', borderRadius: radius.sm },
  segmentActive: { backgroundColor: colors.primary },
  segmentText: { fontSize: 14, fontWeight: '600', color: colors.text },
  pill: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'flex-start',
    paddingHorizontal: space(2),
    paddingVertical: 2,
    borderRadius: 999,
    borderWidth: 1,
    gap: 6,
  },
  dot: { width: 7, height: 7, borderRadius: 4 },
  pillText: { fontSize: 12, fontWeight: '700' },
  kv: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingVertical: 6, gap: space(3) },
  banner: { borderLeftWidth: 4, padding: space(3), borderRadius: radius.sm },
});
