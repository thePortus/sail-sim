import { Component, OnInit, Output, EventEmitter } from '@angular/core';
import { Router } from '@angular/router';

import { MatToolbarModule } from '@angular/material/toolbar';
import { MatIconModule } from '@angular/material/icon';
import { MatTooltipModule } from '@angular/material/tooltip';

import { Settings } from '../../../app.settings';

@Component({
  selector: 'app-site-header',
  imports: [MatToolbarModule, MatIconModule, MatTooltipModule],
  standalone: true,
  templateUrl: './site-header.component.html',
  styleUrl: './site-header.component.scss'
})
export class SiteHeaderComponent implements OnInit {
  @Output() navMenuToggle = new EventEmitter<string>();
  // general app settings, for title and credit info
  settings = Settings;

  imgs: any = {
    title: 'images/JCD-banner-logo-white-600x86.png',
    iajsWordmark: 'images/IAJS-wordmark-1-line-black-bold.png',
    portalWordmark: 'images/Portal-wordmark-1-line-black.png'
  };


  constructor(
    private _router: Router,
  ) { }

  ngOnInit(): void {
  }

    /**
   * Navigates router to specified path
   * 
   * @param path - URL of desired route
   */
    navigate(path: string) {
      this._router.navigate([path]);
    }
  
    /**
     * Calls event emitter to signal when nav men button was toggled
     */
    toggleNav() {
      this.navMenuToggle.emit();
    }

}
