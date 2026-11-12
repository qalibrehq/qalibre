/** Thin wrapper over the Telegram Mini App runtime (telegram-web-app.js). Safe outside Telegram. */
interface TgWebApp {
  initData: string;
  initDataUnsafe?: { user?: { id: number; first_name?: string } };
  version: string;
  ready(): void;
  expand(): void;
  setHeaderColor(c: string): void;
  setBackgroundColor(c: string): void;
  enableClosingConfirmation?(): void;
  disableVerticalSwipes?(): void;
  openLink(url: string): void;
  close?(): void;
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
  try {
    tg.setHeaderColor('#F6F4EF');
    tg.setBackgroundColor('#F6F4EF');
    tg.disableVerticalSwipes?.();
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
