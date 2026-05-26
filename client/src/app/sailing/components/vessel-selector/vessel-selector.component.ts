import { Component, OnInit, output, inject, signal, computed } from '@angular/core';
import { CommonModule } from '@angular/common';
import { HttpClient } from '@angular/common/http';
import { Router } from '@angular/router';
import { toSignal } from '@angular/core/rxjs-interop';
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

  vesselSelected = output<{ slug: string }>();

  vessels  = signal<VesselSummary[]>([]);
  selected = signal<VesselSummary | null>(null);
  loading  = signal(true);

  private user = toSignal(this.userService.user$, {
    initialValue: { username: '', callsign: '', role: '', token: '', loggedIn: false },
  });
  callsign = computed(() => this.user()?.callsign || 'Sailor');

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

  setSail(): void {
    const slug = this.selected()?.slug;
    if (slug) this.vesselSelected.emit({ slug });
  }

  logout(): void {
    this.userService.logout();
    this.router.navigate(['/login']);
  }
}
