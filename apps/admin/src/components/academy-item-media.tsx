'use client';

import { useCallback, useRef, useState } from 'react';
import { Chip } from '@/components/chip';
import { formatWhen } from '@/lib/as-of';
import { fetchItemMedia, postMediaChange, uploadCourseFile } from '@/lib/academy/media-browser';
import { checkBeforeUpload, type AcademyItemMedia, type MediaDeskReply, type MediaView } from '@/lib/academy/media-model';
import { Failed } from '@/components/academy-courses-desk';

/**
 * COURSE FILES (AC-videos-02).
 *
 * An item's video, caption files and handouts. A file is checked here against the owner's limits before a byte is
 * sent (blank limits, too large, a type not accepted); svc-academy checks the declaration again, the bytes go to our
 * own object store, and svc-academy reads the stored file back: a file whose content is not its declared type is
 * refused and never shown to learners. A caption file's first malformed line is named and nothing is stored.
 */

const STATE_TONE = { ready: 'live', pending: 'warn', refused: 'danger' } as const;
const STATE_WORDS = { ready: 'Checked', pending: 'Not checked yet', refused: 'Refused' } as const;

function MediaOutcome({ reply }: { reply: MediaDeskReply | null }) {
  if (!reply) return null;
  if (reply.ok)
    return (
      <div className="adm-callout" role="status" data-tone="ok" data-testid="media-outcome">
        <strong>Done: {reply.what}</strong>
      </div>
    );
  return (
    <div
      className="adm-callout"
      role="alert"
      data-tone={reply.changed === 'unknown' ? 'warn' : 'danger'}
      data-testid="media-outcome"
      data-code={reply.code ?? ''}
    >
      <strong>{reply.title}</strong>
      <p>{reply.body}</p>
      <p className="dk-muted">{reply.next}</p>
      {reply.code && <p className="dk-muted">Code: {reply.code}</p>}
    </div>
  );
}

function Limits({ limits }: { limits: AcademyItemMedia['limits'] }) {
  return (
    <dl className="dk-kv" data-testid="media-limits">
      <dt>Largest file</dt>
      <dd>{limits.maxBytes === null ? 'Not set by the owner: nothing is uploaded' : `${limits.maxBytes} bytes`}</dd>
      <dt>Video types</dt>
      <dd>{limits.videoTypes === null ? 'Not set by the owner: no video is uploaded' : limits.videoTypes.join(', ')}</dd>
      <dt>Handout types</dt>
      <dd>{limits.handoutTypes === null ? 'Not set by the owner: no handout is uploaded' : limits.handoutTypes.join(', ')}</dd>
    </dl>
  );
}

function UploadRow({
  kind,
  busy,
  onFile,
}: {
  kind: 'video' | 'handout';
  busy: boolean;
  onFile: (kind: 'video' | 'handout', file: File) => void;
}) {
  // Read from the input when pressed, so a file chosen before the page was interactive still counts.
  const input = useRef<HTMLInputElement>(null);
  const word = kind === 'video' ? 'Video' : 'Handout';
  return (
    <div className="dk-row">
      <label htmlFor={`media-${kind}-file`}>{word} file</label>
      <input id={`media-${kind}-file`} ref={input} type="file" />
      <button
        type="button"
        className="adm-btn"
        disabled={busy}
        onClick={() => {
          const file = input.current?.files?.[0];
          if (file) onFile(kind, file);
        }}
      >
        Upload {word.toLowerCase()}
      </button>
    </div>
  );
}

function CaptionsForm({ busy, onCaptions }: { busy: boolean; onCaptions: (fields: Record<string, string>) => void }) {
  const file = useRef<HTMLInputElement>(null);
  const [language, setLanguage] = useState('en');
  const [label, setLabel] = useState('English');
  const [format, setFormat] = useState<'srt' | 'vtt'>('srt');
  return (
    <form
      className="dk-stack"
      onSubmit={(e) => {
        e.preventDefault();
        const chosen = file.current?.files?.[0];
        if (chosen) void chosen.text().then((text) => onCaptions({ language, label, format, text }));
      }}
    >
      <div className="dk-row">
        <div className="adm-field">
          <label htmlFor="media-captions-language">Language</label>
          <input id="media-captions-language" value={language} maxLength={12} onChange={(e) => setLanguage(e.target.value)} />
        </div>
        <div className="adm-field">
          <label htmlFor="media-captions-label">Label</label>
          <input id="media-captions-label" value={label} maxLength={60} onChange={(e) => setLabel(e.target.value)} />
        </div>
        <div className="adm-field">
          <label htmlFor="media-captions-format">Format</label>
          <select id="media-captions-format" value={format} onChange={(e) => setFormat(e.target.value === 'vtt' ? 'vtt' : 'srt')}>
            <option value="srt">SRT</option>
            <option value="vtt">WebVTT</option>
          </select>
        </div>
      </div>
      <div className="dk-row">
        <label htmlFor="media-captions-file">Caption file</label>
        <input id="media-captions-file" ref={file} type="file" accept=".srt,.vtt,text/vtt,application/x-subrip" />
        <button type="submit" className="adm-btn" disabled={busy}>
          Add captions
        </button>
      </div>
    </form>
  );
}

