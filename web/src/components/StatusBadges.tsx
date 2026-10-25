import type { LinkStatus, ProposalStatus, RequestStatus, Revision } from '../api/types';
import {
  LINK_STATUS, LINK_TONE, PROPOSAL_STATUS, PROPOSAL_TONE, REQUEST_STATUS, REQUEST_TONE, REVISION_STATUS, REVISION_TONE,
} from '../labels';
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
export const RequestBadge = ({ status }: { status: RequestStatus }) =>
  <Badge tone={REQUEST_TONE[status]}>{REQUEST_STATUS[status]}</Badge>;
export const ProposalBadge = ({ status }: { status: ProposalStatus }) =>
  <Badge tone={PROPOSAL_TONE[status]}>{PROPOSAL_STATUS[status]}</Badge>;
export const LinkBadge = ({ status }: { status: LinkStatus }) =>
  <Badge tone={LINK_TONE[status]}>{LINK_STATUS[status]}</Badge>;
