// volt-room: /academy/rooms/discussion/:courseSlug/:postId
import { useEffect, useId, useRef, useState } from 'react';
import {
  ACADEMY_DISCUSSION_GENERAL_TOPIC,
  type AcademyDiscussionAuthor,
  type AcademyDiscussionPost,
  type AcademyDiscussionPostKind,
  type AcademyDiscussionTopic,
} from '@intafaced/contracts/academy-discussion';
import {
  ACADEMY_ACCEPT_DISCUSSION_REPLY,
  ACADEMY_CREATE_DISCUSSION_POST,
  ACADEMY_DISCUSSION_COURSES,
  ACADEMY_DISCUSSION_POST_IMAGE,
  ACADEMY_DISCUSSION_POSTS,
  ACADEMY_DISCUSSION_THREAD,
  ACADEMY_DISCUSSION_TOPICS,
  ACADEMY_FOLLOW_DISCUSSION_POST,
  ACADEMY_LIKE_DISCUSSION_POST,
  ACADEMY_REPLY_DISCUSSION_POST,
  ACADEMY_REPORT_DISCUSSION_POST,
} from '@intafaced/contracts/academy-learner-procedures';
import type { ApiResult } from '../../shared/api';
import { usePreferences } from '../../shared/preferences';
import { useResource, type Resource } from '../../shared/resource';
import { useApi, useSession } from '../session';
import { academyCodeOf, academyRefusalText } from './academy-flows';
import { academyLmsCopy as copy } from './academy-lms-copy';
import { academyDiscussionHref, formatMoment } from './academy-lms';
import { AcademyRefusal } from './academy-refusal';
import { AcademySections } from './academy-sections';
import { t as copyText } from './copy';
import { Button, Field, Tag } from '@intafaced/ui/lit';
import { CheckField, FileField, ReadingTemplate, SelectField, TextAreaField } from '@intafaced/ui/lit/templates';
import { Section, Waiting } from './volt-parts';

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
      <p role="status" className="lt-refusal" data-testid={testId}>
        {t('discussionUncertain')}
      </p>
    );
  const code = academyCodeOf(outcome.failure);
  const words = code === 'academy.enrolment_required' ? t('discussionEnrolRequired') : academyRefusalText(outcome.failure, t);
  return (
    <div role="status" className="lt-refusal" data-testid={testId} data-code={code ?? undefined}>
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
    (signal) => api.call(ACADEMY_DISCUSSION_COURSES, { limit: COURSES_PAGE }, { signal }),
    `discussion-courses:${userId}`,
  );
  return (
    <Section title={t('discussionCoursesTitle')}>
      <div data-discussion-courses>
        <p>{t('discussionCoursesIntro')}</p>
        {list.resource.status === 'loading' && <Waiting />}
        {list.resource.status === 'failed' && <AcademyRefusal failure={list.resource.failure} retry={list.reload} />}
        {list.resource.status === 'ready' &&
          (list.resource.data.length === 0 ? (
            <p role="status">{t('discussionCoursesNone')}</p>
          ) : (
            <ul>
              {list.resource.data.map((course) => (
                <li key={course.courseId} data-discussion-course={course.slug}>
                  <strong lang="und">{course.title}</strong>
                  <a className="lt-link" href={academyDiscussionHref(course.slug)}>
                    {t('discussionOpen')}
                  </a>
                </li>
              ))}
            </ul>
          ))}
      </div>
    </Section>
  );
}

