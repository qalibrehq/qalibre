import type { Nav } from '../App';
import { haptic } from '../tg';
import { Icon } from './Icons';

const TABS = [
  ['home', 'Home', 'home'],
  ['activity', 'Activity', 'activity'],
  ['control', 'Wallet', 'wallet'],
] as const;

export function TabBar({ current, nav }: { current: 'home' | 'activity' | 'control'; nav: Nav }) {
  return (
    <nav className="tabbar" aria-label="Main">
      {TABS.map(([key, label, icon]) => (
        <button key={key} className="tab" aria-current={current === key ? 'page' : undefined} onClick={() => { if (current !== key) { haptic.select(); nav(key); } }}>
          <span className="pill"><Icon name={icon} size={21} /></span>
          {label}
        </button>
      ))}
    </nav>
  );
}
