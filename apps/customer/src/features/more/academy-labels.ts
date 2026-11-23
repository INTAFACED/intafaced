import type { academyLmsCopy as copy } from './academy-lms-copy';
import type { AcademyPath } from './academy-lms';

/** The Academy's labels for a path, a lesson kind and an item type, as a person reads them; no drawing. */
const pathKeys = {
  foundations: 'pathFoundations',
  markets: 'pathMarkets',
  builder: 'pathBuilder',
  sovereign: 'pathSovereign',
} as const;
const kindKeys = { playbook: 'kindPlaybook', workbook: 'kindWorkbook', lesson: 'kindLesson' } as const;
/** A lesson's kind as a person reads it. A kind this app does not know is shown as sent. */
export const kindLabel = (t: (typeof copy)['t'], kind: string): string =>
  kind in kindKeys ? t(kindKeys[kind as keyof typeof kindKeys]) : kind;
const typeKeys = { lesson: 'outlineLesson', quiz: 'outlineQuiz', assignment: 'outlineAssignment' } as const;
/** What an item of a course is to the learner (lesson, quiz or assignment), as a person reads it. */
export const itemTypeLabel = (t: (typeof copy)['t'], type: keyof typeof typeKeys): string => t(typeKeys[type]);
export const pathLabel = (t: (typeof copy)['t'], path: AcademyPath) => t(pathKeys[path]);
