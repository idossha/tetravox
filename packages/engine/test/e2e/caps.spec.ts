/**
 * §11, last bullet: "One Phase-0 e2e asserts `Capabilities` is non-null and logs it, so every CI run
 * records which renderer produced the goldens."
 *
 * It also pins the §7.1 `[SwS]` row that the whole golden strategy rests on: the golden authority does
 * **not** have `EXT_texture_norm16`, so every golden takes the R32F branch of the §6.1 payload ladder
 * while the shipping renderer takes R16. If that ever stops being true, the reasoning in §11 changes and
 * this test is where it should surface.
 *
 * The last test is the mirror of that on §11's **second** leg: `chromium-angle` exists to reach the
 * platform GPU, and it has to be able to go wrong out loud. See its own comment.
 */

import { expect, test } from '@playwright/test';

/** §7.1's `isSoftware` rule, restated so the test checks the probe rather than trusting it. */
const RE_SOFTWARE = /SwiftShader|llvmpipe|softpipe/i;

/**
 * `TETRAVOX_ALLOW_SOFTWARE_ANGLE=1` is consent for the `chromium-angle` leg to fall back to software —
 * a runner with no usable GPU. Same shape as `TETRAVOX_REQUIRE_PACKAGED`, opposite default: a skip
 * there needs opting *out* of, because the machine that matters here (a Mac) always has a GPU.
 */
const ALLOW_SOFTWARE = process.env.TETRAVOX_ALLOW_SOFTWARE_ANGLE === '1';

