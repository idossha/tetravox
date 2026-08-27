/**
 * §8's **tissue table** — "name from `$PhysicalNames`, colour swatch, eye, opacity slider — **not a
 * list of checkboxes**", backed by `MeshLayer.tagStyle`. It is the mesh face of maintainer
 * requirement **R5** (region select / mute / recolour), so the row carries everything R5 names: eye,
 * colour picker, opacity, name, id and count, with search, bulk show/hide/invert and Alt-click solo.
 *
 * The row look is intentionally self-contained. `docs/PHASE2-OWNERSHIP.md` asks the two halves of
 * A-PROPS to share a row component **only if one already exists on `main`**; `panels/regions/` is a
 * `null`-returning placeholder there, so there is nothing to reuse and inventing a shared component
 * across two branches would be a merge conflict rather than a saving.
 *
 * Every control is one `Engine.updateLayer` call with a `tagStyle` patch computed by `state.ts`.
 */

import { useMemo, useState } from 'react';
import type { MeshDataset, MeshLayer } from '@tetravox/engine';
import { useController } from '../../../ui/context';
import { NumberField, Row, Section, Swatch } from './controls';
import {
  filterRows,
  hexToVec4,
  invertTagVisibility,
  resetTagColor,
  setTagColor,
  setTagOpacity,
  setTagVisible,
  setTagsVisible,
  soloTag,
  tissueRows,
  vec4ToHex,
} from './state';

export function TissueTable({
  dataset,
  layer,
}: {
  dataset: MeshDataset;
  layer: MeshLayer;
}): React.JSX.Element {
  const controller = useController();
  const [query, setQuery] = useState('');
  const rows = useMemo(() => tissueRows(dataset, layer), [dataset, layer]);
  const shown = useMemo(() => filterRows(rows, query), [rows, query]);
  const shownTags = shown.map((r) => r.tag);
  const hidden = rows.filter((r) => !r.visible).length;

  const patch = (p: Partial<MeshLayer>): void => controller.patchLayer(layer.id, p);

  return (
    <Section
      testId={`mesh-tissue-${layer.id}`}
      title={`Tissues (${rows.length}${hidden > 0 ? `, ${hidden} hidden` : ''})`}
      defaultOpen
    >
      <div className="flex items-center gap-1">
        <input
          type="search"
          data-testid={`mesh-tissue-search-${layer.id}`}
          aria-label="Search tissues"
          placeholder="search…"
          className="tvx-input min-w-0 flex-1 px-1 py-0.5 text-[10px]"
          value={query}
          onPointerDown={(e) => e.stopPropagation()}
          onChange={(e) => setQuery(e.currentTarget.value)}
        />
        <button
          type="button"
          data-testid={`mesh-tissue-showall-${layer.id}`}
          className="tvx-btn tvx-btn-sm"
          title="Show every tag the search left on screen"
          onClick={(e) => {
            e.stopPropagation();
            patch(setTagsVisible(layer, shownTags, true));
          }}
        >
          all
        </button>
        <button
          type="button"
          data-testid={`mesh-tissue-hideall-${layer.id}`}
          className="tvx-btn tvx-btn-sm"
          title="Hide every tag the search left on screen"
          onClick={(e) => {
            e.stopPropagation();
            patch(setTagsVisible(layer, shownTags, false));
          }}
        >
          none
        </button>
        <button
          type="button"
          data-testid={`mesh-tissue-invert-${layer.id}`}
          className="tvx-btn tvx-btn-sm"
          title="Invert visibility"
          onClick={(e) => {
            e.stopPropagation();
            patch(invertTagVisibility(layer, shownTags));
          }}
        >
          inv
        </button>
      </div>

      {shown.length === 0 ? (
        <p data-testid={`mesh-tissue-empty-${layer.id}`} className="text-[10px] text-tvx-dim">
          No tag matches “{query}”.
        </p>
      ) : (
        <div role="list" data-testid={`mesh-tissue-list-${layer.id}`} className="flex flex-col">
          {shown.map((row) => (
            <div
              role="listitem"
              key={row.tag}
              data-testid={`mesh-tag-row-${layer.id}-${row.tag}`}
              data-visible={row.visible}
              data-recoloured={row.recoloured}
              className="flex items-center gap-1 py-0.5"
            >
              <button
                type="button"
                data-testid={`mesh-tag-eye-${layer.id}-${row.tag}`}
                aria-pressed={row.visible}
                aria-label={row.visible ? `Hide ${row.name}` : `Show ${row.name}`}
                title="Click to show/hide · Alt-click to solo"
                className="tvx-btn tvx-btn-sm w-6"
                onClick={(e) => {
                  e.stopPropagation();
                  // R5: Alt-click solos — mute everything else, which is Freeview's gesture.
                  patch(
                    e.altKey
                      ? soloTag(
                          layer,
                          rows.map((r) => r.tag),
                          row.tag
                        )
                      : setTagVisible(layer, row.tag, !row.visible)
                  );
                }}
              >
                {row.visible ? '◉' : '○'}
              </button>
              <Swatch
                testId={`mesh-tag-color-${layer.id}-${row.tag}`}
                hex={vec4ToHex(row.color)}
                title={`Colour of ${row.name}`}
                onChange={(hex) => patch(setTagColor(layer, row.tag, hexToVec4(hex, row.color[3])))}
              />
              {row.recoloured ? (
                <button
                  type="button"
                  data-testid={`mesh-tag-color-reset-${layer.id}-${row.tag}`}
                  className="tvx-btn tvx-btn-sm"
                  title="Back to the file's colour (.msh.opt / §7.6 palette)"
                  onClick={(e) => {
                    e.stopPropagation();
                    patch(resetTagColor(layer, row.tag));
                  }}
                >
                  ↺
                </button>
              ) : null}
              <span
                data-testid={`mesh-tag-name-${layer.id}-${row.tag}`}
                className="min-w-0 flex-1 truncate text-[10px] text-tvx-text"
                title={`${row.name} · tag ${row.tag} · ${row.kind} · ${row.count.toLocaleString()}`}
              >
                {row.name}
              </span>
              <span className="shrink-0 font-mono text-[9px] text-tvx-dim">
                {row.tag} · {row.count.toLocaleString()}
              </span>
              <input
                type="range"
                data-testid={`mesh-tag-opacity-${layer.id}-${row.tag}`}
                aria-label={`Opacity of ${row.name}`}
                min={0}
                max={1}
                step={0.01}
                value={row.opacity}
                className="h-1 w-14 shrink-0 accent-tvx-accent"
                onPointerDown={(e) => e.stopPropagation()}
                onChange={(e) =>
                  patch(setTagOpacity(layer, row.tag, Number(e.currentTarget.value)))
                }
              />
            </div>
          ))}
        </div>
      )}

      <Row label="Solid colour">
        <Swatch
          testId={`mesh-solid-color-${layer.id}`}
          hex={vec4ToHex(layer.solidColor)}
          title="The colour used by colorMode 'solid' and by any tag the file left uncoloured"
          onChange={(hex) => patch({ solidColor: hexToVec4(hex, layer.solidColor[3]) })}
        />
        <span className="flex-1" />
        <span className="shrink-0 text-[10px] text-tvx-dim">alpha</span>
        <NumberField
          testId={`mesh-solid-alpha-${layer.id}`}
          value={layer.solidColor[3]}
          step={0.05}
          min={0}
          max={1}
          onCommit={(a) =>
            patch({
              solidColor: [layer.solidColor[0], layer.solidColor[1], layer.solidColor[2], a],
            })
          }
        />
      </Row>
    </Section>
  );
}
