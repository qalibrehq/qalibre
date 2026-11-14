import type { Safety } from '../api';

type Finding = Safety['findings'][number];

/** One severity scale across the product: the same dot colours as the chat cards, and the same headings as the chat. */
const DOT: Record<string, string> = { danger: 'var(--danger)', caution: 'var(--caution)', unknown: 'var(--muted)', pass: 'var(--green-text)' };
const WORD: Record<string, string> = { danger: 'Warning', caution: 'Worth knowing', unknown: 'Worth knowing', pass: 'Looks fine' };
const ORDER: Record<string, number> = { danger: 0, caution: 1, unknown: 2, pass: 3 };

/** Most serious first. */
export const bySeverity = (a: Finding, b: Finding) => (ORDER[a.level] ?? 9) - (ORDER[b.level] ?? 9);

/** A finding: coloured dot, the severity word in small caps, the title, and an optional explanation. */
export function FlagRow({ f, detail = true }: { f: Finding; detail?: boolean }) {
  return (
    <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start', padding: '10px 0' }}>
      <span aria-hidden="true" style={{ width: 8, height: 8, borderRadius: 4, background: DOT[f.level], flex: 'none', marginTop: 7 }} />
      <span style={{ minWidth: 0 }}>
        <span style={{ display: 'block', fontSize: 14, fontWeight: 600, lineHeight: 1.45, color: 'var(--ink)' }}>
          <span style={{ fontSize: 11, letterSpacing: '0.06em', textTransform: 'uppercase', color: DOT[f.level], marginRight: 8 }}>{WORD[f.level]}</span>
          {f.title}
        </span>
        {detail && f.detail && <span className="muted" style={{ display: 'block', marginTop: 2, fontSize: 13, lineHeight: 1.5 }}>{f.detail}</span>}
      </span>
    </div>
  );
}
