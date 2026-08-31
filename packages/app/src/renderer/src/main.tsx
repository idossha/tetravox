import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { loadInstalledManifests } from './modules/installedBoot';
import { installModuleSdk } from './modules/sdk-runtime';
import './index.css';

const root = document.getElementById('root');
if (root === null) throw new Error('#root missing from index.html');

function render(): void {
  createRoot(root as HTMLElement).render(
    <StrictMode>
      <App />
    </StrictMode>
  );
}

/**
 * The installed extensions' manifests, registered **before the first commit** (§13.1, 2026-08-30).
 *
 * `manifestFor` is synchronous and is called while rendering — a layer's owner badge, the module
 * status cells, a toast naming a module — so an installed module has to be known by the time React
 * paints, or every one of those sites would show a bare id and then flicker into a title.
 *
 * It is a single `ipcRenderer.invoke` answered out of an array main built at startup, and
 * `loadInstalledManifests` neither rejects nor hangs (it carries its own timeout), so the cost is
 * one microtask on a launch with no extensions, and the app opens either way.
 */
/**
 * `globalThis.__tetravoxModuleSdk`, before anything can activate a module (§13.8, 2026-08-30).
 *
 * A downloaded module's bundle executes its top level the moment `import()` resolves it, and the
 * inlined SDK shim reads this global *there* — not when `activate` is called. So it is installed
 * synchronously at boot, beside the manifests, rather than lazily inside `activateModule` where it
 * would already be one statement too late.
 */
installModuleSdk();

void loadInstalledManifests().then(render, render);
