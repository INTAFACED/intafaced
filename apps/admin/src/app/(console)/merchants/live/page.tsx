import FounderOpsPage from '../../[...founderPath]/page';
export const dynamic = 'force-dynamic';
export default async function Page() {
  return FounderOpsPage({ params: Promise.resolve({ founderPath: ['merchants', 'live'] }), searchParams: Promise.resolve({}) });
}
