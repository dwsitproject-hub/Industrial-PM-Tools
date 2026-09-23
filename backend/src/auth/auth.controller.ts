import {
  BadRequestException, Body, Controller, Get, HttpCode, Param, Post, Req, Res,
} from '@nestjs/common';
import { IsEmail, IsString, MaxLength, MinLength } from 'class-validator';
import { Transform } from 'class-transformer';
import { Request, Response } from 'express';
import {
  AllowWhenMfaPending, AllowWhenMustChangePassword, CurrentUser, JwtUser, Public,
} from '../common/auth.types';
import { Credentials } from '../common/throttle';
import { clearRefreshCookie, REFRESH_COOKIE, setRefreshCookie } from '../common/cookies';
import { AuthService } from './auth.service';
import { MfaService } from './mfa.service';
import { TokensService } from './tokens.service';
import { PrismaService } from '../prisma.service';
import { Authenticated } from '../common/route-policy';

class LoginDto {
  @Transform(({ value }) => (typeof value === 'string' ? value.trim().toLowerCase() : value))
  @IsEmail({}, { message: 'A valid email address is required' }) @MaxLength(200) email!: string;
  @IsString() @MinLength(1) @MaxLength(128) password!: string;
}
class ForgotPasswordDto {
  @Transform(({ value }) => (typeof value === 'string' ? value.trim().toLowerCase() : value))
  @IsEmail({}, { message: 'A valid email address is required' }) @MaxLength(200) email!: string;
}
class TokenPasswordDto {
  @IsString() @MinLength(20) @MaxLength(200) token!: string;
  @IsString() @MaxLength(128) newPassword!: string;
}
class MfaVerifyDto {
  @IsString() @MinLength(10) @MaxLength(1000) mfaToken!: string;
  @IsString() @MinLength(6) @MaxLength(20) code!: string;
}
class MfaCodeDto {
  @IsString() @MinLength(6) @MaxLength(20) code!: string;
}
class MfaDisableDto {
  @IsString() @MaxLength(128) password!: string;
}
class ChangePasswordDto {
  @IsString() currentPassword!: string;
  @IsString() @MaxLength(128) newPassword!: string;
}

@Controller('auth')
export class AuthController {
  constructor(
    private auth: AuthService,
    private mfa: MfaService,
    private tokens: TokensService,
    private prisma: PrismaService,
  ) {}

  private async company(): Promise<string> {
    const ws = await this.prisma.workspace.findFirst({ orderBy: { createdAt: 'asc' } });
    return ws?.company || 'EngPro';
  }

  @Public()
  @Credentials()
  @Post('login')
  @HttpCode(200)
  async login(@Body() dto: LoginDto, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const result = await this.auth.login(dto.email, dto.password, req.ip, req.headers['user-agent']);
    // AR-04: a correct password on an MFA-protected account yields a challenge, not a session.
    // No refresh cookie is set here, so nothing usable exists until the second factor arrives.
    if ('mfaRequired' in result) return { mfaRequired: true, mfaToken: result.mfaToken };
    setRefreshCookie(res, result.refreshToken);
    const full = await this.auth.me(result.user.id);
    return { accessToken: result.accessToken, ...full };
  }

  @Public()
  @Credentials()
  @Post('mfa/verify')
  @HttpCode(200)
  async verifyMfa(@Body() dto: MfaVerifyDto, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const { accessToken, refreshToken, user } = await this.auth.completeMfa(
      dto.mfaToken, dto.code, req.ip, req.headers['user-agent'],
    );
    setRefreshCookie(res, refreshToken);
    const full = await this.auth.me(user.id);
    return { accessToken, ...full };
  }

  // ── enrolment (authenticated) ────────────────────────────────────
  @AllowWhenMfaPending()
  @Authenticated('reads the caller own MFA state')
  @Get('mfa/status')
  mfaStatus(@CurrentUser() user: JwtUser) {
    return this.mfa.status(user.sub, user.role);
  }

  @AllowWhenMfaPending()
  @Authenticated('starts enrolment for the caller own account')
  @Post('mfa/setup')
  @HttpCode(200)
  mfaSetup(@CurrentUser() user: JwtUser) {
    return this.mfa.beginSetup(user.sub);
  }

