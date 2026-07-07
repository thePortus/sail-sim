import { Component } from '@angular/core';

import { Settings } from '../../app.settings';

/**
 * "Download native client" block for the home / login / register pages. Links to the server's
 * /download/:platform route (streams the newest published build). The button matching the visitor's OS is
 * highlighted; both are always available.
 */
@Component({
  selector: 'app-download-client',
  standalone: true,
  template: `
    <div class="download-native">
      <h3>Download the desktop client</h3>
      <p>A faster native build for macOS &amp; Windows — auto-updates itself.</p>
      <div class="download-links">
        <a class="dl-btn" [class.primary]="isMac" [href]="macUrl">⬇ macOS</a>
        <a class="dl-btn" [class.primary]="isWindows" [href]="winUrl">⬇ Windows</a>
      </div>
    </div>
  `,
  styles: [`
    .download-native { margin: 1.25rem 0; text-align: center; }
    .download-native h3 { margin: 0 0 .25rem; font-size: 1rem; }
    .download-native p { margin: 0 0 .6rem; opacity: .8; font-size: .85rem; }
    .download-links { display: flex; gap: .6rem; justify-content: center; flex-wrap: wrap; }
    .dl-btn { padding: .5rem 1rem; border-radius: .5rem; border: 1px solid rgba(255,255,255,.25);
              text-decoration: none; color: inherit; font-weight: 600; }
    .dl-btn.primary { border-color: #4aa3ff; box-shadow: 0 0 0 1px #4aa3ff inset; }
    .dl-btn:hover { background: rgba(255,255,255,.08); }
  `],
})
export class DownloadClientComponent {
  readonly macUrl = Settings.apiUrl + 'download/mac';
  readonly winUrl = Settings.apiUrl + 'download/win';
  get isWindows(): boolean { return /Win/i.test(navigator.userAgent); }
  get isMac(): boolean { return /Mac/i.test(navigator.userAgent); }
}
