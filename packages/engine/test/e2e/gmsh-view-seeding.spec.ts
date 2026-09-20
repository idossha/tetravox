import { expect, test } from '@playwright/test';

const geometry = `$MeshFormat
2.2 0 8
$EndMeshFormat
$Nodes
3
1 0 0 0
2 10 0 0
3 0 10 0
$EndNodes
$Elements
1
1 2 0 1 2 3
$EndElements
`;
function field(kind: string, name: string): string {
  return `$${kind}\n1\n"${name}"\n1\n0\n3\n0\n1\n1\n1 7\n$End${kind}\n`;
}

test('mixed-source Gmsh views retain identity and explicit caller settings win', async ({
  page,
}) => {
  await page.goto('/test/pages/scene.html');
  await page.waitForFunction(() => window.__tvxEngine !== undefined);
  const result = await page.evaluate(
    async (text) => {
      const engine = window.__tvxEngine!;
      const encode = (s: string) => new TextEncoder().encode(s).buffer;
      const ds = await engine.addDataset({
        kind: 'bytes',
        name: 'mixed.msh',
        bytes: encode(text),
        sidecars: {
          opt: encode(
            'View[0].Visible=1; View[1].Visible=0; View[0].RangeType=2; View[0].CustomMin=0; View[0].CustomMax=10; View[0].ColormapNumber=23; View[0].ColormapAlphaPower=0.5;'.replaceAll(
              ';',
              ';\n'
            )
          ),
        },
      });
      if (ds.kind !== 'mesh') throw new Error('mesh required');
      const seeded = engine.addLayer({ datasetId: ds.id, kind: 'mesh' });
      const explicit = engine.addLayer({
        datasetId: ds.id,
        kind: 'mesh',
        colorMode: 'field',
        field: { source: 'node', name: 'node', component: 'mag' },
        colormap: 'gray',
        scale: { kind: 'linear', lo: -3, hi: 3 },
        threshold: { lo: 2, hi: 5, mode: 'hide', symmetric: false, softEdge: 0.1 },
      });
      return {
        fields: ds.fields.map((f) => [f.source, f.name, f.gmshViewIndex]),
        seeded,
        explicit,
      };
    },
    geometry + field('ElementData', 'element') + field('NodeData', 'node')
  );
  expect(result.fields).toEqual([
    ['node', 'node', 1],
    ['elm', 'element', 0],
  ]);
  expect(result.seeded).toMatchObject({
    field: { source: 'elm', name: 'element' },
    colormap: 'viridis',
    threshold: { mode: 'clamp' },
  });
  expect(result.explicit).toMatchObject({
    field: { source: 'node', name: 'node' },
    colormap: 'gray',
    scale: { lo: -3, hi: 3 },
    threshold: { lo: 2, hi: 5, mode: 'hide', softEdge: 0.1 },
  });
});
