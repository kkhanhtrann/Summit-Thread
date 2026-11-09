import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { MaterialsPanel } from './MaterialsPanel';
import type { TalkMaterial } from './api/materialsApi';

const api = vi.hoisted(() => ({ list: vi.fn(), addText: vi.fn(), uploadPdf: vi.fn(), remove: vi.fn() }));
vi.mock('./api/materialsApi', () => ({
  listMaterials: api.list,
  addTextMaterial: api.addText,
  uploadPdfMaterial: api.uploadPdf,
  deleteMaterial: api.remove
}));

// Synthetic test fixture: presenter-visible materials without text
function material(patch: Partial<TalkMaterial>): TalkMaterial {
  return { id: 'm-1', kind: 'text', title: 'Fixture notes', status: 'ready', pageCount: null, passageCount: 2, createdAt: '2026-11-09T00:00:00.000Z', ...patch };
}

describe('MaterialsPanel', () => {
  afterEach(cleanup);
  beforeEach(() => {
    for (const mock of Object.values(api)) mock.mockReset();
    api.list.mockResolvedValue([]);
  });

  it('lists materials with a readable status for each', async () => {
    api.list.mockResolvedValue([
      material({ id: 'a', title: 'Fixture notes', status: 'ready', passageCount: 2 }),
      material({ id: 'b', kind: 'pdf', title: 'Fixture scan', status: 'empty', pageCount: 3, passageCount: 0 }),
      material({ id: 'c', kind: 'pdf', title: 'Fixture broken', status: 'failed', passageCount: 0 })
    ]);
    render(<MaterialsPanel sessionId="AB12CD34" />);

    const list = await screen.findByRole('list', { name: 'Talk materials' });
    expect(within(list).getByText('Fixture notes').closest('li')).toHaveTextContent('Ready · 2 passages');
    expect(within(list).getByText('Fixture scan').closest('li')).toHaveTextContent('No extractable text');
    expect(within(list).getByText('Fixture broken').closest('li')).toHaveTextContent('Couldn’t process');
    expect(api.list).toHaveBeenCalledWith('AB12CD34', expect.any(AbortSignal));
  });

  it('adds pasted notes and clears the form', async () => {
    api.addText.mockResolvedValue(material({ id: 'new', title: 'Fixture outline', passageCount: 1 }));
    const user = userEvent.setup();
    render(<MaterialsPanel sessionId="AB12CD34" />);

    await user.type(await screen.findByRole('textbox', { name: 'Notes title' }), 'Fixture outline');
    await user.type(screen.getByRole('textbox', { name: 'Notes' }), 'Fixture note about cool roofs.');
    await user.click(screen.getByRole('button', { name: 'Add notes' }));

    expect(api.addText).toHaveBeenCalledWith('AB12CD34', 'Fixture outline', 'Fixture note about cool roofs.');
    expect(await screen.findByText('Fixture outline')).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'Notes' })).toHaveValue('');
  });

  it('uploads a PDF titled from its file name and shows the server status', async () => {
    api.uploadPdf.mockImplementation(async (_room: string, _title: string, _file: Blob, onProgress: (ratio: number) => void) => {
      onProgress(0.5);
      return material({ id: 'pdf', kind: 'pdf', title: 'Fixture slides', pageCount: 4, passageCount: 4 });
    });
    const user = userEvent.setup();
    render(<MaterialsPanel sessionId="AB12CD34" />);

    const file = new File(['%PDF-fixture'], 'Fixture slides.pdf', { type: 'application/pdf' });
    await user.upload(await screen.findByLabelText('PDF slides or handout'), file);

    await waitFor(() => expect(api.uploadPdf).toHaveBeenCalledWith('AB12CD34', 'Fixture slides', file, expect.any(Function), expect.any(AbortSignal)));
    expect(await screen.findByText('Fixture slides')).toBeInTheDocument();
    expect(screen.getByText('Fixture slides').closest('li')).toHaveTextContent('Ready · 4 passages from 4 pages');
  });

  it('sends a .pdf file with a blank browser type as application/pdf', async () => {
    api.uploadPdf.mockResolvedValue(material({ id: 'pdf', kind: 'pdf', title: 'Fixture slides', pageCount: 1, passageCount: 1 }));
    const user = userEvent.setup({ applyAccept: false });
    render(<MaterialsPanel sessionId="AB12CD34" />);

    await user.upload(await screen.findByLabelText('PDF slides or handout'), new File(['%PDF-fixture'], 'Fixture slides.pdf', { type: '' }));

    await waitFor(() => expect(api.uploadPdf).toHaveBeenCalledOnce());
    const sent = api.uploadPdf.mock.calls[0]![2] as Blob;
    expect(sent.type).toBe('application/pdf');
    expect(sent.size).toBe('%PDF-fixture'.length);
  });

  it('rejects a non-PDF file before uploading', async () => {
    const user = userEvent.setup({ applyAccept: false });
    render(<MaterialsPanel sessionId="AB12CD34" />);

    await user.upload(await screen.findByLabelText('PDF slides or handout'), new File(['x'], 'notes.txt', { type: 'text/plain' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Choose a PDF file');
    expect(api.uploadPdf).not.toHaveBeenCalled();
  });

  it('shows the server message when an upload fails and reloads the list', async () => {
    api.uploadPdf.mockRejectedValue(new Error('The PDF could not be read. Export it again or paste its text instead'));
    const user = userEvent.setup();
    render(<MaterialsPanel sessionId="AB12CD34" />);

    await user.upload(await screen.findByLabelText('PDF slides or handout'), new File(['%PDF'], 'bad.pdf', { type: 'application/pdf' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('The PDF could not be read');
    await waitFor(() => expect(api.list).toHaveBeenCalledTimes(2));
  });

  it('removes a material by its accessible name', async () => {
    api.list.mockResolvedValue([material({ id: 'm-1', title: 'Fixture notes' })]);
    api.remove.mockResolvedValue(undefined);
    const user = userEvent.setup();
    render(<MaterialsPanel sessionId="AB12CD34" />);

    await user.click(await screen.findByRole('button', { name: 'Remove Fixture notes' }));

    expect(api.remove).toHaveBeenCalledWith('AB12CD34', 'm-1');
    await waitFor(() => expect(screen.queryByText('Fixture notes')).not.toBeInTheDocument());
  });
});
