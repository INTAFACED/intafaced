import { useEffect, useRef, useState } from 'react';
import type { useResource } from '../../shared/resource';

type Resource<T> = ReturnType<typeof useResource<T>>;

/** The gateway's answer when the service did not reply: a crash, a restart or a service that is not running. */
export const NO_ANSWER_CODE = 'edge.upstream_unavailable';
/**
 * The retry window: the room asks again on its own, and a person may ask again too. After this many no-answer replies in a
 * row, a second attempt is no longer worth offering, so the room says the service is not running here and hides Try again.
 */
const NO_ANSWER_ATTEMPTS = 3;
const NO_ANSWER_RETRY_MS = 4000;

/** True once the retry window has run out of attempts. Any other answer starts the count again. */
export function useNoAnswerWindow<T>({ resource, reload }: Resource<T>): boolean {
  const [failures, setFailures] = useState(0);
  const latest = useRef(reload);
  latest.current = reload;
  const noAnswer = resource.status === 'failed' && resource.failure.code === NO_ANSWER_CODE;
  const counted = useRef<unknown>(null);
  useEffect(() => {
    if (resource.status === 'loading' || counted.current === resource) return;
    counted.current = resource;
    setFailures((count) => (noAnswer ? count + 1 : 0));
  }, [resource, noAnswer]);
  useEffect(() => {
    if (!noAnswer || failures === 0 || failures >= NO_ANSWER_ATTEMPTS) return;
    const timer = setTimeout(() => latest.current(), NO_ANSWER_RETRY_MS);
    return () => clearTimeout(timer);
  }, [noAnswer, failures]);
  return failures >= NO_ANSWER_ATTEMPTS;
}
