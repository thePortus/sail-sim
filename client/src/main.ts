import { bootstrapApplication } from '@angular/platform-browser';
import { appConfig } from './app/app.config';
import { AppComponent } from './app/app.component';
import { environment } from './environments/environment';

bootstrapApplication(AppComponent, appConfig)
  .catch((err) => console.error(err));

// Asset cache (production only): a stale-while-revalidate service worker for the heavy /geometry/ + /images/
// assets so a returning player's load is near-instant. Skipped in dev so the server's ETag revalidation of
// re-exported GLBs keeps working. Registered after load so it never delays first paint.
if (environment.production && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch((err) => console.warn('[sw] registration failed:', err));
  });
}
