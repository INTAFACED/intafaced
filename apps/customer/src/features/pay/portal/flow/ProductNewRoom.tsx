// volt-room: portal:product-new
// volt-room: /pay/products/new
import { useState, type ChangeEvent } from 'react';
import { useRelease } from '../../../../shared/outside';
import { Button, Field } from '@intafaced/ui/lit';
import { FlowTemplate } from '@intafaced/ui/lit/templates';
import { PRODUCT_TYPES, type ProductImageRules } from '@intafaced/contracts/merchant-catalog';
import { navigate } from '../../../../app/location';
import { useResource } from '../../../../shared/resource';
import type { PortalApi } from '../api';
import { base64Of } from '../settings/onboarding/Application';
import { useBodyRequestId } from '../payments/invoice-model';
import { useMayAddProducts } from '../catalog/access';
import { useCatalogMode } from '../catalog/mode';
import { catalogCopy as c } from '../catalog/copy';
import { blankProduct, checkImage, draftProblem, imageRequestId, productBody, sizeText, type ProductDraft } from '../catalog/model';
import { Actions, Empty, Failure, Loading, Section, SelectField } from './parts';

const productHref = (id: string) => `/pay/products/${encodeURIComponent(id)}`;

/**
 * `/pay/products/new` (J-merchant-03 steps 1 and 2), on the flow template: name, type and the details a product needs,
 * an optional image kept by the service at once, then Save. One request id per body, so a retry after a lost answer is
 * the same request.
 */
