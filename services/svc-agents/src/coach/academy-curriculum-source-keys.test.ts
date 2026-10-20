import { createAcademyCurriculumSource } from './academy-curriculum-source.js';
import { SECRET, keyCases } from '../s2s-keys-fixture.js';

keyCases('svc-agents -> svc-academy curriculum read', 'svc-academy', async (fetchImpl, s2s) => {
  await createAcademyCurriculumSource('http://academy.test', SECRET, fetchImpl, s2s).load();
});
