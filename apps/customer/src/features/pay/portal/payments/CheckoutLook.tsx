import { useEffect, useState, type ChangeEvent } from 'react';
import {
  CHECKOUT_DEFAULT_BRAND_COLOR,
  checkoutButtonTextColor,
  type CheckoutBranding,
} from '@intafaced/contracts/merchant-checkout-branding';
import { Button, Field } from '@intafaced/ui/lit';
import { BrandSample } from '@intafaced/ui/lit/templates';
import { useResource } from '../../../../shared/resource';
import { useMerchantAccess } from '../access/MerchantAccess';
import type { PortalApi } from '../api';
import { checkImage, imageRequestId, sizeText } from '../catalog/model';
import { base64Of } from '../settings/onboarding/Application';
import { DateTime } from '../ui/DateTime';
import { Gate, Section } from '../volt/parts';
import { lookCopy as c } from './look-copy';

/** A logo as the form holds it: the saved one, a newly picked file, or none. */
type LogoChoice =
  { kind: 'saved'; src: string } | { kind: 'new'; src: string; contentType: string; dataBase64: string; file: File } | { kind: 'none' };

const COLOR = /^#[0-9a-fA-F]{6}$/;
const TYPE_NAMES: Record<string, string> = { 'image/png': 'PNG', 'image/jpeg': 'JPEG', 'image/webp': 'WebP' };
/** The allowed types as people say them: "PNG, JPEG or WebP". */
const typeNames = (types: readonly string[]) => {
  const names = types.map((t) => TYPE_NAMES[t] ?? t.replace('image/', '').toUpperCase());
  return names.length > 1 ? `${names.slice(0, -1).join(', ')} or ${names[names.length - 1]}` : (names[0] ?? '');
};

/**
 * Whether this person may change the checkout's settings (its look, its payment methods): the role table says so, and the
 * business is verified (the service's rule too).
 */
export function useMayChangeLook(): { allowed: boolean; unverified: boolean } {
  const { access, can } = useMerchantAccess();
  const unverified = access.status === 'ready' && access.kybStatus !== 'approved';
  return { allowed: can('profile.manage') && !unverified, unverified: can('profile.manage') && unverified };
}

/**
 * `/pay/checkout`, first section: the logo and brand colour every payment link's hosted page shows (J-merchant-04 step 1).
 * A business that never saved one sees the default look with Save. A logo is checked against the published size before
 * it is sent, and the service checks its bytes again.
 */
export function CheckoutLook({ portal, id }: { portal: PortalApi; id?: string }) {
  const { resource, reload } = useResource((s) => portal.checkoutLook(s), 'portal:checkout-look');
  // Kept here, not in the form: a save reloads the look and draws a fresh form, and its answer must stay on screen.
  const [note, setNote] = useState<Note | null>(null);
  return (
    <Section id={id} title={c.t('title')} description={c.t('purpose')}>
      <Gate resource={resource} retry={reload} rows={4}>
        {(branding) => (
          <LookForm
            key={branding.look.status === 'saved' ? branding.look.version : 0}
            branding={branding}
            portal={portal}
            onSaved={reload}
            note={note}
            setNote={setNote}
          />
        )}
      </Gate>
    </Section>
  );
}

type Note = { ok: boolean; text: string };