export function CourseItemFiles({ itemId, initial }: { itemId: string; initial: MediaView | null }) {
  const [view, setView] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [reply, setReply] = useState<MediaDeskReply | null>(null);

  const reload = useCallback(async () => {
    const next = await fetchItemMedia(itemId);
    if (next) setView(next);
  }, [itemId]);

  const part = view?.media;
  const media = part?.kind === 'ok' ? part.data : null;

  const upload = async (kind: 'video' | 'handout', file: File) => {
    if (!media) return;
    const check = checkBeforeUpload(media.limits, kind, file);
    if (!check.ok) {
      setReply({ ok: false, title: check.title, body: check.body, next: 'Nothing was sent.', code: null, changed: 'no' });
      return;
    }
    setBusy(true);
    try {
      setReply(await uploadCourseFile(itemId, kind, file));
    } finally {
      setBusy(false);
    }
    await reload();
  };

  const captions = async (fields: Record<string, string>) => {
    setBusy(true);
    setReply(await postMediaChange({ op: 'captions', itemId, ...fields }));
    setBusy(false);
    await reload();
  };

  return (
    <section className="dk-stack" aria-labelledby="h-item-media" data-testid="item-media">
      <h2 id="h-item-media">Video, captions and handouts</h2>
      <MediaOutcome reply={reply} />
      {!part && (
        <p className="dk-why">The console could not reach its own server for this item’s files. Nothing is shown rather than a guess.</p>
      )}
      {part?.kind === 'failed' && <Failed title="Could not read this item’s files" message={part.message} code={part.code} />}
      {media && (
        <>
          <Limits limits={media.limits} />
          <UploadRow kind="video" busy={busy} onFile={(k, f) => void upload(k, f)} />
          <UploadRow kind="handout" busy={busy} onFile={(k, f) => void upload(k, f)} />
          {media.media.length === 0 ? (
            <p className="dk-muted" data-testid="media-files">
              No file uploaded for this item yet.
            </p>
          ) : (
            <ul className="dk-stack" data-testid="media-files">
              {media.media.map((m) => (
                <li key={m.id} className="dk-row" data-testid={`media-file-${m.kind}`} data-state={m.state}>
                  <span>
                    {m.kind === 'video' ? 'Video' : 'Handout'}: {m.fileName} ({m.contentType}, {m.bytes} bytes), {formatWhen(m.createdAt)}
                  </span>
                  <Chip tone={STATE_TONE[m.state]}>{STATE_WORDS[m.state]}</Chip>
                  {m.id === media.videoId && <Chip tone="info">The item’s video</Chip>}
                  {m.refusal && <span className="dk-why">{m.refusal}</span>}
                  {m.url && (
                    <a href={m.url} target="_blank" rel="noreferrer noopener">
                      Open {m.fileName}
                    </a>
                  )}
                  {m.state === 'pending' && (
                    <button
                      type="button"
                      className="adm-btn"
                      disabled={busy}
                      onClick={() =>
                        void (async () => {
                          setBusy(true);
                          setReply(await postMediaChange({ op: 'confirm', mediaId: m.id }));
                          setBusy(false);
                          await reload();
                        })()
                      }
                    >
                      Check {m.fileName} again
                    </button>
                  )}
                </li>
              ))}
            </ul>
          )}
          <h3>Captions</h3>
          {media.captions.length === 0 ? (
            <p className="dk-muted" data-testid="media-captions">
              No captions yet. Captions belong to the item’s video, the newest one checked.
            </p>
          ) : (
            <ul className="dk-stack" data-testid="media-captions">
              {media.captions.map((c) => (
                <li key={c.language}>
                  {c.label} ({c.language}, {c.format.toUpperCase()}): {c.cues} cues, first “{c.firstCue}”
                </li>
              ))}
            </ul>
          )}
          <CaptionsForm busy={busy} onCaptions={(fields) => void captions(fields)} />
        </>
      )}
    </section>
  );
}
