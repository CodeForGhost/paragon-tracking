import { create } from 'zustand';

export interface LogEntry {
  t: number;
  level: 'debug' | 'info' | 'warn' | 'error';
  tag: string;
  msg: string;
}

const MAX = 200;

export const useLog = create<{ entries: LogEntry[] }>(() => ({ entries: [] }));

function push(level: LogEntry['level'], tag: string, msg: string) {
  if (__DEV__ || level !== 'debug') {
    const line = `[${tag}] ${msg}`;
    if (level === 'error') console.error(line);
    else if (level === 'warn') console.warn(line);
    else console.log(line);
  }
  if (level === 'debug') return;
  const entries = useLog.getState().entries;
  useLog.setState({ entries: [{ t: Date.now(), level, tag, msg }, ...entries].slice(0, MAX) });
}

export const log = {
  debug: (tag: string, msg: string) => push('debug', tag, msg),
  info: (tag: string, msg: string) => push('info', tag, msg),
  warn: (tag: string, msg: string) => push('warn', tag, msg),
  error: (tag: string, msg: string) => push('error', tag, msg),
};
