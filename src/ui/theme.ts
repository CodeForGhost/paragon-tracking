export const colors = {
  bg: '#F3F5F8',
  surface: '#FFFFFF',
  surfaceAlt: '#EAEEF3',
  border: '#D9DFE7',
  text: '#0E1A2B',
  textMuted: '#5B6779',
  primary: '#0B3D6E', // deep airfield navy
  primaryText: '#FFFFFF',
  accent: '#F2A900', // taxiway amber
  danger: '#C62828',
  success: '#1E8E3E',
  warning: '#B26A00',
  zoneImmed: '#1E8E3E',
  zoneNear: '#F2A900',
  zoneFar: '#6B7A90',
  header: '#0B3D6E',
};

export const space = (n: number) => n * 4;

export const radius = { sm: 6, md: 10, lg: 16 };

export const type = {
  title: { fontSize: 22, fontWeight: '700' as const, color: colors.text },
  h2: { fontSize: 17, fontWeight: '700' as const, color: colors.text },
  body: { fontSize: 15, color: colors.text },
  small: { fontSize: 13, color: colors.textMuted },
  mono: { fontFamily: 'monospace', fontSize: 13, color: colors.text },
};
