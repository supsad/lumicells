import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
// The kit stylesheet is imported here directly: the kit's barrel (`./stand/ui`) is tree-shaken away
// in production builds (package.json `sideEffects` does not list CSS), which would drop its CSS.
// It must come before app.css so the stand layout can override kit defaults.
import './stand/ui/ui.css';
import { App } from './App';
import './app.css';

const root = document.getElementById('root');
if (root) {
  createRoot(root).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}