  @AllowWhenMfaPending()
  @Authenticated('completes enrolment for the caller own account')
  @Post('mfa/enable')
  @HttpCode(200)
  async mfaEnable(@CurrentUser() user: JwtUser, @Body() dto: MfaCodeDto, @Req() req: Request,
                  @Res({ passthrough: true }) res: Response) {
    const result = await this.mfa.enable(user.sub, dto.code, user.ws, req.ip);
    // Re-issue the session so the new access token carries the mfa claim and the enrolment
    // guard stops challenging them.
    const fresh = await this.auth.reissue(user.sub, req.headers['user-agent']);
    setRefreshCookie(res, fresh.refreshToken);
    return { ...result, accessToken: fresh.accessToken };
  }

  /** Turning MFA off re-checks the password, so a borrowed screen cannot do it. */
  @Authenticated('disables MFA on the caller own account after re-authentication')
  @Post('mfa/disable')
  @HttpCode(200)
  async mfaDisable(@CurrentUser() user: JwtUser, @Body() dto: MfaDisableDto, @Req() req: Request) {
    await this.auth.assertPassword(user.sub, dto.password);
    if (MfaService.isRequiredFor(user.role)) {
      throw new BadRequestException(
        'Your role is required to keep two-factor authentication on. Ask a manager to change the policy.',
      );
    }
    await this.mfa.disable(user.sub, user.ws, req.ip);
    return { ok: true };
  }

  @Public()
  @Post('refresh')
  @HttpCode(200)
  async refresh(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const raw = req.cookies?.[REFRESH_COOKIE];
    const { accessToken, refreshToken, user } = await this.auth.refresh(raw, req.headers['user-agent']);
    setRefreshCookie(res, refreshToken);
    const full = await this.auth.me(user.id);
    return { accessToken, ...full };
  }

  /** Always 200 — never reveals whether an address is registered. */
  @Public()
  @Credentials()
  @Post('forgot-password')
  @HttpCode(200)
  async forgotPassword(@Body() dto: ForgotPasswordDto, @Req() req: Request) {
    await this.auth.forgotPassword(dto.email, await this.company(), req.ip);
    return { ok: true, message: 'If that address belongs to an account, a reset link is on its way.' };
  }

  /** Link pre-flight so the page can show a clear message instead of failing on submit. */
  @Public()
  @Get('reset-password/:token')
  async checkReset(@Param('token') token: string) {
    const row = await this.tokens.peek(token, 'PASSWORD_RESET');
    return { valid: true, email: row.user.email, fullName: row.user.fullName };
  }

  @Public()
  @Post('reset-password')
  @HttpCode(200)
  resetPassword(@Body() dto: TokenPasswordDto, @Req() req: Request) {
    return this.auth.resetPassword(dto.token, dto.newPassword, req.ip);
  }

  @Public()
  @Get('activate/:token')
  async checkActivation(@Param('token') token: string) {
    const row = await this.tokens.peek(token, 'ACTIVATION');
    return { valid: true, email: row.user.email, fullName: row.user.fullName };
  }

  @Public()
  @Post('activate')
  @HttpCode(200)
  activate(@Body() dto: TokenPasswordDto, @Req() req: Request) {
    return this.auth.activate(dto.token, dto.newPassword, req.ip);
  }

  @Authenticated('ends the caller own session')
  @AllowWhenMustChangePassword()
  @Post('logout')
  @HttpCode(200)
  async logout(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    await this.auth.logout(req.cookies?.[REFRESH_COOKIE]);
    clearRefreshCookie(res);
    return { ok: true };
  }

  @Authenticated('changes the caller own password, verified against the current one')
  @AllowWhenMustChangePassword()
  @Post('change-password')
  @HttpCode(200)
  async changePassword(
    @CurrentUser() user: JwtUser,
    @Body() dto: ChangePasswordDto,
    @Res({ passthrough: true }) res: Response,
  ) {
    const { accessToken, refreshToken } = await this.auth.changePassword(
      user.sub, dto.currentPassword, dto.newPassword,
    );
    setRefreshCookie(res, refreshToken);
    return { accessToken, ok: true };
  }

  @Authenticated('returns the caller own profile only')
  @AllowWhenMustChangePassword()
  @Get('me')
  async me(@CurrentUser() user: JwtUser) {
    return this.auth.me(user.sub);
  }
}