test.describe('§7.1 capability probe', () => {
  test('createContext returns a live WebGL2 context and a complete Capabilities', async ({
    page,
  }, testInfo) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));

    await page.goto('/test/pages/caps.html');
    await page.waitForFunction(() => window.__tvxProbe !== undefined);
    const probe = await page.evaluate(() => window.__tvxProbe);

    expect(errors, `page errors: ${errors.join(' | ')}`).toEqual([]);
    expect(probe).toBeDefined();
    if (probe === undefined) return;

    // §7.1: getContext('webgl2') === null must be a real error, never a white window.
    expect(probe.ok, `probe failed: ${probe.message ?? ''}`).toBe(true);

    const caps = probe.caps;
    const limits = probe.limits;
    expect(caps).toBeDefined();
    expect(limits).toBeDefined();
    if (caps === undefined || limits === undefined) return;

    // Log it, and attach it, so every CI run records which renderer produced that run's goldens.
    const report = JSON.stringify(
      { rendererClass: probe.rendererClass, caps, limits, extensions: probe.supportedExtensions },
      null,
      2
    );
    console.log(`[caps] ${report}`);
    await testInfo.attach('capabilities.json', { body: report, contentType: 'application/json' });

    expect(caps.renderer.length).toBeGreaterThan(0);
    expect(caps.vendor.length).toBeGreaterThan(0);
    expect(caps.isSoftware).toBe(RE_SOFTWARE.test(caps.renderer) || RE_SOFTWARE.test(caps.vendor));

    // WebGL2 core minimums (the "REQUIRED = WebGL2 core only" rule of §7.1). The spec floors are
    // MAX_3D_TEXTURE_SIZE 256, MAX_TEXTURE_SIZE 2048, MAX_DRAW_BUFFERS 4, MAX_TEXTURE_IMAGE_UNITS 16,
    // MAX_VARYING_VECTORS 15. A renderer under any of these cannot run the engine at all.
    expect(caps.max3d).toBeGreaterThanOrEqual(256);
    expect(limits.max3dTextureSize).toBe(caps.max3d);
    expect(limits.maxTextureSize).toBeGreaterThanOrEqual(2048);
    expect(caps.maxDrawBuffers).toBeGreaterThanOrEqual(4);
    expect(caps.maxTextureImageUnits).toBeGreaterThanOrEqual(16);
    expect(caps.maxVaryingVectors).toBeGreaterThanOrEqual(15);
    expect(limits.maxSamples).toBe(caps.maxSamples);

    // §7.0 item 4: the engine picks a sample count from getInternalformatParameter and clamps it to
    // MAX_SAMPLES; 4 is the value both reference renderers report.
    expect(caps.maxSamples).toBeGreaterThanOrEqual(4);

    // maxClipDistances is only meaningful when the extension was actually granted (§7.1: getExtension
    // is a request, not a query).
    if (caps.clipDistance) expect(caps.maxClipDistances).toBeGreaterThanOrEqual(8);
    else expect(caps.maxClipDistances).toBe(0);
  });

  test('the golden authority has no EXT_texture_norm16 (§7.1 [SwS], §11)', async ({ page }) => {
    await page.goto('/test/pages/caps.html');
    await page.waitForFunction(() => window.__tvxProbe !== undefined);
    const probe = await page.evaluate(() => window.__tvxProbe);
    expect(probe?.caps).toBeDefined();
    const caps = probe?.caps;
    if (caps === undefined) return;

    test.skip(!caps.isSoftware, 'not the golden authority; the [SwS] row does not apply');
    expect(probe?.rendererClass).toBe('swiftshader');
    // The consequence §11 spells out: every golden pins the R32F/R8 branch of the §6.1 ladder, and the
    // R16 branch is covered only by paired analytic tests through EngineOptions.forceCaps.
    expect(caps.norm16).toBe(false);
  });

  /**
   * **The `chromium-angle` leg asserts that it is still the GPU leg.**
   *
   * Everything §11 gets from the second leg rests on one unverified premise: that `channel: 'chromium'`
   * without `--enable-unsafe-swiftshader` actually reached ANGLE/Metal on this machine. Nothing used to
   * check it. The two tests above are untagged, so `grep: /@angle/` excluded them and the `[caps]` line
   * in an `--project=chromium-angle` run came from the *other* leg; the only in-suite signal left was
   * `@angle gate 6` **not** skipping — and a silently skipping test is the exact failure mode §11 was
   * written against (Phase 1 shipped that gate with no leg to run it, and the table called it covered).
   * The leg used to have a visible window as an incidental sanity cue; now that it is headless, it has
   * this instead.
   *
   * So: log this leg's own capabilities, and fail if they are the golden authority's. A fallback to
   * SwiftShader here makes the leg *empty* — every `@angle` test either passes vacuously on software or
   * self-skips — and an empty leg must be red, not green. `TETRAVOX_ALLOW_SOFTWARE_ANGLE=1` is the
   * documented way to say "this runner has no GPU, I know".
   */
  test('@angle the second leg reaches the platform GPU, and records which one', async ({
    page,
  }, testInfo) => {
    test.skip(
      testInfo.project.name !== 'chromium-angle',
      'the chromium-angle leg only — the other leg logs its own capabilities above'
    );

    await page.goto('/test/pages/caps.html');
    await page.waitForFunction(() => window.__tvxProbe !== undefined);
    const probe = await page.evaluate(() => window.__tvxProbe);
    expect(probe?.ok, `probe failed: ${probe?.message ?? ''}`).toBe(true);
    const caps = probe?.caps;
    expect(caps).toBeDefined();
    if (probe === undefined || caps === undefined) return;

    // The ANGLE leg's own record, under its own name: `capabilities.json` from the run above is the
    // golden authority's, and the two are meant to differ.
    const report = JSON.stringify(
      { rendererClass: probe.rendererClass, caps, limits: probe.limits },
      null,
      2
    );
    console.log(`[caps chromium-angle] ${report}`);
    await testInfo.attach('capabilities-angle.json', {
      body: report,
      contentType: 'application/json',
    });

    const fallback =
      `the chromium-angle leg is running on a SOFTWARE renderer (${caps.renderer}). ` +
      'It exists to reach the platform GPU: on software every @angle test passes vacuously or ' +
      'self-skips, so the leg is empty rather than green. Set TETRAVOX_ALLOW_SOFTWARE_ANGLE=1 if this ' +
      'runner genuinely has no GPU (docs/TESTING.md §2.1).';
    test.skip(caps.isSoftware && ALLOW_SOFTWARE, `${fallback} Allowed by the env var.`);

    expect(caps.isSoftware, fallback).toBe(false);
    expect(probe.rendererClass).toBe('angle-metal');
    // The one capability the leg is *for*: without it `@angle gate 6`'s R16 branch skips itself and the
    // §6.1 primary format path goes back to being covered nowhere (§7.1 [SwS], §2.1).
    expect(
      caps.norm16,
      'this GPU reports no EXT_texture_norm16, so the R16 branch of the §6.1 ladder cannot run here'
    ).toBe(true);
  });
});
