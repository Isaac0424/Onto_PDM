import type { Revision } from '../api/types';
import { REVISION_STATUS, REVISION_TONE } from '../labels';
import { Badge } from './ui';

export function RevisionBadge({ revision }: { revision?: Revision }) {
  if (!revision) return <span className="faint">—</span>;
  return (
    <span className="row" style={{ gap: 6, flexWrap: 'nowrap' }}>
      <span className="mono">{revision.rev}</span>
      <Badge tone={REVISION_TONE[revision.status]}>{REVISION_STATUS[revision.status]}</Badge>
    </span>
  );
}
