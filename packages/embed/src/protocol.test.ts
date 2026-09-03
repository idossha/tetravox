/**
 * The trust boundary and the envelope (`protocol.ts`).
 *
 * `acceptMessage` is the only thing standing between a host's scene and any other page that can
 * find this frame, so every branch of it is driven here rather than end to end: an origin check
 * that is only ever exercised by a test which serves both pages from the same origin is a check
 * that has never actually been tested.
 */

import { describe, expect, it } from 'vitest';
import {
  EMBED_MESSAGE_TYPES,
  HOST_MESSAGE_TYPES,
  PROTOCOL_VERSION,
  acceptMessage,
  embedParams,
  isEmbedMessage,
  isHostMessage,
  withId,
  type EmbedMessage,
} from './protocol';
import schema from '../protocol.schema.json' with { type: 'json' };

const PARENT = { name: 'parent' };
const OPTS = { expectedSource: PARENT, hostOrigin: 'https://host.example' };
const HELLO = { tvx: 1, type: 'hello' };

describe('acceptMessage', () => {
  it('accepts a well-formed message from the expected window and origin', () => {
    const got = acceptMessage(
      { source: PARENT, origin: 'https://host.example', data: HELLO },
      OPTS
    );
    expect(got).toEqual(HELLO);
  });

  it('rejects a message from another window on the right origin', () => {
    // A sibling iframe served from the same origin as the host. The origin check alone would pass
    // it, which is exactly why the source check is not optional.
    const got = acceptMessage(
      { source: { name: 'sibling' }, origin: 'https://host.example', data: HELLO },
      OPTS
    );
    expect(got).toBeNull();
  });

  it('rejects the right window on the wrong origin', () => {
    expect(
      acceptMessage({ source: PARENT, origin: 'https://evil.example', data: HELLO }, OPTS)
    ).toBeNull();
  });

  it('rejects a near-miss origin', () => {
    // `https://host.example.evil.com` and `http://host.example` both contain the expected string.
    // The comparison is exact equality, never a prefix or a substring.
    for (const origin of [
      'https://host.example.evil.com',
      'http://host.example',
      'https://host.example:8443',
      'https://host.example/',
    ]) {
      expect(acceptMessage({ source: PARENT, origin, data: HELLO }, OPTS)).toBeNull();
    }
  });

  it('rejects everything when no hostOrigin was configured', () => {
    // A host that forgot the query parameter gets a viewer that renders and ignores it, rather than
    // one that trusts the whole web.
    expect(
      acceptMessage(
        { source: PARENT, origin: 'https://host.example', data: HELLO },
        {
          expectedSource: PARENT,
          hostOrigin: '',
        }
      )
    ).toBeNull();
  });

  it("accepts any origin under '*', but still only the expected window", () => {
    const anyOrigin = { expectedSource: PARENT, hostOrigin: '*' };
    expect(
      acceptMessage({ source: PARENT, origin: 'https://anything.example', data: HELLO }, anyOrigin)
    ).toEqual(HELLO);
    expect(
      acceptMessage(
        { source: { other: true }, origin: 'https://anything.example', data: HELLO },
        anyOrigin
      )
    ).toBeNull();
  });

  it('ignores traffic that is not ours', () => {
    const from = (data: unknown): unknown =>
      acceptMessage({ source: PARENT, origin: 'https://host.example', data }, OPTS);
    // A Vite HMR ping, a devtools bridge, a string, a null, an array, the wrong protocol version.
    expect(from({ type: 'update', updates: [] })).toBeNull();
    expect(from('hello')).toBeNull();
    expect(from(null)).toBeNull();
    expect(from([{ tvx: 1, type: 'hello' }])).toBeNull();
    expect(from({ tvx: 2, type: 'hello' })).toBeNull();
    expect(from({ tvx: '1', type: 'hello' })).toBeNull();
  });

  it('ignores an unknown message type rather than failing', () => {
    // Forward compatibility: a host written against a later build may send something this one has
    // never heard of, and the right answer is to carry on.
    expect(
      acceptMessage(
        { source: PARENT, origin: 'https://host.example', data: { tvx: 1, type: 'teleport' } },
        OPTS
      )
    ).toBeNull();
  });

  it('accepts every documented host message type', () => {
    for (const type of HOST_MESSAGE_TYPES) {
      const data = { tvx: PROTOCOL_VERSION, type, id: 'x' };
      expect(acceptMessage({ source: PARENT, origin: 'https://host.example', data }, OPTS)).toEqual(
        data
      );
    }
  });
});

describe('isHostMessage / isEmbedMessage', () => {
  it('separates the two directions', () => {
    expect(isHostMessage({ tvx: 1, type: 'load' })).toBe(true);
    expect(isHostMessage({ tvx: 1, type: 'loaded' })).toBe(false);
    expect(isEmbedMessage({ tvx: 1, type: 'loaded' })).toBe(true);
    expect(isEmbedMessage({ tvx: 1, type: 'load' })).toBe(false);
  });

  it("shares 'probe' and 'screenshot', which are a request in one direction and a reply in the other", () => {
    expect(isHostMessage({ tvx: 1, type: 'probe' })).toBe(true);
    expect(isEmbedMessage({ tvx: 1, type: 'probe' })).toBe(true);
  });
});

describe('withId', () => {
  it('echoes the request id onto the reply', () => {
    const reply: EmbedMessage = { tvx: 1, type: 'scene', id: '', spec: {} as never };
    expect(withId(reply, { id: 'req-7' }).id).toBe('req-7');
  });

  it('leaves a reply to an id-less request without one', () => {
    // The field means "this answers *that*". Inventing one would tell a host it can correlate
    // something it cannot.
    const reply: EmbedMessage = { tvx: 1, type: 'status', phase: 'idle' };
    expect(withId(reply, {})).not.toHaveProperty('id');
  });
});

describe('embedParams', () => {
  it('reads the two query parameters', () => {
    expect(embedParams('?embed=1&hostOrigin=https%3A%2F%2Fhost.example')).toEqual({
      embed: true,
      hostOrigin: 'https://host.example',
    });
  });

  it('defaults hostOrigin to the empty string, which trusts nobody', () => {
    expect(embedParams('?embed=1')).toEqual({ embed: true, hostOrigin: '' });
  });

  it('is not embed mode without the flag', () => {
    expect(embedParams('').embed).toBe(false);
    expect(embedParams('?embed=0').embed).toBe(false);
  });
});

describe('protocol.schema.json', () => {
  // The schema is the contract for a host that is not TypeScript. These two assertions are what
  // stop it from drifting: a message type added to the union and not to the schema fails here.
  it('lists exactly the host message types the union does', () => {
    const types = schema.definitions.HostMessage.oneOf.map(
      (s: { properties: { type: { const: string } } }) => s.properties.type.const
    );
    expect(types.sort()).toEqual([...HOST_MESSAGE_TYPES].sort());
  });

  it('lists exactly the embed message types the union does', () => {
    const types = schema.definitions.EmbedMessage.oneOf.map(
      (s: { properties: { type: { const: string } } }) => s.properties.type.const
    );
    expect(types.sort()).toEqual([...EMBED_MESSAGE_TYPES].sort());
  });

  it('pins the protocol version', () => {
    expect(schema.properties.tvx.const).toBe(PROTOCOL_VERSION);
  });
});
