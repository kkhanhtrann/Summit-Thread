import type { paths } from '../../../lib/api/generated';
import { requestJson } from '../../../lib/api/http';
type Health = paths['/api/health/ready']['get']['responses'][200]['content']['application/json'];
// Read the authoritative local dependency status
export function getReadiness() { return requestJson<Health>('/api/health/ready'); }
