# Remove Authentication Implementation Plan

> **For Hermes:** Use subagent-driven-development skill to implement this plan task-by-task.

**Goal:** Strip all authentication, user management, login pages, and JWT token handling from DrivePod. The app becomes open-access with no login required.

**Architecture:** Remove auth middleware from all backend routes, delete login page/guards/interceptor from frontend, replace token-based audio streaming with open access, and prune auth-related npm dependencies.

**Tech Stack:** Angular 21 frontend, Express/TypeScript backend, Prisma (no User model exists — auth is purely JWT/token-based).

---

## Inventory of what to remove

### Backend (`backend/src/server.ts`)
- Lines 18-20: `import { expressjwt as jwt } from 'express-jwt'`, `import jwksRsa from 'jwks-rsa'`, `import jwtLib from 'jsonwebtoken'`
- Lines 170-235: Auth block — AUTH0_DOMAIN, DEMO_SECRET, DEMO_USER, TokenPayload, Express namespace, isAuthEnabled(), getAuth0JwksHost(), authMiddleware, demoAuthMiddleware, getAuthStrategy(), requireAuth()
- Lines 1607-1638: `POST /api/auth/login`, `GET /api/auth/me`, `POST /api/auth/refresh` endpoints
- All `requireAuth` middleware calls on every API route (~20 routes)
- Lines 2447-2469: `/api/stream/:videoId` JWT token verification (both query param and Bearer header paths)

### Backend (`backend/package.json`)
- Dependencies: `express-jwt`, `jsonwebtoken`, `jwks-rsa`
- DevDependencies: `@types/express-jwt`

### Frontend files to DELETE entirely
- `frontend/src/app/services/auth.service.ts`
- `frontend/src/app/guards/auth.guard.ts`
- `frontend/src/app/interceptors/auth.interceptor.ts`
- `frontend/src/app/login.component.ts`
- `frontend/src/app/login.component.html`

### Frontend (`frontend/src/app/app.routes.ts`)
- Remove login route, authGuard, loginGuard — only AppComponent at root

### Frontend (`frontend/src/app/app.config.ts`)
- Remove `withInterceptors([authInterceptor])` — use plain `provideHttpClient()`

### Frontend (`frontend/src/app/app.component.ts`)
- Line 7: `import { AuthService } from './services/auth.service'`
- Line 86: `authService!: AuthService;`
- Lines 174: `private tokenRefreshInterval: any = null;`
- Lines 311-323: Token refresh on load + 24h interval
- Line 352: `if (this.tokenRefreshInterval) clearInterval(this.tokenRefreshInterval);`
- Lines 1611-1622: `logout()` method
- `tokenParam` construction in audio URL — remove `?token=` from stream URLs

### Frontend (`frontend/src/app/app.component.html`)
- Lines 127-136: Login button and logout button in tab bar

### Frontend (`frontend/package.json`)
- Dependencies: `@auth0/auth0-angular`, `jwt-decode`

### Env vars to remove from docs/skill
- `DEMO_SECRET`, `AUTH0_DOMAIN`, `AUTH0_AUDIENCE`

---

### Task 1: Remove backend auth imports and middleware

**Objective:** Strip JWT/auth imports and the entire auth middleware block from server.ts.

**Files:**
- Modify: `backend/src/server.ts:18-20` (imports)
- Modify: `backend/src/server.ts:170-235` (auth block)

**Step 1: Remove auth imports**

Delete these 3 lines from the import section (~line 18-20):
```typescript
import { expressjwt as jwt } from 'express-jwt';
import jwksRsa from 'jwks-rsa';
import jwtLib from 'jsonwebtoken';
```

**Step 2: Remove the entire auth block (lines 170-235)**

Delete everything from `// === AUTH ===` through the `requireAuth` function, including:
- `AUTH0_DOMAIN`, `AUTH0_AUDIENCE`, `DEMO_SECRET`, `DEMO_USER` constants
- `TokenPayload` interface
- Express namespace declaration
- `isAuthEnabled()`, `getAuth0JwksHost()`
- `authMiddleware` (jwt() call)
- `demoAuthMiddleware`
- `getAuthStrategy()`
- `requireAuth()`

The section starts at `// === AUTH ===` (~line 170) and ends at the closing `}` of `requireAuth` (~line 235).

**Step 3: Verify no remaining references to removed symbols**

Search `backend/src/server.ts` for: `DEMO_SECRET`, `jwtLib`, `requireAuth`, `authMiddleware`, `demoAuthMiddleware`, `jwksRsa`, `TokenPayload` — all should be gone except the usages we will fix in later tasks.

**Verification:** Run `cd backend && npx tsc --noEmit` — should show errors for `requireAuth` on route definitions (expected, next task fixes those).

---

### Task 2: Remove requireAuth from all API routes

