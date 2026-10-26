import { useEffect, useId, useRef, useState } from 'react';
import { z } from 'zod';
import {
  ACADEMY_DISCUSSION_GENERAL_TOPIC,
  academyDiscussionCourseSchema,
  academyDiscussionAcceptResultSchema,
  academyDiscussionFollowResultSchema,
  academyDiscussionImageSchema,
  academyDiscussionLikeResultSchema,
  academyDiscussionPostSchema,
  academyDiscussionReplySchema,
  academyDiscussionThreadSchema,
  academyDiscussionTopicsSchema,
  type AcademyDiscussionAuthor,
  type AcademyDiscussionPostKind,
  type AcademyDiscussionTopic,
} from '@intafaced/contracts/academy-discussion';
import type { ApiResult } from '../../shared/api';
import { usePreferences } from '../../shared/preferences';
import { useResource, type Resource } from '../../shared/resource';
import { Button, Field, Loading, Panel } from '../../shared/ui';
import { useApi, useSession } from '../session/session';
import { academyCodeOf, academyRefusalText } from './academy-flows';
import { academyLmsCopy as copy } from './academy-lms-copy';
import { academyDiscussionHref, formatMoment } from './academy-lms';
import { AcademyRefusal } from './AcademyLmsParts';

/**
 * Course discussions (AC-rooms-01). The Rooms tab lists the courses the reader is enrolled in, each a way into its
 * discussion; a course's discussion shows its topics (pinned first, with the default General topic), the open topic's
 * posts and a form to post; a post's page shows its image, replies, the accepted answer first, and follow and like.
 * Everything shown is read from Academy; a retry of a post or reply sends the same request id, so it is never twice.
 */

/** The page sizes these reads ask for. */
const COURSES_PAGE = 50;
const POSTS_PAGE = 50;
const REPLIES_PAGE = 200;

type Failure = Extract<ApiResult<never>, { ok: false }>;
type Outcome = { kind: 'refused'; failure: Failure } | { kind: 'uncertain' } | { kind: 'done' };
type T = ReturnType<typeof copy.useCopy>['t'];

async function base64Of(file: File): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

/** A new request id for a new draft; the same draft sent again keeps it. */
const newRequest = (kind: string) => `${kind}:${crypto.randomUUID()}`;

/**
 * The last answer for this key while a re-read is on its way, so a form under it keeps what the reader typed and the
 * outcome of what they sent. A different key (another topic or post) shows nothing until its own answer lands.
 */
function useSteady<T>(resource: Resource<T>, key: string): T | null {
  const [last, setLast] = useState<{ key: string; data: T } | null>(null);
  const ready = resource.status === 'ready' ? resource.data : null;
  useEffect(() => {
    if (ready !== null) setLast({ key, data: ready });
  }, [ready, key]);
  return ready ?? (last?.key === key ? last.data : null);
}

function authorText(author: AcademyDiscussionAuthor, t: T) {
  if (author.kind === 'you') return author.anonymous ? t('discussionYouAnonymous') : t('discussionYou');
  if (author.kind === 'anonymous') return t('discussionAnonymousAuthor');
  return author.label;
}

const likesText = (likes: number, t: T) => (likes === 1 ? t('discussionLikesOne') : t('discussionLikes', { count: likes }));
const repliesText = (count: number, t: T) => (count === 1 ? t('discussionRepliesOne') : t('discussionReplies', { count }));
const postsText = (count: number, t: T) => (count === 1 ? t('discussionTopicPostsOne') : t('discussionTopicPosts', { count }));

function OutcomeLine({ outcome, done, testId }: { outcome: Outcome; done: string; testId: string }) {
  const { t } = copy.useCopy();
  if (outcome.kind === 'done')
    return (
      <p role="status" data-testid={testId} data-code="ok">
        {done}
      </p>
    );
  if (outcome.kind === 'uncertain')
    return (
      <p role="status" className="failure" data-testid={testId}>
        {t('discussionUncertain')}
      </p>
    );
  const code = academyCodeOf(outcome.failure);
  const words = code === 'academy.enrolment_required' ? t('discussionEnrolRequired') : academyRefusalText(outcome.failure, t);
  return (
    <div role="status" className="failure" data-testid={testId} data-code={code ?? undefined}>
      {words === null ? <AcademyRefusal failure={outcome.failure} /> : <p>{words}</p>}
    </div>
  );
}

