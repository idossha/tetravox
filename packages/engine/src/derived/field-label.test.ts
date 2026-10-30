/**
 * §4.4's label markup: `X_{sub}` is the only subscript form. Expectations are the markup's own
 * definition, written out by hand (2026-10-30).
 */

import { describe, expect, it } from 'vitest';
import { labelParts, plainLabel } from './field-label';

describe('field label markup', () => {
  it('splits `X_{sub}` into a base and a subscript', () => {
    expect(labelParts('TI_{max}')).toEqual([
      { text: 'TI', sub: false },
      { text: 'max', sub: true },
    ]);
    expect(labelParts('HF_{rms} (2 ch)')).toEqual([
      { text: 'HF', sub: false },
      { text: 'rms', sub: true },
      { text: ' (2 ch)', sub: false },
    ]);
  });

  it('leaves a bare name and every other underscore or brace literal', () => {
    expect(labelParts('TI_max')).toEqual([{ text: 'TI_max', sub: false }]);
    expect(labelParts('a{b}_c')).toEqual([{ text: 'a{b}_c', sub: false }]);
    expect(labelParts('x_{a{b}}')).toEqual([{ text: 'x_{a{b}}', sub: false }]);
    expect(labelParts('')).toEqual([]);
    expect(labelParts('E_{}')).toEqual([{ text: 'E', sub: false }]);
  });

  it('plain text keeps the underscore', () => {
    expect(plainLabel('TI_{max}')).toBe('TI_max');
    expect(plainLabel('SAR proxy')).toBe('SAR proxy');
  });
});
