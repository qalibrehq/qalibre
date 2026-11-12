/** Thin wrapper over the Telegram Mini App runtime (telegram-web-app.js). Safe outside Telegram. */
interface TgWebApp {
  initData: string;
  initDataUnsafe?: { user?: { id: number; first_name?: string; photo_url?: string } };
  version: string;
  ready(): void;
  expand(): void;
  setHeaderColor(c: string): void;
  setBackgroundColor(c: string): void;
  enableClosingConfirmation?(): void;
  disableVerticalSwipes?(): void;
  openLink(url: string): void;
  openTelegramLink?(url: string): void;
  close?(): void;
  colorScheme?: 'light' | 'dark';
  onEvent?(event: string, cb: () => void): void;
  isVersionAtLeast?(v: string): boolean;
  HapticFeedback?: { impactOccurred(s: 'light' | 'medium' | 'rigid' | 'soft' | 'heavy'): void; notificationOccurred(t: 'success' | 'warning' | 'error'): void; selectionChanged(): void };
  CloudStorage?: {
    setItem(k: string, v: string, cb?: (err: string | null, ok?: boolean) => void): void;
    getItem(k: string, cb: (err: string | null, v?: string) => void): void;
  };
  BackButton?: { show(): void; hide(): void; onClick(cb: () => void): void; offClick(cb: () => void): void };
}

declare global {
  interface Window {
    Telegram?: { WebApp?: TgWebApp };
  }
}

export const tg: TgWebApp | undefined = window.Telegram?.WebApp;
export const inTelegram = Boolean(tg?.initData);

export function initTelegram() {
  if (!tg) return;
  tg.ready();
  tg.expand();
  applyTheme();
  tg.onEvent?.('themeChanged', () => applyTheme());
  void syncThemePref();
  try {
    tg.disableVerticalSwipes?.();
  } catch {
    /* older clients */
  }
}

/** Light or dark, from Telegram (or the system outside Telegram); the header bar matches the page. */
export type ThemePref = 'telegram' | 'light' | 'dark';
const THEME_KEY = 'qalibre_theme';

export function themePref(): ThemePref {
  try {
    const v = localStorage.getItem(THEME_KEY);
    return v === 'light' || v === 'dark' ? v : 'telegram';
  } catch {
    return 'telegram';
  }
}

/** Choose the look. 'telegram' follows Telegram's own setting, live. */
export function setThemePref(p: ThemePref) {
  try {
    localStorage.setItem(THEME_KEY, p);
  } catch {
    /* private mode: still applies for this session */
  }
  void cloud.set(THEME_KEY, p).catch(() => undefined);
  applyTheme(p);
}

/** On open: pick up a choice made on another device. */
export async function syncThemePref() {
  const v = await cloud.get(THEME_KEY).catch(() => null);
  if ((v === 'light' || v === 'dark' || v === 'telegram') && v !== themePref()) {
    try {
      localStorage.setItem(THEME_KEY, v);
    } catch {
      /* ignore */
    }
    applyTheme(v);
  }
}

export function applyTheme(pref: ThemePref = themePref()) {
  const system = tg?.colorScheme ? tg.colorScheme === 'dark' : window.matchMedia?.('(prefers-color-scheme: dark)').matches;
  const dark = pref === 'dark' || (pref === 'telegram' && system);
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  const bg = dark ? '#0F1012' : '#F6F4EF';
  try {
    tg?.setHeaderColor(bg);
    tg?.setBackgroundColor(bg);
  } catch {
    /* older clients */
  }
}

export const haptic = {
  tap: () => tg?.HapticFeedback?.impactOccurred('light'),
  select: () => tg?.HapticFeedback?.selectionChanged(),
  success: () => tg?.HapticFeedback?.notificationOccurred('success'),
  warn: () => tg?.HapticFeedback?.notificationOccurred('warning'),
};

export function openLink(url: string) {
  if (tg) tg.openLink(url);
  else window.open(url, '_blank', 'noopener');
}

/** Back to the chat with the bot: the place to trade. */
export function openChat(bot?: string) {
  if (bot && tg?.openTelegramLink) tg.openTelegramLink(`https://t.me/${bot}`);
  else if (tg?.close) tg.close();
}

/** The user's Telegram profile photo, when they allow it (https only). */
export function photoUrl(): string | undefined {
  const u = tg?.initDataUnsafe?.user?.photo_url;
  return u && u.startsWith('https://') ? u : undefined;
}

export function firstName(): string | undefined {
  return tg?.initDataUnsafe?.user?.first_name;
}

/** Telegram CloudStorage (synced to the user's Telegram account), falling back to localStorage. */
export const cloud = {
  get(key: string): Promise<string | null> {
    return new Promise((resolve) => {
      const local = () => {
        try {
          resolve(localStorage.getItem(key));
        } catch {
          resolve(null);
        }
      };
      if (!tg?.CloudStorage) return local();
      tg.CloudStorage.getItem(key, (err, v) => (err ? local() : resolve(v || null)));
    });
  },
  set(key: string, value: string): Promise<void> {
    try {
      localStorage.setItem(key, value);
    } catch {
      /* private mode */
    }
    return new Promise((resolve) => {
      if (!tg?.CloudStorage) return resolve();
      tg.CloudStorage.setItem(key, value, () => resolve());
    });
  },
};
