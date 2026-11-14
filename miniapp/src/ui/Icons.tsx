/** Line icons drawn on a 24 grid, 1.6 stroke, round joins: one family for the whole app. */
const P: Record<string, string> = {
  buy: 'M12 5v14M5 12h14',
  bolt: 'M13 3 5.5 13.5H11L10 21l7.5-10.5H12L13 3z',
  sell: 'M5 12h14',
  receive: 'M12 4v12M6.5 10.5 12 16l5.5-5.5M5 20h14',
  send: 'M12 20V8M6.5 13.5 12 8l5.5 5.5M5 4h14',
  home: 'M4 10.5 12 4l8 6.5V20h-5.5v-6h-5v6H4z',
  activity: 'M5 4h14v16l-3.5-2-3.5 2-3.5-2L5 20zM8.5 9h7M8.5 13h7',
  wallet: 'M4 7h16v12H4zM4 7l11-3v3M15.5 13h4.5',
  chevron: 'M9 6l6 6-6 6',
  copy: 'M9 9h10v10H9zM5 15V5h10',
  share: 'M12 4v11M7.5 8.5 12 4l4.5 4.5M5 13v7h14v-7',
  shield: 'M12 3.5 19 6v5.5c0 4.3-3 7.6-7 9-4-1.4-7-4.7-7-9V6z',
  key: 'M14.5 9.5a4 4 0 1 1-1.2-2.8L21 14.4V17h-2.6v-2.2h-2.2V12.6',
  limits: 'M5 7h9M18 7h1M5 17h3M12 17h7M14 5v4M8 15v4',
  drop: 'M12 4c3.2 4 5 6.9 5 9.5a5 5 0 0 1-10 0C7 10.9 8.8 8 12 4z',
  explorer: 'M10.5 17a6.5 6.5 0 1 0 0-13 6.5 6.5 0 0 0 0 13zM15.5 15.5 20 20',
  chat: 'M5 5h14v10H10l-5 4z',
  help: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM9.6 9.5a2.5 2.5 0 0 1 4.8.9c0 1.7-2.4 2.2-2.4 3.6M12 17h.01',
  gift: 'M4 10h16v4H4zM6 14v6h12v-6M12 10v10M12 10c-1.5-3-5-3.5-5-1.2 0 1.2 2 1.2 5 1.2zM12 10c1.5-3 5-3.5 5-1.2 0 1.2-2 1.2-5 1.2z',
};

export function Icon({ name, size = 22, stroke = 1.6 }: { name: keyof typeof P | string; size?: number; stroke?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth={stroke} strokeLinecap="round" strokeLinejoin="round">
      <path d={P[name] ?? ''} />
    </svg>
  );
}