/** The Rooms tab's way into each course discussion: the published courses the reader is enrolled in. */
export function AcademyDiscussionCourses() {
  const api = useApi();
  const { userId } = useSession();
  const { t } = copy.useCopy();
  const list = useResource(
    (signal) => api.query('academy', 'discussionCourses', { limit: COURSES_PAGE }, z.array(academyDiscussionCourseSchema), { signal }),
    `discussion-courses:${userId}`,
  );
  return (
    <Panel title={t('discussionCoursesTitle')}>
      <div className="academy-lms-stack" data-discussion-courses>
        <p className="muted">{t('discussionCoursesIntro')}</p>
        {list.resource.status === 'loading' && <Loading />}
        {list.resource.status === 'failed' && <AcademyRefusal failure={list.resource.failure} retry={list.reload} />}
        {list.resource.status === 'ready' &&
          (list.resource.data.length === 0 ? (
            <p role="status">{t('discussionCoursesNone')}</p>
          ) : (
            <ul className="academy-lms-rows">
              {list.resource.data.map((course) => (
                <li key={course.courseId} data-discussion-course={course.slug}>
                  <strong lang="und">{course.title}</strong>
                  <a className="academy-learning-link" href={academyDiscussionHref(course.slug)}>
                    {t('discussionOpen')}
                  </a>
                </li>
              ))}
            </ul>
          ))}
      </div>
    </Panel>
  );
}

/** `/academy/rooms/discussion/:courseSlug`: the topics, the open topic's posts and the new-post form. */
export function AcademyDiscussionPage({ courseSlug }: { courseSlug: string }) {
  const api = useApi();
  const { userId } = useSession();
  const { t } = copy.useCopy();
  const [topicSlug, setTopicSlug] = useState(ACADEMY_DISCUSSION_GENERAL_TOPIC);
  const topics = useResource(
    (signal) => api.query('academy', 'discussionTopics', { courseSlug }, academyDiscussionTopicsSchema, { signal }),
    `discussion-topics:${userId}:${courseSlug}`,
  );
  const posts = useResource(
    (signal) =>
      api.query('academy', 'discussionPosts', { courseSlug, topicSlug, limit: POSTS_PAGE }, z.array(academyDiscussionPostSchema), {
        signal,
      }),
    `discussion-posts:${userId}:${courseSlug}:${topicSlug}`,
  );
  const topicsData = useSteady(topics.resource, courseSlug);
  const postsData = useSteady(posts.resource, `${courseSlug}:${topicSlug}`);
  const settled = () => {
    posts.reload();
    topics.reload();
  };
  return (
    <div className="academy-lms-stack">
      <a className="text-link" href="/academy/rooms">
        {t('discussionAll')}
      </a>
      {topics.resource.status === 'failed' && (
        <OutcomeLine outcome={{ kind: 'refused', failure: topics.resource.failure }} done="" testId="discussion-refused" />
      )}
      {topicsData === null
        ? topics.resource.status !== 'failed' && <Loading />
        : (() => {
            const data = topicsData;
            const open = data.topics.find((topic) => topic.slug === topicSlug) ?? data.topics[0]!;
            return (
              <div className="more-columns" data-discussion={data.course.slug}>
                <Panel title={<span lang="und">{data.course.title}</span>}>
                  <nav aria-label={t('discussionTopicsTitle')}>
                    <ol className="academy-lms-rows">
                      {data.topics.map((topic) => (
                        <li key={topic.slug} data-discussion-topic={topic.slug} data-pinned={String(topic.pinned)}>
                          <Button
                            variant={topic.slug === open.slug ? 'primary' : 'secondary'}
                            aria-pressed={topic.slug === open.slug}
                            onClick={() => setTopicSlug(topic.slug)}
                          >
                            <span lang={topic.general ? undefined : 'und'}>
                              {topic.general ? t('discussionTopicGeneral') : topic.title}
                            </span>
                          </Button>
                          <span data-testid="academy-lms-meta" className="academy-lms-meta">
                            {topic.pinned && <span className="academy-lms-chip">{t('discussionPinned')}</span>}
                            <span>{postsText(topic.posts, t)}</span>
                          </span>
                        </li>
                      ))}
                    </ol>
                  </nav>
                </Panel>
                <div className="academy-lms-stack" data-testid="discussion-open-topic" data-topic={open.slug}>
                  <TopicPosts courseSlug={data.course.slug} topic={open} posts={postsData} failure={posts.resource} retry={posts.reload} />
                  <NewPost key={open.slug} courseSlug={data.course.slug} topic={open} onSettled={settled} />
                </div>
              </div>
            );
          })()}
    </div>
  );
}

