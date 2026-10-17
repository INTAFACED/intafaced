import { CampaignsOverview } from '../public/PublicPages';

/** /campaigns: no campaign service exists, so the room says so and lists what a person can join today (see CampaignsOverview). */
export function Campaigns() {
  return <CampaignsOverview heading={false} />;
}
