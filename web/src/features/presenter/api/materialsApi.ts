import type { components } from '../../../lib/api/generated';
import { requestJson, uploadBinary } from '../../../lib/api/http';

// Describe one presenter material without its text
export type TalkMaterial = components['schemas']['Material'];

// Build the room-scoped materials route
function materialsUrl(sessionId: string): string {
  return `/api/sessions/${encodeURIComponent(sessionId)}/materials`;
}

// List a room's materials and their processing status
export async function listMaterials(sessionId: string, signal?: AbortSignal): Promise<TalkMaterial[]> {
  const response = await requestJson<components['schemas']['MaterialList']>(materialsUrl(sessionId), { signal });
  return response.materials;
}

// Store pasted notes as presenter context
export async function addTextMaterial(sessionId: string, title: string, text: string): Promise<TalkMaterial> {
  const response = await requestJson<components['schemas']['MaterialResponse']>(materialsUrl(sessionId), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title, text } satisfies components['schemas']['CreateTextMaterialRequest'])
  });
  return response.material;
}

// Upload a PDF with byte progress; the title travels percent-encoded in a header
export async function uploadPdfMaterial(
  sessionId: string,
  title: string,
  file: Blob,
  onProgress: (ratio: number) => void,
  signal?: AbortSignal
): Promise<TalkMaterial> {
  const response = await uploadBinary<components['schemas']['MaterialResponse']>(
    `${materialsUrl(sessionId)}/pdf`,
    file,
    onProgress,
    { 'X-Material-Title': encodeURIComponent(title) },
    signal
  );
  return response.material;
}

// Remove a material and its search documents
export async function deleteMaterial(sessionId: string, materialId: string): Promise<void> {
  await requestJson<null>(`${materialsUrl(sessionId)}/${encodeURIComponent(materialId)}`, { method: 'DELETE' });
}
