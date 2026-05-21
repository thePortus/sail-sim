import { Injectable } from '@angular/core';
import { ActivatedRouteSnapshot, RouterStateSnapshot, Router } from '@angular/router';
import { Observable } from 'rxjs';
import { AuthService } from './auth.service';

/**
 * AuthGuardService prevents users who are not logged in from accessing certain routes.
 */
@Injectable({
  providedIn: 'root'
})
export class AuthGuardService {

  constructor(
    private _authService: AuthService,
    private _router: Router
  ) { }

  /**
   * Returns true if user is logged in. Middleware function to prevent
   * users who are not logged in from accessing certain routes.
   * 
   * @param next - Snapshot of desired route change
   * @param state - Snapshot of current route
   * @returns Boolean t/f whether user is logged in (and can thus change to router state)
   */
  canActivate(next: ActivatedRouteSnapshot, state: RouterStateSnapshot): Observable<boolean> | Promise<boolean> | boolean {
    if (this._authService.getToken()) {
      return true;
    }

    // navigate to login page
    this._router.navigate(['/login']);
    return false;
  }
}