/** `/academy/rooms/discussion/:courseSlug`: the topics, the open topic's posts and the new-post form. */
export function AcademyDiscussionPage({ courseSlug }: { courseSlug: string }) {
  const api = useApi();
  const { userId } = useSession();
  const { t } = copy.useCopy();
  const [topicSlug, setTopicSlug] = useState(ACADEMY_DISCUSSION_GENERAL_TOPIC);
  const topics = useResource(
    (signal) => api.call(ACADEMY_DISCUSSION_TOPICS, { courseSlug }, { signal }),
    `discussion-topics:${userId}:${courseSlug}`,
  );
  const posts = useResource(
    (signal) => api.call(ACADEMY_DISCUSSION_POSTS, { courseSlug, topicSlug, limit: POSTS_PAGE }, { signal }),
    `discussion-posts:${userId}:${courseSlug}:${topicSlug}`,
  );
  const topicsData = useSteady(topics.resource, courseSlug);
  const postsData = useSteady(posts.resource, `${courseSlug}:${topicSlug}`);
  const settled = () => {
    posts.reload();
    topics.reload();
  };
  return (
    <div>
      <a className="lt-link" href="/academy/rooms">
        {t('discussionAll')}
      </a>
      {topics.resource.status === 'failed' && (
        <OutcomeLine outcome={{ kind: 'refused', failure: topics.resource.failure }} done="" testId="discussion-refused" />
      )}
      {topicsData === null
        ? topics.resource.status !== 'failed' && <Waiting />
        : (() => {
            const data = topicsData;
            const open = data.topics.find((topic) => topic.slug === topicSlug) ?? data.topics[0]!;
            return (
              <div data-discussion={data.course.slug}>
                <Section title={<span lang="und">{data.course.title}</span>}>
                  <nav aria-label={t('discussionTopicsTitle')}>
                    <ol>
                      {data.topics.map((topic) => (
                        <li key={topic.slug} data-discussion-topic={topic.slug} data-pinned={String(topic.pinned)}>
                          <Button
                            tone={topic.slug === open.slug ? 'primary' : 'secondary'}
                            aria-pressed={topic.slug === open.slug}
                            onClick={() => setTopicSlug(topic.slug)}
                          >
                            <span lang={topic.general ? undefined : 'und'}>
                              {topic.general ? t('discussionTopicGeneral') : topic.title}
                            </span>
                          </Button>
                          <span data-testid="academy-lms-meta">
                            {topic.pinned && <Tag tone="neutral">{t('discussionPinned')}</Tag>}
                            <span>{postsText(topic.posts, t)}</span>
                          </span>
                        </li>
                      ))}
                    </ol>
                  </nav>
                </Section>
                <div data-testid="discussion-open-topic" data-topic={open.slug}>
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
  posts: AcademyDiscussionPost[] | null;
  failure: Resource<unknown>;
  retry: () => void;
}) {
  const { t } = copy.useCopy();
  const { language } = usePreferences();
  return (
    <Section title={t('discussionPostsTitle', { topic: topicName(topic, t) })}>
      {failure.status === 'failed' && <AcademyRefusal failure={failure.failure} retry={retry} />}
      {posts === null ? (
        failure.status !== 'failed' && <Waiting />
      ) : posts.length === 0 ? (
        <p role="status" data-testid="discussion-empty">
          {t('discussionEmpty')}
        </p>
      ) : (
        <ul>
          {posts.map((post) => (
            <li key={post.id} data-discussion-post={post.id} data-kind={post.kind}>
              <div>
                <a className="lt-link" href={academyDiscussionHref(courseSlug, post.id)} lang="und">
                  {post.title}
                </a>
                <div data-testid="academy-lms-meta">
                  <Tag tone="neutral">{post.kind === 'question' ? t('discussionKindQuestion') : t('discussionKindDiscussion')}</Tag>
                  <span data-testid="post-author">{authorText(post.author, t)}</span>
                  <span>{formatMoment(post.createdAt, language)}</span>
                  <span>{repliesText(post.replies, t)}</span>
                  <span>{likesText(post.likes, t)}</span>
                  {post.acceptedReplyId && <Tag tone="neutral">{t('discussionAccepted')}</Tag>}
                  {post.hasImage && <span>{t('discussionHasImage')}</span>}
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}
    </Section>
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
      const sent = await api.call(ACADEMY_CREATE_DISCUSSION_POST, {
        courseSlug,
        topicSlug: topic.slug,
        kind,
        title,
        body,
        anonymous,
        image,
        clientRequestId: request.current,
      });
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
    <Section title={t('discussionNewPost', { topic: topicName(topic, t) })}>
      <form
        data-testid="discussion-new-post"
        onSubmit={(event) => {
          event.preventDefault();
          void send();
        }}
      >
        <SelectField
          id={`${id}-kind`}
          label={t('discussionKind')}
          value={kind}
          onChange={(value) => edited(() => setKind(value === 'discussion' ? 'discussion' : 'question'))}
          options={[
            { value: 'question', label: t('discussionKindQuestion') },
            { value: 'discussion', label: t('discussionKindDiscussion') },
          ]}
        />
        <Field
          label={t('discussionPostTitle')}
          value={title}
          maxLength={200}
          required
          onChange={(event) => edited(() => setTitle(event.target.value))}
        />
        <TextAreaField
          id={`${id}-body`}
          label={t('discussionPostBody')}
          value={body}
          rows={5}
          required
          onChange={(value) => edited(() => setBody(value))}
        />
        <FileField
          id={`${id}-image`}
          ref={fileInput}
          label={t('discussionImage')}
          accept="image/png,image/jpeg,image/gif"
          hint={t('discussionImageHint')}
          onChange={(picked) => edited(() => setFile(picked))}
        />
        <CheckField
          id={`${id}-anon`}
          label={t('discussionAnonymous')}
          checked={anonymous}
          onChange={(checked) => edited(() => setAnonymous(checked))}
        />
        <p>{t('discussionAnonymousHint')}</p>
        <Button tone="primary" type="submit" disabled={sending}>
          {t('discussionPost')}
        </Button>
        {outcome && <OutcomeLine outcome={outcome} done={t('discussionPosted')} testId="discussion-outcome" />}
      </form>
    </Section>
  );
}

/**
 * `/academy/rooms/discussion/:courseSlug/:postId` on the reading template, signed in: the post, its replies and the forms
 * under them. The Academy's sections are links above it.
 */
export function AcademyDiscussionThreadRoom({ courseSlug, postId }: { courseSlug: string; postId: string }) {
  return (
    <div data-room="academy-discussion-post">
      <ReadingTemplate
        title={copyText('moreroutes.academy')}
        description={copyText('moreroutes.learn.practise.and.join.hosted.sessions')}
        state={{ kind: 'ready' }}
        meta={<AcademySections current="Rooms" />}
        body={<AcademyDiscussionThread key={postId} courseSlug={courseSlug} postId={postId} />}
      />
    </div>
  );
}

/** `/academy/rooms/discussion/:courseSlug/:postId`: one post with its image and replies, follow, like and accept. */
export function AcademyDiscussionThread({ courseSlug, postId }: { courseSlug: string; postId: string }) {
  const api = useApi();
  const { userId } = useSession();
  const { t } = copy.useCopy();
  const { language } = usePreferences();
  const thread = useResource(
    (signal) => api.call(ACADEMY_DISCUSSION_THREAD, { postId, limit: REPLIES_PAGE }, { signal }),
    `discussion-thread:${userId}:${postId}`,
  );
  const threadData = useSteady(thread.resource, postId);
  const [busy, setBusy] = useState(false);
  const [refused, setRefused] = useState<Outcome | null>(null);
  const act = async (send: () => Promise<ApiResult<unknown>>) => {
    setBusy(true);
    setRefused(null);
    const done = await send();
    setBusy(false);
    if (!done.ok) setRefused(done.reason === 'uncertain' ? { kind: 'uncertain' } : { kind: 'refused', failure: done });
    // Whatever the reply said, the page shows what Academy stored.
    thread.reload();
  };
  return (
    <div>
      <a className="lt-link" href={academyDiscussionHref(threadData?.course.slug ?? courseSlug)}>
        {t('discussionBack')}
      </a>
      {thread.resource.status === 'failed' ? (
        <OutcomeLine outcome={{ kind: 'refused', failure: thread.resource.failure }} done="" testId="discussion-refused" />
      ) : threadData === null ? (
        <Waiting />
      ) : (
        (() => {
          const { post, replies, canAccept } = threadData;
          return (
            <div data-discussion-thread={post.id}>
              <Section title={<span lang="und">{post.title}</span>}>
                <div>
                  <div data-testid="academy-lms-meta">
                    <Tag tone="neutral">{post.kind === 'question' ? t('discussionKindQuestion') : t('discussionKindDiscussion')}</Tag>
                    <span data-testid="post-author">{authorText(post.author, t)}</span>
                    <span>{formatMoment(post.createdAt, language)}</span>
                    <span>{likesText(post.likes, t)}</span>
                  </div>
                  <p lang="und" className="lt-pre-wrap">
                    {post.body}
                  </p>
                  {post.hasImage && <PostImage postId={post.id} />}
                  <div data-testid="academy-lms-meta">
                    <Button
                      tone="secondary"
                      disabled={busy}
                      aria-pressed={post.following}
                      onClick={() => void act(() => api.call(ACADEMY_FOLLOW_DISCUSSION_POST, { postId: post.id, on: !post.following }))}
                    >
                      {post.following ? t('discussionFollowing') : t('discussionFollow')}
                    </Button>
                    <Button
                      tone="secondary"
                      disabled={busy}
                      aria-pressed={post.liked}
                      onClick={() => void act(() => api.call(ACADEMY_LIKE_DISCUSSION_POST, { postId: post.id, on: !post.liked }))}
                    >
                      {post.liked ? t('discussionLiked') : t('discussionLike')}
                    </Button>
                  </div>
                  {post.author.kind !== 'you' && <ReportForm postId={post.id} />}
                </div>
              </Section>
              <Section title={t('discussionRepliesTitle')}>
                <div>
                  {replies.length === 0 ? (
                    <p role="status">{t('discussionNoReplies')}</p>
                  ) : (
                    <ol>
                      {replies.map((reply) => (
                        <li key={reply.id} data-discussion-reply={reply.id} data-accepted={String(reply.accepted)}>
                          <div>
                            <div data-testid="academy-lms-meta">
                              {reply.accepted && (
                                <Tag tone="neutral" data-testid="reply-accepted">
                                  {t('discussionAccepted')}
                                </Tag>
                              )}
                              <span data-testid="post-author">{authorText(reply.author, t)}</span>
                              <span>{formatMoment(reply.createdAt, language)}</span>
                              <span data-testid="reply-likes">{likesText(reply.likes, t)}</span>
                            </div>
                            <p lang="und" className="lt-pre-wrap">
                              {reply.body}
                            </p>
                            <div data-testid="academy-lms-meta">
                              <Button
                                tone="secondary"
                                disabled={busy}
                                aria-pressed={reply.liked}
                                onClick={() =>
                                  void act(() => api.call(ACADEMY_LIKE_DISCUSSION_POST, { postId: reply.id, on: !reply.liked }))
                                }
                              >
                                {reply.liked ? t('discussionLiked') : t('discussionLike')}
                              </Button>
                              {canAccept && !reply.accepted && (
                                <Button
                                  tone="secondary"
                                  disabled={busy}
                                  onClick={() =>
                                    void act(() => api.call(ACADEMY_ACCEPT_DISCUSSION_REPLY, { postId: post.id, replyId: reply.id }))
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
              </Section>
            </div>
          );
        })()
      )}
    </div>
  );
}

/**
 * Report a post to the course's moderators with a reason (AC-rooms-02). One report per account per post: a second one
 * changes nothing and says so. Reporting does not promise a takedown, and the author never learns who reported.
 */
function ReportForm({ postId }: { postId: string }) {
  const api = useApi();
  const { t } = copy.useCopy();
  const id = useId();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [sending, setSending] = useState(false);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [first, setFirst] = useState(true);
  const send = async () => {
    setSending(true);
    setOutcome(null);
    const sent = await api.call(ACADEMY_REPORT_DISCUSSION_POST, { postId, reason });
    setSending(false);
    if (sent.ok) {
      setFirst(sent.data.reported);
      setOutcome({ kind: 'done' });
    } else setOutcome(sent.reason === 'uncertain' ? { kind: 'uncertain' } : { kind: 'refused', failure: sent });
  };
  if (!open)
    return (
      <div>
        <Button tone="secondary" onClick={() => setOpen(true)}>
          {t('discussionReport')}
        </Button>
      </div>
    );
  return (
    <form
      data-testid="discussion-report-form"
      onSubmit={(event) => {
        event.preventDefault();
        void send();
      }}
    >
      <TextAreaField
        id={`${id}-why`}
        label={t('discussionReportWhy')}
        value={reason}
        rows={2}
        required
        maxLength={500}
        onChange={setReason}
      />
      <Button tone="primary" type="submit" disabled={sending}>
        {t('discussionReportSend')}
      </Button>
      {outcome && (
        <OutcomeLine
          outcome={outcome}
          done={first ? t('discussionReported') : t('discussionReportedBefore')}
          testId="discussion-report-outcome"
        />
      )}
    </form>
  );
}

/** A post's image, read once on its own: a like or a follow re-reads the thread, not the image. */
function PostImage({ postId }: { postId: string }) {
  const api = useApi();
  const { userId } = useSession();
  const { t } = copy.useCopy();
  const image = useResource(
    (signal) => api.call(ACADEMY_DISCUSSION_POST_IMAGE, { postId }, { signal }),
    `discussion-image:${userId}:${postId}`,
  );
  if (image.resource.status === 'loading') return <Waiting />;
  if (image.resource.status === 'failed') return <AcademyRefusal failure={image.resource.failure} retry={image.reload} />;
  const data = image.resource.data;
  if (!data) return null;
  return <img data-post-image className="lt-media" src={`data:${data.contentType};base64,${data.base64}`} alt={t('discussionImageAlt')} />;
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
      const sent = await api.call(ACADEMY_REPLY_DISCUSSION_POST, { postId, body, anonymous, clientRequestId: request.current });
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
      data-testid="discussion-reply-form"
      onSubmit={(event) => {
        event.preventDefault();
        void send();
      }}
    >
      <TextAreaField
        id={`${id}-reply`}
        label={t('discussionReply')}
        value={body}
        rows={3}
        required
        onChange={(value) => edited(() => setBody(value))}
      />
      <CheckField
        id={`${id}-anon`}
        label={t('discussionAnonymous')}
        checked={anonymous}
        onChange={(checked) => edited(() => setAnonymous(checked))}
      />
      <Button tone="primary" type="submit" disabled={sending}>
        {t('discussionSendReply')}
      </Button>
      {outcome && <OutcomeLine outcome={outcome} done={t('discussionReplied')} testId="discussion-reply-outcome" />}
    </form>
  );
}
