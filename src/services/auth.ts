import { create } from 'zustand';

import { apiRequest, isApiConfigured } from './api';
import { getSecret, setSecret } from './secrets';

/**
 * Demo sign-in is ONLY available in development builds or when explicitly enabled with
 * EXPO_PUBLIC_DEMO_AUTH=1, and only while no backend API is configured.
 */
export const DEMO_AUTH_ALLOWED = __DEV__ || process.env.EXPO_PUBLIC_DEMO_AUTH === '1';

export interface SessionUser {
  email: string;
  name?: string;
  demo: boolean;
}

interface AuthState {
  status: 'loading' | 'signedOut' | 'signedIn';
  user: SessionUser | null;
}

export const useAuth = create<AuthState>(() => ({ status: 'loading', user: null }));

export const auth = {
  async restore() {
    const [token, userJson] = await Promise.all([getSecret('authToken'), getSecret('authUser')]);
    if (token && userJson) {
      try {
        useAuth.setState({ status: 'signedIn', user: JSON.parse(userJson) as SessionUser });
        return;
      } catch {
        /* fallthrough */
      }
    }
    useAuth.setState({ status: 'signedOut', user: null });
  },

  canUseDemo() {
    return DEMO_AUTH_ALLOWED && !isApiConfigured();
  },

  async login(email: string, password: string) {
    const e = email.trim().toLowerCase();
    if (!/^\S+@\S+\.\S+$/.test(e)) throw new Error('Enter a valid email address');
    if (password.length < 1) throw new Error('Enter your password');

    let user: SessionUser;
    let token: string;
    if (isApiConfigured()) {
      const res = await apiRequest<{ token: string; user?: { email?: string; name?: string } }>(
        'POST',
        '/auth/login',
        { email: e, password },
        { auth: false },
      );
      if (!res?.token) throw new Error('Login failed: no token returned');
      token = res.token;
      user = { email: res.user?.email ?? e, name: res.user?.name, demo: false };
    } else if (DEMO_AUTH_ALLOWED) {
      token = `demo-${Date.now()}`;
      user = { email: e, demo: true };
    } else {
      throw new Error('No authentication server configured. Set the API URL in Server settings.');
    }
    await setSecret('authToken', token);
    await setSecret('authUser', JSON.stringify(user));
    useAuth.setState({ status: 'signedIn', user });
  },

  async logout() {
    await setSecret('authToken', '');
    await setSecret('authUser', '');
    useAuth.setState({ status: 'signedOut', user: null });
  },
};