**Objective:** Strip `requireAuth` middleware from every route definition in server.ts.

**Files:**
- Modify: `backend/src/server.ts` (all route definitions)

**Step 1: Remove `requireAuth` from every route**

These routes currently have `requireAuth` as a middleware argument. Remove it:

```typescript
// BEFORE:
app.get('/api/harvest-status', requireAuth, (_, res) => ...);
app.get('/api/config', requireAuth, async (_, res) => ...);
app.post('/api/config', requireAuth, async (req, res) => ...);
app.post('/api/cookies', requireAuth, (req, res) => ...);
app.get('/api/channels', requireAuth, async (_, res) => ...);
app.patch('/api/channels/:channelId/active', requireAuth, async (req, res) => ...);
app.post('/api/channels', requireAuth, async (req, res) => ...);
app.delete('/api/channels/:channelId', requireAuth, async (req, res) => ...);
app.post('/api/import', requireAuth, async (req, res) => ...);
app.post('/api/channels/import', requireAuth, async (req, res) => ...);
app.post('/api/channels/reorder', requireAuth, async (req, res) => ...);
app.patch('/api/video/:videoId/progress', requireAuth, async (req, res) => ...);
app.post('/api/video/:videoId/watched', requireAuth, async (req, res) => ...);
app.patch('/api/video/:videoId/watched', requireAuth, async (req, res) => ...);
app.get('/api/player/current', requireAuth, async (_, res) => ...);
app.patch('/api/player/current', requireAuth, async (req, res) => ...);
app.post('/api/purge-all', requireAuth, async (req, res) => ...);
app.patch('/api/video/:videoId/protect', requireAuth, async (req, res) => ...);

// AFTER:
app.get('/api/harvest-status', (_, res) => ...);
// ... same pattern for all routes
```

**Step 2: Verify build**

Run `cd backend && npx tsc --noEmit` — should pass with no errors.

---

### Task 3: Delete auth endpoints

**Objective:** Remove the three auth API endpoints (login, me, refresh).

**Files:**
- Modify: `backend/src/server.ts` (~lines 1607-1638)

**Step 1: Delete these three route blocks:**

```typescript
// DELETE: POST /api/auth/login
app.post('/api/auth/login', (req, res) => { ... });

// DELETE: GET /api/auth/me
app.get('/api/auth/me', requireAuth, (req: Request, res) => { ... });

// DELETE: POST /api/auth/refresh
app.post('/api/auth/refresh', (req: Request, res) => { ... });
```

**Verification:** `grep -n 'auth/login\|auth/me\|auth/refresh' backend/src/server.ts` should return nothing.

---

### Task 4: Open the stream endpoint

**Objective:** Remove JWT token verification from `/api/stream/:videoId` — make it open access.

**Files:**
- Modify: `backend/src/server.ts` (~lines 2447-2472)

**Step 1: Replace the stream endpoint**

Current code (~line 2447):
```typescript
app.get('/api/stream/:videoId', async (req, res) => {
  const video = await prisma.video.findUnique({ where: { videoId: req.params.videoId } });
  if (!video || !fs.existsSync(video.audioPath)) return res.status(404).send('Video not found');

  // Allow query param token for <audio> src URLs (no custom headers)
  if (req.query.token) {
    try {
      jwtLib.verify(req.query.token as string, DEMO_SECRET);
    } catch {
      return res.status(401).send('Unauthorized');
    }
  } else {
    // Fall back to Bearer header for regular API calls
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).send('Unauthorized');
    }
    try {
      jwtLib.verify(authHeader.substring(7), DEMO_SECRET);
    } catch {
      return res.status(401).send('Unauthorized');
    }
  }

  res.sendFile(video.audioPath);
});
```

Replace with:
```typescript
app.get('/api/stream/:videoId', async (req, res) => {
  const video = await prisma.video.findUnique({ where: { videoId: req.params.videoId } });
  if (!video || !fs.existsSync(video.audioPath)) return res.status(404).send('Video not found');
  res.sendFile(video.audioPath);
});
```

**Verification:** `grep -n 'jwtLib\|DEMO_SECRET\|Bearer\|token' backend/src/server.ts` should return nothing.

---

### Task 5: Remove auth npm dependencies from backend

**Objective:** Remove unused auth packages from backend.

**Files:**
- Modify: `backend/package.json`

**Step 1: Remove from dependencies:**
```json
"express-jwt": "^8.5.1",
"jsonwebtoken": "^9.0.3",
"jwks-rsa": "^4.0.1",
```

**Step 2: Remove from devDependencies:**
```json
"@types/express-jwt": "^6.0.4",
```

**Step 3: Reinstall and rebuild**

```bash
cd /mnt/e/projects/drivepod/backend && npm install
npx tsc --noEmit
```

**Verification:** `tsc` passes. No auth-related packages in `node_modules`.

