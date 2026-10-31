/**
 * A field's display label with §4.4's `X_{sub}` markup as a real subscript. A label without the
 * markup, and a bare field name, render exactly as written.
 */

import { labelParts } from '@tetravox/engine';

export function FieldText({ label }: { label: string }): React.JSX.Element {
  return <>{labelParts(label).map((p, i) => (p.sub ? <sub key={i}>{p.text}</sub> : p.text))}</>;
}
