import { MotionRoot } from '@zerodrift/ui';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { App } from './App.js';
import { AuthProvider } from './auth.js';
import './index.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <MotionRoot>
      <BrowserRouter>
        <AuthProvider>
          <App />
        </AuthProvider>
      </BrowserRouter>
    </MotionRoot>
  </StrictMode>,
);
