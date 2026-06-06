import { HttpInterceptorFn, HttpRequest, HttpHandlerFn, HttpErrorResponse } from '@angular/common/http';
import { inject } from '@angular/core';
import { Router } from '@angular/router';
import { catchError, throwError } from 'rxjs';

const TOKEN_KEY = 'drivepod_token';
const USER_KEY = 'drivepod_user';

let redirecting = false;

const clearAuth = () => {
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(USER_KEY);
};

export const authInterceptor: HttpInterceptorFn = (req: HttpRequest<any>, next: HttpHandlerFn) => {
  const token = localStorage.getItem(TOKEN_KEY);
  const router = inject(Router);

  if (token && !req.url.includes('/auth/login')) {
    const cloned = req.clone({
      setHeaders: {
        Authorization: `Bearer ${token}`
      }
    });
    return next(cloned).pipe(
      catchError((error: HttpErrorResponse) => {
        if ((error.status === 401 || error.status === 403) && !redirecting) {
          redirecting = true;
          clearAuth();
          router.navigate(['/login']).finally(() => {
            redirecting = false;
          });
        }
        return throwError(() => error);
      })
    );
  }

  return next(req).pipe(
    catchError((error: HttpErrorResponse) => {
      if ((error.status === 401 || error.status === 403) && !redirecting) {
        redirecting = true;
        clearAuth();
        router.navigate(['/login']).finally(() => {
          redirecting = false;
        });
      }
      return throwError(() => error);
    })
  );
};
