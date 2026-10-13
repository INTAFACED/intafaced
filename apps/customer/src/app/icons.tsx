// TODO(B1): swap to lucide-react through @intafaced/ui. These are small stand-in line icons
// drawn for this shell (not copied from any other product); they share Lucide's 24 px grid.
export type ShellIconName =
  | 'home'
  | 'wallet'
  | 'activity'
  | 'markets'
  | 'spot'
  | 'buy'
  | 'convert'
  | 'send'
  | 'receive'
  | 'help'
  | 'settings'
  | 'grid'
  | 'search'
  | 'bell'
  | 'user'
  | 'chevron';

const paths: Record<ShellIconName, string> = {
  home: 'M4 11 12 4l8 7M6 10v10h12V10M10 20v-6h4v6',
  wallet: 'M4 7h15a1 1 0 0 1 1 1v11a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1zM4 7V6a2 2 0 0 1 2-2h11M16 14h2',
  activity: 'M3 12h4l3-8 4 16 3-8h4',
  markets: 'M4 20V10M10 20V4M16 20v-8M22 20H2',
  spot: 'M8 4v16M8 8H6v6h2M16 7v13M16 11h-2v5h2M4 20h16',
  buy: 'M12 4v16M5 11l7-7 7 7M5 20h14',
  convert: 'M4 8h13l-3-3M20 16H7l3 3',
  send: 'M4 12 20 4l-4 16-4-7zM12 13 20 4',
  receive: 'M12 4v12M6 11l6 6 6-6M5 20h14',
  help: 'M9.5 9a2.5 2.5 0 1 1 3.5 2.3c-.7.4-1 .9-1 1.7M12 17h.01M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18',
  settings: 'M4 7h9M17 7h3M4 17h3M11 17h9M15 5v4M9 15v4',
  grid: 'M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h6v6h-6z',
  search: 'm21 21-4.3-4.3M17 10.5a6.5 6.5 0 1 1-13 0 6.5 6.5 0 0 1 13 0',
  bell: 'M18 9a6 6 0 0 0-12 0c0 6-2 7-2 8h16c0-1-2-2-2-8zM10 20.5a2 2 0 0 0 4 0',
  user: 'M20 21v-1.5a5 5 0 0 0-5-5H9a5 5 0 0 0-5 5V21M16 7a4 4 0 1 1-8 0 4 4 0 0 1 8 0',
  chevron: 'm7 10 5 5 5-5',
};

export function ShellIcon({ name, size = 20 }: { name: ShellIconName; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d={paths[name]} />
    </svg>
  );
}
