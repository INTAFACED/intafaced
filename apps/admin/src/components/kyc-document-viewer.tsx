'use client';

import { formatWhen } from '@/lib/as-of';
import { mediaType, savedName, viewableImage, type OpenedDocument } from '@/lib/kyc-documents/document';
import './desk.css';

/**
 * THE KYC DOCUMENT VIEWER. One document identity opened for this founder, shown on the page that asked for it.
 *
 * It is the one viewer for identity's documents: the customer record's documents tab uses it, and so will a KYC case's detail
 * (OPS-cases-07). An image is drawn on the page; any other type (a PDF, say) is offered as a file to save, because this
 * console's security policy embeds no frames or plug-ins. The contents live only in this page while the viewer is open:
 * `onClose` drops them from whatever holds the reply, and opening the document again needs a new approval.
 */
export function KycDocumentViewer({ document, onClose }: { document: OpenedDocument; onClose?: () => void }) {
  const image = viewableImage(document);

  function save() {
    // Saved as plain bytes, never as the stored type, so the browser does not render or run it while saving.
    const bytes = Uint8Array.from(atob(document.bytesBase64), (c) => c.charCodeAt(0));
    const url = URL.createObjectURL(new Blob([bytes], { type: 'application/octet-stream' }));
    const link = window.document.createElement('a');
    link.href = url;
    link.download = savedName(document);
    link.rel = 'noopener';
    window.document.body.appendChild(link);
    link.click();
    link.remove();
    // Some browsers start the download after click() returns, so the URL is released a moment later.
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  return (
    <section className="dk-stack" data-testid="kyc-document-viewer" data-document={document.id} aria-labelledby={`kyc-doc-${document.id}`}>
      <h4 id={`kyc-doc-${document.id}`}>Document {document.id}</h4>
      <dl className="dk-kv">
        <div className="dk-kv-row">
          <dt>Type</dt>
          <dd>{document.contentType}</dd>
        </div>
        <div className="dk-kv-row">
          <dt>Size (bytes)</dt>
          <dd>{document.byteLength}</dd>
        </div>
        <div className="dk-kv-row">
          <dt>Stored</dt>
          <dd>{formatWhen(document.createdAt)}</dd>
        </div>
      </dl>
      {image ? (
        // A plain image, not next/image: the bytes are already in the page and must not go to an image optimiser.
        <img
          src={`data:${mediaType(document.contentType)};base64,${document.bytesBase64}`}
          alt={`KYC document ${document.id}`}
          data-testid="kyc-document-image"
          className="dk-document"
        />
      ) : (
        <div className="adm-callout" data-tone="info" data-testid="kyc-document-file">
          <p>
            This console draws images on the page. A {document.contentType} document is saved to your computer to open there, because the
            console embeds no frames or plug-ins.
          </p>
          <button type="button" className="adm-btn" onClick={save}>
            Save the file
          </button>
        </div>
      )}
      {onClose && (
        <div className="dk-row">
          <button type="button" className="adm-btn" onClick={onClose}>
            Close the document
          </button>
          <span className="dk-muted">Closing drops its contents from this page.</span>
        </div>
      )}
    </section>
  );
}
