/** §7.3: explicit tensor interpretation; six frames alone never change the default display. */
import type { VolumeDataset, VolumeLayer } from '@tetravox/engine';

type Tensor = NonNullable<VolumeLayer['tensor']>;

export function TensorControls({
  dataset,
  layer,
  patch,
}: {
  dataset: VolumeDataset;
  layer: VolumeLayer;
  patch: (value: Partial<VolumeLayer>) => void;
}): React.JSX.Element | null {
  if (dataset.nvols !== 6 || !['f32', 'f64'].includes(dataset.dtype)) return null;
  const t = layer.tensor;
  const style = 'tvx-input min-w-0 flex-1 px-1 py-0.5 text-[10px]';
  return (
    <>
      <label className="flex items-center gap-1.5 text-[10px] text-tvx-dim">
        <span className="w-16 shrink-0">Display</span>
        <select
          className={style}
          aria-label="Volume display"
          value={t === undefined ? 'scalar' : t.order}
          onChange={(e) => {
            const order = e.currentTarget.value;
            patch({
              tensor:
                order === 'scalar'
                  ? undefined
                  : {
                      order: order as Tensor['order'],
                      basis: order === 'fsl' ? 'fsl' : 'voxel',
                      stride: t?.stride ?? 2,
                      minFA: t?.minFA ?? 0,
                    },
            });
          }}
        >
          <option value="scalar">Scalar frames</option>
          <option value="fsl">Tensor · FSL / SimNIBS</option>
          <option value="nifti">Tensor · NIfTI symmetric matrix</option>
        </select>
      </label>
      {t !== undefined && (
        <>
          <label className="flex items-center gap-1.5 text-[10px] text-tvx-dim">
            <span className="w-16 shrink-0">Axes</span>
            <select
              className={style}
              aria-label="Tensor coordinate basis"
              value={t.basis}
              onChange={(e) =>
                patch({ tensor: { ...t, basis: e.currentTarget.value as Tensor['basis'] } })
              }
            >
              <option value="fsl">FSL scaled voxel axes</option>
              <option value="voxel">Voxel axes</option>
              <option value="world">World RAS axes</option>
            </select>
          </label>
          <label className="flex items-center gap-1.5 text-[10px] text-tvx-dim">
            <span className="w-16 shrink-0">Spacing</span>
            <select
              className={style}
              aria-label="Tensor glyph spacing"
              value={t.stride}
              onChange={(e) =>
                patch({
                  tensor: { ...t, stride: Number(e.currentTarget.value) as Tensor['stride'] },
                })
              }
            >
              {[1, 2, 4, 8].map((stride) => (
                <option key={stride} value={stride}>
                  {stride} voxel{stride === 1 ? '' : 's'}
                </option>
              ))}
            </select>
          </label>
          <label className="flex items-center gap-1.5 text-[10px] text-tvx-dim">
            <span className="w-16 shrink-0">Min FA</span>
            <input
              className="min-w-0 flex-1 accent-tvx-accent"
              type="range"
              aria-label="Minimum tensor FA"
              min={0}
              max={1}
              step={0.01}
              value={t.minFA}
              onChange={(e) => patch({ tensor: { ...t, minFA: Number(e.currentTarget.value) } })}
            />
            <span>{t.minFA.toFixed(2)}</span>
          </label>
          <label className="flex items-center gap-1.5 text-[10px] text-tvx-dim">
            <input
              type="checkbox"
              checked={layer.showIn3D}
              onChange={(e) => patch({ showIn3D: e.currentTarget.checked })}
            />
            Show tensor slices in 3D
          </label>
          <p className="text-[10px] text-tvx-dim">
            Ellipsoids · red L/R · green A/P · blue S/I. Zoom in to inspect shape. Non-positive
            tensors are hidden.
          </p>
        </>
      )}
    </>
  );
}
