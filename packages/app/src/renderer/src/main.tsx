import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { loadInstalledManifests } from './modules/installedBoot';
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
void loadInstalledManifests().then(render, render);
