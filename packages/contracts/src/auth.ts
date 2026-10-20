export interface RegisterRequest {
  username: string;
  password: string;
  inviteCode: string;
  acceptedPrivacyVersion: string;
}

export interface UserIdentity {
  id: string;
  username: string;
}

export interface RegisterResponse {
  id: string;
  username: string;
}

export interface LoginRequest {
  username: string;
  password: string;
}

export interface LoginResponse {
  tokenType: "Bearer";
  accessToken: string;
  expiresAt: string;
  user: UserIdentity;
}

export interface MeResponse {
  id: string;
  username: string;
  defaultProviderProfileId: string | null;
  createdAt: string;
}

export interface ChangePasswordRequest {
  currentPassword: string;
  newPassword: string;
}
