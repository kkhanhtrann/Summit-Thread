import { useEffect, useId, useRef, useState, type ChangeEvent, type FormEvent } from 'react';

import {
  addTextMaterial,
  deleteMaterial,
  listMaterials,
  uploadPdfMaterial,
  type TalkMaterial
} from './api/materialsApi';

// Match the backend limits so presenters see problems before uploading
const MAX_PDF_BYTES = 25 * 1024 * 1024;
const MAX_TEXT_LENGTH = 50_000;
const MAX_TITLE_LENGTH = 100;

// Describe a material's processing outcome in plain language
function describeStatus(material: TalkMaterial): string {
  if (material.status === 'processing') return 'Processing…';
  if (material.status === 'empty') return 'No extractable text';
  if (material.status === 'failed') return 'Couldn’t process';
  const passages = `${material.passageCount} ${material.passageCount === 1 ? 'passage' : 'passages'}`;
  return material.pageCount ? `Ready · ${passages} from ${material.pageCount} ${material.pageCount === 1 ? 'page' : 'pages'}` : `Ready · ${passages}`;
}

// Derive a readable title from an uploaded file name
function titleFromFile(name: string): string {
  return name.replace(/\.pdf$/i, '').trim().slice(0, MAX_TITLE_LENGTH) || 'Slides';
}

// Let presenters add notes and PDFs that ground private Ask answers and topic wording
export function MaterialsPanel({ sessionId }: { sessionId: string }) {
  const headingId = useId();
  const fileInput = useRef<HTMLInputElement>(null);
  const upload = useRef<AbortController | null>(null);
  const [materials, setMaterials] = useState<TalkMaterial[] | null>(null);
  const [notesTitle, setNotesTitle] = useState('');
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<number | null>(null);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [reloads, setReloads] = useState(0);

  // Reload the list on mount and after failures; ignore responses for an old room
  useEffect(() => {
    const controller = new AbortController();
    listMaterials(sessionId, controller.signal)
      .then((items) => setMaterials(items))
      .catch(() => { if (!controller.signal.aborted) setError('Materials couldn’t be loaded. Try again shortly.'); });
    return () => controller.abort();
  }, [sessionId, reloads]);

  // Cancel an in-flight upload when the presenter leaves the room
  useEffect(() => () => upload.current?.abort(), []);

  // Put a newly stored material at the top of the list
  function accept(material: TalkMaterial, verb: string): void {
    setMaterials((current) => [material, ...(current ?? []).filter((item) => item.id !== material.id)]);
    setMessage(`${material.title} ${verb}. ${describeStatus(material)}.`);
  }

  async function submitNotes(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (busy || !notesTitle.trim() || !notes.trim()) return;
    setBusy(true);
    setError('');
    try {
      accept(await addTextMaterial(sessionId, notesTitle.trim(), notes.trim()), 'added');
      setNotesTitle('');
      setNotes('');
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'The notes couldn’t be added.');
      setReloads((count) => count + 1);
    } finally {
      setBusy(false);
    }
  }

  async function chooseFile(event: ChangeEvent<HTMLInputElement>): Promise<void> {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file || busy) return;
    setError('');
    if (file.type !== 'application/pdf' && !/\.pdf$/i.test(file.name)) {
      setError('Choose a PDF file');
      return;
    }
    if (file.size > MAX_PDF_BYTES) {
      setError('Choose a PDF up to 25 MiB and 300 pages');
      return;
    }
    const controller = new AbortController();
    upload.current = controller;
    setBusy(true);
    setProgress(0);
    try {
      // Send a PDF content type even when the browser reports a blank or generic file type
      const pdf = file.type === 'application/pdf' ? file : new Blob([file], { type: 'application/pdf' });
      accept(await uploadPdfMaterial(sessionId, titleFromFile(file.name), pdf, setProgress, controller.signal), 'uploaded');
    } catch (failure) {
      if (controller.signal.aborted) return;
      setError(failure instanceof Error ? failure.message : 'The PDF couldn’t be uploaded.');
      // Show the failed row the backend kept so it can be removed
      setReloads((count) => count + 1);
    } finally {
      upload.current = null;
      if (!controller.signal.aborted) {
        setBusy(false);
        setProgress(null);
      }
    }
  }

  async function remove(material: TalkMaterial): Promise<void> {
    setError('');
    try {
      await deleteMaterial(sessionId, material.id);
      setMaterials((current) => (current ?? []).filter((item) => item.id !== material.id));
      setMessage(`${material.title} removed.`);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'The material couldn’t be removed.');
    }
  }

  return (
    <section className="talk-materials" aria-labelledby={headingId}>
      <h2 id={headingId}>Talk materials</h2>
      <p className="talk-materials-note">
        Add notes or slides. Attendees’ private questions can cite them, labeled as your materials. Topics use them only for wording, never as something you said.
      </p>

      {materials === null && !error ? <p role="status">Loading materials…</p> : materials && materials.length > 0 ? (
        <ul className="talk-material-list" aria-label="Talk materials">
          {materials.map((material) => (
            <li key={material.id} className={`talk-material is-${material.status}`}>
              <span className="talk-material-title">{material.title}</span>
              <span className="talk-material-meta">{material.kind === 'pdf' ? 'PDF' : 'Notes'} · {describeStatus(material)}</span>
              <button className="text-action" type="button" aria-label={`Remove ${material.title}`} onClick={() => void remove(material)}>
                Remove
              </button>
            </li>
          ))}
        </ul>
      ) : materials ? <p className="talk-materials-empty">No materials yet.</p> : null}

      <div className="talk-material-upload">
        <label htmlFor={`${headingId}-pdf`}>PDF slides or handout</label>
        <input
          ref={fileInput}
          id={`${headingId}-pdf`}
          type="file"
          accept="application/pdf,.pdf"
          disabled={busy}
          onChange={(event) => void chooseFile(event)}
        />
        <p className="talk-materials-hint">Up to 25 MiB and 300 pages. Scanned pages without text can’t be read.</p>
        {progress !== null && <progress max={1} value={progress} aria-label="PDF upload progress" />}
      </div>

      <form className="talk-material-notes" onSubmit={(event) => void submitNotes(event)}>
        <label htmlFor={`${headingId}-title`}>Notes title</label>
        <input
          id={`${headingId}-title`}
          type="text"
          maxLength={MAX_TITLE_LENGTH}
          value={notesTitle}
          disabled={busy}
          onChange={(event) => setNotesTitle(event.target.value)}
        />
        <label htmlFor={`${headingId}-notes`}>Notes</label>
        <textarea
          id={`${headingId}-notes`}
          rows={4}
          maxLength={MAX_TEXT_LENGTH}
          value={notes}
          disabled={busy}
          onChange={(event) => setNotes(event.target.value)}
        />
        <button className="button button-outline" type="submit" disabled={busy || !notesTitle.trim() || !notes.trim()}>
          Add notes
        </button>
      </form>

      {error && <p className="inline-error" role="alert">{error}</p>}
      <p className="sr-only" role="status" aria-live="polite">{message}</p>
    </section>
  );
}
