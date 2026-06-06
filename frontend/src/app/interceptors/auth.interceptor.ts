import { HttpInterceptorFn, HttpRequest, HttpHandlerFn, HttpErrorResponse } from '@angular/common/http';
import { inject } from '@angular/core';
import { Router } from '@angular/router';
import { catchError, throwError, switchMap, of, finalize } from 'rxjs';

const TOKEN_KEY='drivepod_token';
const USER_KEY = 'drivepod_user';

let redirecting = false;

const clearAuth = () => {
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(USER_KEY);
};

const refreshToken = (token: string) => {
  return fetch('/api/auth/refresh', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` }
  }).then(res => {
    if (!res.ok) throw new Error('Refresh failed');
    return res.json();
  });
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
          // Try to refresh the token before giving up
          return of(null).pipe(
            switchMap(() => refreshToken(token)),
            switchMap((data: any) => {
              localStorage.setItem(TOKEN_KEY, data.token);
              if (data.user) localStorage.setItem(USER_KEY, JSON.stringify(data.user));
              // Retry the original request with the new token
              const retried = req.clone({
                setHeaders: { Authorization: `Bearer ${data.token}` }
              });
              return next(retried).pipe(finalize(() => { redirecting = false; }));
            }),
            catchError(() => {
              clearAuth();
              router.navigate(['/login']).finally(() => { redirecting = false; });
              return throwError(() => error);
            })
          );
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
