/**
 * The host's confirm dialog — `DialogKind 'confirm'` (§8, §13.3).
 *
 * Two or three buttons over a question, resolving a promise the controller holds. It is the first
 * dialog in the app that *asks* rather than *configures*, which is why it exists at all: the discard
 * guard and `host.ui.confirm` both need an answer before the gesture that raised them can carry on,
 * and `window.confirm` is not available under a `default-src 'none'` renderer that must stay
 * themed and testable.
 *
 * **The last button is the cancelling one**, always. `DialogFrame` already routes Escape and a
 * backdrop click to `onCancel`, so wiring that to the last index is what makes "press Escape" and
 * "press Cancel" the same answer — and why a question is written with its safe answer last.
 */

import { DialogFrame } from './dialog';
import type { ConfirmRequest } from '../store/store';

export interface ConfirmDialogProps {
  request: ConfirmRequest;
  onChoose(choice: 0 | 1 | 2): void;
}

export function ConfirmDialog({ request, onChoose }: ConfirmDialogProps): React.JSX.Element {
  const cancel = (request.buttons.length - 1) as 0 | 1 | 2;
  return (
    <DialogFrame
      testId="confirm-dialog"
      title={request.title}
      width="26rem"
      onCancel={() => onChoose(cancel)}
      footer={
        <div className="ml-auto flex items-center gap-2">
          {request.buttons.map((label, index) => (
            <button
              key={label}
              type="button"
              data-testid={`confirm-button-${index}`}
              // The **first** button is the affirmative one and carries the accent, matching the
              // order the question is written in ("Save…, Discard, Cancel").
              className={index === 0 ? 'tvx-btn tvx-btn-on' : 'tvx-btn'}
              autoFocus={index === 0}
              onClick={() => onChoose(index as 0 | 1 | 2)}
            >
              {label}
            </button>
          ))}
        </div>
      }
    >
      <p data-testid="confirm-body" className="text-[11px] text-tvx-text">
        {request.body}
      </p>
    </DialogFrame>
  );
}
