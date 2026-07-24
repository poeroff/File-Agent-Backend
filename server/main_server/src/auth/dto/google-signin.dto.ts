export interface GoogleSignInDto {
  providerAccountId: string;
  email: string;
  name?: string | null;
  image?: string | null;
}
