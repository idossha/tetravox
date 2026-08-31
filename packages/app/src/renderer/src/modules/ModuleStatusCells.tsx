/**
 * A module's status-bar cell (§13.3).
 *
 * Mounted **before** the dataset cells, and that ordering is measured rather than aesthetic: two
 * BIDS-named datasets already overflow the status strip, which does not scroll (`tvx-strip`), and
 * `ml-auto` cannot pull a cell back inside a container that has overflowed. A cell added after them
 * would simply not be on screen in the case a module is most likely to be used in.
 *
 * Renders nothing when no module has anything to say, so the strip is unchanged while the slot is
 * idle — and a module that clears its status with `host.ui.status(null)` really does get its cell
 * back rather than an empty gap.
 */

import { useUi } from '../ui/context';
import { manifestFor } from '../../../modules/manifests';

/** The cap §13.3 names. A longer status is truncated by CSS as well; this keeps the strip honest. */
const MAX_STATUS_CHARS = 40;

export function ModuleStatusCells(): React.JSX.Element | null {
  const moduleStatus = useUi((s) => s.moduleStatus);
  const entries = Object.entries(moduleStatus).filter(
    (entry): entry is [string, string] => typeof entry[1] === 'string' && entry[1] !== ''
  );
  if (entries.length === 0) return null;

  return (
    <>
      {entries.map(([id, text]) => (
        <span
          key={id}
          data-testid={`status-module-${id}`}
          className="flex shrink-0 items-baseline gap-1"
          title={`${manifestFor(id)?.title ?? id} (§13)`}
        >
          <span className="text-tvx-dim">{manifestFor(id)?.title ?? id}</span>
          <span className="max-w-[16rem] truncate text-tvx-text">
            {text.length > MAX_STATUS_CHARS ? `${text.slice(0, MAX_STATUS_CHARS - 1)}…` : text}
          </span>
        </span>
      ))}
    </>
  );
}
