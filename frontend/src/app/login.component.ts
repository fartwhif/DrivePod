import { Component, inject, signal, OnInit } from '@angular/core';
import { Router, ActivatedRoute } from '@angular/router';
import { FormsModule } from '@angular/forms';
import { CommonModule } from '@angular/common';
import { AuthService, LoginCredentials, LoginResponse } from './services/auth.service';

@Component({
  selector: 'app-login',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './login.component.html',
  styleUrls: []
})
export class LoginComponent implements OnInit {
  private authService = inject(AuthService);
  private router = inject(Router);
  private route = inject(ActivatedRoute);

  username = 'admin';
  password = 'demo123';
  error = '';
  loading = false;
  private redirectUrl = '/';

  ngOnInit() {
    this.route.queryParams.subscribe(params => {
      this.redirectUrl = params['redirect'] || '/';
    });
  }

  onSubmit() {
    this.error = '';
    this.loading = true;

    const credentials: LoginCredentials = {
      username: this.username,
      password: this.password
    };

    this.authService.login(credentials).subscribe({
      next: (response: LoginResponse) => {
        this.authService.saveAuth(response.token, response.user);
        this.router.navigate([this.redirectUrl]);
      },
      error: (err: any) => {
        this.error = err.error?.error || 'Login failed';
        this.loading = false;
      }
    });
  }
}