---

### Task 6: Delete frontend auth files

**Objective:** Remove all auth-related frontend files.

**Files to DELETE:**
- `frontend/src/app/services/auth.service.ts`
- `frontend/src/app/guards/auth.guard.ts`
- `frontend/src/app/interceptors/auth.interceptor.ts`
- `frontend/src/app/login.component.ts`
- `frontend/src/app/login.component.html`

**Step 1: Delete the files**

```bash
rm frontend/src/app/services/auth.service.ts
rm frontend/src/app/guards/auth.guard.ts
rm frontend/src/app/interceptors/auth.interceptor.ts
rm frontend/src/app/login.component.ts
rm frontend/src/app/login.component.html
```

**Step 2: Clean up empty directories (if empty)**

```bash
rmdir frontend/src/app/services 2>/dev/null || true
rmdir frontend/src/app/guards 2>/dev/null || true
rmdir frontend/src/app/interceptors 2>/dev/null || true
```

Note: Only remove directories if they're truly empty after deletion. Check first.

---

### Task 7: Simplify app.routes.ts

**Objective:** Remove login route and auth guards — app is always accessible.

**Files:**
- Modify: `frontend/src/app/app.routes.ts`

**Step 1: Replace the entire file**

Before:
```typescript
import { Routes } from '@angular/router';
import { LoginComponent } from './login.component';
import { AppComponent } from './app.component';
import { authGuard, loginGuard } from './guards/auth.guard';

export const routes: Routes = [
  { path: 'login', component: LoginComponent, canActivate: [loginGuard] },
  { path: '', component: AppComponent, canActivate: [authGuard] },
  { path: '**', redirectTo: '' }
];
```

After:
```typescript
import { Routes } from '@angular/router';
import { AppComponent } from './app.component';

export const routes: Routes = [
  { path: '', component: AppComponent },
  { path: '**', redirectTo: '' }
];
```

---

### Task 8: Remove auth interceptor from app.config.ts

**Objective:** Remove the auth interceptor — no more Bearer tokens on requests.

**Files:**
- Modify: `frontend/src/app/app.config.ts`

**Step 1: Replace the file**

Before:
```typescript
import { ApplicationConfig, provideBrowserGlobalErrorListeners } from '@angular/core';
import { provideRouter } from '@angular/router';
import { provideHttpClient, withInterceptors } from '@angular/common/http';

import { routes } from './app.routes';
import { authInterceptor } from './interceptors/auth.interceptor';

export const appConfig: ApplicationConfig = {
  providers: [
    provideBrowserGlobalErrorListeners(),
    provideRouter(routes),
    provideHttpClient(withInterceptors([authInterceptor]))
  ]
};
```

After:
```typescript
import { ApplicationConfig, provideBrowserGlobalErrorListeners } from '@angular/core';
import { provideRouter } from '@angular/router';
import { provideHttpClient } from '@angular/common/http';

import { routes } from './app.routes';

export const appConfig: ApplicationConfig = {
  providers: [
    provideBrowserGlobalErrorListeners(),
    provideRouter(routes),
    provideHttpClient()
  ]
};
```

---

### Task 9: Clean up AppComponent auth code

**Objective:** Remove AuthService injection, token refresh, logout method, and token param from stream URLs.

**Files:**
- Modify: `frontend/src/app/app.component.ts`

**Step 1: Remove AuthService import (line 7)**

Delete:
```typescript
import { AuthService } from './services/auth.service';
```

**Step 2: Remove AuthService injection and tokenRefreshInterval**

Delete line 86:
```typescript
authService!: AuthService;
```

Delete line 174:
```typescript
private tokenRefreshInterval: any = null;
```

**Step 3: Remove token refresh in ngOnInit (lines 311-323)**

Delete this block:
```typescript
    // Refresh auth token silently on load
    this.authService.refreshToken().subscribe({
      next: (resp) => this.authService.saveAuth(resp.token, resp.user),
      error: () => {}
    });

    // Auto-refresh token every 24 hours
    this.tokenRefreshInterval = setInterval(() => {
      this.authService.refreshToken().subscribe({
        next: (resp) => this.authService.saveAuth(resp.token, resp.user),
        error: () => {}
      });
    }, 24 * 60 * 60 * 1000);
```

**Step 4: Remove tokenRefreshInterval cleanup in ngOnDestroy/cleanup**

Find and remove (around line 352):
```typescript
    if (this.tokenRefreshInterval) clearInterval(this.tokenRefreshInterval);
```

Also remove the `tokenRefreshInterval` declaration if not already done.

**Step 5: Remove logout() method (lines 1611-1622)**

