import { useRef, useState, type FormEvent } from 'react';
import {
  Button,
  Card,
  isHiddenPath,
  Note,
  refusalCopy,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  TextField,
  useSession,
} from './deps';
import { supportScreenCopy } from './copy';
import { createTicket, type Category } from './support-api';
import { pickableCategories } from './support-view';

type Sent = 'none' | 'sent' | 'unknown' | { failed: string };

/** Contact: one form that opens a request. The only contact route today (there is no live chat or phone line). */
export function ContactForm({ onSent }: { onSent: () => void }) {
  const { t } = supportScreenCopy.useCopy();
  const { api, userId } = useSession();
  const topics = pickableCategories(isHiddenPath('/uc/recharge'));
  const [category, setCategory] = useState<Category>('account');
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState<Sent>('none');
  const sending = useRef(false);
  const labels = Object.fromEntries(topics.map((topic) => [topic, t(`Topic ${topic}`)]));

  async function submit(event: FormEvent) {
    event.preventDefault();
    const clean = { category, subject: subject.trim(), body: body.trim() };
    if (sending.current || !userId || !clean.subject || !clean.body || !api.canWrite()) return;
    sending.current = true;
    setBusy(true);
    setSent('none');
    const answer = await createTicket(api, userId, clean);
    sending.current = false;
    setBusy(false);
    if (answer.ok) {
      setSubject('');
      setBody('');
      setSent('sent');
      onSent();
    } else if (answer.reason === 'uncertain') {
      setSent('unknown');
      onSent();
    } else {
      const words = answer.code ? refusalCopy(answer.code) : null;
      setSent({ failed: words ? `${words.title}. ${words.body}` : t('Send failed') });
    }
  }

  return (
    <Card title={t('Contact')} lead={t('Contact lead')} className="sup-contact">
      <form className="sup-form" onSubmit={(event) => void submit(event)}>
        <div className="sk-field">
          <span className="sk-field__label" id="sup-topic">
            {t('Topic')}
          </span>
          <Select items={labels} value={category} onValueChange={(value) => setCategory(value as Category)}>
            <SelectTrigger aria-labelledby="sup-topic" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {topics.map((topic) => (
                <SelectItem key={topic} value={topic}>
                  {labels[topic]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <TextField
          label={t('Subject')}
          name="support-subject"
          required
          maxLength={200}
          value={subject}
          onChange={(event) => setSubject(event.target.value)}
        />
        <TextField
          label={t('Message')}
          name="support-message"
          multiline
          required
          maxLength={10000}
          hint={t('Message hint')}
          value={body}
          onChange={(event) => setBody(event.target.value)}
        />
        <Button type="submit" variant="primary" size={40} loading={busy} disabled={!subject.trim() || !body.trim()}>
          {t('Send message')}
        </Button>
      </form>
      {sent === 'sent' ? (
        <Note tone="good" role="status">
          <p>{t('Message sent')}</p>
        </Note>
      ) : sent === 'unknown' ? (
        <Note tone="warn" role="alert">
          <p>{t('Send unknown')}</p>
        </Note>
      ) : typeof sent === 'object' ? (
        <Note tone="error" role="alert">
          <p>{sent.failed}</p>
        </Note>
      ) : null}
    </Card>
  );
}
