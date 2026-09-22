import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { JwtModule } from '@nestjs/jwt';
import { ThrottlerModule } from '@nestjs/throttler';
import { PrismaService } from './prisma.service';
import { AuditService } from './common/audit.service';
import { MailService } from './common/mail.service';
import { MailController } from './common/mail.controller';
import { TokensService } from './auth/tokens.service';
import { PermissionsService } from './common/permissions';
import { JwtAuthGuard, PasswordChangeGuard, PermGuard, RolesGuard } from './common/guards';
import { RolesController } from './roles/roles.controller';
import { SsoController } from './sso/sso.controller';
import { SsoService } from './sso/sso.service';
import { EventsGateway } from './events/events.gateway';
import { AuthController } from './auth/auth.controller';
import { AuthService } from './auth/auth.service';
import { UsersController } from './users/users.controller';
import { UsersService } from './users/users.service';
import { SitesController } from './sites/sites.controller';
import { WorkspaceController } from './workspace/workspace.controller';
import { TicketsController } from './tickets/tickets.controller';
import { TicketsService } from './tickets/tickets.service';
import { KpiController } from './kpi/kpi.controller';
import { KpiService } from './kpi/kpi.service';
import { AuditController } from './audit/audit.controller';
import { HealthController } from './health/health.controller';

@Module({
  imports: [
    JwtModule.register({ global: true }),
    ThrottlerModule.forRoot({
      throttlers: [{ ttl: 60_000, limit: parseInt(process.env.THROTTLE_LIMIT || '5', 10) }],
    }),
  ],
  controllers: [
    AuthController, UsersController, SitesController, WorkspaceController,
    TicketsController, KpiController, AuditController, RolesController, SsoController, MailController, HealthController,
  ],
  providers: [
    PrismaService, AuditService, PermissionsService, EventsGateway, MailService, TokensService,
    AuthService, UsersService, TicketsService, KpiService, SsoService,
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: PasswordChangeGuard },
    { provide: APP_GUARD, useClass: RolesGuard },
    { provide: APP_GUARD, useClass: PermGuard },
  ],
})
export class AppModule {}
