import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable } from 'rxjs';
import { Settings } from '../../app.settings';

/**
 * Thin HTTP wrapper around the admin weather / time-of-day override endpoints.
 *
 * All routes require a valid JWT with role admin|owner — the server returns 403
 * for anyone else.  The admin panel reads the role from localStorage before
 * even rendering so non-admins never see the controls.
 *
 * Server routes (from weather.routes.js):
 *   POST   /api/weather/override        { windSpeed, fromBearingDeg }
 *   DELETE /api/weather/override
 *   POST   /api/weather/time-offset     { offsetSecs }
 *   DELETE /api/weather/time-offset
 */
@Injectable({ providedIn: 'root' })
export class AdminService {
  private http = inject(HttpClient);

  setWeatherOverride(windSpeed: number, fromBearingDeg: number): Observable<any> {
    return this.http.post(`${Settings.apiUrl}weather/override`, { windSpeed, fromBearingDeg });
  }

  clearWeatherOverride(): Observable<any> {
    return this.http.delete(`${Settings.apiUrl}weather/override`);
  }

  setTimeOffset(offsetSecs: number): Observable<any> {
    return this.http.post(`${Settings.apiUrl}weather/time-offset`, { offsetSecs });
  }

  clearTimeOffset(): Observable<any> {
    return this.http.delete(`${Settings.apiUrl}weather/time-offset`);
  }
}
