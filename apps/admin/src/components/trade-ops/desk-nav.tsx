'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { cn } from '@intafaced/ui';
import { DESK_ROOMS } from '@/lib/trade-ops/rooms';

/** Room switcher across the top of every trade-desk page. Current room is marked with aria-current and the lime underline. */
export function DeskNav() {
  const pathname = usePathname();
  return (
    <nav aria-label="Trade operator rooms" className="flex gap-1 overflow-x-auto border-b border-line px-(--if-gutter)">
      {DESK_ROOMS.map((room) => {
        const active = room.href === '/trade-ops' ? pathname === '/trade-ops' : pathname.startsWith(room.href);
        return (
          <Link
            key={room.id}
            href={room.href}
            aria-current={active ? 'page' : undefined}
            className={cn(
              'whitespace-nowrap border-b-2 px-3 py-3 text-sm font-medium outline-none focus-visible:ring-2 focus-visible:ring-lime',
              active ? 'border-lime text-fg' : 'border-transparent text-fg-2 hover:text-fg',
            )}
          >
            {room.label}
          </Link>
        );
      })}
    </nav>
  );
}