function LookForm({
  branding,
  portal,
  onSaved,
  note,
  setNote,
}: {
  branding: CheckoutBranding;
  portal: PortalApi;
  onSaved: () => void;
  note: Note | null;
  setNote: (note: Note | null) => void;
}) {
  const { look, rules } = branding;
  const may = useMayChangeLook();
  const [color, setColor] = useState(look.status === 'saved' ? look.brandColor : CHECKOUT_DEFAULT_BRAND_COLOR);
  const [logo, setLogo] = useState<LogoChoice>(
    look.status === 'saved' && look.logo
      ? { kind: 'saved', src: `data:${look.logo.contentType};base64,${look.logo.dataBase64}` }
      : { kind: 'none' },
  );
  const [busy, setBusy] = useState(false);
  useEffect(() => () => void (logo.kind === 'new' && URL.revokeObjectURL(logo.src)), [logo]);
  const colorOk = COLOR.test(color.trim());
  const types = typeNames(rules.logoTypes);

  async function picked(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    const check = checkImage(file, { maxBytes: rules.logoMaxBytes, types: rules.logoTypes });
    if (!check.ok) {
      setNote({
        ok: false,
        text:
          check.reason === 'rulesUnset'
            ? c.t('logoRulesUnset')
            : c.t(check.reason === 'tooLarge' ? 'logoTooLarge' : 'logoWrongType', {
                size: sizeText(check.size),
                max: sizeText(check.max),
                types,
              }),
      });
      return;
    }
    setLogo({ kind: 'new', src: URL.createObjectURL(file), contentType: file.type, dataBase64: await base64Of(file), file });
    setNote({ ok: true, text: c.t('logoNew') });
  }

  async function save() {
    if (!colorOk) return;
    setBusy(true);
    setNote(null);
    try {
      const expectedVersion = look.status === 'saved' ? look.version : 0;
      const brandColor = color.trim().toLowerCase();
      const logoInput =
        logo.kind === 'new'
          ? { contentType: logo.contentType, dataBase64: logo.dataBase64 }
          : logo.kind === 'none' && look.status === 'saved' && look.logo
            ? null
            : undefined;
      // The request id comes from what is saved and the version it is saved over: sending the same save again after a
      // lost answer is the same request, and the service answers with the look it already saved.
      const requestId = await imageRequestId(
        new Blob([
          JSON.stringify({
            expectedVersion,
            brandColor,
            logo: logo.kind === 'new' ? await imageRequestId(logo.file) : logoInput === null ? 'none' : 'keep',
          }),
        ]),
      );
      const result = await portal.saveCheckoutLook({
        requestId,
        expectedVersion,
        brandColor,
        ...(logoInput !== undefined ? { logo: logoInput } : {}),
      });
      if (result.ok) {
        setNote({ ok: true, text: c.t('saved') });
        onSaved();
      } else {
        setNote({ ok: false, text: result.message });
        if (result.code === 'pay.checkout_branding_stale') onSaved();
      }
    } finally {
      setBusy(false);
    }
  }

  const previewColor = colorOk ? color.trim().toLowerCase() : CHECKOUT_DEFAULT_BRAND_COLOR;
  return (
    <div>
      <div data-testid="form-stack">
        <p className="lt-hint" role="status" data-testid="checkout-look-state">
          {look.status === 'default' ? (
            c.t('isDefault')
          ) : (
            <>
              {c.t('savedOn')} <DateTime value={look.updatedAt} />
            </>
          )}
        </p>
        {!may.allowed && (
          <p className="lt-hint" role="note">
            {c.t(may.unverified ? 'unverified' : 'noWrite')}
          </p>
        )}
        <div>
          <Field
            label={c.t('color')}
            hint={c.t('colorHint')}
            required
            value={color}
            maxLength={7}
            disabled={!may.allowed}
            onChange={(e) => setColor(e.target.value)}
            error={colorOk ? undefined : c.t('colorInvalid')}
          />
          <Field
            label={c.t('colorPicker')}
            type="color"
            value={previewColor}
            disabled={!may.allowed}
            onChange={(e) => setColor(e.target.value)}
          />
        </div>
        {rules.logoMaxBytes === null ? (
          <div>
            <p>{c.t('logo')}</p>
            <p className="lt-hint" data-testid="checkout-logo-off">
              {c.t('logoRulesUnset')}
            </p>
          </div>
        ) : (
          <Field
            label={c.t('logo')}
            hint={c.t('logoRule', { types, max: sizeText(rules.logoMaxBytes) })}
            type="file"
            accept={rules.logoTypes.join(',')}
            disabled={busy || !may.allowed}
            onChange={(e) => void picked(e)}
          />
        )}
        <p className="lt-hint">{logo.kind === 'new' ? c.t('logoNew') : logo.kind === 'saved' ? c.t('logoSaved') : c.t('logoNone')}</p>
        {logo.kind !== 'none' && may.allowed && (
          <div className="lt-actions">
            <Button tone="secondary" onClick={() => setLogo({ kind: 'none' })}>
              {c.t('logoRemove')}
            </Button>
          </div>
        )}
        {note && (
          <p className="lt-hint" role={note.ok ? 'status' : 'alert'}>
            {note.text}
          </p>
        )}
        <div className="lt-actions">
          <Button tone="primary" disabled={!may.allowed || !colorOk || busy} onClick={() => void save()}>
            {busy ? c.t('saving') : c.t('save')}
          </Button>
        </div>
      </div>
      <BrandSample label={c.t('previewLabel')} accent={previewColor} onAccent={checkoutButtonTextColor(previewColor)}>
        <figcaption className="lt-hint">{c.t('previewTitle')}</figcaption>
        {logo.kind !== 'none' && <img className="lt-brand-logo" src={logo.src} alt={c.t('logoAlt')} />}
        <p className="lt-hint">{c.t('previewEyebrow')}</p>
        <p>{c.t('previewItem')}</p>
        <p className="lt-figure">{c.t('previewAmount')}</p>
        <span className="lt-brand-button" data-testid="checkout-look-button">
          {c.t('previewButton')}
        </span>
        <p className="lt-hint">{c.t('previewNote')}</p>
      </BrandSample>
    </div>
  );
}
