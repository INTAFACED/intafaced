import { useSyncExternalStore } from 'react';
import { z } from 'zod';

const schema=z.object({theme:z.enum(['dark','light','system']).default('dark'),language:z.enum(['en','es','fr']).default('en'),hideBalances:z.boolean().default(false),displayCurrency:z.enum(['USD','BTC']).default('USD'),phoneChart:z.enum(['top','bottom','hidden']).default('top'),upColor:z.enum(['green','red']).default('green'),timeZone:z.enum(['UTC','UTC+8','device']).default('UTC'),showOrders:z.boolean().default(true),showFills:z.boolean().default(false),confirmSend:z.boolean().default(true),confirmCancel:z.boolean().default(true),favoritesView:z.enum(['list','cards']).default('list')});
export type Preferences=z.infer<typeof schema>;
const key='intafaced.customer.view.v1';
let snapshot:Preferences=schema.parse({});
try{const saved=localStorage.getItem(key);if(saved){const parsed=schema.safeParse(JSON.parse(saved));if(parsed.success)snapshot=parsed.data;}}catch{/* Device storage is optional. */}
const listeners=new Set<()=>void>();
export function savePreferences(patch:Partial<Preferences>){snapshot=schema.parse({...snapshot,...patch});try{localStorage.setItem(key,JSON.stringify(snapshot));}catch{/* Changes still work for this visit. */}for(const notify of listeners)notify();}
export function usePreferences(){return useSyncExternalStore((notify)=>{listeners.add(notify);return()=>{listeners.delete(notify);};},()=>snapshot);}
export function currentPreferences(){return snapshot;}
