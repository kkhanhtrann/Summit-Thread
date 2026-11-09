import '@fontsource-variable/source-sans-3/wght.css';
import '@fontsource-variable/bricolage-grotesque/opsz.css';
import './shared/styles/tokens.css';
import './styles.css';
import { createRoot } from 'react-dom/client';
import { setupBrowserTelemetry } from './platform/telemetry/setup';
setupBrowserTelemetry();
void import('./app/App').then(({ App }) => {
  createRoot(document.getElementById('root')!).render(<App />);
});
