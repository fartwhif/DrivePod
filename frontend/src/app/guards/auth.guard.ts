import { inject } from '@angular/core';
import { CanActivateFn, Router } from '@angular/router';
import { AuthService } from '../services/auth.service';

export const authGuard: CanActivateFn = () => {
  const authService = inject(AuthService);
  const router = inject(Router);

  if (authService.isAuthenticated()) {
    return true;
  }

  // Save the current URL so login can redirect back
  router.navigate(['/login'], { queryParams: { redirect: router.url.split('?')[0] } });
  return false;
};

export const loginGuard: CanActivateFn = () => {
  const authService = inject(AuthService);
  const router = inject(Router);

  // If already logged in, redirect to main app
  if (authService.isAuthenticated()) {
    router.navigate(['/']);
    return false;
  }

  return true;
};
