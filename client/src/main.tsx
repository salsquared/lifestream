import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { AppRouter } from './shell/router';
import './styles.css';

const container = document.getElementById('root');
if (!container) {
  throw new Error('LIFEstream: #root container is missing from index.html');
}

createRoot(container).render(
  <StrictMode>
    <AppRouter />
  </StrictMode>,
);
