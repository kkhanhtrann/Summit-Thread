import { prisma } from '../src/lib/prisma';
import { ReleasedContentRepository, SessionIndexingWorker } from '../src/features/sessions/public';
import { ElasticsearchCaptionIndex } from '../src/features/search/public';

// Restore search from committed released captions without touching media or AI providers
async function rebuild() {
  const repository = new ReleasedContentRepository(prisma);
  const search = new ElasticsearchCaptionIndex();
  try {
    const enqueued = await repository.enqueueRebuild();
    await new SessionIndexingWorker(repository, search).drain();
    const pending = await prisma.searchIndexJob.count();
    console.log(JSON.stringify({ enqueued, pending }));
    if (pending) process.exitCode = 1;
  } finally { await search.close(); await prisma.$disconnect(); }
}
void rebuild().catch(() => { console.error('Search rebuild could not finish; committed records and pending jobs are retained'); process.exitCode = 1; });
