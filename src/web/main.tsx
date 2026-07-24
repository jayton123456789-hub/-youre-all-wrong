import '@fontsource/bebas-neue/400.css';
import '@fontsource-variable/space-grotesk';
import './styles.css';

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { App } from './App.js';

const root = document.getElementById('root');
if (!root) throw new Error('The application root is missing.');

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
