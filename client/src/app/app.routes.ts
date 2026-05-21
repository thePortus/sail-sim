import { Routes } from '@angular/router';
import { AuthGuardService } from './services/auth-guard.service';

export const routes: Routes = [
  { path: '', redirectTo: 'home', pathMatch: 'full' },
  {
    path: 'home',
    loadComponent: () => import('./components/home/home.component').then(m => m.HomeComponent)
  },
  {
    path: 'game',
    canActivate: [AuthGuardService],
    loadComponent: () => import('./game/game.component').then(m => m.GameComponent)
  },
  {
    path: 'login',
    loadComponent: () => import('./components/auth/login/login.component').then(m => m.LoginComponent)
  },
  {
    path: 'register',
    loadComponent: () => import('./components/auth/register/register.component').then(m => m.RegisterComponent)
  },
  {
    path: 'profile',
    canActivate: [AuthGuardService],
    loadComponent: () => import('./components/profile/profile.component').then(m => m.ProfileComponent)
  },
  {
    path: 'profile/update',
    canActivate: [AuthGuardService],
    loadComponent: () => import('./components/auth/update/update.component').then(m => m.UpdatePasswordComponent)
  },
  {
    path: '**',
    loadComponent: () => import('./components/common/not-found/not-found.component').then(m => m.NotFoundComponent)
  }
];
