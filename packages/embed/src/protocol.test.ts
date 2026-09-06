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
  ENVELOPE_VERSION,
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
      const data = { tvx: ENVELOPE_VERSION, type, id: 'x' };
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

describe('ack', () => {
  // The bug this closes: `setPoints`, `setPointTool` and `setPointSelection` acted and replied with
  // nothing, so a host awaiting a reply — the ordinary "select this electrode, then redraw" shape —
  // waited forever. The end-to-end half is in `embed-points.spec.ts`; what is provable here is that
  // the type exists in both directions' vocabularies and correlates the way every other reply does.
  it('is an embed message and not a host one', () => {
    expect(isEmbedMessage({ tvx: 1, type: 'ack', id: 'r1', of: 'setPoints' })).toBe(true);
    expect(isHostMessage({ tvx: 1, type: 'ack', id: 'r1', of: 'setPoints' })).toBe(false);
  });

  it('carries the request id, like every other reply', () => {
    const reply: EmbedMessage = { tvx: 1, type: 'ack', id: '', of: 'setPoints' };
    expect(withId(reply, { id: 'req-9' })).toEqual({
      tvx: 1,
      type: 'ack',
      id: 'req-9',
      of: 'setPoints',
    });
  });

  it('names a request type the host union actually has', () => {
    // `of` is typed as `HostMessage['type']`; this is the runtime half, so the three senders below
    // cannot drift out of the vocabulary a host switches on.
    for (const of of ['setPoints', 'setPointTool', 'setPointSelection'] as const) {
      expect(HOST_MESSAGE_TYPES).toContain(of);
    }
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

  it('pins the envelope version, which is not the protocol version', () => {
    // The whole compatibility promise in one assertion: `tvx` is 1 and the feature level is 2.
    // Bumping `tvx` would strand every protocol-1 host, which filters on `tvx !== 1` and posts
    // `tvx: 1` — so an additive release would have been unreachable by exactly the hosts the
    // additive promise was made to.
    expect(schema.properties.tvx.const).toBe(ENVELOPE_VERSION);
    expect(ENVELOPE_VERSION).toBe(1);
    expect(PROTOCOL_VERSION).toBe(2);
  });

  it('pins the feature level on `ready.version`, which is what a host reads', () => {
    const ready = schema.definitions.EmbedMessage.oneOf.find(
      (m: { title: string }) => m.title === 'ready'
    ) as { properties: { version: { const: number } } };
    expect(ready.properties.version.const).toBe(PROTOCOL_VERSION);
  });
});

describe('protocol 2 is additive', () => {
  // The compatibility guarantee, asserted rather than assumed: protocol 1's fourteen host types and
  // ten embed types are all still there, in the same order, before anything protocol 2 appended.
  // A reordering is as breaking as a removal for a host that diffs these lists.
  const V1_HOST = [
    'hello',
    'load',
    'setTheme',
    'setLayout',
    'setCursor',
    'setLayerVisible',
    'setLayerOpacity',
    'updateLayer',
    'setActiveLayer',
    'screenshot',
    'serialize',
    'probe',
    'focus',
    'reset',
  ] as const;
  const V1_EMBED = [
    'ready',
    'status',
    'progress',
    'loaded',
    'layers',
    'cursor',
    'probe',
    'screenshot',
    'scene',
    'error',
  ] as const;

  it('keeps every protocol-1 type, in order, and only appends', () => {
    expect(HOST_MESSAGE_TYPES.slice(0, V1_HOST.length)).toEqual([...V1_HOST]);
    expect(EMBED_MESSAGE_TYPES.slice(0, V1_EMBED.length)).toEqual([...V1_EMBED]);
  });

  it('added exactly what protocol 2 documents', () => {
    expect(HOST_MESSAGE_TYPES.slice(V1_HOST.length)).toEqual([
      'setPointTool',
      'setPointSelection',
      'setPoints',
      'setPickEvents',
      'getCamera',
      'setCamera',
    ]);
    // `ack` is protocol 2's too — it landed a day later (2026-09-05), before 2 was ever released,
    // and it is appended after the three the first pass added. Appending is the whole rule: a host
    // may compare this list against its own, so the ORDER is part of the contract and a type added
    // in the middle would silently renumber somebody's index.
    expect(EMBED_MESSAGE_TYPES.slice(V1_EMBED.length)).toEqual([
      'pick',
      'pointTool',
      'camera',
      'ack',
    ]);
  });

  it('still accepts every protocol-1 message on the unchanged envelope', () => {
    // A protocol-1 host posts `{ tvx: 1, … }` and this build must take it, unchanged, for ever.
    for (const type of V1_HOST) {
      const data = { tvx: 1, type };
      expect(acceptMessage({ source: PARENT, origin: 'https://host.example', data }, OPTS)).toEqual(
        data
      );
    }
  });
});