export function ProductCreate({ portal }: { portal: PortalApi }) {
  const { t } = c.useCopy();
  const may = useMayAddProducts();
  const rules = useResource((signal) => portal.productImageRules(signal), 'portal:catalog:image-rules');
  const [draft, setDraft] = useState<ProductDraft>(blankProduct);
  const [mode] = useCatalogMode();
  // One request id per body: a retry of the same product after a lost answer is the same request, and any change to it
  // is a new one, so the service never sees one id with two different products.
  const { requestId: _unsent, ...body } = productBody(draft, '', mode);
  const request = useBodyRequestId('catalog:product-new', body);
  const [busy, setBusy] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [refused, setRefused] = useState<string | null>(null);
  const [shown, setShown] = useState(false);
  const set = <K extends keyof ProductDraft>(key: K, value: ProductDraft[K]) => setDraft((d) => ({ ...d, [key]: value }));
  const problem = draftProblem(draft);

  async function save() {
    setShown(true);
    if (problem || uploading) return;
    setBusy(true);
    setRefused(null);
    try {
      request.sent();
      const result = await portal.createProduct({ ...body, requestId: request.id });
      if (result.ok) {
        request.renew();
        navigate(productHref(result.data.product.id));
      } else {
        setRefused(result.message);
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <FlowTemplate
      framed
      title={t('newTitle')}
      state={{ kind: 'ready' }}
      step={
        !may.allowed ? (
          <Empty title={t('newTitle')} body={t(may.unverified ? 'emptyBodyUnverified' : 'emptyBodyReadOnly')} />
        ) : (
          <Section title={t('newTitle')} description={t('newPurpose')}>
            <div data-testid="form-stack">
              {mode === 'test' && <p role="note">{t('testCatalogueNote')}</p>}
              <Field
                label={t('name')}
                hint={t('nameHint')}
                value={draft.name}
                maxLength={250}
                onChange={(e) => set('name', e.target.value)}
                error={shown && problem === 'nameRequired' ? t('nameRequired') : undefined}
              />
              <SelectField
                label={t('type')}
                value={draft.type}
                onChange={(value) => set('type', value as ProductDraft['type'])}
                options={PRODUCT_TYPES.map((type) => [type, t(`type_${type}`)] as const)}
              />
              {draft.type === 'event' && (
                <>
                  <Field
                    label={t('eventStarts')}
                    hint={t('eventStartsHint')}
                    type="datetime-local"
                    value={draft.eventStartsAt}
                    onChange={(e) => set('eventStartsAt', e.target.value)}
                    error={shown && problem === 'eventInvalid' && !draft.eventStartsAt ? t('eventInvalid') : undefined}
                  />
                  <Field
                    label={t('eventLocation')}
                    hint={t('eventLocationHint')}
                    value={draft.eventLocation}
                    maxLength={200}
                    onChange={(e) => set('eventLocation', e.target.value)}
                    error={shown && problem === 'eventInvalid' && draft.eventStartsAt ? t('eventInvalid') : undefined}
                  />
                </>
              )}
              <Field
                label={t('unitLabel')}
                hint={t('unitLabelHint')}
                value={draft.unitLabel}
                maxLength={40}
                onChange={(e) => set('unitLabel', e.target.value)}
              />
              <Field
                label={t('descriptor')}
                hint={t('descriptorHint')}
                value={draft.statementDescriptor}
                maxLength={22}
                onChange={(e) => set('statementDescriptor', e.target.value)}
                error={shown && problem === 'descriptorInvalid' ? t('descriptorInvalid') : undefined}
              />
              <Field
                label={t('productKey')}
                hint={t('productKeyHint')}
                value={draft.productKey}
                maxLength={64}
                onChange={(e) => set('productKey', e.target.value)}
                error={shown && problem === 'keyInvalid' ? t('keyInvalid') : undefined}
              />
              {rules.resource.status === 'loading' ? (
                <Loading rows={1} />
              ) : rules.resource.status === 'failed' ? (
                <Failure result={rules.resource.failure} retry={rules.reload} />
              ) : (
                <ImagePicker
                  portal={portal}
                  rules={rules.resource.data}
                  imageId={draft.imageId}
                  onChange={(id) => set('imageId', id)}
                  onBusy={setUploading}
                />
              )}
              {refused && <p role="alert">{refused}</p>}
              <Actions>
                <Button tone="primary" disabled={!draft.name.trim() || busy || uploading} onClick={() => void save()}>
                  {busy ? t('saving') : t('save')}
                </Button>
              </Actions>
            </div>
          </Section>
        )
      }
    />
  );
}

/**
 * The image field: the owner's rule, checked on the picked file before it is sent, then kept by the service at once.
 * Save waits while an upload runs (`onBusy`), so a product is never saved without the picture just picked.
 */
function ImagePicker({
  portal,
  rules,
  imageId,
  onChange,
  onBusy,
}: {
  portal: PortalApi;
  rules: ProductImageRules;
  imageId: string | null;
  onChange: (imageId: string | null) => void;
  onBusy: (busy: boolean) => void;
}) {
  const { t } = c.useCopy();
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusyState] = useState(false);
  // The picked file shows from the browser's own copy; nothing is fetched back to preview it.
  const [preview, setPreview] = useState<string | null>(null);
  useRelease(preview ?? '', () => void (preview && URL.revokeObjectURL(preview)));
  const setBusy = (value: boolean) => {
    setBusyState(value);
    onBusy(value);
  };
  if (rules.maxBytes === null)
    return (
      <div className="lt-field">
        <span>{t('image')}</span>
        <p className="lt-hint" data-testid="product-image-off">
          {t('imageRulesUnset')}
        </p>
      </div>
    );
  const max = sizeText(rules.maxBytes);
  async function picked(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    const check = checkImage(file, rules);
    if (!check.ok) {
      onChange(null);
      setPreview(null);
      setNote({
        ok: false,
        text:
          check.reason === 'rulesUnset'
            ? t('imageRulesUnset')
            : t(check.reason === 'tooLarge' ? 'imageTooLarge' : 'imageWrongType', { size: sizeText(check.size), max: sizeText(check.max) }),
      });
      return;
    }
    setBusy(true);
    setNote(null);
    try {
      // The request id comes from the file's own bytes: sending the same file again after a lost answer is the same
      // upload, and the service hands back the image it already kept instead of storing a second copy.
      const result = await portal.uploadProductImage({
        requestId: await imageRequestId(file),
        contentType: file.type,
        dataBase64: await base64Of(file),
      });
      if (result.ok) {
        onChange(result.data.imageId);
        setPreview(URL.createObjectURL(file));
        setNote({ ok: true, text: t('imageAdded') });
      } else {
        onChange(null);
        setPreview(null);
        setNote({ ok: false, text: result.message });
      }
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="lt-field">
      <Field
        label={t('image')}
        hint={t('imageRule', { size: max })}
        type="file"
        accept={rules.types.join(',')}
        disabled={busy}
        onChange={(e) => void picked(e)}
      />
      {busy && <p className="lt-hint">{t('imageUploading')}</p>}
      {note && <p role={note.ok ? 'status' : 'alert'}>{note.text}</p>}
      {imageId && (
        <>
          {preview && <img src={preview} alt={t('imagePreviewAlt')} width={160} />}
          <Button
            tone="secondary"
            onClick={() => {
              onChange(null);
              setPreview(null);
              setNote(null);
            }}
          >
            {t('imageRemove')}
          </Button>
        </>
      )}
    </div>
  );
}
