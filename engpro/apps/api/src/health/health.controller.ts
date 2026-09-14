import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';
import { Public } from '../common/auth.types';
import { PrismaService } from '../prisma.service';

@Controller()
export class HealthController {
  constructor(private prisma: PrismaService) {}

  @Public()
  @Get('health')
  health() {
    return { status: 'ok', service: 'engpro-api' };
  }

  @Public()
  @Get('ready')
  async ready() {
    try {
      await this.prisma.$queryRaw`SELECT 1`;
      return { status: 'ready' };
    } catch {
      throw new ServiceUnavailableException({ status: 'not-ready', reason: 'database unreachable' });
    }
  }
}