Delete the entire method:
```typescript
  logout() {
    // Save progress before stopping
    if (this.currentVideo()) {
      this.saveProgress(this.audio.currentTime);
    }
    // Stop audio and cleanup before navigating
    this.cleanup();
    this.zone.runOutsideAngular(() => {
      this.authService.logout();
      this.router.navigate(['/login']);
    });
  }
```

**Step 6: Remove token from audio stream URLs**

Search for `tokenParam` in the file. It's constructed somewhere and appended to `/api/stream/...` URLs. Remove its construction and its use in URL strings.

The pattern is:
```typescript
// Find wherever tokenParam is built, e.g.:
const tokenParam = this.authService.getToken() ? `&token=${this.authService.getToken()}` : '';
// ...
this.audio.src = `/api/stream/${video.videoId}?bitrate=${this.preferredBitrate()}${monoStr}${tokenParam}`;
```

Replace all stream URL constructions to drop the token param:
```typescript
this.audio.src = `/api/stream/${video.videoId}?bitrate=${this.preferredBitrate()}${monoStr}`;
```

Do this for ALL occurrences (there are ~2 places: `loadAndSeekVideo` and `playVideo`).

**Step 7: Remove unused Router import if no longer needed**

Check if `Router` is still used elsewhere (e.g., `this.router.navigate`). If the only navigate was in logout(), the Router import and injection can be removed. But check — `router` might be used for other navigation.

**Verification:** `grep -n 'auth\|token\|logout' frontend/src/app/app.component.ts` should show no auth-related hits.

---

### Task 10: Remove login/logout buttons from app.component.html

**Objective:** Remove the user and logout buttons from the tab bar.

**Files:**
- Modify: `frontend/src/app/app.component.html` (~lines 127-136)

**Step 1: Delete these two buttons:**

```html
    <button
      (click)="router.navigate(['/login'])"
      class="py-3 px-3 text-sm font-semibold rounded-2xl transition-all text-zinc-400 hover:text-sky-400 hover:bg-sky-900/20">
      👤
    </button>
    <button
      (click)="logout()"
      class="py-3 px-3 text-sm font-semibold rounded-2xl transition-all text-zinc-400 hover:text-red-400 hover:bg-red-900/20">
      🚪
    </button>
```

These are the last two buttons before the closing `</div>` of the tab bar (~line 137).

---

### Task 11: Remove auth npm dependencies from frontend

**Objective:** Remove unused auth packages from frontend.

**Files:**
- Modify: `frontend/package.json`

**Step 1: Remove from dependencies:**
```json
"@auth0/auth0-angular": "^2.9.0",
"jwt-decode": "^4.0.0",
```

**Step 2: Reinstall**

```bash
cd /mnt/e/projects/drivepod/frontend && npm install
```

---

### Task 12: Full build and verify

**Objective:** Build the entire Docker image and confirm it starts cleanly.

**Step 1: Build**

```bash
cd /mnt/e/projects/drivepod && docker compose build && docker compose create --force-recreate && docker compose start
```

**Step 2: Check logs**

```bash
docker compose logs --tail=30 drivepod
```

Should see `DrivePod Backend ready` with no errors. No auth-related warnings.

**Step 3: Test API access without auth**

```bash
curl -s http://localhost:<host_port>/api/config | head -5
```

Should return config JSON (not 401).

**Step 4: Test stream access without auth**

```bash
curl -sI http://localhost:<host_port>/api/stream/<any_video_id>
```

Should return 200 (or 404 if video ID doesn't exist) — never 401.

**Step 5: Verify frontend loads without redirect to /login**

Open the app in browser — should go directly to the main app, no login page.

---

### Task 13: Update documentation and skill

**Objective:** Update README.md and the drivepod-development skill to remove auth references.

**Files:**
- Modify: `README.md` (API endpoints table, features section)
- Modify: `~/.hermes/skills/drivepod-development/SKILL.md` (Authentication System section, auth-related pitfalls)

**Step 1: README.md**

Remove from the API endpoints table:
```
| POST   | `/api/auth/login`               | Login (demo mode only)          |
| GET    | `/api/auth/me`                  | Current user info               |
| POST   | `/api/auth/refresh`             | Refresh token (demo mode only)  |
```

Remove/update any mentions of authentication, login, or user management in the features/future sections.

**Step 2: SKILL.md**

Remove the entire "Authentication System" section (it's long — covers demo mode, Auth0 mode, token refresh, frontend auth flow, RxJS pitfalls).

Remove auth-related entries from Common Pitfalls:
- "Dead code: AuthService.hasAuth0Config() always returns false"
- "NG0203 on logout"
- "Auth stream endpoint" note

Update the "Adding a Backend Endpoint" example to remove `requireAuth` from the pattern.

**Step 3: Verify no dangling references**

```bash
grep -rn 'requireAuth\|DEMO_SECRET\|auth0\|AuthService\|authGuard\|authInterceptor' backend/src/ frontend/src/
```

Should return nothing.