function topicName(topic: AcademyDiscussionTopic, t: T) {
  return topic.general ? t('discussionTopicGeneral') : topic.title;
}

function TopicPosts({
  courseSlug,
  topic,
  posts,
  failure,
  retry,
}: {
  courseSlug: string;
  topic: AcademyDiscussionTopic;
  posts: z.infer<typeof academyDiscussionPostSchema>[] | null;
  failure: Resource<unknown>;
  retry: () => void;
}) {
  const { t } = copy.useCopy();
  const { language } = usePreferences();
  return (
    <Panel title={t('discussionPostsTitle', { topic: topicName(topic, t) })}>
      {failure.status === 'failed' && <AcademyRefusal failure={failure.failure} retry={retry} />}
      {posts === null ? (
        failure.status !== 'failed' && <Loading />
      ) : posts.length === 0 ? (
        <p role="status" data-testid="discussion-empty">
          {t('discussionEmpty')}
        </p>
      ) : (
        <ul className="academy-lms-rows">
          {posts.map((post) => (
            <li key={post.id} data-discussion-post={post.id} data-kind={post.kind}>
              <div>
                <a className="academy-learning-link" href={academyDiscussionHref(courseSlug, post.id)} lang="und">
                  {post.title}
                </a>
                <div data-testid="academy-lms-meta" className="academy-lms-meta">
                  <span className="academy-lms-chip">
                    {post.kind === 'question' ? t('discussionKindQuestion') : t('discussionKindDiscussion')}
                  </span>
                  <span data-testid="post-author">{authorText(post.author, t)}</span>
                  <span>{formatMoment(post.createdAt.toISOString(), language)}</span>
                  <span>{repliesText(post.replies, t)}</span>
                  <span>{likesText(post.likes, t)}</span>
                  {post.acceptedReplyId && <span className="academy-lms-chip">{t('discussionAccepted')}</span>}
                  {post.hasImage && <span>{t('discussionHasImage')}</span>}
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}

function NewPost({ courseSlug, topic, onSettled }: { courseSlug: string; topic: AcademyDiscussionTopic; onSettled: () => void }) {
  const api = useApi();
  const { t } = copy.useCopy();
  const id = useId();
  const [kind, setKind] = useState<AcademyDiscussionPostKind>('question');
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [anonymous, setAnonymous] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [sending, setSending] = useState(false);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const request = useRef(newRequest('post'));
  const inFlight = useRef(false);
  const fileInput = useRef<HTMLInputElement>(null);
  /** A changed draft is a new post: only the same draft sent again keeps its request id. */
  const edited = (change: () => void) => {
    change();
    request.current = newRequest('post');
  };
  const send = async () => {
    // A second press while the first is on its way sends nothing: the first answer is the answer.
    if (inFlight.current) return;
    inFlight.current = true;
    setSending(true);
    setOutcome(null);
    try {
      const image = file ? { contentType: file.type || 'application/octet-stream', base64: await base64Of(file) } : null;
      const sent = await api.mutate(
        'academy',
        'createDiscussionPost',
        { courseSlug, topicSlug: topic.slug, kind, title, body, anonymous, image, clientRequestId: request.current },
        academyDiscussionPostSchema,
      );
      if (sent.ok) {
        setOutcome({ kind: 'done' });
        setTitle('');
        setBody('');
        setAnonymous(false);
        setFile(null);
        if (fileInput.current) fileInput.current.value = '';
        request.current = newRequest('post');
      } else if (sent.reason === 'uncertain') setOutcome({ kind: 'uncertain' });
      else {
        setOutcome({ kind: 'refused', failure: sent });
        // A refused draft was not stored: a changed draft is a new request.
        request.current = newRequest('post');
      }
    } finally {
      inFlight.current = false;
      setSending(false);
      onSettled();
    }
  };
  return (
    <Panel title={t('discussionNewPost', { topic: topicName(topic, t) })}>
      <form
        className="academy-lms-stack"
        data-testid="discussion-new-post"
        onSubmit={(event) => {
          event.preventDefault();
          void send();
        }}
      >
        <label className="field" htmlFor={`${id}-kind`}>
          <span>{t('discussionKind')}</span>
          <select
            id={`${id}-kind`}
            value={kind}
            onChange={(event) => edited(() => setKind(event.target.value as AcademyDiscussionPostKind))}
          >
            <option value="question">{t('discussionKindQuestion')}</option>
            <option value="discussion">{t('discussionKindDiscussion')}</option>
          </select>
        </label>
        <Field
          label={t('discussionPostTitle')}
          value={title}
          maxLength={200}
          required
          onChange={(event) => edited(() => setTitle(event.target.value))}
        />
        <label className="field" htmlFor={`${id}-body`}>
          <span>{t('discussionPostBody')}</span>
          <textarea id={`${id}-body`} value={body} rows={5} required onChange={(event) => edited(() => setBody(event.target.value))} />
        </label>
        <label className="field" htmlFor={`${id}-image`}>
          <span>{t('discussionImage')}</span>
          <input
            id={`${id}-image`}
            ref={fileInput}
            type="file"
            accept="image/png,image/jpeg,image/gif"
            aria-describedby={`${id}-image-hint`}
            onChange={(event) => edited(() => setFile(event.target.files?.[0] ?? null))}
          />
        </label>
        <small id={`${id}-image-hint`}>{t('discussionImageHint')}</small>
        <label className="academy-lms-choice" htmlFor={`${id}-anon`}>
          <input
            id={`${id}-anon`}
            type="checkbox"
            checked={anonymous}
            onChange={(event) => edited(() => setAnonymous(event.target.checked))}
          />
          <span>{t('discussionAnonymous')}</span>
        </label>
        <p className="muted">{t('discussionAnonymousHint')}</p>
        <Button type="submit" disabled={sending}>
          {t('discussionPost')}
        </Button>
        {outcome && <OutcomeLine outcome={outcome} done={t('discussionPosted')} testId="discussion-outcome" />}
      </form>
    </Panel>
  );
}

/** `/academy/rooms/discussion/:courseSlug/:postId`: one post with its image and replies, follow, like and accept. */
export function AcademyDiscussionThread({ courseSlug, postId }: { courseSlug: string; postId: string }) {
  const api = useApi();
  const { userId } = useSession();
  const { t } = copy.useCopy();
  const { language } = usePreferences();
  const thread = useResource(
    (signal) => api.query('academy', 'discussionThread', { postId, limit: REPLIES_PAGE }, academyDiscussionThreadSchema, { signal }),
    `discussion-thread:${userId}:${postId}`,
  );
  const threadData = useSteady(thread.resource, postId);
  const [busy, setBusy] = useState(false);
  const [refused, setRefused] = useState<Outcome | null>(null);
  const act = async (procedure: string, input: Record<string, unknown>, schema: z.ZodType) => {
    setBusy(true);
    setRefused(null);
    const done = await api.mutate('academy', procedure, input, schema);
    setBusy(false);
    if (!done.ok) setRefused(done.reason === 'uncertain' ? { kind: 'uncertain' } : { kind: 'refused', failure: done });
    // Whatever the reply said, the page shows what Academy stored.
    thread.reload();
  };
  return (
    <div className="academy-lms-stack">
      <a className="text-link" href={academyDiscussionHref(threadData?.course.slug ?? courseSlug)}>
        {t('discussionBack')}
      </a>
      {thread.resource.status === 'failed' ? (
        <OutcomeLine outcome={{ kind: 'refused', failure: thread.resource.failure }} done="" testId="discussion-refused" />
      ) : threadData === null ? (
        <Loading />
      ) : (
        (() => {
          const { post, replies, canAccept } = threadData;
          return (
            <div className="academy-lms-stack" data-discussion-thread={post.id}>
              <Panel title={<span lang="und">{post.title}</span>}>
                <div className="academy-lms-stack">
                  <div data-testid="academy-lms-meta" className="academy-lms-meta">
                    <span className="academy-lms-chip">
                      {post.kind === 'question' ? t('discussionKindQuestion') : t('discussionKindDiscussion')}
                    </span>
                    <span data-testid="post-author">{authorText(post.author, t)}</span>
                    <span>{formatMoment(post.createdAt.toISOString(), language)}</span>
                    <span>{likesText(post.likes, t)}</span>
                  </div>
                  <p lang="und" className="academy-discussion-body">
                    {post.body}
                  </p>
                  {post.hasImage && <PostImage postId={post.id} />}
                  <div data-testid="academy-lms-meta" className="academy-lms-meta">
                    <Button
                      variant="secondary"
                      disabled={busy}
                      aria-pressed={post.following}
                      onClick={() =>
                        void act('followDiscussionPost', { postId: post.id, on: !post.following }, academyDiscussionFollowResultSchema)
                      }
                    >
                      {post.following ? t('discussionFollowing') : t('discussionFollow')}
                    </Button>
                    <Button
                      variant="secondary"
                      disabled={busy}
                      aria-pressed={post.liked}
                      onClick={() =>
                        void act('likeDiscussionPost', { postId: post.id, on: !post.liked }, academyDiscussionLikeResultSchema)
                      }
                    >
                      {post.liked ? t('discussionLiked') : t('discussionLike')}
                    </Button>
                  </div>
                </div>
              </Panel>
              <Panel title={t('discussionRepliesTitle')}>
                <div className="academy-lms-stack">
                  {replies.length === 0 ? (
                    <p role="status">{t('discussionNoReplies')}</p>
                  ) : (
                    <ol className="academy-lms-rows">
                      {replies.map((reply) => (
                        <li key={reply.id} data-discussion-reply={reply.id} data-accepted={String(reply.accepted)}>
                          <div className="academy-lms-stack">
                            <div data-testid="academy-lms-meta" className="academy-lms-meta">
                              {reply.accepted && (
                                <span className="academy-lms-chip" data-testid="reply-accepted">
                                  {t('discussionAccepted')}
                                </span>
                              )}
                              <span data-testid="post-author">{authorText(reply.author, t)}</span>
                              <span>{formatMoment(reply.createdAt.toISOString(), language)}</span>
                              <span data-testid="reply-likes">{likesText(reply.likes, t)}</span>
                            </div>
                            <p lang="und" className="academy-discussion-body">
                              {reply.body}
                            </p>
                            <div data-testid="academy-lms-meta" className="academy-lms-meta">
                              <Button
                                variant="secondary"
                                disabled={busy}
                                aria-pressed={reply.liked}
                                onClick={() =>
                                  void act('likeDiscussionPost', { postId: reply.id, on: !reply.liked }, academyDiscussionLikeResultSchema)
                                }
                              >
                                {reply.liked ? t('discussionLiked') : t('discussionLike')}
                              </Button>
                              {canAccept && !reply.accepted && (
                                <Button
                                  variant="secondary"
                                  disabled={busy}
                                  onClick={() =>
                                    void act(
                                      'acceptDiscussionReply',
                                      { postId: post.id, replyId: reply.id },
                                      academyDiscussionAcceptResultSchema,
                                    )
                                  }
                                >
                                  {t('discussionAccept')}
                                </Button>
                              )}
                            </div>
                          </div>
                        </li>
                      ))}
                    </ol>
                  )}
                  {refused && <OutcomeLine outcome={refused} done="" testId="discussion-outcome" />}
                  <ReplyForm postId={post.id} onSettled={thread.reload} />
                </div>
              </Panel>
            </div>
          );
        })()
      )}
    </div>
  );
}

/** A post's image, read once on its own: a like or a follow re-reads the thread, not the image. */
function PostImage({ postId }: { postId: string }) {
  const api = useApi();
  const { userId } = useSession();
  const { t } = copy.useCopy();
  const image = useResource(
    (signal) => api.query('academy', 'discussionPostImage', { postId }, academyDiscussionImageSchema.nullable(), { signal }),
    `discussion-image:${userId}:${postId}`,
  );
  if (image.resource.status === 'loading') return <Loading />;
  if (image.resource.status === 'failed') return <AcademyRefusal failure={image.resource.failure} retry={image.reload} />;
  const data = image.resource.data;
  if (!data) return null;
  return (
    <img
      data-post-image
      className="academy-discussion-image"
      src={`data:${data.contentType};base64,${data.base64}`}
      alt={t('discussionImageAlt')}
    />
  );
}

function ReplyForm({ postId, onSettled }: { postId: string; onSettled: () => void }) {
  const api = useApi();
  const { t } = copy.useCopy();
  const id = useId();
  const [body, setBody] = useState('');
  const [anonymous, setAnonymous] = useState(false);
  const [sending, setSending] = useState(false);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const request = useRef(newRequest('reply'));
  const inFlight = useRef(false);
  /** A changed reply is a new reply: only the same reply sent again keeps its request id. */
  const edited = (change: () => void) => {
    change();
    request.current = newRequest('reply');
  };
  const send = async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    setSending(true);
    setOutcome(null);
    try {
      const sent = await api.mutate(
        'academy',
        'replyDiscussionPost',
        { postId, body, anonymous, clientRequestId: request.current },
        academyDiscussionReplySchema,
      );
      if (sent.ok) {
        setOutcome({ kind: 'done' });
        setBody('');
        setAnonymous(false);
        request.current = newRequest('reply');
      } else if (sent.reason === 'uncertain') setOutcome({ kind: 'uncertain' });
      else {
        setOutcome({ kind: 'refused', failure: sent });
        request.current = newRequest('reply');
      }
    } finally {
      inFlight.current = false;
      setSending(false);
      onSettled();
    }
  };
  return (
    <form
      className="academy-lms-stack"
      data-testid="discussion-reply-form"
      onSubmit={(event) => {
        event.preventDefault();
        void send();
      }}
    >
      <label className="field" htmlFor={`${id}-reply`}>
        <span>{t('discussionReply')}</span>
        <textarea id={`${id}-reply`} value={body} rows={3} required onChange={(event) => edited(() => setBody(event.target.value))} />
      </label>
      <label className="academy-lms-choice" htmlFor={`${id}-anon`}>
        <input
          id={`${id}-anon`}
          type="checkbox"
          checked={anonymous}
          onChange={(event) => edited(() => setAnonymous(event.target.checked))}
        />
        <span>{t('discussionAnonymous')}</span>
      </label>
      <Button type="submit" disabled={sending}>
        {t('discussionSendReply')}
      </Button>
      {outcome && <OutcomeLine outcome={outcome} done={t('discussionReplied')} testId="discussion-reply-outcome" />}
    </form>
  );
}
