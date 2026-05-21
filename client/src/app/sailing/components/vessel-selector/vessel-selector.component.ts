import { Component, OnInit, output, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { HttpClient } from '@angular/common/http';
import { Router } from '@angular/router';
import { VesselSummary } from '../../models';
import { Settings } from '../../../app.settings';
import { UserService } from '../../../services/user.service';

@Component({
  selector: 'app-vessel-selector',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './vessel-selector.component.html',
})
export class VesselSelectorComponent implements OnInit {
  private http        = inject(HttpClient);
  private router      = inject(Router);
  private userService = inject(UserService);

  vesselSelected = output<{ slug: string; callsign: string }>();

  vessels  = signal<VesselSummary[]>([]);
  selected = signal<VesselSummary | null>(null);
  callsign = signal('Sailor');
  loading  = signal(true);

  ngOnInit(): void {
    this.http.get<VesselSummary[]>(`${Settings.apiUrl}vessels`).subscribe({
      next: (list) => {
        this.vessels.set(list);
        if (list.length > 0) this.selected.set(list[0]);
        this.loading.set(false);
      },
      error: () => this.loading.set(false),
    });
  }

  select(v: VesselSummary): void {
    this.selected.set(v);
  }

  onCallsignInput(e: Event): void {
    this.callsign.set((e.target as HTMLInputElement).value.slice(0, 16) || 'Sailor');
  }

  setSail(): void {
    const slug = this.selected()?.slug;
    if (slug) this.vesselSelected.emit({ slug, callsign: this.callsign() });
  }

  logout(): void {
    this.userService.logout();
    this.router.navigate(['/login']);
  }
}
