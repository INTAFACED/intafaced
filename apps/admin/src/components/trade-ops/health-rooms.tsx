import Link from 'next/link';
import { DESK_ROOMS } from '@/lib/trade-ops/rooms';

/** The other rooms of the desk, each with the job it does, so the overview is also the way in. */
export function HealthRooms() {
  return (
    <ul className="m-0 grid list-none grid-cols-1 gap-x-6 p-0 md:grid-cols-2">
      {DESK_ROOMS.filter((r) => r.id !== 'overview').map((room) => (
        <li key={room.id} className="border-b border-line py-2">
          <Link
            href={room.href}
            className="text-sm font-medium text-fg outline-none hover:underline focus-visible:ring-2 focus-visible:ring-lime"
          >
            {room.label}
          </Link>
          <p className="m-0 text-xs text-fg-2">{room.job}</p>
        </li>
      ))}
    </ul>
  );
}
