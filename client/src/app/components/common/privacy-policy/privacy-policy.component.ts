import { Component } from '@angular/core';
import { RouterLink } from '@angular/router';

import { MatCardModule } from '@angular/material/card';
import { MatButtonModule } from '@angular/material/button';

import { Settings } from '../../../app.settings';

@Component({
  selector: 'app-privacy-policy',
  imports: [RouterLink, MatCardModule, MatButtonModule],
  standalone: true,
  templateUrl: './privacy-policy.component.html',
  styleUrl: './privacy-policy.component.scss'
})
export class PrivacyPolicyComponent {
  // app settings
  settings = Settings;
}
