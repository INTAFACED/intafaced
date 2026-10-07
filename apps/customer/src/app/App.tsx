import { useEffect, type MouseEvent } from 'react';
import { Page, EmptyState } from '../shared/ui';
import { findRoom } from './navigation';
import { useLocation, navigate } from './location';
import { Shell } from './Shell';
import { PublicRoutes } from '../features/public/PublicRoutes';
import { useSession } from '../features/session/session';

export function App() {
  const current=useLocation();const path=current.split('?')[0]??'/';const room=findRoom(path);const {session}=useSession();
  useEffect(()=>{if(room?.alias)navigate(room.alias+location.search,true);document.title=`${room?.title??'Page not found'} · Intafaced`;},[path,room]);
  function followLink(event:MouseEvent<HTMLDivElement>){if(event.defaultPrevented||event.button!==0||event.metaKey||event.ctrlKey||event.shiftKey||event.altKey)return;const anchor=event.target instanceof Element?event.target.closest('a'):null;if(!anchor||anchor.target||anchor.hasAttribute('download'))return;const url=new URL(anchor.href,location.href);if(url.origin!==location.origin||url.hash)return;event.preventDefault();navigate(url.pathname+url.search);}
  const needsSession=room&&['money','pay','more','person'].includes(room.area)&&path!=='/pay/checkout';
  const content=room?.area==='public'?<PublicRoutes path={path}/>:room?.area==='team'?<Page title="Separate team desk"><EmptyState title="Open the operator console">The team desk has a separate deployment and authentication boundary. It is not a customer room.</EmptyState></Page>:room?.area==='parked'?<Page title="This room is parked"><EmptyState title="Chain services are not active">This room remains reserved until owner activation. It is not available from customer navigation or search.</EmptyState></Page>:<Shell door={room?.door}>{needsSession&&!session?<Page title={room?.title??'Sign in'}><EmptyState title="Sign in to continue" action={<a className="button button--primary" href={`/login?redirect=${encodeURIComponent(current)}`}>Sign in</a>}>Your account context is needed before this room can show private information.</EmptyState></Page>:<Page title={room?.title??'Page not found'}><EmptyState title={room?'Journey implementation in progress':'This address is not available'}>{room?'This feature is being connected to its verified contracts.':'Return to one of the four customer doors.'}</EmptyState></Page>}</Shell>;
  return <div onClick={followLink}>{content}</div>;
}
