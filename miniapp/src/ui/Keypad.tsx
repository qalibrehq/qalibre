import { haptic } from '../tg';

const KEYS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '.', '0', 'del'] as const;

export function Keypad({ onKey, decimal = true }: { onKey: (k: string) => void; decimal?: boolean }) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: 2 }}>
      {KEYS.map((k) => {
        const hidden = k === '.' && !decimal;
        return (
          <button
            key={k}
            type="button"
            aria-label={k === 'del' ? 'Delete' : k === '.' ? 'Decimal point' : k}
            disabled={hidden}
            onClick={() => {
              haptic.tap();
              onKey(k);
            }}
            style={{ height: 58, border: 0, borderRadius: 12, background: 'transparent', fontSize: 26, fontWeight: 500, cursor: hidden ? 'default' : 'pointer', visibility: hidden ? 'hidden' : 'visible' }}
            className="key"
          >
            {k === 'del' ? (
              <svg width="24" height="18" viewBox="0 0 24 18" aria-hidden="true"><path d="M8 2 H21 a1 1 0 0 1 1 1 V15 a1 1 0 0 1-1 1 H8 L2 9 Z M12 6 L17 12 M17 6 L12 12" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" strokeLinecap="round" /></svg>
            ) : (
              k
            )}
          </button>
        );
      })}
    </div>
  );
}

/** Apply a key press to a decimal amount string. */
export function applyKey(amount: string, k: string, maxDecimals: number): string {
  if (k === 'del') return amount.length > 1 ? amount.slice(0, -1) : '0';
  if (k === '.') return amount.includes('.') || maxDecimals === 0 ? amount : amount + '.';
  if (amount.includes('.') && amount.split('.')[1]!.length >= maxDecimals) return amount;
  if (amount.replace('.', '').length >= 9) return amount;
  return amount === '0' ? k : amount + k;
}
