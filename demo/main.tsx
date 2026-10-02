import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
// The kit stylesheet is imported here directly: the kit's barrel (`./stand/ui`) is tree-shaken away
// in production builds (package.json `sideEffects` does not list CSS), which would drop its CSS.
// It must come before app.css so the stand layout can override kit defaults.
import './stand/ui/ui.css';
import { App } from './App';
import './app.css';

const DOCS_URL = 'https://github.com/supsad/lumicells/tree/main/docs';
const REPO_URL = 'https://github.com/supsad/lumicells';

/**
 * A one-line footer under the stand: the page's h1 and a short description stay in the rendered
 * DOM after React replaces the static block of index.html (search engines index that DOM). Styled
 * in index.html (`.lc-about`), next to the static block it replaces.
 */
function About() {
  return (
    <footer className="lc-about">
      <h1 className="lc-about__name">LumiCells</h1>
      <p className="lc-about__text">
        A live WebGL2 neon pixel-grid animated background for the web: a React component, a{' '}
        <code>&lt;lumi-cells&gt;</code> Web Component or plain TypeScript.
      </p>
      <nav className="lc-about__links" aria-label="LumiCells">
        <a href={DOCS_URL}>Documentation</a>
        <a href={REPO_URL}>GitHub</a>
        <span>MIT</span>
      </nav>
    </footer>
  );
}

const root = document.getElementById('root');
if (root) {
  createRoot(root).render(
    <StrictMode>
      <App />
      <About />
    </StrictMode>,
  );
}
