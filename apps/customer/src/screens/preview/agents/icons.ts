import {
  ChartPie,
  Compass,
  Copy,
  GraduationCap,
  LifeBuoy,
  Megaphone,
  Radar,
  Rocket,
  ShieldCheck,
  Store,
  type LucideIcon,
} from 'lucide-react';
import type { SampleAgentId } from '../../../preview/fixtures/agents';

/** One plain line icon per agent (no brand marks). */
export const agentIcons: Readonly<Record<SampleAgentId, LucideIcon>> = {
  navigator: Compass,
  portfolio: ChartPie,
  scanner: Radar,
  'copy-intel': Copy,
  risk: ShieldCheck,
  support: LifeBuoy,
  coach: GraduationCap,
  launch: Rocket,
  merchant: Store,
  growth: Megaphone,
};
